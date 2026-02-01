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

// ----------------- Environment Variables -----------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("❌ DISCORD_TOKEN missing from environment variables!");
  process.exit(1);
}

const ALLOWED_GUILD_ID = "1462335230345089254";

// ----------------- Storage Management -----------------
const DATA = path.join(__dirname, "data");
const AUTH_ROOT = path.join(DATA, "auth");
const STORE = path.join(DATA, "users.json");

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA);
if (!fs.existsSync(AUTH_ROOT)) fs.mkdirSync(AUTH_ROOT, { recursive: true });

let users = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, "utf8")) : {};

/**
 * Saves user data to the JSON store asynchronously.
 */
async function save() {
  try {
    await fs.promises.writeFile(STORE, JSON.stringify(users, null, 2));
  } catch (err) {
    console.error("Storage Save Error:", err);
  }
}

/**
 * Retrieves or initializes user configuration.
 */
function getUser(uid) {
  if (!users[uid]) users[uid] = {};
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

// ----------------- Runtime State -----------------
const sessions = new Map();
const pendingLink = new Map();

// ----------------- Discord Client Setup -----------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

/**
 * Safely replies to an interaction, handling expired or deferred states.
 */
async function safeReply(interaction, options) {
  try {
    if (interaction.replied || interaction.deferred) return await interaction.editReply(options);
    return await interaction.reply(options);
  } catch (e) {
    // Interaction likely expired or was deleted
  }
}

// ----------------- Global System Monitor (30s) -----------------
setInterval(() => {
  const mem = process.memoryUsage().heapUsed / 1024 / 1024;
  console.log(`\n--- [SYSTEM STATUS REPORT] ${new Date().toLocaleTimeString()} ---`);
  console.log(`Active Sessions: ${sessions.size}`);
  console.log(`Memory Usage: ${mem.toFixed(2)} MB`);
  
  sessions.forEach((s, uid) => {
    const status = s.connected ? "CONNECTED" : (s.isReconnecting ? "RECONNECTING" : "INITIALIZING");
    console.log(` > User [${uid}]: ${status} | Uptime: ${Math.floor((Date.now() - s.startedAt)/1000)}s`);
  });
  console.log(`----------------------------------------------------\n`);
}, 30000);

// ----------------- UI Component Generators -----------------
function panelRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("link").setLabel("🔑 Link Microsoft").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("unlink").setLabel("🗑 Unlink").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("start").setLabel("▶ Start Bot").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("stop").setLabel("⏹ Stop Bot").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("more").setLabel("➕ More Options").setStyle(ButtonStyle.Secondary)
    )
  ];
}

function versionRow(current = "auto") {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("set_version")
    .setPlaceholder("🌐 Select Bedrock Version")
    .addOptions(
      { label: "Auto-Detect", value: "auto", default: current === "auto" },
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
      { label: "Online (Microsoft Auth)", value: "online", default: current === "online" },
      { label: "Offline (Cracked/No Auth)", value: "offline", default: current === "offline" }
    );
  return new ActionRowBuilder().addComponents(menu);
}

// ----------------- Bedrock Protocol Engine -----------------
function cleanupSession(uid) {
  const s = sessions.get(uid);
  if (!s) return;
  if (s.timeout) clearTimeout(s.timeout);
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  if (s.afkInterval) clearInterval(s.afkInterval);
  if (s.waitForEntity) clearInterval(s.waitForEntity);
  try { s.client.close(); } catch {}
  sessions.delete(uid);
}

async function linkMicrosoft(uid, interaction) {
  if (pendingLink.has(uid)) {
    return safeReply(interaction, "⏳ Login in progress. Please use the previous code.");
  }

  const authDir = getUserAuthDir(uid);
  const u = getUser(uid);
  
  const flow = new Authflow(uid, authDir, {
    flow: "live",
    authTitle: Titles?.MinecraftNintendoSwitch || "Bedrock AFK Bot",
    deviceType: "Nintendo"
  }, async (data) => {
    const uri = data.verification_uri_complete || data.verification_uri || "https://www.microsoft.com/link";
    const code = data.user_code || "ERROR";
    
    const content = `🔐 **Microsoft Account Linking**\n\n1. Visit: [Microsoft Link](${uri})\n2. Enter code: \`${code}\`\n\n*This message will update once you have authenticated.*`;
    await safeReply(interaction, { 
        content: content, 
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("🌐 Open Login Page").setStyle(ButtonStyle.Link).setURL(uri))] 
    });
  });

  const p = (async () => {
    try {
      await flow.getMsaToken();
      u.linked = true;
      save();
      await interaction.followUp({ ephemeral: true, content: "✅ Microsoft account linked successfully!" }).catch(() => {});
    } catch (e) {
      await safeReply(interaction, `❌ Login failed: ${e.message}`);
    } finally {
      pendingLink.delete(uid);
    }
  })();
  pendingLink.set(uid, p);
}

function startSession(uid, interaction) {
  const u = getUser(uid);
  if (!u.server) return safeReply(interaction, "⚠ Please configure your server settings first.");

  // Check if a session is already running for this user
  const existing = sessions.get(uid);
  if (existing && !existing.isReconnecting) {
    return safeReply(interaction, "❌ **Bot already running for your account!** Please stop the existing bot before starting a new one.");
  }

  const { ip, port } = u.server;
  const authDir = getUserAuthDir(uid);

  const opts = {
    host: ip,
    port,
    connectTimeout: 45000,
    keepAlive: true,
    version: u.bedrockVersion === "auto" ? undefined : u.bedrockVersion
  };

  if (u.connectionType === "offline") {
    opts.username = u.offlineUsername || `AFK_${uid.slice(-4)}`;
    opts.offline = true;
  } else {
    opts.username = uid;
    opts.profilesFolder = authDir;
  }

  const mc = bedrock.createClient(opts);
  
  const sessionData = {
    client: mc,
    startedAt: Date.now(),
    manualStop: false,
    connected: false,
    isReconnecting: false,
    pos: { x: 0, y: 0, z: 0 },
    afkInterval: null,
    waitForEntity: null,
    timeout: null,
    reconnectTimer: null
  };
  sessions.set(uid, sessionData);

  // --- AUTHORITY SYNC ENGINE ---
  // Listens to server-forced movements (e.g., gravity, knockback, arrows)
  mc.on('move_player', (packet) => {
    if (packet.runtime_id === mc.entityId) {
      sessionData.pos = packet.position; 
    }
  });

  mc.on('start_game', (packet) => {
    sessionData.pos = packet.player_position;
  });

  mc.on('spawn', () => {
    sessionData.connected = true;
    clearTimeout(sessionData.timeout);
    safeReply(interaction, `🟢 Bot connected to **${ip}:${port}**\nPhysics synchronization and Anti-AFK are now active.`);

    // Initialize AFK logic once the player entity is ready
    sessionData.waitForEntity = setInterval(() => {
      if (!mc.entityId) return;
      clearInterval(sessionData.waitForEntity);
      sessionData.waitForEntity = null;
      
      sessionData.afkInterval = setInterval(() => {
        try {
          if (!mc.entityId) return;

          const yaw = Math.random() * 360;
          const pitch = (Math.random() * 10) - 5;
          const offset = (Math.random() - 0.5) * 0.1;
          
          sessionData.pos.x += offset;
          sessionData.pos.z += offset;

          // 1. Move Player Packet (Client-side request)
          mc.write("move_player", {
            runtime_id: mc.entityId,
            position: sessionData.pos,
            pitch, yaw, head_yaw: yaw,
            mode: 0, on_ground: true, ridden_runtime_id: 0, teleport: false
          });

          // 2. Player Auth Input (Server-side validation)
          mc.write("player_auth_input", {
            pitch, yaw, head_yaw: yaw,
            position: sessionData.pos,
            move_vector: { x: offset, z: offset },
            input_data: { _value: 0n, is_sneaking: false, is_sprinting: false },
            input_mode: 'mouse', play_mode: 'normal', tick: 0n, delta: { x: offset, y: 0, z: offset }
          });
        } catch (e) {}
      }, 30000); // 30s cycle for high reliability
    }, 1000);
  });

  sessionData.timeout = setTimeout(() => {
    if (!sessionData.connected) {
      mc.close();
      handleReconnect(uid, interaction);
    }
  }, 47000);

  mc.on("error", (err) => {
    console.error(`[Session ${uid}] Error:`, err.message);
    handleReconnect(uid, interaction);
  });
  
  mc.on("close", () => handleReconnect(uid, interaction));
}

function handleReconnect(uid, interaction) {
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
  }, 30000); // Strict 30-second delay
}

// ----------------- Interaction Listeners -----------------
client.on(Events.InteractionCreate, async (i) => {
  if (!i.inGuild() || i.guildId !== ALLOWED_GUILD_ID) return;
  const uid = i.user.id;

  try {
    if (i.isChatInputCommand() && i.commandName === "panel") {
      return i.reply({ content: "🎛 **Bedrock AFK Management Console**", components: panelRow() });
    }

    if (i.isButton()) {
      if (i.customId === "link") { await i.deferReply({ ephemeral: true }); return linkMicrosoft(uid, i); }
      if (i.customId === "unlink") { unlinkMicrosoft(uid); return i.reply({ ephemeral: true, content: "🗑 Microsoft account unlinked." }); }
      if (i.customId === "start") { await i.deferReply({ ephemeral: true }); return startSession(uid, i); }
      if (i.customId === "stop") { 
          const s = sessions.get(uid);
          if (s) { s.manualStop = true; cleanupSession(uid); return i.reply({ ephemeral: true, content: "⏹ Bot stopped and session cleared." }); }
          return i.reply({ ephemeral: true, content: "No active bot found for your account." });
      }
      if (i.customId === "settings") {
        const u = getUser(uid);
        const modal = new ModalBuilder().setCustomId("settings_modal").setTitle("⚙ Server Configuration");
        
        const ip = new TextInputBuilder().setCustomId("ip").setLabel("Server Address (IP/Host)").setStyle(TextInputStyle.Short).setRequired(true).setValue(u.server?.ip || "");
        const port = new TextInputBuilder().setCustomId("port").setLabel("Server Port (Default 19132)").setStyle(TextInputStyle.Short).setRequired(true).setValue(String(u.server?.port || 19132));
        const off = new TextInputBuilder().setCustomId("off").setLabel("Offline Username (Cracked)").setStyle(TextInputStyle.Short).setRequired(false).setValue(u.offlineUsername || "");
        
        modal.addComponents(
            new ActionRowBuilder().addComponents(ip), 
            new ActionRowBuilder().addComponents(port), 
            new ActionRowBuilder().addComponents(off)
        );
        return i.showModal(modal);
      }
      if (i.customId === "more") {
        const u = getUser(uid);
        return i.reply({ ephemeral: true, content: "➕ **Advanced Settings**", components: [versionRow(u.bedrockVersion), connRow(u.connectionType)] });
      }
    }

    if (i.isStringSelectMenu()) {
      const u = getUser(uid);
      if (i.customId === "set_version") { u.bedrockVersion = i.values[0]; save(); return i.reply({ ephemeral: true, content: `✅ Protocol version set to: **${u.bedrockVersion}**` }); }
      if (i.customId === "set_conn") { u.connectionType = i.values[0]; save(); return i.reply({ ephemeral: true, content: `✅ Connection mode updated to: **${u.connectionType}**` }); }
    }

    if (i.isModalSubmit() && i.customId === "settings_modal") {
      const ip = i.fields.getTextInputValue("ip").trim();
      const port = parseInt(i.fields.getTextInputValue("port").trim(), 10);
      const off = i.fields.getTextInputValue("off").trim();
      
      if (!ip || isNaN(port)) return i.reply({ ephemeral: true, content: "❌ Invalid Server Address or Port." });
      
      const u = getUser(uid);
      u.server = { ip, port };
      if (off) u.offlineUsername = off;
      save();
      return i.reply({ ephemeral: true, content: `✅ Configuration saved for **${ip}:${port}**` });
    }
  } catch (e) { 
    console.error("Interaction Error:", e); 
  }
});

client.once("ready", async () => {
  console.log(`🟢 System Online. Logged in as: ${client.user.tag}`);
  // Register Slash Commands
  await client.application.commands.set([
    new SlashCommandBuilder()
        .setName("panel")
        .setDescription("Open the AFK Bot Management Panel")
  ]);
});

// Global Error Handling to prevent crashes
process.on("unhandledRejection", (e) => console.error("Unhandled Promise Rejection:", e));
process.on("uncaughtException", (e) => console.error("Uncaught Exception:", e));

client.login(DISCORD_TOKEN);

