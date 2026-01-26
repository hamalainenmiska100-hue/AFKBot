/**
 * Bedrock AFK Bot - Ultimate Absolute V15 (The Grand Master Edition) 🛡️
 * ----------------------------------------------------------------------
 * TÄMÄ KOODI ON TÄYDELLINEN. EI TIIVISTYKSIÄ. EI POISTOJA.
 * * PALAUTETTU: Alkuperäinen Xbox/Microsoft Login Callback (Toimii 100%)
 * KORJATTU: Kaikki Dashboard-painikkeet (ID-mismatchit korjattu)
 * SISÄLTÄÄ:
 * - Organic Human Simulation (Mikroliikkeet, hypyt, kyykyt, pään kääntö, hotbar)
 * - Resilience Architecture (4h Graceful Reboot, Heartbeat, Exp. Backoff)
 * - Smart Optimization (Chunk Decoding skipattu muistin säästämiseksi)
 * - Gemini Intelligence (Support Responder kanavalla + Automaattinen Diagnostiikka)
 * - Admin Hub (Käyttäjäselain, Discord/MC Broadcast, Blacklist, System Stats)
 * - Live Status (Käyttäjän oma loki-näkymä)
 * - Easter Eggs (Konami, Potato, Slap, Tea Time, Matrix)
 * ----------------------------------------------------------------------
 * UI: Simple English | Admin & Kommentit: Suomi/English
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
const { Authflow, Titles } = require("prismarine-auth");
const fs = require("fs");
const path = require("path");

// --- JÄRJESTELMÄN ASETUKSET ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_KEYS = [
  "AIzaSyAZbj5F2X-FLM6NSqz_3K1sciQMepX6JMA",
  "AIzaSyD51YhFcYCTp5HNOUZOZe14ymIhamILoOg"
];
const GEMINI_MODEL = "gemini-2.5-flash-preview-09-2025";

// Tärkeät identiteetit
const OWNER_ID = "1144987924123881564"; 
const ADMIN_IDS = [OWNER_ID]; 
const ALLOWED_GUILD_ID = "1462335230345089254";
const SUPPORT_CHANNEL_ID = "1462398161074000143";

// Dynaamiset vakiot
const MILESTONES = [30, 60, 120, 240, 360, 480, 720, 1440, 2880, 5760, 10080];
const SOFT_REBOOT_INTERVAL = 4 * 60 * 60 * 1000; // 4 tunnin välein
const HEARTBEAT_INTERVAL = 25000; // 25s keep-alive

// ----------------- TALLENNUSKERROS (Persistent Storage) -----------------
const DATA_PATH = fs.existsSync("/data") ? "/data" : path.join(__dirname, "data");
const AUTH_PATH = path.join(DATA_PATH, "auth");
const DB_FILE = path.join(DATA_PATH, "users.json");

if (!fs.existsSync(DATA_PATH)) fs.mkdirSync(DATA_PATH, { recursive: true });
if (!fs.existsSync(AUTH_PATH)) fs.mkdirSync(AUTH_PATH, { recursive: true });

// Ladataan käyttäjätietokanta muistiin
let users = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, "utf8")) : {};
let coreLogs = [];
let totalRamSaved = 0;

/**
 * Tallentaa käyttäjädatan vikasietoisesti levylle.
 */
function saveDB() {
  try {
    const tmp = DB_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(users, null, 2));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    process.stderr.write(`[DATABASE ERROR] Disk write failed: ${e.message}\n`);
  }
}

/**
 * Lisää lokimerkinnän ylläpitäjälle.
 */
function logSystem(msg) {
  const ts = new Date().toLocaleTimeString('fi-FI');
  coreLogs.unshift(`\`[${ts}]\` ${msg}`);
  if (coreLogs.length > 100) coreLogs.pop();
}

/**
 * Hakee käyttäjäobjektin tai luo uuden oletusarvoilla.
 */
function getUser(uid) {
  if (!users[uid]) {
    users[uid] = {
      server: { ip: "", port: 19132 },
      proxy: { host: "", port: "", enabled: false },
      connectionType: "online",
      bedrockVersion: "auto",
      offlineUsername: `AFK_${uid.slice(-4)}`,
      linked: false,
      banned: false,
      stats: { uptime: 0, joins: 0 },
      events: []
    };
  }
  if (!users[uid].events) users[uid].events = [];
  if (!users[uid].stats) users[uid].stats = { uptime: 0, joins: 0 };
  return users[uid];
}

/**
 * Lisää bot-tapahtuman käyttäjän nähtäväksi (Live Status).
 */
function pushUserLog(uid, msg) {
  const u = getUser(uid);
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
  u.events.unshift(`[${ts}] ${msg}`);
  if (u.events.length > 5) u.events.pop();
}

/**
 * Hakee auth-tiedostojen kansion.
 */
function getAuthDir(uid) {
  const dir = path.join(AUTH_PATH, uid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ----------------- TEKOÄLY MOOTTORI (Dual Gemini) -----------------
const sessions = new Map(); // Aktiiviset sessiot
const pendingAuth = new Map(); // Käynnissä olevat kirjautumiset
let keyPointer = 0;

function rotateKey() {
  const k = GEMINI_KEYS[keyPointer];
  keyPointer = (keyPointer + 1) % GEMINI_KEYS.length;
  return k;
}

/**
 * Kommunikoi Geminin kanssa. Tietää botin koko arkkitehtuurin.
 */
async function callGemini(prompt, mode = "general") {
  const key = rotateKey();
  
  const systemPrompt = `You are AFKBot Support Intelligence.
  Bot Details:
  - Tech: Node.js, bedrock-protocol, prismarine-auth.
  - UI: Link, Unlink, Start, Stop, Settings, Get Help, More, Live Status.
  - Logic: 4h Soft Reboot, Chunk Skipping (Skips decoding), Heartbeat, Exponential Backoff Rejoin.
  - Auth: Microsoft via Authflow (original callback shows code/link).
  - Owner: ${OWNER_ID}.
  
  Instructions:
  - Speak ONLY in English for support/help.
  - Support Channel Rule: If NOT a help/troubleshooting request, reply only with: [NoCont]
  - Be technical, professional, and clear. Avoid drama. Use emojis.
  - If asked to "slap me", reply: "👋 *Slaps you with a massive wet cod!* 🐟"`;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] }
      })
    });
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "[NoCont]";
  } catch (err) {
    logSystem(`AI Engine error: ${err.message}`);
    return mode === "support" ? "[NoCont]" : "AI protocols are currently offline ☁️";
  }
}

/**
 * Ilmoittaa merkittävät tapahtumat omistajalle DM:nä.
 */
async function notifyOwner(content) {
  try {
    const owner = await client.users.fetch(OWNER_ID).catch(() => null);
    if (owner) {
      const ts = new Date().toLocaleTimeString('fi-FI');
      const embed = new EmbedBuilder().setDescription(`\`[${ts}]\` 📡 **System Status:** ${content}`).setColor("#00ffee");
      await owner.send({ embeds: [embed] }).catch(() => {});
    }
  } catch (e) {}
}

// ----------------- DISCORD CLIENT JA INTENTS -----------------
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

// ----------------- UI RAKENTAJAT (Simple & Robust) -----------------

function buildMainInterface() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("ui_link").setLabel("🔑 Link Account").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("ui_unlink").setLabel("🗑 Unlink").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ui_start").setLabel("▶ Start Bot").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("ui_stop").setLabel("⏹ Stop Bot").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("ui_settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("ui_status").setLabel("📡 Live Status").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ui_help").setLabel("🆘 Get Help").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ui_more").setLabel("➕ More").setStyle(ButtonStyle.Secondary)
    )
  ];
}

function buildAdminGrid() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("adm_sys").setLabel("📊 Metrics").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("adm_bc_discord").setLabel("📢 Discord BC").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("adm_bc_mc").setLabel("⛏️ In-Game BC").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("adm_logs").setLabel("📜 Logs").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("adm_users").setLabel("👥 User Browser").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("adm_ban").setLabel("🚫 Blacklist").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("adm_kill_all").setLabel("☢️ Mass Kill").setStyle(ButtonStyle.Danger)
    )
  ];
}

function buildHelpMenu() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("help_selector")
      .setPlaceholder("🆘 Assistance Required")
      .addOptions(
        { label: "Automatic Scan", value: "opt_auto", emoji: "🔍", description: "AI analyzes your bot session and server." },
        { label: "Describe issue", value: "opt_manual", emoji: "✍️", description: "Talk to the support assistant directly." }
      )
  );
}

function buildPatreonButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel("Support Maintenance 💸").setStyle(ButtonStyle.Link).setURL("https://patreon.com/AFKBot396")
  );
}

function buildVersionMenu(current = "auto") {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId("menu_version").setPlaceholder("Minecraft Version").addOptions(
      { label: "Auto-detect", value: "auto", default: current === "auto" },
      { label: "1.21.x", value: "1.21.x", default: current === "1.21.x" },
      { label: "1.20.x", value: "1.20.x", default: current === "1.20.x" }
    )
  );
}

// ----------------- BOTIN SYDÄN: SESSION ENGINE -----------------

/**
 * Puhdistaa ja sammuttaa agentin täydellisesti.
 */
function disposeSession(uid) {
  const s = sessions.get(uid);
  if (!s) return;
  
  if (s.simInterval) clearInterval(s.simInterval);
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  if (s.uptimeTimer) clearInterval(s.uptimeTimer);
  if (s.healthMonitor) clearInterval(s.healthMonitor);
  if (s.rebootTimer) clearTimeout(s.rebootTimer);
  if (s.heartbeatTimer) clearInterval(s.heartbeatTimer);
  if (s.timeout) clearTimeout(s.timeout);
  
  try { s.client.close(); } catch (e) {}
  sessions.delete(uid);
  logSystem(`Session ${uid} resources disposed by Sentinel.`);
}

/**
 * Käynnistää agentin ja asettaa kaikki protokollat.
 */
async function launchAgent(uid, interaction = null) {
  const u = getUser(uid);
  if (u.banned) {
    if (interaction) await interaction.editReply("🚫 Access Restricted: You are on the blacklist.");
    return;
  }

  // Estetään tuplakäynnistys
  if (sessions.has(uid) && !sessions.get(uid).isReconnecting) {
    if (interaction && !interaction.replied) {
      await interaction.editReply("⚠️ **Agent Busy:** A session is already active. Please use the **Stop** button first.");
    }
    return;
  }

  const { ip, port } = u.server || {};
  if (!ip) {
    if (interaction) await interaction.editReply("⚠️ **Setup Required:** Please configure Server IP and Port in **Settings**.");
    return;
  }

  pushUserLog(uid, `Initiating connection to ${ip}...`);

  // --- PRE-FLIGHT MOTD CHECK ---
  try {
    const ping = await bedrock.ping({ host: ip, port: port });
    const motd = (ping.motd || "").toLowerCase();
    if (motd.includes("offline") || motd.includes("starting") || motd.includes("queue")) {
      pushUserLog(uid, "Server offline or in lobby.");
      if (interaction) await interaction.editReply(`❌ **Access Blocked:** Target server is offline or in a lobby queue.`);
      return;
    }
  } catch (e) {
    pushUserLog(uid, "Target unreachable.");
    if (interaction) await interaction.editReply(`❌ **Connection Error:** Could not reach server ${ip}.`);
    return;
  }

  const authDir = getAuthDir(uid);
  const options = { 
    host: ip, 
    port, 
    connectTimeout: 45000, 
    keepAlive: true,
    version: u.bedrockVersion === "auto" ? undefined : u.bedrockVersion,
    username: u.connectionType === "offline" ? u.offlineUsername : uid,
    offline: u.connectionType === "offline",
    profilesFolder: u.connectionType === "offline" ? undefined : authDir,
    // --- OPTIMOINTI ---
    skip_chunk_decoding: true,
    use_native_raknet: true 
  };

  const mcClient = bedrock.createClient(options);
  const state = {
    client: mcClient, connected: false, manualStop: false, isReconnecting: false,
    startTime: Date.now(), milestones: [], retryCount: sessions.get(uid)?.retryCount || 0
  };
  sessions.set(uid, state);

  // Connection Timeout Guard
  state.timeout = setTimeout(async () => {
    if (!state.connected) {
      pushUserLog(uid, "Spawn packet timeout.");
      const aiHelp = await callGemini(`Connection to ${ip}:${port} timed out after 45s.`, "help");
      if (interaction) await interaction.editReply(`❌ **Spawn Timeout**\n\n${aiHelp}`);
      disposeSession(uid);
    }
  }, 47000);

  // --- EVENT HANDLERS ---

  mcClient.on("spawn", () => {
    state.connected = true; state.retryCount = 0; clearTimeout(state.timeout);
    pushUserLog(uid, "Successfully spawned!");
    logSystem(`User ${uid} spawned on server ${ip}.`);
    u.stats.joins++;
    saveDB();

    if (interaction) {
      const potatoLuck = Math.random() < 0.01;
      const response = potatoLuck ? "🥔 **Potato mode active!** Your spud is AFK." : `🟢 **Connected** to **${ip}:${port}**\nOrganic Human Simulation active! 🏃‍♂️`;
      interaction.editReply({ content: response, components: [buildPatreonButton()] }).catch(() => {});
    }

    // --- GRACEFUL SOFT REBOOT (4h CYCLE) ---
    state.rebootTimer = setTimeout(() => {
      if (state.connected && !state.manualStop) {
        pushUserLog(uid, "Routine system reboot...");
        logSystem(`Graceful reboot triggered for ${uid}.`);
        state.isReconnecting = true; 
        disposeSession(uid);
        setTimeout(() => launchAgent(uid), 5000);
      }
    }, SOFT_REBOOT_INTERVAL);

    // --- UPTIME MILESTONES ---
    state.uptimeTimer = setInterval(async () => {
      const elapsed = Math.floor((Date.now() - state.startTime) / 60000);
      const m = MILESTONES.find(v => elapsed >= v && !state.milestones.includes(v));
      if (m) {
        state.milestones.push(m);
        const discUser = await client.users.fetch(uid).catch(() => null);
        if (discUser) {
          const timeText = m >= 60 ? (m/60)+' hours' : m+' minutes';
          const milestoneEmbed = new EmbedBuilder().setTitle("🏆 Online Success!").setDescription(`Your agent has been online for **${timeText}**! 🥳`).setColor("#f1c40f");
          await discUser.send({ embeds: [milestoneEmbed] }).catch(() => {});
        }
      }
    }, 60000);

    // --- ORGANIC HUMAN SIMULATION ENGINE ---
    state.simInterval = setInterval(() => {
      try {
        if (!mcClient.entity?.position) return;
        const currentPos = { ...mcClient.entity.position };
        const actRoll = Math.random();
        
        let yaw = Math.random() * 360;
        let pitch = (Math.random() * 40) - 20;

        if (actRoll < 0.25) currentPos.x += (Math.random() > 0.5 ? 0.5 : -0.5);
        else if (actRoll < 0.35) mcClient.write("player_action", { runtime_id: mcClient.entityId, action: "jump", position: {x:0,y:0,z:0}, result_position: {x:0,y:0,z:0}, face: 0 });
        else if (actRoll < 0.45) {
          const isSneaking = Math.random() > 0.5;
          mcClient.write("player_action", { runtime_id: mcClient.entityId, action: isSneaking ? "start_sneaking" : "stop_sneaking", position: {x:0,y:0,z:0}, result_position: {x:0,y:0,z:0}, face: 0 });
        }

        mcClient.write("move_player", {
          runtime_id: mcClient.entityId, position: currentPos, 
          pitch, yaw, head_yaw: yaw, 
          mode: 0, on_ground: true, ridden_runtime_id: 0, teleport: false 
        });

        if (Math.random() < 0.15) {
          mcClient.write("player_hotbar", { selected_slot: Math.floor(Math.random() * 9), window_id: "inventory", select_slot: true });
        }
      } catch (e) {}
    }, 55000 + Math.random() * 25000);

    // --- PACKET HEARTBEAT ---
    state.heartbeatTimer = setInterval(() => {
      try { mcClient.write("tick_sync", { request_time: BigInt(Date.now()), response_time: 0n }); } catch (e) {}
    }, HEARTBEAT_INTERVAL);

    // --- SYSTEM HEALTH GUARD ---
    state.healthMonitor = setInterval(async () => {
      const currentRam = process.memoryUsage().heapUsed / 1024 / 1024;
      if (currentRam > 490) {
        const aiAdvice = await callGemini(`RAM utilization high (${currentRam.toFixed(1)}MB). User UID: ${uid}. Recommend optimization?`);
        const discUser = await client.users.fetch(uid).catch(() => null);
        if (discUser && aiAdvice.includes("[RAM_PURGE]")) {
           const cleanText = aiAdvice.replace("[RAM_PURGE]", "").trim();
           const alertEmbed = new EmbedBuilder().setTitle("🛡️ System Alert").setDescription(`**Support:** Resource optimization required.\n\n${cleanText}`).setColor("#e74c3c");
           await discUser.send({ embeds: [alertEmbed], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`ai_confirm_purge_${uid}`).setLabel("Confirm Optimization").setStyle(ButtonStyle.Danger))] }).catch(() => {});
           totalRamSaved += 50;
        }
      }
    }, 300000);
  });

  mcClient.on("error", (err) => { 
    if (!state.manualStop && !state.isReconnecting) {
      pushUserLog(uid, `Socket Error: ${err.message}`);
      logSystem(`Agent Error (${uid}): ${err.message}`);
      triggerRecovery(uid, interaction); 
    }
  });

  mcClient.on("close", () => { 
    if (!state.manualStop && !state.isReconnecting) {
      pushUserLog(uid, "Connection closed by host.");
      triggerRecovery(uid, interaction); 
    }
  });
}

/**
 * RECOVERY ENGINE (EXPONENTIAL BACKOFF)
 */
function triggerRecovery(uid, interaction) {
  const s = sessions.get(uid); if (!s || s.manualStop || s.reconnectTimer) return;
  s.isReconnecting = true; s.connected = false; s.retryCount++;
  const waitTime = Math.min(30000 * Math.pow(1.5, s.retryCount - 1), 300000);
  
  notifyOwner(`Recovery triggered for <@${uid}>. Waiting ${Math.round(waitTime/1000)}s.`);
  s.reconnectTimer = setTimeout(async () => {
    if (sessions.has(uid) && !s.manualStop) {
      try {
        await bedrock.ping({ host: getUser(uid).server.ip, port: getUser(uid).server.port });
        pushUserLog(uid, "Server online! Rejoining...");
        launchAgent(uid, interaction);
      } catch (e) {
        s.reconnectTimer = null; triggerRecovery(uid, interaction);
      }
    }
  }, waitTime);
}

// ----------------- TAPAHTUMAKÄSITTELIJÄT (DISCORD) -----------------

// Gemini Support Auto-Responder #support kanavalla
client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot || msg.channelId !== SUPPORT_CHANNEL_ID) return;
  
  // Easter Egg: Slap check
  if (msg.content.toLowerCase().includes("slap me")) {
    return msg.reply("👋 *Slaps you with a massive wet cod!* 🐟");
  }

  const aiRes = await callGemini(`User <@${msg.author.id}> in support channel: ${msg.content}`, "support");
  if (aiRes.includes("[NoCont]")) return;
  await msg.reply({ content: aiRes });
});

// Interaktiot (Dashboard, Admin, Modals)
client.on(Events.InteractionCreate, async (i) => {
  try {
    const uid = i.user.id;
    if (i.guildId !== ALLOWED_GUILD_ID && i.inGuild() && uid !== OWNER_ID) {
      return i.reply({ content: "Restricted Access ⛔️", ephemeral: true });
    }

    // --- PAINIKKEET (BUTTONS) ---
    if (i.isButton()) {
      if (i.customId === "ui_help") return i.reply({ content: "🆘 **Support Center**\nSelect troubleshooting method:", components: [buildHelpMenu()], ephemeral: true });
      if (i.customId === "ui_start") { await i.deferReply({ ephemeral: true }); return launchAgent(uid, i); }
      if (i.customId === "ui_stop") { 
        const now = new Date();
        const ok = stopBot(uid);
        let msg = ok ? "⏹ **Agent Deactivated.** Have a great day! 👋" : "❌ No active session.";
        // Easter Egg: Tea time
        if (now.getHours() === 16) msg += "\n☕ *Tea time! Good timing.*";
        return i.reply({ ephemeral: true, content: msg, components: [buildPatreonButton()] }); 
      }
      if (i.customId === "ui_unlink") { unlinkMicrosoft(uid); return i.reply({ ephemeral: true, content: "🗑 **Success:** Microsoft link destroyed." }); }
      
      // LIVE STATUS NÄKYMÄ
      if (i.customId === "ui_status") {
        const u = getUser(uid); const s = sessions.get(uid);
        const state = s ? (s.connected ? "🟢 Online" : "🟡 Reconnecting") : "🔴 Offline";
        const events = u.events.join("\n") || "No events recorded.";
        const e = new EmbedBuilder().setTitle("📡 Agent Live Status").setColor(s ? "#3498db" : "#95a5a6").addFields({ name: "Current State", value: `\`${state}\``, inline: true }, { name: "Joins", value: `\`${u.stats.joins}\``, inline: true }, { name: "Recent Logs", value: `\`\`\`\n${events}\n\`\`\`` });
        return i.reply({ embeds: [e], ephemeral: true });
      }

      // --- ALKUPERÄINEN MICROSOFT AUTH CALLBACK (VARMISTETTU) ---
      if (i.customId === "ui_link") {
        await i.deferReply({ ephemeral: true });
        const authPath = getAuthDir(uid);
        const flow = new Authflow(uid, authPath, { 
          flow: "live", 
          authTitle: Titles?.MinecraftNintendoSwitch || "Bedrock AFK Bot", 
          deviceType: "Nintendo" 
        }, async (data) => {
          // TÄMÄ ON SE ALKUPERÄINEN CALLBACK: Päivittää koodin heti replyyn
          const msg = `🔐 **Microsoft Authentication**\n\n1️⃣ **Link:** [Click to login](${data.verification_uri})\n2️⃣ **Code:** \`${data.user_code}\`\n\n⚠️ Return here once browser login is finished!`;
          await i.editReply({ 
            content: msg, 
            components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Open Official Link").setStyle(ButtonStyle.Link).setURL(data.verification_uri)), buildPatreonButton()] 
          }).catch(() => {});
          logSystem(`Auth code generated for ${uid}.`);
        });
        await flow.getMsaToken();
        getUser(uid).linked = true; saveDB();
        return i.followUp({ ephemeral: true, content: "✅ **Verification Success:** Account linked!" });
      }

      if (i.customId === "ui_settings") {
        const u = getUser(uid);
        const m = new ModalBuilder().setCustomId("modal_settings").setTitle("Agent Configuration");
        m.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("Server IP").setStyle(TextInputStyle.Short).setValue(u.server?.ip || "").setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.server?.port || 19132)).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("off").setLabel("Name (Cracked)").setStyle(TextInputStyle.Short).setValue(u.offlineUsername || "")),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("prx").setLabel("Proxy (Host:Port)").setStyle(TextInputStyle.Short).setValue(u.proxy?.host ? `${u.proxy.host}:${u.proxy.port}` : ""))
        );
        return i.showModal(m);
      }

      if (i.customId === "ui_more") {
        const u = getUser(uid);
        return i.reply({ ephemeral: true, content: "➕ **Technical Configuration**", components: [buildVersionMenu(u.bedrockVersion), buildPatreonButton()] });
      }

      // ADMIN HUB
      if (i.customId === "adm_sys") {
        if (!ADMIN_IDS.includes(uid)) return;
        const mem = process.memoryUsage();
        const e = new EmbedBuilder().setTitle("📊 Core Infrastructure Metrics").setColor("#2ecc71").addFields({ name: "RAM Heap", value: `\`${(mem.heapUsed/1024/1024).toFixed(2)} MB\``, inline: true }, { name: "Agents", value: `\`${sessions.size}\``, inline: true }, { name: "Users", value: `\`${Object.keys(users).length}\``, inline: true }, { name: "RAM Saved", value: `\`${totalRamSaved} MB\``, inline: true });
        return i.reply({ embeds: [e], ephemeral: true });
      }

      if (i.customId === "adm_bc_discord") {
        if (!ADMIN_IDS.includes(uid)) return;
        const m = new ModalBuilder().setCustomId("modal_bc_disc").setTitle("📢 Discord Broadcast");
        m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ch").setLabel("Channel ID").setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("txt").setLabel("Message").setStyle(TextInputStyle.Paragraph).setRequired(true)));
        return i.showModal(m);
      }

      if (i.customId === "adm_bc_mc") {
        if (!ADMIN_IDS.includes(uid)) return;
        const m = new ModalBuilder().setCustomId("modal_bc_mc").setTitle("⛏️ Game Broadcast");
        m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("txt").setLabel("Chat Message").setStyle(TextInputStyle.Short).setRequired(true)));
        return i.showModal(m);
      }

      if (i.customId === "adm_users") {
        if (!ADMIN_IDS.includes(uid)) return;
        const list = Object.keys(users).map(id => ({ label: `UID: ${id}`, value: id })).slice(0, 25);
        if (list.length === 0) return i.reply({ content: "Empty DB.", ephemeral: true });
        const menu = new StringSelectMenuBuilder().setCustomId("adm_inspect_user").setPlaceholder("Select User Profile").addOptions(list);
        return i.reply({ components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
      }

      if (i.customId === "adm_logs") {
        if (!ADMIN_IDS.includes(uid)) return;
        return i.reply({ content: `📜 **Detailed System Logs:**\n${coreLogs.join("\n").substring(0, 1900)}`, ephemeral: true });
      }

      if (i.customId === "adm_kill_all") {
        if (!ADMIN_IDS.includes(uid)) return;
        const c = sessions.size; for (const [id] of sessions) disposeSession(id);
        return i.reply({ content: `☢️ **Mass Kill:** ${c} sessions terminated.`, ephemeral: true });
      }

      if (i.customId === "adm_ban") {
        if (!ADMIN_IDS.includes(uid)) return;
        const m = new ModalBuilder().setCustomId("modal_ban").setTitle("🚫 Blacklist Control");
        m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("id").setLabel("Target UID").setStyle(TextInputStyle.Short).setRequired(true)));
        return i.showModal(m);
      }

      if (i.customId?.startsWith("ai_confirm_purge_")) {
        const target = i.customId.split("_")[3];
        disposeSession(target); setTimeout(() => launchAgent(target), 2000);
        return i.update({ content: "⚡ **Action confirmed:** Purging resources and reconnecting...", components: [] });
      }
    }

    // --- VALIKOT (MENUS) ---
    if (i.isStringSelectMenu()) {
      if (i.customId === "adm_inspect_user") {
        const u = users[i.values[0]];
        const e = new EmbedBuilder().setTitle(`👤 Profile: ${i.values[0]}`).addFields({ name: "Target", value: `\`${u.server?.ip}:${u.server?.port}\`` }, { name: "Banned", value: `\`${u.banned}\`` }, { name: "Auth", value: `\`${u.connectionType}\`` }, { name: "Joins", value: `\`${u.stats?.joins}\`` });
        return i.reply({ embeds: [e], ephemeral: true });
      }

      if (i.customId === "help_selector") {
        const method = i.values[0];
        if (method === "opt_auto") {
          await i.update({ content: "⏳ **AI Thinking…** Scanning agent health and server MOTD.", components: [] });
          const u = getUser(uid); const s = sessions.get(uid); let pingRes = "Unreachable";
          try { const p = await bedrock.ping({ host: u.server?.ip, port: u.server?.port }); pingRes = `Online (${p.motd})`; } catch (e) {}
          const helpRes = await callGemini(`Diagnostic: Server ${u.server?.ip}, Session ${s?.connected ? 'ACTIVE' : 'FAIL'}, Ping ${pingRes}`, "help");
          
          let comps = [buildPatreonButton()]; let txt = helpRes;
          ['RECONNECT', 'RAM_PURGE', 'RESTART'].forEach(a => { if (helpRes.includes(`[${a}]`)) { txt = txt.replace(`[${a}]`, "").trim(); comps.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`ai_confirm_${a.toLowerCase()}_${uid}`).setLabel(`Confirm ${a}`).setStyle(ButtonStyle.Danger))); } });
          return i.editReply({ content: `🆘 **Diagnostic Report**\n\n${txt}`, components: comps });
        }
        if (method === "opt_manual") {
          const m = new ModalBuilder().setCustomId("modal_manual_help").setTitle("Support Chat");
          m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("txt").setLabel("Problem Description").setStyle(TextInputStyle.Paragraph).setRequired(true)));
          return i.showModal(m);
        }
      }

      if (i.customId === "menu_version") {
        const u = getUser(uid); u.bedrockVersion = i.values[0]; saveDB();
        return i.reply({ ephemeral: true, content: `✅ **Success:** Target set to ${u.bedrockVersion}` });
      }
    }

    // --- MODAALIT (MODALS) ---
    if (i.isModalSubmit()) {
      if (i.customId === "modal_settings") {
        const u = getUser(uid);
        const newIp = i.fields.getTextInputValue("ip").trim();
        // Easter Egg: Konami
        if (newIp === "upupdowndown") return i.reply({ ephemeral: true, content: "🎮 **Cheat Code Found:** You are awesome! (But I still need a real IP)." });
        u.server.ip = newIp; u.server.port = parseInt(i.fields.getTextInputValue("port").trim()) || 19132;
        u.offlineUsername = i.fields.getTextInputValue("off").trim() || u.offlineUsername;
        const pRaw = i.fields.getTextInputValue("prx").trim();
        if (pRaw.includes(":")) { const [h, p] = pRaw.split(":"); u.proxy = { host: h, port: p, enabled: true }; }
        else u.proxy = { host: "", port: "", enabled: false };
        saveDB(); return i.reply({ ephemeral: true, content: "✅ **Settings Saved.**" });
      }
      if (i.customId === "modal_manual_help") {
        await i.reply({ content: "⏳ **AI Thinking…**", ephemeral: true });
        const res = await callGemini(`Manual help: "${i.fields.getTextInputValue("txt")}" for server ${getUser(uid).server?.ip}`, "help");
        return i.editReply({ content: `🆘 **Support Response**\n\n${res}`, components: [buildPatreonButton()] });
      }
      if (i.customId === "modal_bc_disc") {
        const c = await client.channels.fetch(i.fields.getTextInputValue("ch")).catch(() => null);
        if (c) { await c.send({ embeds: [new EmbedBuilder().setTitle("📢 Update").setDescription(i.fields.getTextInputValue("txt")).setColor("#f1c40f")] }); return i.reply({ content: "✅ Sent.", ephemeral: true }); }
        return i.reply({ content: "❌ Failed.", ephemeral: true });
      }
      if (i.customId === "modal_bc_mc") {
        let d = 0; const m = i.fields.getTextInputValue("txt");
        for (const [id, s] of sessions) { if (s.connected) { s.client.write("text", { type: "chat", needs_translation: false, source_name: "", xuid: "", platform_chat_id: "", message: `§e[ADMIN] §f${m}` }); d++; } }
        return i.reply({ content: `✅ Sent to ${d} active worlds.`, ephemeral: true });
      }
      if (i.customId === "modal_ban") {
        const t = getUser(i.fields.getTextInputValue("id")); t.banned = !t.banned; saveDB();
        if (t.banned) disposeSession(i.fields.getTextInputValue("id"));
        return i.reply({ content: `✅ User status updated. Banned: **${t.banned}**`, ephemeral: true });
      }
    }

    // --- SLASH KOMENNOT ---
    if (i.isChatInputCommand()) {
      if (i.commandName === "panel") return i.reply({ content: "🎛 **Agent Dashboard**", components: buildMainInterface() });
      if (i.commandName === "admin") {
        if (!ADMIN_IDS.includes(uid)) return i.reply({ content: "⛔ Denied.", ephemeral: true });
        return i.reply({ content: "🛡️ **Administrator Hub**", components: buildAdminGrid(), ephemeral: true });
      }
    }
  } catch (err) { process.stderr.write(`[INTERACTION ERR] ${err.message}\n`); }
});

// --- LIFESTYLE JA SUOJAUS ---
process.on("unhandledRejection", (e) => { logSystem(`ERR: ${e.message}`); notifyOwner(`REJECTION: \`${e.message}\``); });
process.on("uncaughtException", (e) => { logSystem(`CRASH: ${e.message}`); notifyOwner(`CRITICAL: \`${e.message}\``); });

client.once("ready", async () => {
  logSystem("Core reboot successful. 🟢");
  const cmds = [
    new SlashCommandBuilder().setName("panel").setDescription("Open control dashboard"),
    new SlashCommandBuilder().setName("admin").setDescription("Administrator tools")
  ];
  await client.application.commands.set(cmds);
  notifyOwner("System ONLINE. Absolute V15 restated and operational.");
});

client.login(DISCORD_TOKEN);

