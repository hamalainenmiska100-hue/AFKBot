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
  StringSelectMenuBuilder
} = require("discord.js");

const bedrock = require("bedrock-protocol");
const mcJava = require("minecraft-protocol"); // Java raw protocol integration
const { Authflow, Titles } = require("prismarine-auth");
const fs = require("fs");
const path = require("path");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("❌ DISCORD_TOKEN missing");
  process.exit(1);
}

const ALLOWED_GUILD_ID = "1462335230345089254";

// ----------------- Storage -----------------
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
  if (!users[uid].delayMs) users[uid].delayMs = 5000;
  if (!users[uid].connectionType) users[uid].connectionType = "online";
  if (!users[uid].bedrockVersion) users[uid].bedrockVersion = "auto";
  if (!users[uid].offlineUsername) users[uid].offlineUsername = `AFK_${uid.slice(-4)}`;
  // Java specific defaults
  if (!users[uid].javaConnectionType) users[uid].javaConnectionType = "online";
  if (!users[uid].javaServer) users[uid].javaServer = { ip: "", port: 25565 };
  return users[uid];
}

function getUserAuthDir(uid) {
  const dir = path.join(AUTH_ROOT, uid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function unlinkMicrosoft(uid) {
  const dir = getUserAuthDir(uid);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  const u = getUser(uid);
  u.linked = false;
  save();
}

// ----------------- Runtime -----------------
const sessions = new Map();
const javaSessions = new Map(); // Separate map for Java NMP sessions
const pendingLink = new Map();
const lastMsa = new Map();

// ----------------- Discord client -----------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

function denyIfWrongGuild(i) {
  if (!i.inGuild() || i.guildId !== ALLOWED_GUILD_ID) {
    const msg = "This bot cannot be used in this server ⛔️";
    if (i.deferred) return i.editReply(msg).catch(() => {});
    if (i.replied) return i.followUp({ ephemeral: true, content: msg }).catch(() => {});
    return i.reply({ ephemeral: true, content: msg }).catch(() => {});
  }
  return null;
}

// ----------------- UI helpers -----------------
function panelRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("link").setLabel("🔑 Link Microsoft").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("unlink").setLabel("🗑 Unlink Microsoft").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("start").setLabel("▶ Start Bedrock").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("stop").setLabel("⏹ Stop Bedrock").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("settings").setLabel("⚙ Bedrock Settings").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("more").setLabel("➕ More Bedrock").setStyle(ButtonStyle.Secondary)
    )
  ];
}

function javaPanelRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("link").setLabel("🔑 Link Microsoft").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("j_start").setLabel("▶ Start Java").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("j_stop").setLabel("⏹ Stop Java").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("j_settings").setLabel("⚙ Java Settings").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("set_java_conn")
        .setPlaceholder("🔌 Java Connection Type")
        .addOptions(
          { label: "Online (Microsoft)", value: "online" },
          { label: "Offline (Cracked)", value: "offline" }
        )
    )
  ];
}

function msaComponents(uri) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel("🌐 Open link").setStyle(ButtonStyle.Link).setURL(uri)
    )
  ];
}

function versionRow(current = "auto") {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("set_version")
    .setPlaceholder("🌐 Bedrock Version")
    .addOptions(
      { label: "Auto", value: "auto", default: current === "auto" },
      { label: "1.21.x", value: "1.21.x", default: current === "1.21.x" },
      { label: "1.20.x", value: "1.20.x", default: current === "1.20.x" },
      { label: "1.19.x", value: "1.19.x", default: current === "1.19.x" }
    );
  return new ActionRowBuilder().addComponents(menu);
}

function connRow(current = "online") {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("set_conn")
    .setPlaceholder("🔌 Connection Type")
    .addOptions(
      { label: "Online (Microsoft)", value: "online", default: current === "online" },
      { label: "Offline (Cracked)", value: "offline", default: current === "offline" }
    );
  return new ActionRowBuilder().addComponents(menu);
}

// ----------------- Slash commands -----------------
client.once("ready", async () => {
  console.log("🟢 Online as", client.user.tag);
  const cmds = [
    new SlashCommandBuilder().setName("panel").setDescription("Open Bedrock AFK panel"),
    new SlashCommandBuilder().setName("java").setDescription("Open Java AFK panel")
  ];
  await client.application.commands.set(cmds);
});

// ----------------- Microsoft link -----------------
async function linkMicrosoft(uid, interaction) {
  if (pendingLink.has(uid)) {
    await interaction.editReply("⏳ Login already in progress. Use the last code.");
    return;
  }
  const authDir = getUserAuthDir(uid);
  const u = getUser(uid);
  let codeShown = false;
  const flow = new Authflow(uid, authDir, {
      flow: "live",
      authTitle: Titles?.MinecraftNintendoSwitch || "Bedrock AFK Bot",
      deviceType: "Nintendo"
    },
    async (data) => {
      const uri = data.verification_uri_complete || data.verification_uri || "https://www.microsoft.com/link";
      const code = data.user_code || "(no code)";
      lastMsa.set(uid, { uri, code, at: Date.now() });
      codeShown = true;
      const msg = `🔐 **Microsoft login required**\n\n👉 ${uri}\n\nYour code: \`${code}\`\n\n⚠ **IMPORTANT:** Use a *second* account.\n\nCome back after login.`;
      await interaction.editReply({ content: msg, components: msaComponents(uri) }).catch(() => {});
    }
  );
  const p = (async () => {
    try {
      if (!codeShown) await interaction.editReply("⏳ Requesting Microsoft login code…");
      await flow.getMsaToken();
      u.linked = true;
      save();
      await interaction.followUp({ ephemeral: true, content: "✅ Microsoft account linked!" }).catch(() => {});
    } catch (e) {
      await interaction.editReply(`❌ Microsoft login failed: ${String(e?.message || e)}`).catch(() => {});
    } finally {
      pendingLink.delete(uid);
    }
  })();
  pendingLink.set(uid, p);
}

// ----------------- Bedrock session -----------------
function cleanupSession(uid) {
  const s = sessions.get(uid);
  if (!s) return;
  if (s.timeout) clearTimeout(s.timeout);
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  try { s.client.close(); } catch {}
  sessions.delete(uid);
}

function stopSession(uid) {
  const s = sessions.get(uid);
  if (!s) return false;
  s.manualStop = true;
  cleanupSession(uid);
  return true;
}

async function startSession(uid, interaction) {
  const u = getUser(uid);
  if (!u.server || !u.server.ip) {
    if (interaction && !interaction.replied) interaction.editReply("⚠ Set settings first.");
    return;
  }
  const existing = sessions.get(uid);
  if (existing && !existing.isReconnecting) {
    if (interaction && !interaction.replied) interaction.editReply("⚠ Bot already running.");
    return;
  }

  // --- MOTD PING CHECK ---
  try {
    await bedrock.ping({ host: u.server.ip, port: u.server.port });
  } catch (err) {
    if (interaction && !interaction.replied) interaction.editReply(`❌ Bedrock Server Offline. Retrying in 30s...`);
    handleAutoReconnect(uid, interaction);
    return;
  }

  const authDir = getUserAuthDir(uid);
  const opts = { host: u.server.ip, port: u.server.port, connectTimeout: 47000, keepAlive: true };

  if (u.connectionType === "offline") {
    opts.username = u.offlineUsername;
    opts.offline = true;
  } else {
    opts.username = uid;
    opts.offline = false;
    opts.profilesFolder = authDir;
  }

  const mc = bedrock.createClient(opts);
  let currentSession = sessions.get(uid);
  if (!currentSession) {
    currentSession = { client: mc, timeout: null, manualStop: false };
    sessions.set(uid, currentSession);
  } else {
    currentSession.client = mc;
    currentSession.isReconnecting = false;
  }

  mc.on("spawn", () => {
    currentSession.connected = true;
    clearTimeout(currentSession.timeout);
    if (interaction) interaction.editReply(`🟢 Bedrock Connected to **${u.server.ip}**`).catch(() => {});
  });

  mc.on("error", () => { if (!currentSession.manualStop) handleAutoReconnect(uid, interaction); });
  mc.on("close", () => { if (!currentSession.manualStop) handleAutoReconnect(uid, interaction); });
}

function handleAutoReconnect(uid, interaction) {
  const s = sessions.get(uid);
  if (!s || s.manualStop || s.reconnectTimer) return;
  s.isReconnecting = true;
  s.reconnectTimer = setTimeout(() => {
    s.reconnectTimer = null;
    startSession(uid, interaction);
  }, 30000);
}

// ----------------- Java Logic (PURE NMP - NO MINEFLAYER) -----------------

function cleanupJavaSession(uid) {
  const s = javaSessions.get(uid);
  if (!s) return;
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  if (s.afkTimer) clearInterval(s.afkTimer);
  try { s.client.end(); } catch {}
  javaSessions.delete(uid);
}

function stopJavaSession(uid) {
  const s = javaSessions.get(uid);
  if (!s) return false;
  s.manualStop = true;
  cleanupJavaSession(uid);
  return true;
}

function handleJavaAutoReconnect(uid, interaction) {
  const s = javaSessions.get(uid);
  if (!s || s.manualStop || s.reconnectTimer) return;
  s.isReconnecting = true;
  s.reconnectTimer = setTimeout(() => {
    s.reconnectTimer = null;
    startJavaSession(uid, interaction);
  }, 30000);
}

async function startJavaSession(uid, interaction) {
  const u = getUser(uid);
  if (!u.javaServer || !u.javaServer.ip) {
    if (interaction && !interaction.replied) interaction.editReply("⚠ Set Java settings first.");
    return;
  }

  const existing = javaSessions.get(uid);
  if (existing && !existing.isReconnecting) {
    if (interaction && !interaction.replied) interaction.editReply("⚠ Java bot already running.");
    return;
  }

  const opts = {
    host: u.javaServer.ip,
    port: u.javaServer.port,
    version: false // Autodetect
  };

  if (u.javaConnectionType === "offline") {
    opts.username = u.offlineUsername || `AFK_Java_${uid.slice(-4)}`;
  } else {
    // Online mode via raw NMP Xbox Auth
    opts.auth = 'microsoft';
    opts.profilesFolder = getUserAuthDir(uid);
    opts.username = uid;
  }

  try {
    const mc = mcJava.createClient(opts);
    let session = javaSessions.get(uid);

    if (!session) {
      session = { client: mc, manualStop: false, pos: { x: 0, y: 0, z: 0 }, afkTimer: null };
      javaSessions.set(uid, session);
    } else {
      session.client = mc;
      session.isReconnecting = false;
    }

    // Capture position packets to know where we are (essential for raw NMP)
    mc.on('position', (packet) => {
      session.pos = { x: packet.x, y: packet.y, z: packet.z };
      // Acknowledge teleport if required by protocol
      mc.write('teleport_confirm', { teleportId: packet.teleportId });
    });

    // AFK Jitter via raw packets
    session.afkTimer = setInterval(() => {
      if (mc.state === mcJava.states.PLAY && session.pos.y !== 0) {
        mc.write('position', {
          x: session.pos.x + (Math.random() * 0.05),
          y: session.pos.y,
          z: session.pos.z + (Math.random() * 0.05),
          onGround: true
        });
      }
    }, 45000);

    mc.on('login', () => {
      if (interaction) interaction.editReply(`🟢 Java Connected to **${u.javaServer.ip}**`).catch(() => {});
    });

    mc.on('error', (e) => {
      console.log(`Java Error [${uid}]:`, e);
      if (!session.manualStop) handleJavaAutoReconnect(uid, interaction);
    });

    mc.on('end', () => {
      if (!session.manualStop) handleJavaAutoReconnect(uid, interaction);
    });

  } catch (err) {
    if (interaction) interaction.editReply(`❌ Java Connection Error: ${err.message}`);
    handleJavaAutoReconnect(uid, interaction);
  }
}

// ----------------- Interactions -----------------
client.on(Events.InteractionCreate, async (i) => {
  try {
    const blocked = denyIfWrongGuild(i);
    if (blocked) return;
    const uid = i.user.id;

    if (i.isChatInputCommand()) {
      if (i.commandName === "panel") return i.reply({ content: "🎛 **Bedrock Panel**", components: panelRow() });
      if (i.commandName === "java") return i.reply({ content: "☕ **Java Panel**", components: javaPanelRow() });
    }

    if (i.isButton()) {
      if (i.customId === "link") { await i.deferReply({ ephemeral: true }); return linkMicrosoft(uid, i); }
      if (i.customId === "start") { await i.deferReply({ ephemeral: true }); return startSession(uid, i); }
      if (i.customId === "stop") { stopSession(uid); return i.reply({ ephemeral: true, content: "⏹ Bedrock Stopped." }); }
      if (i.customId === "j_start") { await i.deferReply({ ephemeral: true }); return startJavaSession(uid, i); }
      if (i.customId === "j_stop") { stopJavaSession(uid); return i.reply({ ephemeral: true, content: "⏹ Java Stopped." }); }
      
      if (i.customId === "settings") {
        const u = getUser(uid);
        const modal = new ModalBuilder().setCustomId("settings_modal").setTitle("Bedrock Settings");
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("Server IP").setStyle(TextInputStyle.Short).setValue(u.server?.ip || "")),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.server?.port || 19132)))
        );
        return i.showModal(modal);
      }

      if (i.customId === "j_settings") {
        const u = getUser(uid);
        const modal = new ModalBuilder().setCustomId("j_settings_modal").setTitle("Java Settings");
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("j_ip").setLabel("Java IP").setStyle(TextInputStyle.Short).setValue(u.javaServer?.ip || "")),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("j_port").setLabel("Java Port").setStyle(TextInputStyle.Short).setValue(String(u.javaServer?.port || 25565)))
        );
        return i.showModal(modal);
      }
    }

    if (i.isStringSelectMenu()) {
      const u = getUser(uid);
      if (i.customId === "set_java_conn") { u.javaConnectionType = i.values[0]; save(); return i.reply({ ephemeral: true, content: `Java set to ${i.values[0]}` }); }
    }

    if (i.isModalSubmit()) {
      const u = getUser(uid);
      if (i.customId === "settings_modal") {
        u.server = { ip: i.fields.getTextInputValue("ip"), port: parseInt(i.fields.getTextInputValue("port")) };
        save();
        return i.reply({ ephemeral: true, content: "Bedrock Settings Saved." });
      }
      if (i.customId === "j_settings_modal") {
        u.javaServer = { ip: i.fields.getTextInputValue("j_ip"), port: parseInt(i.fields.getTextInputValue("j_port")) };
        save();
        return i.reply({ ephemeral: true, content: "Java Settings Saved." });
      }
    }
  } catch (e) { console.error(e); }
});

client.login(DISCORD_TOKEN);
