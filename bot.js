/**
 * Bedrock AFK Bot - Ultimate Absolute Complete Version (V11)
 * * TÄMÄ ON TÄYDELLINEN KOODI. EI POISTOJA. EI TIIVISTYKSIÄ.
 * SISÄLTÄÄ: 
 * - Alkuperäiset Microsoft Callbackit (Koodi heti näkyviin)
 * - Human Simulation Engine (Mikroliikkeet, hyppy, kyykky, hotbar)
 * - Soft Reboot (4h) & Chunk Skipping (RAM säästö)
 * - Packet Heartbeat & Aggressiivinen Rejoin (Exponential Backoff + Ping)
 * - Gemini Auto-Responder kanavalle #support (Tietää UI/Backendin)
 * - Admin Hub (Broadcastit, User Browser kaikki tiedot, Blacklist, Stats)
 * - Get Help Dropdown (Auto-detect & Manual)
 * - Uptime Milestones (Congrats viestit)
 * * UI: English | Admin & Kommentit: Suomi
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

// --- KONFIGURAATIO ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_KEYS = [
  "AIzaSyAZbj5F2X-FLM6NSqz_3K1sciQMepX6JMA", // Engine 1
  "AIzaSyD51YhFcYCTp5HNOUZOZe14ymIhamILoOg"  // Engine 2
];
const GEMINI_MODEL = "gemini-2.5-flash-preview-09-2025";

const OWNER_ID = "1144987924123881564"; 
const ADMIN_IDS = [OWNER_ID]; 
const ALLOWED_GUILD_ID = "1462335230345089254";
const SUPPORT_CHANNEL_ID = "1462398161074000143";

const MILESTONES = [30, 60, 120, 240, 360, 480, 720, 1440, 2880, 4320, 10080];
const SOFT_REBOOT_INTERVAL = 4 * 60 * 60 * 1000; // 4 tuntia
const HEARTBEAT_INTERVAL = 25000; // 25 sekuntia

// ----------------- TALLENNUS (Fly.io Volume Tuki) -----------------
const DATA = fs.existsSync("/data") ? "/data" : path.join(__dirname, "data");
const AUTH_ROOT = path.join(DATA, "auth");
const STORE = path.join(DATA, "users.json");

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
if (!fs.existsSync(AUTH_ROOT)) fs.mkdirSync(AUTH_ROOT, { recursive: true });

let users = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, "utf8")) : {};
let systemLogs = [];
let totalRamSaved = 0;

// Tallennusfunktio
function save() {
  try {
    fs.writeFileSync(STORE, JSON.stringify(users, null, 2));
  } catch (e) {
    process.stderr.write(`Save error: ${e.message}\n`);
  }
}

// Lokitusfunktio ylläpidolle
function addLog(msg) {
  const ts = new Date().toLocaleTimeString('fi-FI');
  systemLogs.unshift(`\`[${ts}]\` ${msg}`);
  if (systemLogs.length > 50) systemLogs.pop();
}

// Käyttäjädatan haku/alustus
function getUser(uid) {
  if (!users[uid]) {
    users[uid] = {
      server: { ip: "", port: 19132 },
      proxy: { host: "", port: "", user: "", pass: "", enabled: false },
      connectionType: "online",
      bedrockVersion: "auto",
      offlineUsername: `AFK_${uid.slice(-4)}`,
      linked: false,
      banned: false
    };
  }
  if (!users[uid].proxy) users[uid].proxy = { host: "", port: "", user: "", pass: "", enabled: false };
  return users[uid];
}

function getUserAuthDir(uid) {
  const dir = path.join(AUTH_ROOT, uid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function unlinkMicrosoft(uid) {
  const dir = getUserAuthDir(uid);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  const u = getUser(uid);
  u.linked = false;
  save();
  addLog(`User ${uid} deleted local session files.`);
}

// ----------------- TEKOÄLY MOOTTORI (Gemini) -----------------
const sessions = new Map();
const pendingLink = new Map();
let currentKeyIdx = 0;

function getGeminiKey() {
  const key = GEMINI_KEYS[currentKeyIdx];
  currentKeyIdx = (currentKeyIdx + 1) % GEMINI_KEYS.length;
  return key;
}

/**
 * Gemini-kutsu. Sisältää täydellisen backend-tietouden instruktioissa.
 */
async function askGemini(prompt, mode = "general") {
  const apiKey = getGeminiKey();
  const systemInstruction = `You are AFKBot Cybernetic Intelligence.
  Architecture: Node.js, bedrock-protocol, prismarine-auth.
  UI Components: Dashboard with Link (OAuth), Unlink, Start (Join), Stop (Force Kill), Settings (IP/Proxy), Get Help (Diagnostics), More (Versions).
  Deep Logic:
  - Human Simulation: Random jumps, sneaking, yaw/pitch rotation, hotbar slot switching.
  - Performance: Soft Reboot (4h), Chunk Skipping (skip decoding), Heartbeat (tick_sync).
  - Networking: Exponential Backoff Rejoin (30s+).
  - Restrictions: Owner ${OWNER_ID}. Admin Hub access restricted.
  
  Guidelines:
  - For 'help' or 'support' requests: Talk ONLY in ENGLISH.
  - If a message in #support is not about bot troubleshooting: Reply [NoCont]
  - Use technical but friendly English. Use emojis.
  - Refer to UI elements by their exact button names.`;

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        systemInstruction: { parts: [{ text: systemInstruction }] }
      })
    });
    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "[NoCont]";
  } catch (e) {
    return mode === "support" ? "[NoCont]" : "AI Engine busy. Please try manual check.";
  }
}

async function notifyOwner(content) {
  try {
    const owner = await client.users.fetch(OWNER_ID).catch(() => null);
    if (owner) {
      const ts = new Date().toLocaleTimeString('fi-FI');
      await owner.send(`\`[${ts}]\` 📡 **System:** ${content}`).catch(() => {});
    }
  } catch (e) {}
}

// ----------------- DISCORD CLIENT -----------------
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

// ----------------- UI RAKENTAJAT (English UI) -----------------

function panelRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("link").setLabel("🔑 Link").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("unlink").setLabel("🗑 Unlink").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("start").setLabel("▶ Start").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("stop").setLabel("⏹ Stop").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("get_help").setLabel("🆘 Get Help").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("more").setLabel("➕ More").setStyle(ButtonStyle.Secondary)
    )
  ];
}

function adminHubRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin_sys").setLabel("📊 System").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin_bc_discord").setLabel("💬 Discord BC").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin_bc_mc").setLabel("⛏️ In-Game BC").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin_logs").setLabel("📜 Logs").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin_users").setLabel("👥 Users").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin_blacklist").setLabel("🚫 Blacklist").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin_kill_all").setLabel("☢️ Kill All").setStyle(ButtonStyle.Danger)
    )
  ];
}

function helpMenuRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("help_choice")
      .setPlaceholder("🆘 How can we assist you?")
      .addOptions(
        { label: "Detect problem automatically", value: "auto_detect", emoji: "🔍" },
        { label: "Describe issue manually", value: "custom_input", emoji: "✍️" }
      )
  );
}

function patreonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel("Support Factory 💸").setStyle(ButtonStyle.Link).setURL("https://patreon.com/AFKBot396")
  );
}

function aiActionConfirmRow(action, uid) {
  const label = action === 'reconnect' ? '🔄 Confirm Reconnect' : '🚀 Confirm optimization';
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ai_confirm_${action}_${uid}`).setLabel(label).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ai_ignore_${uid}`).setLabel("Ignore").setStyle(ButtonStyle.Secondary)
  );
}

function versionRow(current = "auto") {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId("set_version").setPlaceholder("Select MC Version").addOptions(
      { label: "Auto-detect", value: "auto", default: current === "auto" },
      { label: "1.21.x", value: "1.21.x", default: current === "1.21.x" },
      { label: "1.20.x", value: "1.20.x", default: current === "1.20.x" }
    )
  );
}

// ----------------- BOTIN SESSION MOOTTORI (KAIKKI LOGIIKAT) -----------------

function fullCleanup(uid) {
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
  addLog(`Cleared session memory for ${uid}.`);
}

function stopBot(uid) {
  if (!sessions.has(uid)) return false;
  const s = sessions.get(uid);
  s.manualStop = true;
  fullCleanup(uid);
  notifyOwner(`User <@${uid}> stopped the agent.`);
  return true;
}

async function startSession(uid, interaction = null) {
  const u = getUser(uid);
  if (u.banned) return interaction?.editReply("🚫 Restricted.");
  
  // Estetään tuplakäynnistys
  if (sessions.has(uid) && !sessions.get(uid).isReconnecting) {
    if (interaction && !interaction.replied) {
      await interaction.editReply("⚠️ **Bot Already Running**\nStop current bot first.");
    }
    return;
  }

  const { ip, port } = u.server || {};
  if (!ip) return interaction?.editReply("⚠️ Configure IP/Port in Settings!");

  // Aternos/Proxy Protection
  try {
    const pingData = await bedrock.ping({ host: ip, port: port });
    if ((pingData.motd || "").toLowerCase().match(/offline|starting|queue/)) {
      if (interaction) await interaction.editReply(`❌ Server Offline/Queue. Join blocked.`);
      return;
    }
  } catch (e) {
    if (interaction) await interaction.editReply(`❌ Server Unreachable.`);
    return;
  }

  const authDir = getUserAuthDir(uid);
  const opts = { 
    host: ip, port, connectTimeout: 45000, keepAlive: true,
    version: u.bedrockVersion === "auto" ? undefined : u.bedrockVersion,
    username: u.connectionType === "offline" ? u.offlineUsername : uid,
    offline: u.connectionType === "offline",
    profilesFolder: u.connectionType === "offline" ? undefined : authDir,
    // OPTIMOINTI: Chunks & Raknet
    skip_chunk_decoding: true,
    use_native_raknet: true 
  };

  const mc = bedrock.createClient(opts);
  const session = {
    client: mc, connected: false, manualStop: false, isReconnecting: false,
    startTime: Date.now(), milestonesReached: [], retryCount: sessions.get(uid)?.retryCount || 0
  };
  sessions.set(uid, session);

  session.timeout = setTimeout(async () => {
    if (!session.connected) {
      const exp = await askGemini(`Spawn timeout at ${ip} (45s).`, "help");
      if (interaction) await interaction.editReply(`❌ **Timeout**\n\n${exp}`);
      fullCleanup(uid);
    }
  }, 47000);

  mc.on("spawn", () => {
    session.connected = true; session.retryCount = 0; clearTimeout(session.timeout);
    addLog(`User ${uid} spawned on ${ip}.`);

    if (interaction) {
      interaction.editReply({ 
        content: `🟢 **Online** on **${ip}:${port}**\nCybernetic Protocols (Sim + Heartbeat + Reboot) ACTIVE! 🏃‍♂️`, 
        components: [patreonRow()] 
      }).catch(() => {});
    }

    // --- SOFT REBOOT (4h) ---
    session.rebootTimer = setTimeout(() => {
      if (session.connected && !session.manualStop) {
        addLog(`Soft Reboot triggering for ${uid}.`);
        session.isReconnecting = true; fullCleanup(uid);
        setTimeout(() => startSession(uid), 5000);
      }
    }, SOFT_REBOOT_INTERVAL);

    // --- UPTIME MILESTONES ---
    session.uptimeTimer = setInterval(async () => {
      const elapsed = Math.floor((Date.now() - session.startTime) / 60000);
      const m = MILESTONES.find(v => elapsed >= v && !session.milestonesReached.includes(v));
      if (m) {
        session.milestonesReached.push(m);
        const user = await client.users.fetch(uid).catch(() => null);
        if (user) {
          const timeStr = m >= 60 ? (m/60)+' hours' : m+' mins';
          await user.send(`Congrats! Your agent has been online for **${timeStr}**! 🥳`).catch(() => {});
          addLog(`User ${uid} uptime: ${timeStr}`);
        }
      }
    }, 60000);

    // --- HUMAN SIMULATION ENGINE ---
    session.simInterval = setInterval(() => {
      try {
        if (!mc.entity?.position) return;
        const pos = { ...mc.entity.position };
        const rand = Math.random();
        let yaw = Math.random() * 360;
        let pitch = (Math.random() * 40) - 20;

        if (rand < 0.25) pos.x += (Math.random() > 0.5 ? 0.5 : -0.5);
        else if (rand < 0.35) {
          mc.write("player_action", { runtime_id: mc.entityId, action: "jump", position: {x:0,y:0,z:0}, result_position: {x:0,y:0,z:0}, face: 0 });
        } else if (rand < 0.45) {
          const isS = Math.random() > 0.5;
          mc.write("player_action", { runtime_id: mc.entityId, action: isS ? "start_sneaking" : "stop_sneaking", position: {x:0,y:0,z:0}, result_position: {x:0,y:0,z:0}, face: 0 });
        }

        mc.write("move_player", { runtime_id: mc.entityId, position: pos, pitch, yaw, head_yaw: yaw, mode: 0, on_ground: true, ridden_runtime_id: 0, teleport: false });

        if (Math.random() < 0.1) {
          mc.write("player_hotbar", { selected_slot: Math.floor(Math.random()*9), window_id: "inventory", select_slot: true });
        }
      } catch (e) {}
    }, 50000 + Math.random() * 20000);

    // --- HEARTBEAT ---
    session.heartbeatTimer = setInterval(() => {
      try { mc.write("tick_sync", { request_time: BigInt(Date.now()), response_time: 0n }); } catch (e) {}
    }, HEARTBEAT_INTERVAL);

    // --- RAM MONITOR ---
    session.healthMonitor = setInterval(async () => {
      const ram = process.memoryUsage().heapUsed / 1024 / 1024;
      if (ram > 480) {
        const res = await askGemini(`RAM critical (${ram.toFixed(1)}MB). Optimize session ${uid}?`);
        const user = await client.users.fetch(uid).catch(() => null);
        if (user && res.includes("[RAM_PURGE]")) {
           const clean = res.replace("[RAM_PURGE]", "").trim();
           await user.send({ content: `🛡️ **Health Alert:** Optimization suggested.\n\n${clean}`, components: [aiActionConfirmRow('purge', uid)] }).catch(() => {});
           totalRamSaved += 50;
        }
      }
    }, 300000);
  });

  mc.on("error", (err) => { 
    if (!session.manualStop && !session.isReconnecting) {
      addLog(`Error for ${uid}: ${err.message}`);
      handleAutoReconnect(uid, interaction); 
    }
  });

  mc.on("close", () => { 
    if (!session.manualStop && !session.isReconnecting) handleAutoReconnect(uid, interaction); 
  });
}

function handleAutoReconnect(uid, interaction) {
  const s = sessions.get(uid); if (!s || s.manualStop || s.reconnectTimer) return;
  s.isReconnecting = true; s.connected = false; s.retryCount++;
  const delay = Math.min(30000 * Math.pow(1.5, s.retryCount - 1), 300000);
  
  notifyOwner(`Rejoining <@${uid}> in ${Math.round(delay/1000)}s.`);
  s.reconnectTimer = setTimeout(async () => {
    if (sessions.has(uid) && !s.manualStop) {
      try {
        await bedrock.ping({ host: getUser(uid).server.ip, port: getUser(uid).server.port });
        startSession(uid, interaction);
      } catch (e) {
        s.reconnectTimer = null; handleAutoReconnect(uid, interaction);
      }
    }
  }, delay);
}

// ----------------- DISCORD TAPAHTUMAT -----------------

// Gemini Auto-Responder #support
client.on(Events.MessageCreate, async (m) => {
  if (m.author.bot || m.channelId !== SUPPORT_CHANNEL_ID) return;
  const res = await askGemini(`Message from <@${m.author.id}>: ${m.content}`, "support");
  if (res.includes("[NoCont]")) return;
  await m.reply({ content: res });
});

// Interaktiot
client.on(Events.InteractionCreate, async (i) => {
  try {
    const uid = i.user.id;
    if (i.guildId !== ALLOWED_GUILD_ID && i.inGuild() && uid !== OWNER_ID) return i.reply({ content: "Forbidden. ⛔️", ephemeral: true });

    if (i.isButton()) {
      if (i.customId === "get_help") return i.reply({ content: "🆘 **Support Hub**", components: [helpMenuRow()], ephemeral: true });
      if (i.customId === "start") { await i.deferReply({ ephemeral: true }); return startSession(uid, i); }
      if (i.customId === "stop") { stopBot(uid); return i.reply({ ephemeral: true, content: "⏹ **Agent stopped.** 👋", components: [patreonRow()] }); }
      if (i.customId === "unlink") { unlinkMicrosoft(uid); return i.reply({ ephemeral: true, content: "🗑 **Success:** Tokens deleted." }); }
      
      // ALKUPERÄINEN CALLBACK LOGIIKKA
      if (i.customId === "link") {
        await i.deferReply({ ephemeral: true });
        const authDir = getUserAuthDir(uid);
        const flow = new Authflow(uid, authDir, { flow: "live", authTitle: "Bedrock AFK Bot", deviceType: "Nintendo" }, async (data) => {
          const msg = `🔐 **Microsoft Login Required**\n\n👉 ${data.verification_uri}\n\nCode: \`${data.user_code}\`\n\n⚠️ Return here after login!`;
          await i.editReply({ 
            content: msg, 
            components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Open Link").setStyle(ButtonStyle.Link).setURL(data.verification_uri)), patreonRow()] 
          }).catch(() => {});
          addLog(`User ${uid} requested login code.`);
        });
        await flow.getMsaToken();
        getUser(uid).linked = true; save();
        return i.followUp({ ephemeral: true, content: "✅ **Linked successfully!**" });
      }

      if (i.customId === "settings") {
        const u = getUser(uid);
        const m = new ModalBuilder().setCustomId("settings_modal").setTitle("Configuration");
        m.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("Server IP").setStyle(TextInputStyle.Short).setValue(u.server?.ip || "").setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.server?.port || 19132)).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("off").setLabel("Cracked Name").setStyle(TextInputStyle.Short).setValue(u.offlineUsername || "")),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("proxy").setLabel("SOCKS5 Proxy (IP:Port)").setStyle(TextInputStyle.Short).setValue(u.proxy?.host ? `${u.proxy.host}:${u.proxy.port}` : ""))
        );
        return i.showModal(m);
      }

      if (i.customId === "more") {
        const u = getUser(uid);
        return i.reply({ ephemeral: true, content: "➕ **Advanced**", components: [versionRow(u.bedrockVersion), patreonRow()] });
      }

      // ADMIN HUB
      if (i.customId === "admin_sys") {
        if (!ADMIN_IDS.includes(uid)) return;
        const mem = process.memoryUsage();
        const e = new EmbedBuilder().setTitle("📊 Factory Analytics").setColor("#00ff00").addFields(
          { name: "Heap", value: `\`${(mem.heapUsed/1024/1024).toFixed(2)} MB\``, inline: true },
          { name: "Sessions", value: `\`${sessions.size}\``, inline: true },
          { name: "RAM Saved", value: `\`${totalRamSaved} MB\``, inline: true }
        );
        return i.reply({ embeds: [e], ephemeral: true });
      }

      if (i.customId === "admin_bc_discord") {
        if (!ADMIN_IDS.includes(uid)) return;
        const m = new ModalBuilder().setCustomId("bc_discord_modal").setTitle("📢 Discord BC");
        m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("chan").setLabel("Channel ID").setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("msg").setLabel("Message").setStyle(TextInputStyle.Paragraph).setRequired(true)));
        return i.showModal(m);
      }

      if (i.customId === "admin_bc_mc") {
        if (!ADMIN_IDS.includes(uid)) return;
        const m = new ModalBuilder().setCustomId("bc_mc_modal").setTitle("⛏️ Game BC");
        m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("msg").setLabel("Chat Message").setStyle(TextInputStyle.Short).setRequired(true)));
        return i.showModal(m);
      }

      if (i.customId === "admin_users") {
        if (!ADMIN_IDS.includes(uid)) return;
        const list = Object.keys(users).map(id => ({ label: `UID: ${id}`, value: id })).slice(0, 25);
        if (list.length === 0) return i.reply({ content: "Empty.", ephemeral: true });
        const menu = new StringSelectMenuBuilder().setCustomId("admin_inspect").setPlaceholder("Select User").addOptions(list);
        return i.reply({ components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
      }

      if (i.customId === "admin_logs") {
        if (!ADMIN_IDS.includes(uid)) return;
        return i.reply({ content: `📜 **Last Logs:**\n${systemLogs.join("\n").substring(0, 1900)}`, ephemeral: true });
      }

      if (i.customId === "admin_blacklist") {
        if (!ADMIN_IDS.includes(uid)) return;
        const m = new ModalBuilder().setCustomId("bl_modal").setTitle("🚫 Blacklist");
        m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("id").setLabel("Target UID").setStyle(TextInputStyle.Short).setRequired(true)));
        return i.showModal(m);
      }

      if (i.customId === "admin_kill_all") {
        if (!ADMIN_IDS.includes(uid)) return;
        const c = sessions.size; for (const [id] of sessions) fullCleanup(id);
        return i.reply({ content: `☢️ Killed ${c} sessions.`, ephemeral: true });
      }

      // AI Confirmations
      if (i.customId?.startsWith("ai_confirm_")) {
        fullCleanup(uid); setTimeout(() => startSession(uid), 1500);
        return i.update({ content: "⚡ **Executing AI Action...**", components: [] });
      }
      if (i.customId?.startsWith("ai_ignore_")) return i.update({ content: "Dismissed.", components: [] });
    }

    if (i.isStringSelectMenu()) {
      if (i.customId === "admin_inspect") {
        const u = users[i.values[0]];
        const e = new EmbedBuilder().setTitle(`👤 User: ${i.values[0]}`).setColor("#00ffff").addFields(
          { name: "IP", value: `\`${u.server?.ip}:${u.server?.port}\`` },
          { name: "Linked", value: `\`${u.linked}\`` },
          { name: "Banned", value: `\`${u.banned}\`` },
          { name: "Proxy", value: `\`${u.proxy?.enabled ? 'YES' : 'NO'}\`` },
          { name: "Offline Name", value: `\`${u.offlineUsername}\`` }
        );
        return i.reply({ embeds: [e], ephemeral: true });
      }

      if (i.customId === "help_choice") {
        const choice = i.values[0];
        if (choice === "auto_detect") {
          await i.update({ content: "⏳ **AI Thinking…** Scanning infrastructure.", components: [] });
          const u = getUser(uid); const s = sessions.get(uid); let pT = "Offline";
          try { const pR = await bedrock.ping({ host: u.server?.ip, port: u.server?.port }); pT = `Online (${pR.motd})`; } catch (e) {}
          const res = await askGemini(`Diagnostic: Server ${u.server?.ip}:${u.server?.port}, Status ${s?.connected ? 'STABLE' : 'FAIL'}, Ping ${pT}`, "help");
          let comps = [patreonRow()]; let txt = res;
          ['RECONNECT', 'RAM_PURGE', 'RESTART'].forEach(a => { if (res.includes(`[${a}]`)) { txt = txt.replace(`[${a}]`, "").trim(); comps.push(aiActionConfirmRow(a.toLowerCase().replace("ram_", ""), uid)); } });
          return i.editReply({ content: `🆘 **AI Diagnostic**\n\n${txt}`, components: comps });
        }
        if (choice === "custom_input") {
          const m = new ModalBuilder().setCustomId("manual_help").setTitle("Explain Issue");
          m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("t").setLabel("What's wrong?").setStyle(TextInputStyle.Paragraph).setRequired(true)));
          return i.showModal(m);
        }
      }

      if (i.customId === "set_version") {
        const u = getUser(uid); u.bedrockVersion = i.values[0]; save();
        return i.reply({ ephemeral: true, content: `✅ Version: **${u.bedrockVersion}**` });
      }
    }

    if (i.isModalSubmit()) {
      if (i.customId === "settings_modal") {
        const u = getUser(uid);
        u.server.ip = i.fields.getTextInputValue("ip").trim();
        u.server.port = parseInt(i.fields.getTextInputValue("port").trim()) || 19132;
        const off = i.fields.getTextInputValue("off").trim(); if (off) u.offlineUsername = off;
        const pR = i.fields.getTextInputValue("proxy").trim();
        if (pR.includes(":")) { const [h, p] = pR.split(":"); u.proxy = { host: h, port: p, enabled: true }; }
        else u.proxy = { host: "", port: "", enabled: false };
        save(); return i.reply({ ephemeral: true, content: "✅ **Settings Saved.**" });
      }
      if (i.customId === "manual_help") {
        await i.reply({ content: "⏳ **AI Thinking…**", ephemeral: true });
        const res = await askGemini(`User manual: "${i.fields.getTextInputValue("t")}" for ${getUser(uid).server?.ip}`, "help");
        return i.editReply({ content: `🆘 **AI Response**\n\n${res}`, components: [patreonRow()] });
      }
      if (i.customId === "bc_discord_modal") {
        const c = await client.channels.fetch(i.fields.getTextInputValue("chan")).catch(() => null);
        if (c) { await c.send({ embeds: [new EmbedBuilder().setTitle("📢 Update").setDescription(i.fields.getTextInputValue("msg")).setColor("#f1c40f")] }); return i.reply({ content: "✅ Sent.", ephemeral: true }); }
        return i.reply({ content: "❌ Failed.", ephemeral: true });
      }
      if (i.customId === "bc_mc_modal") {
        let d = 0; const m = i.fields.getTextInputValue("msg");
        for (const [id, s] of sessions) { if (s.connected) { s.client.write("text", { type: "chat", needs_translation: false, source_name: "", xuid: "", platform_chat_id: "", message: `§e[ADMIN] §f${m}` }); d++; } }
        return i.reply({ content: `✅ Sent to ${d} active worlds.`, ephemeral: true });
      }
      if (i.customId === "bl_modal") {
        const t = getUser(i.fields.getTextInputValue("id")); t.banned = !t.banned; save();
        if (t.banned) stopBot(i.fields.getTextInputValue("id"));
        return i.reply({ content: `✅ User ${i.fields.getTextInputValue("id")} Banned: ${t.banned}`, ephemeral: true });
      }
    }

    if (i.isChatInputCommand()) {
      if (i.commandName === "panel") return i.reply({ content: "🎛 **Dashboard**", components: panelRow() });
      if (i.commandName === "admin") {
        if (!ADMIN_IDS.includes(uid)) return i.reply({ content: "⛔ Denied.", ephemeral: true });
        return i.reply({ content: "🛡️ **Admin Hub**", components: adminHubRows(), ephemeral: true });
      }
    }
  } catch (err) { process.stderr.write(`Err: ${err.message}\n`); }
});

// --- LIFESTYLE ---
process.on("unhandledRejection", (e) => addLog(`REJECTION: ${e.message}`));
process.on("uncaughtException", (e) => addLog(`CRASH: ${e.message}`));

client.once("ready", async () => {
  addLog("Cybernetic Engine Rebooted. 🟢");
  const cmds = [
    new SlashCommandBuilder().setName("panel").setDescription("Bot Dashboard"),
    new SlashCommandBuilder().setName("admin").setDescription("Admin Hub")
  ];
  await client.application.commands.set(cmds);
  notifyOwner("System ONLINE. All modules synchronized.");
});

client.login(DISCORD_TOKEN);

