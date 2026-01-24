/**
 * Bedrock AFK Bot - Full Production Version
 * * Tässä versiossa yhdistyvät:
 * 1. Alkuperäinen toimiva Microsoft-linkitys (Prismarine-auth)
 * 2. Timeout-suojaus: Botti vastaa heti "Requesting..." estääkseen Discordin timeoutin.
 * 3. Aggressiivinen RAM-optimointi: Chunk-paketit tuhotaan heti saapuessa.
 * 4. Ylläpito-ominaisuudet: Admin Panel (ei ephemeral), Force Stop, Auto-refresh 30s.
 * 5. Auto-Restore: Botti yhdistää takaisin peliin deployauksen jälkeen.
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

// ----------------- KONFIGURAATIO -----------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ALLOWED_GUILD_ID = "1462335230345089254";
const ADMIN_ID = "1144987924123881564";
const LOG_CHANNEL_ID = "1464615030111731753";
const ADMIN_CHANNEL_ID = "1464615993320935447";
const CONNECTION_TIMEOUT = 25000; 

if (!DISCORD_TOKEN) {
  console.error("❌ CRITICAL: DISCORD_TOKEN is missing.");
  process.exit(1);
}

// ----------------- TALLENNUSTILA -----------------
const DATA_DIR = path.join(__dirname, "data");
const AUTH_DIR = path.join(DATA_DIR, "auth");
const STORE_FILE = path.join(DATA_DIR, "users.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

let users = {};
if (fs.existsSync(STORE_FILE)) {
  try {
    users = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch (e) {
    users = {};
  }
}

function save() {
  fs.writeFileSync(STORE_FILE, JSON.stringify(users, null, 2));
}

function getUser(uid) {
  if (!users[uid]) {
    users[uid] = {
      connectionType: "online",
      bedrockVersion: "auto",
      offlineUsername: `AFK_${uid.slice(-4)}`,
      active: false,
      server: null
    };
  }
  return users[uid];
}

function getAuthPath(uid) {
  const p = path.join(AUTH_DIR, uid);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

// ----------------- AJONAIKAINEN TILA -----------------
const sessions = new Map();
const activeLinks = new Map();
let adminPanelMsg = null; // Globaali viite admin-paneeliin päivityksiä varten

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages
  ]
});

// ----------------- TUOTANTO-LOKITUS -----------------

async function logToDiscord(desc, color = "#5865F2") {
  try {
    const ch = await client.channels.fetch(LOG_CHANNEL_ID);
    if (ch && ch.isTextBased()) {
      const embed = new EmbedBuilder().setColor(color).setDescription(desc).setTimestamp();
      await ch.send({ embeds: [embed] });
    }
  } catch (e) {}
}

async function sendPrivateDM(uid, msg) {
  try {
    const user = await client.users.fetch(uid);
    if (user) await user.send(msg);
  } catch (e) {}
}

function checkGuild(interaction) {
  if (!interaction.inGuild() || interaction.guildId !== ALLOWED_GUILD_ID) {
    const txt = "Bot restricted to production guild ⛔";
    if (interaction.deferred || interaction.replied) interaction.editReply(txt).catch(() => {});
    else interaction.reply({ ephemeral: true, content: txt }).catch(() => {});
    return false;
  }
  return true;
}

// ----------------- BOTIN LOGIIKKA JA RAM-OPTIMOINTI -----------------

function stopSession(uid, manual = true) {
  const s = sessions.get(uid);
  if (manual) {
    const u = getUser(uid);
    u.active = false;
    save();
  }
  if (!s) return false;
  if (manual) s.manualStop = true;
  
  if (s.timeout) clearTimeout(s.timeout);
  if (s.reconnect) clearTimeout(s.reconnect);
  if (s.afkLoop) clearInterval(s.afkLoop);
  
  try {
    if (s.mc) {
      s.mc.removeAllListeners();
      s.mc.close();
      s.mc = null;
    }
  } catch (e) {}
  
  sessions.delete(uid);
  if (global.gc) global.gc(); // Vapautetaan muisti jos mahdollista
  return true;
}

function startSession(uid, interaction = null) {
  const u = getUser(uid);
  if (!u.server || !u.server.ip) {
    if (interaction && !interaction.replied) interaction.editReply("⚠️ Configure Server Settings first.");
    return;
  }
  if (sessions.has(uid) && !sessions.get(uid).isRetry) {
    if (interaction && !interaction.replied) interaction.editReply("⚠️ Bot already running.");
    return;
  }

  u.active = true;
  save();

  const ip = u.server.ip;
  const port = parseInt(u.server.port) || 19132;

  const opts = {
    host: ip,
    port,
    connectTimeout: CONNECTION_TIMEOUT,
    keepAlive: true,
    version: u.bedrockVersion === "auto" ? undefined : u.bedrockVersion
  };

  if (u.connectionType === "offline") {
    opts.username = u.offlineUsername || `AFK_${uid.slice(-4)}`;
    opts.offline = true;
  } else {
    opts.username = uid;
    opts.offline = false;
    opts.profilesFolder = getAuthPath(uid);
  }

  const mc = bedrock.createClient(opts);
  let state = sessions.get(uid) || { startedAt: Date.now(), manualStop: false, connected: false, pkts: 0, isRetry: false };
  state.mc = mc;
  state.isRetry = false;
  sessions.set(uid, state);

  // --- AGGRESSIIVINEN RAM-OPTIMOINTI (Packet Stripping) ---
  mc.on('packet', (p) => {
    state.pkts++;
    const name = p.data.name;
    // Tuhotaan raskaat maailmapaketit heti saapuessa
    if (name.includes('chunk') || name.includes('level') || name.includes('metadata') || name.includes('entity') || name.includes('player_list')) {
      if (p.data.payload) p.data.payload = null;
      p.data = null; 
    }
  });

  mc.on('play_status', (p) => {
    if ((p.status === 'player_spawn' || p.status === 'login_success') && !state.connected) {
      onSuccessfulSpawn(uid, mc, state, interaction, ip, port);
    }
  });

  mc.on("spawn", () => {
    if (!state.connected) onSuccessfulSpawn(uid, mc, state, interaction, ip, port);
  });

  state.timeout = setTimeout(() => {
    if (sessions.has(uid) && !state.connected) {
      if (interaction && interaction.deferred) interaction.editReply("❌ Connection Timeout (25s). Check Server IP/Port.");
      mc.close();
    }
  }, CONNECTION_TIMEOUT);

  mc.on("error", (e) => {
    clearTimeout(state.timeout);
    logToDiscord(`❌ Error <@${uid}>: \`${e.message}\``, "#FF0000");
    if (!state.manualStop) retryConnection(uid, interaction);
  });

  mc.on("close", () => {
    clearTimeout(state.timeout);
    logToDiscord(`🔌 Closed <@${uid}>`, "#808080");
    if (!state.manualStop) retryConnection(uid, interaction);
  });
}

function onSuccessfulSpawn(uid, mc, state, interaction, ip, port) {
  state.connected = true;
  clearTimeout(state.timeout);
  if (interaction && interaction.deferred) interaction.editReply(`🟢 Bot is now Online at **${ip}:${port}**`);
  logToDiscord(`✅ Bot <@${uid}> joined ${ip}`, "#00FF00");

  state.afkLoop = setInterval(() => {
    try {
      if (!mc.entityId) return;
      mc.write("move_player", {
        runtime_id: mc.entityId, position: mc.entity?.position || {x:0,y:0,z:0}, pitch: 0, yaw: 0, head_yaw: 0,
        mode: 0, on_ground: true, ridden_runtime_id: 0, teleport: false
      });
    } catch (e) {}
  }, 60000);
}

function retryConnection(uid, interaction) {
  const s = sessions.get(uid);
  if (!s || s.manualStop || s.reconnect) return;
  s.isRetry = true;
  s.connected = false;
  s.reconnect = setTimeout(() => {
    if (sessions.has(uid) && !s.manualStop) {
      s.reconnect = null;
      startSession(uid, interaction);
    }
  }, 120000); // 2 minuutin viive
}

// ----------------- MICROSOFT AUTH FLOW (TIMEOUT FIX) -----------------

async function handleLinkRequest(uid, interaction) {
  if (activeLinks.has(uid)) return interaction.editReply("⏳ Login process already active.");

  // VASTATAAN HETI, JOTTA DISCORD EI TIMEOUTTAA
  await interaction.editReply("⏳ Requesting login from Microsoft... Please wait.");

  const authPath = getAuthPath(uid);
  const u = getUser(uid);

  try {
    const flow = new Authflow(uid, authPath, {
      flow: "live",
      authTitle: Titles.MinecraftNintendoSwitch,
      deviceType: "Nintendo"
    }, async (data) => {
      // Prismarine-auth callback: näytetään koodi käyttäjälle
      const embed = new EmbedBuilder()
        .setTitle("🔐 Microsoft Login Required")
        .setDescription(`**Verification Code:** \`${data.user_code}\`\n\n1. Click the button below\n2. Enter the code above\n\n*The bot will update when done.*`)
        .setColor("#5865F2");
      
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel("Enter Code on Microsoft").setStyle(ButtonStyle.Link).setURL(data.verification_uri_complete)
      );

      await interaction.editReply({ content: null, embeds: [embed], components: [row] });
    });

    const promise = (async () => {
      try {
        await flow.getMsaToken();
        u.linked = true;
        save();
        await interaction.followUp({ ephemeral: true, content: "✅ Success! Microsoft account linked." });
        logToDiscord(`🔑 User <@${uid}> linked their Microsoft account.`);
      } catch (e) {
        await interaction.followUp({ ephemeral: true, content: `❌ Linking Error: ${e.message}` });
      } finally {
        activeLinks.delete(uid);
      }
    })();

    activeLinks.set(uid, promise);

  } catch (err) {
    await interaction.editReply(`❌ Init Error: ${err.message}`);
    activeLinks.delete(uid);
  }
}

// ----------------- ADMIN INTERFACE & ANALYTICS -----------------

function getAdminEmbed() {
  const mem = process.memoryUsage();
  const rss = (mem.rss / 1024 / 1024).toFixed(2);
  const uptime = process.uptime();
  
  const embed = new EmbedBuilder()
    .setTitle("🚀 Production Admin Dashboard")
    .setColor("#2B2D31")
    .addFields(
      { name: "💻 System", value: `**RAM:** ${rss} MB\n**Uptime:** ${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m`, inline: true },
      { name: "📊 Stats", value: `**Active Bots:** ${sessions.size}\n**Total Users:** ${Object.keys(users).length}`, inline: true }
    )
    .setTimestamp()
    .setFooter({ text: "Auto-refreshing 30s | pkts = packets" });

  if (sessions.size > 0) {
    let list = "";
    for (const [id, s] of sessions) {
      const status = s.connected ? "🟢" : (s.isRetry ? "⏳" : "🔴");
      list += `${status} <@${id}> (${s.pkts} pkts)\n`;
    }
    embed.addFields({ name: "Live Session Feed", value: list.slice(0, 1024) });
  }
  return embed;
}

function getAdminControls() {
  const rows = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("adm_refresh").setLabel("Refresh Stats").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("adm_stop_all").setLabel("Force Stop All").setStyle(ButtonStyle.Danger)
  )];
  
  if (sessions.size > 0) {
    const options = Array.from(sessions.keys()).slice(0, 25).map(id => ({ label: `User: ${id}`, value: id }));
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("adm_force_user")
        .setPlaceholder("Terminate a specific session")
        .addOptions(options)
    ));
  }
  return rows;
}

// ----------------- TAPAHTUMANKÄSITTELIJÄT -----------------

client.once("ready", async () => {
  console.log(`🟢 Production Instance Online: ${client.user.tag}`);
  
  const cmds = [
    new SlashCommandBuilder().setName("panel").setDescription("User AFK Panel"),
    new SlashCommandBuilder().setName("admin").setDescription("Admin Analytics Panel")
  ];
  await client.application.commands.set(cmds);

  // AUTO-RESTORE (BLACKDOWN PROTECTION)
  const activeIds = Object.keys(users).filter(id => users[id].active === true);
  if (activeIds.length > 0) {
    logToDiscord(`♻️ **Auto-Restore**: Deployment finished. Reconnecting ${activeIds.length} bots...`);
    activeIds.forEach((id, idx) => setTimeout(() => startSession(id), idx * 3000));
  }

  // Admin-paneelin automaattinen päivitys
  setInterval(async () => {
    if (adminPanelMsg) {
      try { 
        await adminPanelMsg.edit({ embeds: [getAdminEmbed()], components: getAdminControls() }); 
      } catch (e) { adminPanelMsg = null; }
    }
  }, 30000);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!checkGuild(interaction)) return;
    const uid = interaction.user.id;

    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "panel") {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("btn_l").setLabel("Link Microsoft").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("btn_u").setLabel("Unlink").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("btn_on").setLabel("Start Bot").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("btn_off").setLabel("Stop Bot").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("btn_s").setLabel("Settings").setStyle(ButtonStyle.Secondary)
        );
        return interaction.reply({ content: "🎛 **AFK Bot Controls**", components: [row] });
      }
      if (interaction.commandName === "admin") {
        if (uid !== ADMIN_ID) return interaction.reply({ content: "⛔ Unauthorized.", ephemeral: true });
        adminPanelMsg = await interaction.reply({ embeds: [getAdminEmbed()], components: getAdminControls(), fetchReply: true });
        return;
      }
    }

    if (interaction.isButton()) {
      const cid = interaction.customId;

      if (cid === "adm_refresh") {
        if (uid !== ADMIN_ID) return;
        return interaction.update({ embeds: [getAdminEmbed()], components: getAdminControls() });
      }
      if (cid === "adm_stop_all") {
        if (uid !== ADMIN_ID) return;
        const total = sessions.size;
        for (const [id, s] of sessions) { 
          stopSession(id, true); 
          sendPrivateDM(id, "⚠️ Your AFK bot was stopped by the owner."); 
        }
        return interaction.reply({ content: `✅ Terminated ${total} sessions.`, ephemeral: true });
      }

      if (cid === "btn_l") { 
        await interaction.deferReply({ ephemeral: true }); 
        return handleLinkRequest(uid, interaction); 
      }
      if (cid === "btn_u") {
        const p = getAuthPath(uid);
        if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
        const u = getUser(uid); u.linked = false; u.active = false; save();
        return interaction.reply({ content: "🗑 Microsoft Link Removed.", ephemeral: true });
      }
      if (cid === "btn_on") { 
        await interaction.deferReply({ ephemeral: true }); 
        return startSession(uid, interaction); 
      }
      if (cid === "btn_off") {
        if (stopSession(uid, true)) return interaction.reply({ content: "⏹ Bot Stopped.", ephemeral: true });
        return interaction.reply({ content: "No active bot found.", ephemeral: true });
      }
      if (cid === "btn_s") {
        const u = getUser(uid);
        const modal = new ModalBuilder().setCustomId("m_save").setTitle("Settings");
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("Server IP").setStyle(TextInputStyle.Short).setValue(u.server?.ip || "")),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.server?.port || 19132))),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("off").setLabel("Offline Name").setStyle(TextInputStyle.Short).setValue(u.offlineUsername || ""))
        );
        return interaction.showModal(modal);
      }
    }

    if (interaction.isModalSubmit() && interaction.customId === "m_save") {
      const u = getUser(uid);
      u.server = { ip: interaction.fields.getTextInputValue("ip").trim(), port: interaction.fields.getTextInputValue("port").trim() };
      u.offlineUsername = interaction.fields.getTextInputValue("off").trim();
      save();
      return interaction.reply({ content: "✅ Settings saved.", ephemeral: true });
    }
    
    if (interaction.isStringSelectMenu() && interaction.customId === "adm_force_user") {
      if (uid !== ADMIN_ID) return;
      const target = interaction.values[0];
      if (stopSession(target, true)) { 
        sendPrivateDM(target, "⚠️ Your AFK bot was stopped by the owner."); 
        return interaction.reply({ content: `✅ Stopped <@${target}>`, ephemeral: true }); 
      }
    }
  } catch (err) { console.error(err); }
});

process.on("unhandledRejection", (e) => console.error(e));
client.login(DISCORD_TOKEN);

