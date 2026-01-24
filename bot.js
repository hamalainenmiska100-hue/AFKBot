/**
 * Bedrock AFK Bot - KORJATTU TUOTANTOVERSIO
 * Päivitetty: Tammikuu 24, 2026
 * Korjaukset:
 * - Oikeaoppinen Authflow-integraatio bedrock-protocolan kanssa.
 * - Turvallinen muistin optimointi (ei rikota pakettidataa).
 * - Parannettu virheen käsittely ja uudelleenkytkentä.
 */

const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  EmbedBuilder
} = require("discord.js");

const bedrock = require("bedrock-protocol");
const { Authflow, Titles } = require("prismarine-auth");
const fs = require("fs");
const path = require("path");

// ----------------------------------------------------------------
// ASETUKSET
// ----------------------------------------------------------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ALLOWED_GUILD_ID = "1462335230345089254";
const ADMIN_ID = "1144987924123881564";
const LOG_CHANNEL_ID = "1464615030111731753";
const ADMIN_CHANNEL_ID = "1464615993320935447";
const REJOIN_DELAY = 30000; // 30 sekuntia
const CONNECT_TIMEOUT = 30000; // 30 sekuntia

if (!DISCORD_TOKEN) {
  console.error("❌ KRIITTINEN VIRHE: DISCORD_TOKEN puuttuu.");
  process.exit(1);
}

// ----------------------------------------------------------------
// TALLENNUSTILA
// ----------------------------------------------------------------
const DATA_DIR = path.join(__dirname, "data");
const AUTH_DIR = path.join(DATA_DIR, "auth");
const STORE_FILE = path.join(DATA_DIR, "users.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

let users = {};
if (fs.existsSync(STORE_FILE)) {
  try {
    users = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch (err) {
    console.error("users.json lukuvirhe, alustetaan tyhjänä.");
    users = {};
  }
}

function saveDatabase() {
  fs.writeFileSync(STORE_FILE, JSON.stringify(users, null, 2));
}

function getUser(uid) {
  if (!users[uid]) {
    users[uid] = {
      connectionType: "online",
      bedrockVersion: "auto",
      offlineUsername: `AFK_${uid.slice(-4)}`,
      active: false,
      server: null,
      linked: false
    };
  }
  return users[uid];
}

function getAuthPath(uid) {
  const p = path.join(AUTH_DIR, uid);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

// ----------------------------------------------------------------
// AJONAIKAINEN TILA
// ----------------------------------------------------------------
const sessions = new Map();
const activeLinks = new Map();
let adminPanelMessage = null;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ----------------------------------------------------------------
// LOGITUS JA APUFUNKTIOT
// ----------------------------------------------------------------

async function postToLogs(message, color = "#5865F2") {
  try {
    const channel = await client.channels.fetch(LOG_CHANNEL_ID);
    if (channel && channel.isTextBased()) {
      const embed = new EmbedBuilder()
        .setColor(color)
        .setDescription(message)
        .setTimestamp();
      await channel.send({ embeds: [embed] });
    }
  } catch (err) {}
}

async function sendDM(uid, text) {
  try {
    const user = await client.users.fetch(uid);
    if (user) await user.send(text);
  } catch (err) {}
}

function validateGuild(interaction) {
  if (!interaction.inGuild() || interaction.guildId !== ALLOWED_GUILD_ID) {
    const msg = "Tämä botti on rajoitettu vain tiettyyn palvelimeen ⛔";
    interaction.reply({ ephemeral: true, content: msg }).catch(() => {});
    return false;
  }
  return true;
}

// ----------------------------------------------------------------
// BOTIN LOGIIKKA
// ----------------------------------------------------------------

function cleanupSession(uid) {
  const s = sessions.get(uid);
  if (!s) return;
  
  if (s.timeout) clearTimeout(s.timeout);
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  if (s.afkInterval) clearInterval(s.afkInterval);
  
  try {
    if (s.client) {
      s.client.close();
      s.client = null;
    }
  } catch (err) {}
  
  sessions.delete(uid);
  if (global.gc) global.gc();
}

function stopBot(uid, manual = true) {
  const profile = getUser(uid);
  if (manual) {
    profile.active = false;
    saveDatabase();
  }
  
  const session = sessions.get(uid);
  if (!session) return false;
  
  if (manual) session.manualStop = true;
  cleanupSession(uid);
  return true;
}

async function startBot(uid, interaction = null) {
  const profile = getUser(uid);
  if (!profile.server || !profile.server.ip) {
    if (interaction) interaction.editReply("⚠️ Palvelimen IP-osoitetta ei ole asetettu.").catch(() => {});
    return;
  }

  // Estetään tuplakäynnistys
  if (sessions.has(uid) && sessions.get(uid).connected) {
    if (interaction) interaction.editReply("⚠️ Botti on jo päällä.").catch(() => {});
    return;
  }

  profile.active = true;
  saveDatabase();

  const authDir = getAuthPath(uid);
  const flow = new Authflow(uid, authDir, {
    flow: "live",
    authTitle: Titles.MinecraftNintendoSwitch,
    deviceType: "Nintendo"
  });

  const options = {
    host: profile.server.ip,
    port: parseInt(profile.server.port) || 19132,
    connectTimeout: CONNECT_TIMEOUT,
    skipInitResurcePacks: true, // TURVALLINEN RAM-optimointi
    version: profile.bedrockVersion === "auto" ? undefined : profile.bedrockVersion
  };

  // Todennuksen asettaminen
  if (profile.connectionType === "offline") {
    options.username = profile.offlineUsername || `AFK_${uid.slice(-4)}`;
    options.offline = true;
  } else {
    options.authflow = flow;
    options.username = uid;
  }

  try {
    const mc = bedrock.createClient(options);
    let state = sessions.get(uid) || { startedAt: Date.now(), manualStop: false, connected: false, pkts: 0, isRetrying: false };
    state.client = mc;
    state.isRetrying = false;
    sessions.set(uid, state);

    // AIKATKAISU LIITTYMISELLE
    state.timeout = setTimeout(() => {
      if (sessions.has(uid) && !state.connected) {
        if (interaction) interaction.editReply("❌ Aikakatkaisu (30s). Palvelin saattaa olla alhaalla.").catch(() => {});
        mc.close();
      }
    }, CONNECT_TIMEOUT);

    mc.on('packet', () => { state.pkts++; });

    mc.on("spawn", () => {
      if (!state.connected) {
        state.connected = true;
        clearTimeout(state.timeout);
        if (interaction) interaction.editReply(`🟢 Botti liittyi palvelimeen **${options.host}**`).catch(() => {});
        postToLogs(`✅ Käyttäjän <@${uid}> botti on nyt Online.`, "#00FF00");

        // AFK-liike (60s välein)
        state.afkInterval = setInterval(() => {
          try {
            if (mc.entityId) {
              mc.write("move_player", {
                runtime_id: mc.entityId, position: mc.entity?.position || {x:0,y:0,z:0}, pitch: 0, yaw: 0, head_yaw: 0,
                mode: 0, on_ground: true, ridden_runtime_id: 0, teleport: false
              });
            }
          } catch (e) {}
        }, 60000);
      }
    });

    mc.on("error", (err) => {
      clearTimeout(state.timeout);
      postToLogs(`❌ Virhe käyttäjälle <@${uid}>: \`${err.message}\``, "#FF0000");
      if (!state.manualStop) triggerRejoin(uid);
    });

    mc.on("close", () => {
      clearTimeout(state.timeout);
      postToLogs(`🔌 Käyttäjän <@${uid}> botin yhteys katkesi.`, "#808080");
      if (!state.manualStop) triggerRejoin(uid);
    });

  } catch (err) {
    console.error(err);
    if (interaction) interaction.editReply(`❌ Käynnistysvirhe: ${err.message}`).catch(() => {});
  }
}

function triggerRejoin(uid) {
  const s = sessions.get(uid);
  if (!s || s.manualStop || s.reconnectTimer) return;

  s.isRetrying = true;
  s.connected = false;
  s.reconnectTimer = setTimeout(() => {
    if (sessions.has(uid) && !s.manualStop) {
      s.reconnectTimer = null;
      startBot(uid);
    }
  }, REJOIN_DELAY);
}

// ----------------- MICROSOFT LOGIN FLOW -----------------

async function handleMsLink(uid, interaction) {
  if (activeLinks.has(uid)) return interaction.editReply("⏳ Kirjautuminen on jo käynnissä.");
  
  await interaction.editReply("⏳ Pyydetään koodia Microsoftilta...");

  const authDir = getAuthPath(uid);
  const profile = getUser(uid);

  try {
    const flow = new Authflow(uid, authDir, {
      flow: "live",
      authTitle: Titles.MinecraftNintendoSwitch,
      deviceType: "Nintendo"
    }, async (data) => {
      const loginEmbed = new EmbedBuilder()
        .setTitle("🔐 Microsoft-tilin yhdistäminen")
        .setDescription(`Koodi: **\`${data.user_code}\`**\n\n1. Klikkaa alla olevaa painiketta\n2. Syötä koodi avautuvaan sivuun\n\n*Botti päivittyy kun olet valmis.*`)
        .setColor("#5865F2");
      
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel("Avaa Microsoft-linkki").setStyle(ButtonStyle.Link).setURL(data.verification_uri_complete)
      );

      await interaction.editReply({ content: null, embeds: [loginEmbed], components: [row] });
    });

    activeLinks.set(uid, true);

    try {
      // Odotetaan että käyttäjä kirjautuu
      await flow.getMinecraftBedrockToken();
      profile.linked = true;
      saveDatabase();
      await interaction.followUp({ ephemeral: true, content: "✅ Onnistui! Microsoft-tili on nyt yhdistetty." });
      postToLogs(`🔑 Käyttäjä <@${uid}> yhdisti tilinsä.`);
    } catch (err) {
      await interaction.followUp({ ephemeral: true, content: `❌ Kirjautumisvirhe: ${err.message}` });
    } finally {
      activeLinks.delete(uid);
    }

  } catch (err) {
    await interaction.editReply(`❌ Auth-aloitus epäonnistui: ${err.message}`);
    activeLinks.delete(uid);
  }
}

// ----------------- ADMIN DASHBOARD -----------------

function getAdminEmbed() {
  const mem = process.memoryUsage();
  const rss = (mem.rss / 1024 / 1024).toFixed(2);
  const uptime = process.uptime();
  
  const embed = new EmbedBuilder()
    .setTitle("🛠 Ylläpidon Ohjauspaneeli")
    .setColor("#2F3136")
    .addFields(
      { name: "📊 Järjestelmä", value: `**RAM:** ${rss} MB\n**Uptime:** ${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m\n**Botit:** ${sessions.size}`, inline: true },
      { name: "📂 Tietokanta", value: `**Käyttäjiä:** ${Object.keys(users).length}\n**Auto-Restore:** PÄÄLLÄ`, inline: true }
    )
    .setTimestamp();

  if (sessions.size > 0) {
    let botList = "";
    for (const [id, s] of sessions) {
      const status = s.connected ? "🟢 Online" : (s.isRetrying ? "🟠 Rejoin" : "🔴 Error");
      botList += `${status} <@${id}> (${s.pkts || 0} pkt)\n`;
    }
    embed.addFields({ name: "🤖 Aktiiviset Istunnot", value: botList.slice(0, 1024) });
  }

  return embed;
}

function getAdminControls() {
  const rows = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("adm_refresh").setLabel("Päivitä").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("adm_stop_all").setLabel("Pysäytä Kaikki").setStyle(ButtonStyle.Danger)
  )];
  return rows;
}

// ----------------- DISCORD HANDLERIT -----------------

client.once("ready", async () => {
  console.log(`🟢 Tuotantotila käynnistetty: ${client.user.tag}`);
  
  const commands = [
    new SlashCommandBuilder().setName("panel").setDescription("Avaa AFK-botin ohjauspaneeli"),
    new SlashCommandBuilder().setName("admin").setDescription("Ylläpitäjän paneeli")
  ];
  await client.application.commands.set(commands);

  // AUTO-RESTORE
  const activeUserIds = Object.keys(users).filter(id => users[id].active === true);
  if (activeUserIds.length > 0) {
    postToLogs(`♻️ **Auto-Restore**: Käynnistetään ${activeUserIds.length} bottia uudelleen...`);
    activeUserIds.forEach((id, idx) => {
      setTimeout(() => startBot(id), idx * 3000);
    });
  }

  setInterval(async () => {
    if (adminPanelMessage) {
      try { 
        await adminPanelMessage.edit({ embeds: [getAdminEmbed()], components: getAdminControls() }); 
      } catch (e) { adminPanelMessage = null; }
    }
  }, 45000);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!validateGuild(interaction)) return;
    const uid = interaction.user.id;

    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "panel") {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("btn_link").setLabel("Yhdistä Microsoft").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("btn_start").setLabel("Käynnistä").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("btn_stop").setLabel("Pysäytä").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("btn_settings").setLabel("Asetukset").setStyle(ButtonStyle.Secondary)
        );
        return interaction.reply({ content: "🎛 **AFK Botti - Ohjauspaneeli**", components: [row] });
      }
      
      if (interaction.commandName === "admin") {
        if (uid !== ADMIN_ID) return interaction.reply({ content: "⛔ Ei oikeuksia.", ephemeral: true });
        adminPanelMessage = await interaction.reply({ embeds: [getAdminEmbed()], components: getAdminControls(), fetchReply: true });
        return;
      }
    }

    if (interaction.isButton()) {
      const cid = interaction.customId;

      if (cid === "adm_refresh") {
        if (uid !== ADMIN_ID) return;
        return interaction.update({ embeds: [getAdminEmbed()], components: getAdminControls() });
      }

      if (cid === "btn_link") { 
        await interaction.deferReply({ ephemeral: true }); 
        return handleMsLink(uid, interaction); 
      }
      
      if (cid === "btn_start") { 
        await interaction.deferReply({ ephemeral: true }); 
        return startBot(uid, interaction); 
      }
      
      if (cid === "btn_stop") {
        if (stopBot(uid, true)) {
          postToLogs(`⏹ Käyttäjä <@${uid}> pysäytti botin manuaalisesti.`);
          return interaction.reply({ content: "⏹ Botti pysäytetty.", ephemeral: true });
        }
        return interaction.reply({ content: "Ei aktiivista bottia.", ephemeral: true });
      }
      
      if (cid === "btn_settings") {
        const profile = getUser(uid);
        const modal = new ModalBuilder().setCustomId("modal_save").setTitle("Botin asetukset");
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("Palvelin IP").setStyle(TextInputStyle.Short).setValue(profile.server?.ip || "").setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("port").setLabel("Portti").setStyle(TextInputStyle.Short).setValue(String(profile.server?.port || 19132))),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("off").setLabel("Offline-nimi (jos ei Microsoft)").setStyle(TextInputStyle.Short).setValue(profile.offlineUsername || ""))
        );
        return interaction.showModal(modal);
      }
    }

    if (interaction.isModalSubmit() && interaction.customId === "modal_save") {
      const p = getUser(uid);
      p.server = { 
        ip: interaction.fields.getTextInputValue("ip").trim(), 
        port: interaction.fields.getTextInputValue("port").trim() 
      };
      p.offlineUsername = interaction.fields.getTextInputValue("off").trim();
      saveDatabase();
      return interaction.reply({ content: "✅ Asetukset tallennettu.", ephemeral: true });
    }
  } catch (err) { console.error("Interaktio-virhe:", err); }
});

process.on("unhandledRejection", (e) => console.error("Unhandled Promise:", e));
client.login(DISCORD_TOKEN);

