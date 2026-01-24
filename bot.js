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

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("❌ DISCORD_TOKEN missing");
  process.exit(1);
}

// ----------------- ASETUKSET -----------------
const ALLOWED_GUILD_ID = "1462335230345089254";
const ADMIN_ID = "1144987924123881564";
const LOG_CHANNEL_ID = "1464615030111731753";
const ADMIN_CHANNEL_ID = "1464615993320935447";
const CONN_TIMEOUT_MS = 25000; 

// ----------------- TALLENNUSTILA -----------------
const DATA = path.join(__dirname, "data");
const AUTH_ROOT = path.join(DATA, "auth");
const STORE = path.join(DATA, "users.json");

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA);
if (!fs.existsSync(AUTH_ROOT)) fs.mkdirSync(AUTH_ROOT, { recursive: true });

let users = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, "utf8")) : {};
function save() {
  fs.writeFileSync(STORE, JSON.stringify(users, null, 2));
}

function getUser(uid) {
  if (!users[uid]) users[uid] = {};
  if (!users[uid].connectionType) users[uid].connectionType = "online";
  if (!users[uid].bedrockVersion) users[uid].bedrockVersion = "auto";
  if (!users[uid].offlineUsername) users[uid].offlineUsername = `AFK_${uid.slice(-4)}`;
  if (users[uid].active === undefined) users[uid].active = false;
  return users[uid];
}

function getUserAuthDir(uid) {
  const dir = path.join(AUTH_ROOT, uid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ----------------- RUNTIME STATE -----------------
const sessions = new Map();
const pendingLink = new Map();
let adminPanelMessage = null;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages
  ]
});

// ----------------- APUOHJELMAT -----------------

async function logToDiscord(message, color = "#5865F2") {
  try {
    const channel = await client.channels.fetch(LOG_CHANNEL_ID);
    if (channel) {
      const embed = new EmbedBuilder().setColor(color).setDescription(message).setTimestamp();
      await channel.send({ embeds: [embed] });
    }
  } catch (e) {}
}

async function sendUserDM(uid, message) {
  try {
    const user = await client.users.fetch(uid);
    if (user) await user.send(message);
  } catch (e) {}
}

function denyIfWrongGuild(i) {
  if (!i.inGuild() || i.guildId !== ALLOWED_GUILD_ID) {
    const msg = "Tätä bottia ei voi käyttää tällä palvelimella ⛔️";
    if (i.deferred || i.replied) return i.editReply(msg).catch(() => {});
    return i.reply({ ephemeral: true, content: msg }).catch(() => {});
  }
  return null;
}

// ----------------- UI KOMPONENTIT -----------------

function panelRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("link").setLabel("🔑 Linkitä Microsoft").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("unlink").setLabel("🗑 Poista Linkitys").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("start").setLabel("▶ Käynnistä").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("stop").setLabel("⏹ Pysäytä").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("settings").setLabel("⚙ Asetukset").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("more").setLabel("➕ Lisää").setStyle(ButtonStyle.Secondary)
    )
  ];
}

function adminPanelComponents() {
  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin_refresh").setLabel("🔄 Päivitä").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin_stop_all").setLabel("🛑 Stop All").setStyle(ButtonStyle.Danger)
    )
  ];
  if (sessions.size > 0) {
    const options = Array.from(sessions.keys()).slice(0, 25).map(uid => ({
      label: `User: ${uid}`,
      description: sessions.get(uid).connected ? "🟢 Online" : "🟠 Connecting",
      value: uid
    }));
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId("admin_force_stop_select").setPlaceholder("Valitse botti pysäytettäväksi").addOptions(options)
    ));
  }
  return rows;
}

// ----------------- PELILOGIIKKA JA RAM-OPTIMOINTI -----------------

function cleanupSession(uid) {
  const s = sessions.get(uid);
  if (!s) return;
  if (s.timeout) clearTimeout(s.timeout);
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  if (s.afkInterval) clearInterval(s.afkInterval);
  try {
    s.client.removeAllListeners();
    s.client.close();
    // Aggressiivinen muistin vapautus
    s.client = null; 
  } catch (e) {}
  sessions.delete(uid);
}

function startSession(uid, interaction = null) {
  const u = getUser(uid);
  if (!u.server) {
    if (interaction && !interaction.replied) interaction.editReply("⚠ Aseta serverin tiedot ensin.");
    return;
  }
  if (sessions.has(uid) && !sessions.get(uid).isReconnecting) {
    if (interaction && !interaction.replied) interaction.editReply("⚠ Botti on jo päällä.");
    return;
  }

  u.active = true;
  save();

  const { ip, port } = u.server;
  const opts = {
    host: ip,
    port: parseInt(port),
    connectTimeout: CONN_TIMEOUT_MS,
    keepAlive: true,
    version: u.bedrockVersion === "auto" ? undefined : u.bedrockVersion
  };

  if (u.connectionType === "offline") {
    opts.username = u.offlineUsername || `AFK_${uid.slice(-4)}`;
    opts.offline = true;
  } else {
    opts.username = uid;
    opts.offline = false;
    opts.profilesFolder = getUserAuthDir(uid);
  }

  const mc = bedrock.createClient(opts);
  let currentSession = sessions.get(uid) || { startedAt: Date.now(), manualStop: false, connected: false, packetsReceived: 0 };
  currentSession.client = mc;
  currentSession.isReconnecting = false;
  sessions.set(uid, currentSession);

  // RAM FIX: Älä prosessoi tai tallenna chunk-dataa
  mc.on('packet', (packet) => {
    currentSession.packetsReceived++;
    const name = packet.data.name;
    // Poistetaan kaikki raskaat maailmapaketit heti
    if (name.includes('chunk') || name.includes('level') || name.includes('metadata')) {
      packet.data.payload = null;
      packet.data = null; 
    }
  });

  // GEYSER FIX
  mc.on('play_status', (packet) => {
    if ((packet.status === 'player_spawn' || packet.status === 'login_success') && !currentSession.connected) {
      handleSpawn(uid, mc, currentSession, interaction, ip, port);
    }
  });

  mc.on("spawn", () => {
    if (!currentSession.connected) handleSpawn(uid, mc, currentSession, interaction, ip, port);
  });

  currentSession.timeout = setTimeout(() => {
    if (sessions.has(uid) && !currentSession.connected) {
      if (interaction && interaction.deferred) interaction.editReply("❌ Aikakatkaisu (25s).");
      mc.close();
    }
  }, CONN_TIMEOUT_MS);

  mc.on("error", (e) => {
    clearTimeout(currentSession.timeout);
    if (!currentSession.manualStop) handleAutoReconnect(uid, interaction);
  });

  mc.on("close", () => {
    clearTimeout(currentSession.timeout);
    if (!currentSession.manualStop) handleAutoReconnect(uid, interaction);
  });
}

function handleSpawn(uid, mc, currentSession, interaction, ip, port) {
  currentSession.connected = true;
  clearTimeout(currentSession.timeout);
  if (interaction && interaction.deferred) interaction.editReply(`🟢 Yhdistetty: **${ip}:${port}**`);
  logToDiscord(`✅ Botti <@${uid}> Online: ${ip}`, "#00FF00");

  currentSession.afkInterval = setInterval(() => {
    try {
      if (!mc.entityId) return;
      mc.write("move_player", {
        runtime_id: mc.entityId, position: mc.entity?.position || {x:0,y:0,z:0}, pitch: 0, yaw: 0, head_yaw: 0,
        mode: 0, on_ground: true, ridden_runtime_id: 0, teleport: false
      });
    } catch (e) {}
  }, 60000);
}

function handleAutoReconnect(uid, interaction) {
  const s = sessions.get(uid);
  if (!s || s.manualStop || s.reconnectTimer) return;
  s.isReconnecting = true;
  s.connected = false;
  s.reconnectTimer = setTimeout(() => {
    if (sessions.has(uid) && !s.manualStop) {
      s.reconnectTimer = null;
      startSession(uid, interaction);
    }
  }, 120000);
}

// ----------------- LINKITYS JA ASETUKSET -----------------

async function performLink(uid, interaction) {
  if (pendingLink.has(uid)) return interaction.editReply("⏳ Odota edellistä koodia.");
  const flow = new Authflow(uid, getUserAuthDir(uid), {
    flow: "live", authTitle: Titles.MinecraftNintendoSwitch, deviceType: "Nintendo"
  }, async (data) => {
    const embed = new EmbedBuilder()
      .setTitle("🔐 Microsoft Linkitys")
      .setDescription(`Koodi: \`${data.user_code}\`\nLinkki: ${data.verification_uri_complete}`)
      .setColor("#5865F2");
    await interaction.editReply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Avaa Linkki").setStyle(ButtonStyle.Link).setURL(data.verification_uri_complete))] });
  });
  const p = (async () => {
    try {
      await flow.getMsaToken();
      const u = getUser(uid); u.linked = true; save();
      await interaction.followUp({ ephemeral: true, content: "✅ Linkitetty!" });
    } catch (e) { await interaction.followUp({ ephemeral: true, content: "❌ Virhe linkityksessä." }); }
    finally { pendingLink.delete(uid); }
  })();
  pendingLink.set(uid, p);
}

// ----------------- ANALYTIIKKA -----------------

function getAdminStatsEmbed() {
  const mem = process.memoryUsage();
  const uptime = process.uptime();
  const embed = new EmbedBuilder()
    .setTitle("🚀 Admin Analytics")
    .setColor("#2F3136")
    .addFields(
      { name: "💻 RAM", value: `${(mem.rss / 1024 / 1024).toFixed(2)} MB`, inline: true },
      { name: "⏱ Uptime", value: `${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m`, inline: true },
      { name: "🤖 Botit", value: `${sessions.size} aktiivista`, inline: true }
    )
    .setTimestamp();
  if (sessions.size > 0) {
    let list = "";
    for (const [uid, s] of sessions) list += `<@${uid}>: ${s.connected ? "🟢" : "🟠"} (${s.packetsReceived} pkt)\n`;
    embed.addFields({ name: "List", value: list.slice(0, 1024) });
  }
  return embed;
}

// ----------------- EVENTS -----------------

client.once("ready", async () => {
  const cmds = [
    new SlashCommandBuilder().setName("panel").setDescription("AFK Paneeli"),
    new SlashCommandBuilder().setName("admin").setDescription("Admin Paneeli")
  ];
  await client.application.commands.set(cmds);

  // AUTO-RESTORE
  const activeUids = Object.keys(users).filter(uid => users[uid].active);
  activeUids.forEach((uid, i) => setTimeout(() => startSession(uid), i * 3000));

  setInterval(async () => {
    if (adminPanelMessage) {
      try { await adminPanelMessage.edit({ embeds: [getAdminStatsEmbed()], components: adminPanelComponents() }); } 
      catch (e) { adminPanelMessage = null; }
    }
  }, 30000);
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (denyIfWrongGuild(i)) return;
    const uid = i.user.id;

    if (i.isChatInputCommand()) {
      if (i.commandName === "panel") return i.reply({ components: panelRow() });
      if (i.commandName === "admin") {
        if (uid !== ADMIN_ID) return i.reply({ content: "❌", ephemeral: true });
        adminPanelMessage = await i.reply({ embeds: [getAdminStatsEmbed()], components: adminPanelComponents(), fetchReply: true });
        return;
      }
    }

    if (i.isButton()) {
      if (i.customId === "admin_refresh") return i.update({ embeds: [getAdminStatsEmbed()], components: adminPanelComponents() });
      if (i.customId === "link") { await i.deferReply({ ephemeral: true }); return performLink(uid, i); }
      if (i.customId === "unlink") { 
        const dir = path.join(AUTH_ROOT, uid);
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        const u = getUser(uid); u.linked = false; save();
        return i.reply({ content: "🗑 Poistettu.", ephemeral: true });
      }
      if (i.customId === "start") { await i.deferReply({ ephemeral: true }); return startSession(uid, i); }
      if (i.customId === "stop") { 
        const s = sessions.get(uid); 
        if (s) { s.manualStop = true; cleanupSession(uid); }
        const u = getUser(uid); u.active = false; save();
        return i.reply({ content: "⏹ Pysäytetty.", ephemeral: true });
      }
      if (i.customId === "settings") {
        const u = getUser(uid);
        const modal = new ModalBuilder().setCustomId("settings_modal").setTitle("Asetukset");
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("IP").setStyle(TextInputStyle.Short).setValue(u.server?.ip || "")),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.server?.port || 19132))),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("offline").setLabel("Offline Name").setStyle(TextInputStyle.Short).setValue(u.offlineUsername || ""))
        );
        return i.showModal(modal);
      }
    }

    if (i.isModalSubmit() && i.customId === "settings_modal") {
      const u = getUser(uid);
      u.server = { ip: i.fields.getTextInputValue("ip"), port: i.fields.getTextInputValue("port") };
      u.offlineUsername = i.fields.getTextInputValue("offline");
      save();
      return i.reply({ content: "✅ Tallennettu", ephemeral: true });
    }
  } catch (e) { console.error(e); }
});

client.login(DISCORD_TOKEN);

