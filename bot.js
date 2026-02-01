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

// ----------------- CONFIGURATION -----------------
const apiKey = ""; // Environment provides the key automatically
const appId = typeof __app_id !== 'undefined' ? __app_id : 'bedrock-afk-ultimate';
const ALLOWED_GUILD_ID = "1462335230345089254";
const AI_CHANNELS = ["1462398161074000143", "1462398206838182123", "1462432034147536956"];

// ----------------- STORAGE -----------------
const DATA = path.join(__dirname, "data");
const AUTH_ROOT = path.join(DATA, "auth");
const STORE = path.join(DATA, "users.json");

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA);
if (!fs.existsSync(AUTH_ROOT)) fs.mkdirSync(AUTH_ROOT, { recursive: true });

let users = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, "utf8")) : {};
let strikeMap = new Map(); // Tracks AI moderation strikes {userId: {count: 0, lastReset: timestamp}}

async function save() {
  try {
    await fs.promises.writeFile(STORE, JSON.stringify(users, null, 2));
  } catch (err) {
    console.error("Storage Save Error:", err);
  }
}

function getUser(uid) {
  if (!users[uid]) users[uid] = {};
  if (!users[uid].connectionType) users[uid].connectionType = "online";
  if (!users[uid].bedrockVersion) users[uid].bedrockVersion = "auto";
  if (!users[uid].offlineUsername) users[uid].offlineUsername = `AFK_${uid.slice(-4)}`;
  if (users[uid].shouldBeOnline === undefined) users[uid].shouldBeOnline = false;
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

// ----------------- GEMINI AI LOGIC -----------------
async function geminiRequest(prompt, systemInstruction) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    systemInstruction: { parts: [{ text: systemInstruction }] }
  };

  let delay = 1000;
  for (let i = 0; i < 5; i++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const result = await response.json();
      return result.candidates?.[0]?.content?.parts?.[0]?.text;
    } catch (e) {
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
    }
  }
  return null;
}

async function handleAIModeration(message) {
  if (!AI_CHANNELS.includes(message.channel.id) || message.author.bot) return;

  const systemPrompt = `You are a moderator for a Discord server. 
  RULES:
  1. Casual swearing is allowed and should be ignored.
  2. Racism, direct insults/bullying, and serious threats are STRICTLY FORBIDDEN.
  3. If a message violates Rule 2, respond ONLY with the word "BLOCK".
  4. If a user asks for help or assistance with the AFK bot, respond ONLY with the word "HELP".
  5. Otherwise, respond ONLY with "PASS".`;

  const result = await geminiRequest(message.content, systemPrompt);

  if (result?.includes("BLOCK")) {
    const uid = message.author.id;
    let data = strikeMap.get(uid) || { count: 0, lastReset: Date.now() };
    
    // Reset strikes every 24 hours
    if (Date.now() - data.lastReset > 86400000) data = { count: 0, lastReset: Date.now() };
    
    data.count++;
    strikeMap.set(uid, data);

    try {
      await message.delete();
      if (data.count === 3) {
        message.channel.send(`<@${uid}> One more time and I'll ban your ass ⛔️`);
      } else {
        message.channel.send(`<@${uid}> Watch your mouth! 😳`);
      }
    } catch (e) {}
    return;
  }

  if (result?.includes("HELP")) {
    const aiHelp = await geminiRequest(
      `User asked: "${message.content}". Provide a witty, funny, but helpful response in English. You are an AFK Bot.`,
      "You are a helpful and funny AFK Bot assistant."
    );
    if (aiHelp) message.reply(aiHelp);
  }
}

// ----------------- RUNTIME & DISCORD -----------------
const sessions = new Map();
const pendingLink = new Map();
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

async function safeReply(interaction, options) {
  try {
    if (interaction.replied || interaction.deferred) return await interaction.editReply(options);
    return await interaction.reply(options);
  } catch (e) {}
}

// ----------------- UI BUILDERS -----------------
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
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("set_version")
      .setPlaceholder("🌐 Bedrock Version")
      .addOptions(
        { label: "Auto", value: "auto", default: current === "auto" },
        { label: "1.21.x", value: "1.21.x", default: current === "1.21.x" },
        { label: "1.20.x", value: "1.20.x", default: current === "1.20.x" },
        { label: "1.19.x", value: "1.19.x", default: current === "1.19.x" }
      )
  );
}

function connRow(current = "online") {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("set_conn")
      .setPlaceholder("🔌 Connection Type")
      .addOptions(
        { label: "Online (Microsoft)", value: "online", default: current === "online" },
        { label: "Offline (Cracked)", value: "offline", default: current === "offline" }
      )
  );
}

// ----------------- HYPER-RELIABLE HEARTBEAT (15s) -----------------
setInterval(async () => {
  const mem = process.memoryUsage().heapUsed / 1024 / 1024;
  console.log(`\n--- [HEARTBEAT] ${new Date().toLocaleTimeString()} ---`);
  console.log(`Memory: ${mem.toFixed(2)}MB | Active Sessions: ${sessions.size}`);
  
  for (const uid of Object.keys(users)) {
    const u = users[uid];
    if (u.shouldBeOnline) {
      const s = sessions.get(uid);
      if (!s || (!s.connected && !s.isReconnecting)) {
        console.log(`[REJOIN] Bot for user ${uid} should be online. Force reconnecting...`);
        startSession(uid, null);
      }
    }
  }
  console.log(`------------------------------------\n`);
}, 15000);

// ----------------- BEDROCK CORE -----------------
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

function startSession(uid, interaction) {
  const u = getUser(uid);
  if (!u.server) {
    if (interaction) safeReply(interaction, "⚠ Configure server settings first.");
    return;
  }

  const existing = sessions.get(uid);
  if (existing && existing.connected) {
    if (interaction) safeReply(interaction, "❌ Bot already running for your account!");
    return;
  }

  if (interaction) safeReply(interaction, `⏳ **Connecting to ${u.server.ip}:${u.server.port}...**`);

  const authDir = getUserAuthDir(uid);
  const opts = {
    host: u.server.ip,
    port: u.server.port,
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
  
  const currentSession = {
    client: mc,
    startedAt: Date.now(),
    manualStop: false,
    connected: false,
    isReconnecting: false,
    pos: { x: 0, y: 0, z: 0 },
    tick: 0n,
    afkInterval: null,
    waitForEntity: null,
    timeout: null
  };
  sessions.set(uid, currentSession);

  // Set persistence flag
  u.shouldBeOnline = true;
  save();

  // Authority Sync
  mc.on('move_player', (packet) => {
    if (packet.runtime_id === mc.entityId) currentSession.pos = packet.position;
  });

  mc.on('spawn', () => {
    currentSession.connected = true;
    if (interaction) safeReply(interaction, `🟢 **Connected to ${u.server.ip}**\nPhysics sync & Anti-AFK initialized.`);

    currentSession.waitForEntity = setInterval(() => {
      if (!mc.entityId) return;
      clearInterval(currentSession.waitForEntity);
      currentSession.waitForEntity = null;

      currentSession.afkInterval = setInterval(() => {
        try {
          if (!mc.entityId) return;
          currentSession.tick++;
          
          const yaw = Math.random() * 360;
          const pitch = (Math.random() * 14) - 7;
          
          // Realistic Sway Physics (Sin/Cos oscillation)
          const moveX = Math.sin(Number(currentSession.tick) / 6) * 0.09;
          const moveZ = Math.cos(Number(currentSession.tick) / 6) * 0.09;
          
          currentSession.pos.x += moveX;
          currentSession.pos.z += moveZ;

          mc.write("move_player", {
            runtime_id: mc.entityId,
            position: currentSession.pos,
            pitch, yaw, head_yaw: yaw,
            mode: 0, on_ground: true, ridden_runtime_id: 0, teleport: false
          });

          mc.write("player_auth_input", {
            pitch, yaw, head_yaw: yaw,
            position: currentSession.pos,
            move_vector: { x: moveX, z: moveZ },
            input_data: { _value: 0n, is_sneaking: false, is_sprinting: false },
            input_mode: 'mouse', play_mode: 'normal', tick: currentSession.tick, delta: { x: moveX, y: 0, z: moveZ }
          });
        } catch (e) {}
      }, 25000);
    }, 1000);
  });

  mc.on("error", (e) => {
    console.error(`[MC ERR ${uid}]`, e.message);
    currentSession.connected = false;
  });

  mc.on("close", () => {
    currentSession.connected = false;
    console.log(`[MC CLOSE ${uid}] Disconnected. Rejoin engine will handle reconnection.`);
  });
}

// ----------------- INTERACTION LISTENERS -----------------
client.on(Events.MessageCreate, handleAIModeration);

client.on(Events.InteractionCreate, async (i) => {
  if (!i.inGuild() || i.guildId !== ALLOWED_GUILD_ID) return;
  const uid = i.user.id;

  try {
    if (i.isChatInputCommand() && i.commandName === "panel") {
      return i.reply({ content: "🎛 **AFK Bot Professional Management**", components: panelRow() });
    }

    if (i.isButton()) {
      if (i.customId === "link") {
        await i.deferReply({ ephemeral: true });
        const authDir = getUserAuthDir(uid);
        const flow = new Authflow(uid, authDir, {
          flow: "live",
          authTitle: Titles?.MinecraftNintendoSwitch || "Bedrock AFK Bot",
          deviceType: "Nintendo"
        }, async (data) => {
          const uri = data.verification_uri_complete || data.verification_uri;
          await safeReply(i, { content: `🔐 **Microsoft Link Required**\nURL: [Click Here](${uri})\nCode: \`${data.user_code}\`` });
        });
        try { 
          await flow.getMsaToken(); 
          getUser(uid).linked = true; 
          save(); 
          i.followUp({ ephemeral: true, content: "✅ Microsoft account linked!" });
        } catch (e) {}
        return;
      }

      if (i.customId === "unlink") { unlinkMicrosoft(uid); return i.reply({ ephemeral: true, content: "🗑 Unlinked." }); }
      if (i.customId === "start") return startSession(uid, i);
      if (i.customId === "stop") {
        const u = getUser(uid);
        u.shouldBeOnline = false;
        save();
        cleanupSession(uid);
        return i.reply({ ephemeral: true, content: "⏹ Bot stopped and auto-rejoin disabled." });
      }

      if (i.customId === "settings") {
        const u = getUser(uid);
        const modal = new ModalBuilder().setCustomId("settings_modal").setTitle("⚙ Server Settings");
        const ip = new TextInputBuilder().setCustomId("ip").setLabel("Server IP").setStyle(TextInputStyle.Short).setRequired(true).setValue(u.server?.ip || "");
        const port = new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setRequired(true).setValue(String(u.server?.port || 19132));
        const off = new TextInputBuilder().setCustomId("off").setLabel("Offline Username").setStyle(TextInputStyle.Short).setRequired(false).setValue(u.offlineUsername || "");
        
        modal.addComponents(
          new ActionRowBuilder().addComponents(ip),
          new ActionRowBuilder().addComponents(port),
          new ActionRowBuilder().addComponents(off)
        );
        return i.showModal(modal);
      }

      if (i.customId === "more") {
        const u = getUser(uid);
        return i.reply({ ephemeral: true, content: "➕ **Advanced Configuration**", components: [versionRow(u.bedrockVersion), connRow(u.connectionType)] });
      }
    }

    if (i.isStringSelectMenu()) {
      const u = getUser(uid);
      if (i.customId === "set_version") { u.bedrockVersion = i.values[0]; save(); return i.reply({ ephemeral: true, content: `✅ Version set to ${i.values[0]}` }); }
      if (i.customId === "set_conn") { u.connectionType = i.values[0]; save(); return i.reply({ ephemeral: true, content: `✅ Connection type set to ${i.values[0]}` }); }
    }

    if (i.isModalSubmit() && i.customId === "settings_modal") {
      const ip = i.fields.getTextInputValue("ip").trim();
      const port = parseInt(i.fields.getTextInputValue("port").trim(), 10);
      const off = i.fields.getTextInputValue("off").trim();
      const u = getUser(uid);
      u.server = { ip, port };
      if (off) u.offlineUsername = off;
      save();
      return i.reply({ ephemeral: true, content: `✅ Settings saved for ${ip}:${port}` });
    }
  } catch (e) { console.error("Interaction Error:", e); }
});

client.once("ready", async () => {
  console.log(`🟢 System Online: ${client.user.tag}`);
  await client.application.commands.set([new SlashCommandBuilder().setName("panel").setDescription("Open the AFK Management Panel")]);
});

process.on("unhandledRejection", (e) => console.error("Unhandled Promise Rejection:", e));
process.on("uncaughtException", (e) => console.error("Uncaught Exception:", e));

client.login(DISCORD_TOKEN);

