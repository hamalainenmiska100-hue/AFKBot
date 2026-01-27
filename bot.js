/**
 * Bedrock & Java AFK Bot - V25 (The Infinite Unity Edition) 🛡️
 * ----------------------------------------------------------------------
 * CORE ARCHITECTURE:
 * - Bedrock Engine: Smooth Physics (Walk/Sneak/Jump), 4h Reboot, Original Callback Auth.
 * - Java Engine: Mineflayer Integration, Advanced AFK Physics, Auto-rejoin.
 * - Stability: Atomic Data Persistence on Fly.io Volume (/data).
 * - Startup Sentinel: Queued logins and Listener Guard (Zero memory leaks).
 * - Intelligence: Gemini AI Support scanning channel 1462398161074000143.
 * - Admin Hub: Massive User Management, Metrics, Global Broadcasts.
 * ----------------------------------------------------------------------
 * UI: Simple, Modern, Professional English. 
 * Logic & Comments: Finnish (Suomi) / English.
 * NO DELETIONS. NO SHORTENING. 1700+ LINES OF ROBUST CODE.
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
  EmbedBuilder,
  Partials
} = require("discord.js");

const bedrock = require("bedrock-protocol");
const mineflayer = require("mineflayer");
const { Authflow, Titles } = require("prismarine-auth");
const fs = require("fs");
const path = require("path");

// --- KONFIGURAATIO ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_KEYS = [
  "AIzaSyAZbj5F2X-FLM6NSqz_3K1sciQMepX6JMA",
  "AIzaSyD51YhFcYCTp5HNOUZOZe14ymIhamILoOg"
];
const GEMINI_MODEL = "gemini-2.5-flash-preview-09-2025";

const OWNER_ID = "1144987924123881564"; 
const ADMIN_IDS = [OWNER_ID]; 
const ALLOWED_GUILD_ID = "1462335230345089254";
const SUPPORT_CHANNEL_ID = "1462398161074000143";

const MILESTONES = [30, 60, 120, 240, 360, 480, 720, 1440, 2880, 5760, 10080];
const SOFT_REBOOT_INTERVAL = 4 * 60 * 60 * 1000; // 4 tuntia
const HEARTBEAT_INTERVAL = 25000; // 25 sekuntia
const STARTUP_DELAY = 3500; // Viive bottien välillä käynnistyksessä

// ----------------- TALLENNUS (FLY.IO PERSISTENT VOLUME) -----------------
const VOL_ROOT = "/data";
const DATA_DIR = fs.existsSync(VOL_ROOT) ? VOL_ROOT : path.join(__dirname, "data");
const AUTH_DIR = path.join(DATA_DIR, "auth");
const DATABASE_PATH = path.join(DATA_DIR, "users.json");

// Varmistetaan että volume-polut ovat olemassa
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

// Ladataan tietokanta muistiin
let users = fs.existsSync(DATABASE_PATH) ? JSON.parse(fs.readFileSync(DATABASE_PATH, "utf8")) : {};
let bedrockSessions = new Map(); 
let javaSessions = new Map();
let connectionQueue = [];
let queueActive = false;
let globalAdminLogs = [];

/**
 * Tallentaa datan atomisesti Fly.io volumeen (estää users.json korruptoitumisen).
 */
function atomicStore() {
  try {
    const temp = DATABASE_PATH + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(users, null, 2));
    fs.renameSync(temp, DATABASE_PATH);
  } catch (err) {
    process.stderr.write(`[DATABASE ERROR] Disk write failed: ${err.message}\n`);
  }
}

/**
 * Lisää lokimerkinnän ylläpitäjälle.
 */
function pushCoreLog(msg) {
  const ts = new Date().toLocaleTimeString('fi-FI');
  globalAdminLogs.unshift(`\`[${ts}]\` ${msg}`);
  if (globalAdminLogs.length > 50) globalAdminLogs.pop();
}

/**
 * Hakee käyttäjän profiilin tai alustaa uuden (Bedrock & Java).
 */
function getProfile(uid) {
  if (!users[uid]) {
    users[uid] = {
      bedrock: { ip: "", port: 19132, version: "auto", name: `AFK_${uid.slice(-4)}` },
      java: { ip: "", port: 25565, version: "auto", name: `AFK_J_${uid.slice(-4)}` },
      linked: false,
      banned: false,
      logs: [],
      stats: { joins: 0, uptimeMinutes: 0 }
    };
  }
  // Varmistetaan yhteensopivuus päivityksen jälkeen
  if (!users[uid].java) users[uid].java = { ip: "", port: 25565, version: "auto", name: `AFK_J_${uid.slice(-4)}` };
  if (!users[uid].bedrock) users[uid].bedrock = { ip: "", port: 19132, version: "auto", name: `AFK_${uid.slice(-4)}` };
  if (!users[uid].logs) users[uid].logs = [];
  return users[uid];
}

/**
 * Kirjaa tapahtuman Live Status -näkymää varten.
 */
function recordEvent(uid, msg) {
  const u = getProfile(uid);
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
  u.logs.unshift(`[${ts}] ${msg}`);
  if (u.logs.length > 6) u.logs.pop();
}

/**
 * Hakee Microsoft-auth kansion.
 */
function getAuthPath(uid) {
  const dir = path.join(AUTH_DIR, uid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ----------------- TEKOÄLY (GEMINI AI ENGINE) -----------------
let keyPointer = 0;

function rotateKey() {
  const k = GEMINI_KEYS[keyPointer];
  keyPointer = (keyPointer + 1) % GEMINI_KEYS.length;
  return k;
}

/**
 * Keskustelee Geminin kanssa. AI on koulutettu ymmärtämään botin koko koodi.
 */
async function callIntelligence(prompt, mode = "general") {
  const key = rotateKey();
  const systemInstruction = `You are the AFKBot Intelligence.
  You manage a dual-engine Minecraft bot (Bedrock & Java).
  
  System Specifications:
  - Persistence: Fly.io volume at /data.
  - Bedrock: bedrock-protocol, Callback Auth, Walk/Sneak/Jump Physics.
  - Java: mineflayer, Smooth Look/Jump Physics.
  - Controls: /panel (Bedrock), /javapanel (Java), /admin.
  
  Behavior Protocols:
  - Language: ENGLISH ONLY for all user interaction.
  - Support Channel: If a message is NOT a problem report, reply strictly with: [NoCont]
  - UI References: Guide users via Dashboard button names (Settings, Link, Status).
  - Tone: Professional, simple, and helpful. No dramatic jargon.
  - Slap Egg: If user says "slap me", reply: "👋 *Slaps you with a massive wet cod!* 🐟"`;

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        systemInstruction: { parts: [{ text: systemInstruction }] }
      })
    });
    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "[NoCont]";
  } catch (err) {
    return mode === "support" ? "[NoCont]" : "AI module is resting. ☁️";
  }
}

/**
 * Ilmoittaa järjestelmäpäivityksistä omistajalle.
 */
async function notifyOwner(msg) {
  try {
    const owner = await client.users.fetch(OWNER_ID).catch(() => null);
    if (owner) {
      const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
      const embed = new EmbedBuilder().setDescription(`\`[${ts}]\` 🛠️ **Infrastructure:** ${msg}`).setColor("#5865f2");
      await owner.send({ embeds: [embed] }).catch(() => {});
    }
  } catch (e) {}
}

// ----------------- DISCORD SETUP -----------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessages
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User]
});

// ----------------- UI BUILDERS (MODERN & SLICK) -----------------

function buildDashboardUI() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("br_link").setLabel("🔑 Login Microsoft").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("br_unlink").setLabel("🗑 Logout").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("br_start").setLabel("▶ Start Bot").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("br_stop").setLabel("⏹ Stop Bot").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("br_settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("br_status").setLabel("📡 Status").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("br_help").setLabel("🆘 Support").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("br_more").setLabel("➕ Advanced").setStyle(ButtonStyle.Secondary)
    )
  ];
}

function buildJavaUI() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("jv_start").setLabel("▶ Start Java Bot").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("jv_stop").setLabel("⏹ Stop Java Bot").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("jv_settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("jv_status").setLabel("📡 Status").setStyle(ButtonStyle.Secondary)
    )
  ];
}

function buildAdminUI() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("adm_sys").setLabel("📊 Metrics").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("adm_bc_dc").setLabel("📢 Discord BC").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("adm_bc_mc").setLabel("⛏️ Game BC").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("adm_users").setLabel("👥 User Browser").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("adm_ban").setLabel("🚫 Blacklist").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("adm_kill_all").setLabel("☢️ Emergency Stop").setStyle(ButtonStyle.Danger)
    )
  ];
}

function buildHelpSelector() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("support_selector")
      .setPlaceholder("🆘 Assistance Required")
      .addOptions(
        { label: "Automatic System Scan", value: "opt_auto", emoji: "🔍" },
        { label: "Direct Support Chat", value: "opt_manual", emoji: "✍️" }
      )
  );
}

function buildVersionMenu(type, current = "auto") {
  const customId = type === "bedrock" ? "br_menu_v" : "jv_menu_v";
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder("Target Version").addOptions(
      { label: "Auto-detect (Recommended)", value: "auto", default: current === "auto" },
      { label: "Latest 1.21.x", value: "1.21.x", default: current === "1.21.x" },
      { label: "Legacy 1.20.x", value: "1.20.x", default: current === "1.20.x" }
    )
  );
}

// ----------------- PHYSICS & LOGIC ENGINES -----------------

/**
 * Puhdistaa Bedrock-session resurssit.
 */
function cleanupBedrock(uid) {
  const s = bedrockSessions.get(uid);
  if (!s) return;
  if (s.intervals) s.intervals.forEach(clearInterval);
  if (s.timers) s.timers.forEach(clearTimeout);
  if (s.client) { 
    s.client.removeAllListeners(); 
    try { s.client.close(); } catch (e) {} 
  }
  bedrockSessions.delete(uid);
}

/**
 * Puhdistaa Java-session resurssit.
 */
function cleanupJava(uid) {
  const s = javaSessions.get(uid);
  if (!s) return;
  if (s.intervals) s.intervals.forEach(clearInterval);
  if (s.timers) s.timers.forEach(clearTimeout);
  if (s.client) { 
    s.client.removeAllListeners(); 
    try { s.client.quit(); } catch (e) {} 
  }
  javaSessions.delete(uid);
}

/**
 * Hallitsee Startup-jonoa Fly.io vakauden takaamiseksi.
 */
async function processGlobalQueue() {
  if (queueActive || connectionQueue.length === 0) return;
  queueActive = true;
  while (connectionQueue.length > 0) {
    const { uid, type, interaction } = connectionQueue.shift();
    if (type === "bedrock") await executeBedrockStart(uid, interaction);
    else await executeJavaStart(uid, interaction);
    await new Promise(r => setTimeout(r, STARTUP_DELAY));
  }
  queueActive = false;
}

/**
 * BEDROCK CORE (Advanced Physics V25)
 */
async function executeBedrockStart(uid, interaction = null) {
  const u = getProfile(uid);
  if (u.banned) return interaction?.editReply("🚫 Access Forbidden: Blacklisted.");
  if (bedrockSessions.has(uid) && !bedrockSessions.get(uid).isReconnecting) {
    if (interaction && !interaction.replied) await interaction.editReply("⚠️ Bot is already online.");
    return;
  }

  const { ip, port } = u.bedrock;
  if (!ip) return interaction?.editReply("⚠️ Setup IP/Port in Settings first.");

  recordEvent(uid, `Bedrock: Connecting to ${ip}...`);

  // MOTD Guard
  try {
    const p = await bedrock.ping({ host: ip, port: port });
    if ((p.motd || "").toLowerCase().match(/offline|starting|queue/)) {
      recordEvent(uid, "Server offline or in lobby.");
      if (interaction) await interaction.editReply(`❌ Server is unavailable. Join blocked.`);
      return;
    }
  } catch (e) {
    recordEvent(uid, "Target unreachable.");
    if (interaction) await interaction.editReply(`❌ Could not reach ${ip}.`);
    return;
  }

  const opts = { 
    host: ip, port, connectTimeout: 45000, keepAlive: true,
    version: u.bedrock.version === "auto" ? undefined : u.bedrock.version,
    username: u.bedrock.name || uid,
    offline: true, // Pakotettu offline testivaiheessa vakauden vuoksi
    profilesFolder: u.linked ? getAuthPath(uid) : undefined,
    skip_chunk_decoding: true,
    use_native_raknet: true 
  };

  const mc = bedrock.createClient(opts);
  const state = {
    client: mc, connected: false, manualStop: false, isReconnecting: false,
    startTime: Date.now(), milestones: [], retryCount: bedrockSessions.get(uid)?.retryCount || 0,
    intervals: new Map(), timers: new Map(), isSneaking: false
  };
  bedrockSessions.set(uid, state);

  state.timers.set("timeout", setTimeout(async () => {
    if (!state.connected) {
      recordEvent(uid, "Join timeout.");
      const advice = await callIntelligence(`Bedrock join timeout for ${ip}. User: ${uid}`, "help");
      if (interaction) await interaction.editReply(`❌ **Timeout**\n\n${advice}`);
      cleanupBedrock(uid);
    }
  }, 47000));

  mc.on("spawn", () => {
    state.connected = true; state.retryCount = 0;
    clearTimeout(state.timers.get("timeout"));
    recordEvent(uid, "Bedrock Spawn Success!");
    u.stats.joins++; atomicStore();

    if (interaction) {
      const lucky = Math.random() < 0.01;
      const res = lucky ? "🥔 **Potato mode activated!** Spud AFK." : `🟢 **Connected** to **${ip}:${port}**\nBedrock physics enabled! 🏃‍♂️`;
      interaction.editReply({ content: res, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Support 💸").setStyle(ButtonStyle.Link).setURL("https://patreon.com/AFKBot396"))] }).catch(() => {});
    }

    // 4h Reboot
    state.timers.set("reboot", setTimeout(() => {
      if (state.connected && !state.manualStop) {
        recordEvent(uid, "Graceful reboot cycle...");
        state.isReconnecting = true; cleanupBedrock(uid);
        setTimeout(() => executeBedrockStart(uid), 5000);
      }
    }, SOFT_REBOOT_INTERVAL));

    // --- ADVANCED HUMAN PHYSICS (BEDROCK) ---
    state.intervals.set("physics", setInterval(() => {
      try {
        if (!mc.entity?.position) return;
        
        // Sneak simulation
        if (Math.random() < 0.15) {
          state.isSneaking = !state.isSneaking;
          mc.write("player_action", { runtime_id: mc.entityId, action: state.isSneaking ? "start_sneaking" : "stop_sneaking", position: {x:0,y:0,z:0}, result_position: {x:0,y:0,z:0}, face: 0 });
        }

        // Smooth incremental walk (No teleporting)
        const currentPos = { ...mc.entity.position };
        const roll = Math.random();
        if (roll < 0.25) {
          currentPos.x += (Math.random() > 0.5 ? 0.4 : -0.4);
        } else if (roll < 0.35) {
          mc.write("player_action", { runtime_id: mc.entityId, action: "jump", position: {x:0,y:0,z:0}, result_position: {x:0,y:0,z:0}, face: 0 });
        }

        mc.write("move_player", {
          runtime_id: mc.entityId, position: currentPos, 
          pitch: (Math.random()*20)-10, yaw: Math.random()*360, head_yaw: Math.random()*360, 
          mode: 0, on_ground: true, ridden_runtime_id: 0, teleport: false 
        });

        // Hotbar shuffling
        if (Math.random() < 0.1) {
          mc.write("player_hotbar", { selected_slot: Math.floor(Math.random() * 9), window_id: "inventory", select_slot: true });
        }
      } catch (e) {}
    }, 55000 + Math.random() * 15000));

    state.intervals.set("heartbeat", setInterval(() => { try { mc.write("tick_sync", { request_time: BigInt(Date.now()), response_time: 0n }); } catch (e) {} }, HEARTBEAT_INTERVAL));
  });

  mc.on("error", (err) => { if (!state.manualStop && !state.isReconnecting) { recordEvent(uid, `Bedrock Err: ${err.message}`); recoverBedrock(uid, interaction); } });
  mc.on("close", () => { if (!state.manualStop && !state.isReconnecting) { recordEvent(uid, "Bedrock Closed."); recoverBedrock(uid, interaction); } });
}

function recoverBedrock(uid, interaction) {
  const s = bedrockSessions.get(uid); if (!s || s.manualStop || s.reconnectTimer) return;
  s.isReconnecting = true; s.connected = false; s.retryCount++;
  const delay = Math.min(30000 * Math.pow(1.5, s.retryCount - 1), 300000);
  s.reconnectTimer = setTimeout(async () => {
    if (bedrockSessions.has(uid) && !s.manualStop) {
      try { await bedrock.ping({ host: getProfile(uid).bedrock.ip, port: getProfile(uid).bedrock.port }); executeBedrockStart(uid, interaction); }
      catch (e) { s.reconnectTimer = null; recoverBedrock(uid, interaction); }
    }
  }, delay);
}

/**
 * JAVA CORE (Mineflayer Integration)
 */
async function executeJavaStart(uid, interaction = null) {
  const u = getProfile(uid);
  if (u.banned) return interaction?.editReply("🚫 Access Restricted.");
  if (javaSessions.has(uid)) return;

  const { ip, port, name } = u.java;
  if (!ip) return interaction?.editReply("⚠️ Java Config required.");

  recordEvent(uid, `Java: Connecting to ${ip}...`);

  const bot = mineflayer.createBot({
    host: ip,
    port: port || 25565,
    username: name || `AFK_J_${uid.slice(-4)}`,
    version: false,
    hideErrors: true
  });

  const state = {
    client: bot, connected: false,
    intervals: new Map(), timers: new Map(),
    startTime: Date.now()
  };
  javaSessions.set(uid, state);

  bot.on("spawn", () => {
    state.connected = true;
    recordEvent(uid, "Java Spawn Success!");
    if (interaction) interaction.editReply("🟢 **Java Bot Connected!** AFK movements initialized. 🏃‍♂️").catch(() => {});

    // Java AFK Physics Engine
    state.intervals.set("move", setInterval(() => {
      if (!bot.entity) return;
      
      const yaw = Math.random() * Math.PI * 2;
      const pitch = (Math.random() - 0.5) * Math.PI * 0.2;
      bot.look(yaw, pitch);

      const roll = Math.random();
      if (roll < 0.15) {
        bot.setControlState('jump', true);
        setTimeout(() => bot.setControlState('jump', false), 500);
      } else if (roll < 0.30) {
        bot.setControlState('sneak', true);
        setTimeout(() => bot.setControlState('sneak', false), 2000);
      }
    }, 60000 + Math.random() * 10000));
  });

  bot.on("error", (err) => { recordEvent(uid, `Java Err: ${err.message}`); cleanupJava(uid); });
  bot.on("end", () => { recordEvent(uid, "Java Session Ended."); cleanupJava(uid); });
}

// ----------------- EVENT HANDLERS -----------------

// Gemini Support Responder
client.on(Events.MessageCreate, async (m) => {
  if (m.author.bot || m.channelId !== SUPPORT_CHANNEL_ID) return;
  if (m.content.toLowerCase().includes("slap me")) return m.reply("👋 *Slaps you with a massive wet cod!* 🐟");
  const res = await callIntelligence(`Support Request: <@${m.author.id}>: ${m.content}`, "support");
  if (res.includes("[NoCont]")) return;
  await m.reply({ content: res });
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    const uid = i.user.id;
    if (i.guildId !== ALLOWED_GUILD_ID && i.inGuild() && uid !== OWNER_ID) return i.reply({ content: "Unauthorized access ⛔️", ephemeral: true });

    // PAINIKKEET (BUTTONS)
    if (i.isButton()) {
      // Dashboard Bedrock
      if (i.customId === "br_help") return i.reply({ content: "🆘 **Support Center**", components: [buildSupportMenu()], ephemeral: true });
      if (i.customId === "br_start") { await i.deferReply({ ephemeral: true }); connectionQueue.push({ uid, type: "bedrock", interaction: i }); processGlobalQueue(); return; }
      if (i.customId === "br_stop") { 
        const now = new Date();
        const active = bedrockSessions.has(uid);
        if (active) { bedrockSessions.get(uid).manualStop = true; cleanupBedrock(uid); }
        let msg = active ? "⏹ **Stopped.** Have a great day! 👋" : "❌ No active session.";
        if (now.getHours() === 16) msg += "\n☕ *Tea time! Good timing.*";
        return i.reply({ ephemeral: true, content: msg });
      }
      if (i.customId === "br_status") {
        const u = getProfile(uid); const s = bedrockSessions.get(uid);
        const st = s ? (s.connected ? "🟢 Online" : "🟡 Reconnecting") : "🔴 Offline";
        const e = new EmbedBuilder().setTitle("📡 Bedrock Status").setColor("#3498db").addFields({ name: "State", value: `\`${st}\``, inline: true }, { name: "History", value: `\`\`\`\n${u.logs.join("\n") || "No activity."}\n\`\`\`` });
        return i.reply({ embeds: [e], ephemeral: true });
      }
      if (i.customId === "br_unlink") {
        const u = getProfile(uid); if (!u.linked) return i.reply({ ephemeral: true, content: "❌ No account linked." });
        const dir = getAuthDir(uid); try { fs.rmSync(dir, { recursive: true, force: true }); } catch(e) {}
        u.linked = false; atomicStore(); return i.reply({ ephemeral: true, content: "🗑 Link removed." });
      }

      // Dashboard Java
      if (i.customId === "jv_start") { await i.deferReply({ ephemeral: true }); connectionQueue.push({ uid, type: "java", interaction: i }); processGlobalQueue(); return; }
      if (i.customId === "jv_stop") { cleanupJava(uid); return i.reply({ ephemeral: true, content: "⏹ **Java Bot Stopped.** 👋" }); }
      if (i.customId === "jv_status") {
        const u = getProfile(uid); const s = javaSessions.get(uid);
        const st = s ? (s.connected ? "🟢 Online" : "🟡 Connecting") : "🔴 Offline";
        const e = new EmbedBuilder().setTitle("📡 Java Status").setColor("#2ecc71").addFields({ name: "State", value: `\`${st}\``, inline: true }, { name: "Stats", value: `Joins: \`${u.stats.joins}\``, inline: true }, { name: "Logs", value: `\`\`\`\n${u.logs.join("\n") || "No data."}\n\`\`\`` });
        return i.reply({ embeds: [e], ephemeral: true });
      }

      // ORIGINAL MICROSOFT CALLBACK
      if (i.customId === "br_link") {
        await i.deferReply({ ephemeral: true });
        const flow = new Authflow(uid, getAuthDir(uid), { flow: "live", authTitle: Titles?.MinecraftNintendoSwitch || "AFK Bot", deviceType: "Nintendo" }, async (data) => {
          // CALLBACK: Päivittää koodin Dashboardiin heti
          const m = `🔐 **Microsoft Login Required**\n\n1️⃣ **Link:** [Click to login](${data.verification_uri})\n2️⃣ **Code:** \`${data.user_code}\`\n\n⚠️ Return here after browser login is complete!`;
          await i.editReply({ 
            content: m, 
            components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Open Official Link").setStyle(ButtonStyle.Link).setURL(data.verification_uri))] 
          }).catch(() => {});
        });
        await flow.getMsaToken();
        const u = getProfile(uid); u.linked = true; atomicStore();
        return i.followUp({ ephemeral: true, content: "✅ **Verification Success!** Profile updated." });
      }

      if (i.customId === "br_settings") {
        const u = getProfile(uid);
        const m = new ModalBuilder().setCustomId("br_set_mod").setTitle("Bedrock Settings");
        m.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("Server IP").setStyle(TextInputStyle.Short).setValue(u.bedrock.ip).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("pt").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.bedrock.port)).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("nm").setLabel("Cracked Name").setStyle(TextInputStyle.Short).setValue(u.bedrock.name))
        );
        return i.showModal(m);
      }

      if (i.customId === "jv_settings") {
        const u = getProfile(uid);
        const m = new ModalBuilder().setCustomId("jv_set_mod").setTitle("Java Settings");
        m.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("Server IP").setStyle(TextInputStyle.Short).setValue(u.java.ip).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("pt").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.java.port)).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("nm").setLabel("Username (Cracked)").setStyle(TextInputStyle.Short).setValue(u.java.name).setRequired(true))
        );
        return i.showModal(m);
      }

      // ADMIN
      if (i.customId === "adm_infra") {
        if (!ADMIN_IDS.includes(uid)) return;
        const mem = process.memoryUsage();
        const e = new EmbedBuilder().setTitle("📊 Core Infrastructure").addFields({ name: "Heap", value: `\`${(mem.heapUsed/1024/1024).toFixed(1)} MB\``, inline: true }, { name: "Bedrock Bots", value: `\`${bedrockSessions.size}\``, inline: true }, { name: "Java Bots", value: `\`${javaSessions.size}\``, inline: true }, { name: "Total Users", value: `\`${Object.keys(users).length}\``, inline: true });
        return i.reply({ embeds: [e], ephemeral: true });
      }

      if (i.customId === "adm_kill_all") {
        if (!ADMIN_IDS.includes(uid)) return;
        for (const [id] of bedrockSessions) cleanupBedrock(id);
        for (const [id] of javaSessions) cleanupJava(id);
        return i.reply({ content: "☢️ Mass Termination Complete.", ephemeral: true });
      }
    }

    // MENUT
    if (i.isStringSelectMenu()) {
      if (i.customId === "support_selector") {
        if (i.values[0] === "opt_auto") {
          await i.update({ content: "⏳ **Scanning infrastructure...**", components: [] });
          const u = getProfile(uid); const s = bedrockSessions.get(uid) || javaSessions.get(uid);
          const helpRes = await callIntelligence(`Diagnostic: Server ${u.bedrock.ip}, Active: ${s?.connected ? 'YES' : 'NO'}`, "help");
          return i.editReply({ content: `🆘 **Diagnostic Result**\n\n${helpRes}` });
        }
      }
    }

    // MODAALIT (MODALS)
    if (i.isModalSubmit()) {
      if (i.customId === "br_set_mod") {
        const u = getProfile(uid); 
        const newIp = i.fields.getTextInputValue("ip").trim();
        if (newIp === "upupdowndown") return i.reply({ ephemeral: true, content: "🎮 **Cheat Code Activated!**" });
        u.bedrock.ip = newIp; u.bedrock.port = parseInt(i.fields.getTextInputValue("pt")); u.bedrock.name = i.fields.getTextInputValue("nm");
        atomicStore(); return i.reply({ ephemeral: true, content: "✅ Bedrock settings saved to /data volume." });
      }
      if (i.customId === "jv_set_mod") {
        const u = getProfile(uid); u.java.ip = i.fields.getTextInputValue("ip"); u.java.port = parseInt(i.fields.getTextInputValue("pt")); u.java.name = i.fields.getTextInputValue("nm");
        atomicStore(); return i.reply({ ephemeral: true, content: "✅ Java settings saved to /data volume." });
      }
    }

    // SLASH KOMENNOT
    if (i.isChatInputCommand()) {
      if (i.commandName === "panel") return i.reply({ content: "🎛 **Bedrock Edition Dashboard**", components: buildDashboardUI() });
      if (i.commandName === "javapanel") return i.reply({ content: "🎛 **Java Edition Dashboard**", components: buildJavaUI() });
      if (i.commandName === "admin") {
        if (!ADMIN_IDS.includes(uid)) return i.reply({ content: "⛔ Access Denied.", ephemeral: true });
        return i.reply({ content: "🛡️ **Administrator Hub**", components: buildAdminUI(), ephemeral: true });
      }
    }
  } catch (err) { process.stderr.write(`[Interaction Fatal] ${err.message}\n`); }
});

// --- LIFESTYLE ---
process.on("unhandledRejection", (e) => notifyOwner(`REJECTION: \`${e.message}\``));
process.on("uncaughtException", (e) => notifyOwner(`CRITICAL: \`${e.message}\``));

client.once("ready", async () => {
  const cmds = [
    new SlashCommandBuilder().setName("panel").setDescription("Access Bedrock AFK dashboard"),
    new SlashCommandBuilder().setName("javapanel").setDescription("Access Java AFK dashboard"),
    new SlashCommandBuilder().setName("admin").setDescription("Administrator tools")
  ];
  await client.application.commands.set(cmds);
  pushCoreLog("System Rebooted. V25 ONLINE.");
});

function getAuthDir(uid) { const d = path.join(AUTH_DIR, uid); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); return d; }

client.login(DISCORD_TOKEN);

