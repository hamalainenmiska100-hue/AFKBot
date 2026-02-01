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
const { Authflow, Titles } = require("prismarine-auth");
const fs = require("fs");
const path = require("path");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("❌ DISCORD_TOKEN missing");
  process.exit(1);
}

const ALLOWED_GUILD_ID = "1462335230345089254";

// ----------------- Storage (Improved with Async) -----------------
const DATA = path.join(__dirname, "data");
const AUTH_ROOT = path.join(DATA, "auth");
const STORE = path.join(DATA, "users.json");

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA);
if (!fs.existsSync(AUTH_ROOT)) fs.mkdirSync(AUTH_ROOT, { recursive: true });

let users = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, "utf8")) : {};

async function save() {
  try {
    await fs.promises.writeFile(STORE, JSON.stringify(users, null, 2));
  } catch (err) {
    console.error("Save error:", err);
  }
}

function getUser(uid) {
  if (!users[uid]) users[uid] = {};
  if (!users[uid].delayMs) users[uid].delayMs = 5000;
  if (!users[uid].connectionType) users[uid].connectionType = "online";
  if (!users[uid].bedrockVersion) users[uid].bedrockVersion = "auto";
  if (!users[uid].offlineUsername) users[uid].offlineUsername = `AFK_${uid.slice(-4)}`;
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
const pendingLink = new Map();
const lastMsa = new Map();

// ----------------- Discord client -----------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// Helper to safe-reply to interactions
async function safeReply(interaction, options) {
  try {
    if (interaction.replied || interaction.deferred) {
      return await interaction.editReply(options);
    }
    return await interaction.reply(options);
  } catch (e) {
    // Interaction expired or failed
  }
}

function denyIfWrongGuild(i) {
  if (!i.inGuild() || i.guildId !== ALLOWED_GUILD_ID) {
    const msg = "This bot cannot be used in this server ⛔️";
    safeReply(i, { ephemeral: true, content: msg });
    return true;
  }
  return false;
}

// ----------------- UI helpers -----------------
function panelRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("link").setLabel("🔑 Link Microsoft").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("unlink").setLabel("🗑 Unlink Microsoft").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("start").setLabel("▶ Start").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("stop").setLabel("⏹ Stop").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("more").setLabel("➕ More").setStyle(ButtonStyle.Secondary)
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

// ----------------- Global Health Logger (30s) -----------------
setInterval(() => {
  const activeCount = sessions.size;
  const memory = process.memoryUsage().heapUsed / 1024 / 1024;
  
  console.log(`--- [SYSTEM STATUS REPORT] ---`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Active Bots: ${activeCount}`);
  console.log(`Memory Usage: ${memory.toFixed(2)} MB`);
  
  sessions.forEach((s, uid) => {
    const status = s.connected ? "CONNECTED" : (s.isReconnecting ? "RECONNECTING" : "CONNECTING");
    console.log(` > User [${uid}]: ${status} | Since: ${new Date(s.startedAt).toLocaleTimeString()}`);
  });
  console.log(`------------------------------`);
}, 30000);

// ----------------- Microsoft link -----------------
async function linkMicrosoft(uid, interaction) {
  if (pendingLink.has(uid)) {
    await safeReply(interaction, "⏳ Login already in progress. Use the last code.");
    return;
  }

  const authDir = getUserAuthDir(uid);
  const u = getUser(uid);
  let codeShown = false;

  const flow = new Authflow(
    uid,
    authDir,
    {
      flow: "live",
      authTitle: Titles?.MinecraftNintendoSwitch || "Bedrock AFK Bot",
      deviceType: "Nintendo"
    },
    async (data) => {
      const uri = data.verification_uri_complete || data.verification_uri || "https://www.microsoft.com/link";
      const code = data.user_code || "(no code)";
      lastMsa.set(uid, { uri, code, at: Date.now() });
      codeShown = true;

      const msg =
        `🔐 **Microsoft login required**\n\n` +
        `👉 ${uri}\n\n` +
        `Your code: \`${code}\`\n\n` +
        `⚠ **IMPORTANT:** Use a *second* Microsoft account.\n\n` +
        `Come back here after login.`;

      await safeReply(interaction, { content: msg, components: msaComponents(uri) });
    }
  );

  const p = (async () => {
    try {
      if (!codeShown) await safeReply(interaction, "⏳ Requesting Microsoft login code…");
      await flow.getMsaToken();
      u.linked = true;
      save();
      await interaction.followUp({ ephemeral: true, content: "✅ Microsoft account linked!" }).catch(() => {});
    } catch (e) {
      await safeReply(interaction, `❌ Microsoft login failed:\n${String(e?.message || e)}`);
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
  if (s.waitForEntity) clearInterval(s.waitForEntity);
  if (s.afkInterval) clearInterval(s.afkInterval);
  
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

function startSession(uid, interaction) {
  const u = getUser(uid);
  if (!u.server) {
    safeReply(interaction, "⚠ Set settings first.");
    return;
  }
  
  const existing = sessions.get(uid);
  if (existing && !existing.isReconnecting) {
    safeReply(interaction, "⚠ You already have a running bot.");
    return;
  }

  const { ip, port } = u.server;
  const authDir = getUserAuthDir(uid);

  const opts = {
    host: ip,
    port,
    connectTimeout: 47000,
    keepAlive: true,
    version: u.bedrockVersion === "auto" ? undefined : u.bedrockVersion
  };

  if (u.connectionType === "offline") {
    opts.username = u.offlineUsername || `AFK_${uid.slice(-4)}`;
    opts.offline = true;
  } else {
    opts.username = uid;
    opts.offline = false;
    opts.profilesFolder = authDir;
  }

  const mc = bedrock.createClient(opts);
  
  // Setup session object
  const sessionData = {
    client: mc,
    timeout: null,
    waitForEntity: null,
    afkInterval: null,
    reconnectTimer: null,
    startedAt: Date.now(),
    manualStop: false,
    connected: false,
    isReconnecting: false
  };
  
  sessions.set(uid, sessionData);

  // Authority & Physics Sync
  let lastPos = { x: 0, y: 0, z: 0 };
  mc.on('move_player', (packet) => {
    if (packet.runtime_id === mc.entityId) {
      lastPos = packet.position;
    }
  });

  // Entity search & AFK Logic
  sessionData.waitForEntity = setInterval(() => {
    if (!mc.entityId) return;
    clearInterval(sessionData.waitForEntity);
    sessionData.waitForEntity = null;

    let moveToggle = false;
    sessionData.afkInterval = setInterval(() => {
      try {
        if (!mc.entityId) return;

        const yaw = Math.random() * 360;
        const pitch = (Math.random() * 20) - 10;
        
        // Minor movement for authority
        const offset = moveToggle ? 0.05 : -0.05;
        const targetPos = { x: lastPos.x + offset, y: lastPos.y, z: lastPos.z };
        moveToggle = !moveToggle;

        // 1. Move Player Packet
        mc.write("move_player", {
          runtime_id: mc.entityId,
          position: targetPos,
          pitch: pitch,
          yaw: yaw,
          head_yaw: yaw,
          mode: 0,
          on_ground: true,
          ridden_runtime_id: 0,
          teleport: false
        });

        // 2. Player Auth Input (Crucial for modern servers)
        mc.write("player_auth_input", {
          pitch: pitch,
          yaw: yaw,
          position: targetPos,
          move_vector: { x: 0, z: 0 },
          head_yaw: yaw,
          input_data: {
            _value: 0n,
            is_sneaking: false,
            is_sprinting: false
          },
          input_mode: 'mouse',
          play_mode: 'normal',
          tick: 0n,
          delta: { x: 0, y: 0, z: 0 }
        });
      } catch (e) {}
    }, 45000); // 45s interval
  }, 1000);

  sessionData.timeout = setTimeout(() => {
    if (!sessionData.connected) {
      safeReply(interaction, "❌ Connection timeout. Retrying in 30s...");
      mc.close();
    }
  }, 47000);

  mc.on("spawn", () => {
    sessionData.connected = true;
    clearTimeout(sessionData.timeout);
    safeReply(interaction, `🟢 Connected to **${ip}:${port}** (Anti-AFK active)`);
  });

  mc.on("error", () => handleAutoReconnect(uid, interaction));
  mc.on("close", () => handleAutoReconnect(uid, interaction));
}

function handleAutoReconnect(uid, interaction) {
  const s = sessions.get(uid);
  if (!s || s.manualStop || s.reconnectTimer) return;

  s.isReconnecting = true;
  s.connected = false;
  
  if (s.afkInterval) clearInterval(s.afkInterval);
  if (s.waitForEntity) clearInterval(s.waitForEntity);

  s.reconnectTimer = setTimeout(() => {
    if (sessions.has(uid) && !s.manualStop) {
      s.reconnectTimer = null;
      startSession(uid, interaction);
    }
  }, 30000); // Strict 30s reconnect
}

// ----------------- Interactions -----------------
client.on(Events.InteractionCreate, async (i) => {
  try {
    if (denyIfWrongGuild(i)) return;
    const uid = i.user.id;

    if (i.isChatInputCommand()) {
      if (i.commandName === "panel") {
        return i.reply({
          content: "🎛 **Bedrock AFK Panel**",
          components: panelRow()
        });
      }
    }

    if (i.isButton()) {
      if (i.customId === "link") {
        await i.deferReply({ ephemeral: true });
        return linkMicrosoft(uid, i);
      }

      if (i.customId === "unlink") {
        unlinkMicrosoft(uid);
        return i.reply({ ephemeral: true, content: "🗑 Microsoft account unlinked." });
      }

      if (i.customId === "settings") {
        const u = getUser(uid);
        const modal = new ModalBuilder().setCustomId("settings_modal").setTitle("⚙ Bedrock Settings");
        
        const ip = new TextInputBuilder().setCustomId("ip").setLabel("Server IP").setStyle(TextInputStyle.Short).setRequired(true).setValue(u.server?.ip || "");
        const port = new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setRequired(true).setValue(String(u.server?.port || 19132));
        const offlineUser = new TextInputBuilder().setCustomId("offline").setLabel("Offline Name").setStyle(TextInputStyle.Short).setRequired(false).setValue(u.offlineUsername || "");

        modal.addComponents(
          new ActionRowBuilder().addComponents(ip),
          new ActionRowBuilder().addComponents(port),
          new ActionRowBuilder().addComponents(offlineUser)
        );
        return i.showModal(modal);
      }

      if (i.customId === "start") {
        await i.deferReply({ ephemeral: true });
        return startSession(uid, i);
      }

      if (i.customId === "stop") {
        const ok = stopSession(uid);
        return i.reply({ ephemeral: true, content: ok ? "⏹ Stopped." : "No bots running." });
      }

      if (i.customId === "more") {
        const u = getUser(uid);
        return i.reply({
          ephemeral: true,
          content: "➕ **More options**",
          components: [versionRow(u.bedrockVersion), connRow(u.connectionType)]
        });
      }
    }

    if (i.isStringSelectMenu()) {
      const u = getUser(uid);
      if (i.customId === "set_version") {
        u.bedrockVersion = i.values[0];
        save();
        return i.reply({ ephemeral: true, content: `Version: ${u.bedrockVersion}` });
      }
      if (i.customId === "set_conn") {
        u.connectionType = i.values[0];
        save();
        return i.reply({ ephemeral: true, content: `Connection: ${u.connectionType}` });
      }
    }

    if (i.isModalSubmit() && i.customId === "settings_modal") {
      const ip = i.fields.getTextInputValue("ip").trim();
      const port = parseInt(i.fields.getTextInputValue("port").trim(), 10);
      const offline = i.fields.getTextInputValue("offline").trim();

      if (!ip || isNaN(port) || port < 1 || port > 65535) {
        return i.reply({ ephemeral: true, content: "Invalid IP or Port." });
      }

      const u = getUser(uid);
      u.server = { ip, port };
      if (offline) u.offlineUsername = offline;
      save();
      return i.reply({ ephemeral: true, content: `Saved: ${ip}:${port}` });
    }

  } catch (e) {
    console.error("Interaction error:", e);
  }
});

process.on("unhandledRejection", (e) => console.error("Unhandled Rejection:", e));
process.on("uncaughtException", (e) => console.error("Uncaught Exception:", e));

client.login(DISCORD_TOKEN);

