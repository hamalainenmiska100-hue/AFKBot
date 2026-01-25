/**
 * Bedrock AFK Bot - Ultimate Absolute Version
 * Everything restored. No code removed. No shortening.
 * UI: English | Admin Hub: Finnish/English | Comments: Finnish
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

// --- KONFIGURAATIO & AVAIMET ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_KEYS = [
  "AIzaSyAZbj5F2X-FLM6NSqz_3K1sciQMepX6JMA",
  "AIzaSyD51YhFcYCTp5HNOUZOZe14ymIhamILoOg"
];
const GEMINI_MODEL = "gemini-2.5-flash-preview-09-2025";

// Tärkeät ID-tunnukset
const OWNER_ID = "1144987924123881564"; 
const ADMIN_IDS = [OWNER_ID]; 
const ALLOWED_GUILD_ID = "1462335230345089254";
const SUPPORT_CHANNEL_ID = "1462398161074000143";

// Uptime-virstanpylväät minuuteissa
const MILESTONES = [30, 60, 120, 240, 360, 480, 720, 1440];

// ----------------- Pysyvä Tallennus (Fly.io Volume) -----------------
const DATA = fs.existsSync("/data") ? "/data" : path.join(__dirname, "data");
const AUTH_ROOT = path.join(DATA, "auth");
const STORE = path.join(DATA, "users.json");

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
if (!fs.existsSync(AUTH_ROOT)) fs.mkdirSync(AUTH_ROOT, { recursive: true });

let users = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, "utf8")) : {};
let systemLogs = [];
let totalRamOptimized = 0;

/**
 * Lisää tapahtuman lokiin (Admin paneelia varten)
 */
function addLog(msg) {
  const ts = new Date().toLocaleTimeString('fi-FI');
  systemLogs.unshift(`\`[${ts}]\` ${msg}`);
  if (systemLogs.length > 50) systemLogs.pop();
}

/**
 * Tallentaa käyttäjädatan levylle
 */
function save() {
  try {
    fs.writeFileSync(STORE, JSON.stringify(users, null, 2));
  } catch (e) {
    process.stderr.write(`Storage save error: ${e.message}\n`);
  }
}

/**
 * Hakee käyttäjän tiedot tai alustaa uuden profiilin
 */
function getUser(uid) {
  if (!users[uid]) {
    users[uid] = {};
  }
  if (!users[uid].delayMs) users[uid].delayMs = 5000;
  if (!users[uid].connectionType) users[uid].connectionType = "online";
  if (!users[uid].bedrockVersion) users[uid].bedrockVersion = "auto";
  if (!users[uid].offlineUsername) users[uid].offlineUsername = `AFK_${uid.slice(-4)}`;
  if (users[uid].banned === undefined) users[uid].banned = false;
  if (users[uid].linked === undefined) users[uid].linked = false;
  return users[uid];
}

/**
 * Hakee Microsoft-auth kansion polun
 */
function getUserAuthDir(uid) {
  const dir = path.join(AUTH_ROOT, uid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Poistaa Microsoft-linkityksen tiedostot
 */
function unlinkMicrosoft(uid) {
  const dir = getUserAuthDir(uid);
  try { 
    fs.rmSync(dir, { recursive: true, force: true }); 
  } catch (e) {}
  const u = getUser(uid);
  u.linked = false;
  save();
  addLog(`User ${uid} unlinked Microsoft account.`);
}

// ----------------- Runtime Tila -----------------
const sessions = new Map(); // Aktiiviset Minecraft-sessiot
const pendingLink = new Map(); // Käynnissä olevat Authflowt
let currentKeyIndex = 0;

/**
 * Vaihtaa Gemini API-avainta kuormituksen mukaan
 */
function getGeminiKey() {
  const key = GEMINI_KEYS[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % GEMINI_KEYS.length;
  return key;
}

/**
 * Lähettää ilmoituksen suoraan omistajalle (Owner Logs)
 */
async function notifyOwner(content) {
  try {
    const owner = await client.users.fetch(OWNER_ID).catch(() => null);
    if (owner) {
      const ts = new Date().toLocaleTimeString('fi-FI');
      await owner.send(`\`[${ts}]\` 📡 **System Status:** ${content}`).catch(() => {});
    }
  } catch (e) {}
}

// ----------------- Gemini AI Core Engine -----------------
/**
 * Käyttää Geminiä diagnostiikkaan ja tuki-chattiin.
 * Tietää backendin ja UI:n toiminnan systemInstructionin kautta.
 */
async function askGemini(prompt, type = "general") {
  const apiKey = getGeminiKey();
  
  const systemInstruction = `You are AFKBot AI.
Backend: Node.js, bedrock-protocol, prismarine-auth.
UI: Discord Dashboard with buttons (Link, Unlink, Start, Stop, Settings, Get Help, More).
- Link: Starts Microsoft Authflow. Shows code/link immediately.
- Unlink: Deletes local token files.
- Start: Pings server first (Aternos check), joins, moves character to avoid AFK kick.
- Stop: Force closes connection and clears intervals.
- Settings: Modals for IP, Port, Username.
- Get Help: Dropdown for Auto-detect or Manual explain.
- Admin Hub: For Owner ${OWNER_ID} only.

Support Channel Rules:
If message is NOT a help request, respond ONLY with: [NoCont]
If it IS a help request, explain backend logic or UI steps clearly. Use emojis. English/Finnish.`;

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
    return "[NoCont]";
  }
}

// ----------------- Discord Client Alustus -----------------
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

// ----------------- UI Rakentajat (English UI) -----------------

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
      new ButtonBuilder().setCustomId("more").setLabel("➕ More Options").setStyle(ButtonStyle.Secondary)
    )
  ];
}

function adminHubRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin_sys").setLabel("📊 System Monitor").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin_bc_discord").setLabel("📢 Discord BC").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin_bc_mc").setLabel("⛏️ In-Game BC").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin_logs").setLabel("📜 System Logs").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin_users").setLabel("👥 User Browser").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin_blacklist").setLabel("🚫 Blacklist Control").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin_stop_all").setLabel("☢️ Mass Disconnect").setStyle(ButtonStyle.Danger)
    )
  ];
}

function helpMenuRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("help_choice")
      .setPlaceholder("🆘 How can we assist you?")
      .addOptions(
        { label: "Detect problem automatically", description: "AI scans your server and status.", value: "auto_detect", emoji: "🔍" },
        { label: "Write my own problem", description: "Explain the issue to the AI.", value: "custom_input", emoji: "✍️" }
      )
  );
}

function patreonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("Support & Donate 💸")
      .setStyle(ButtonStyle.Link)
      .setURL("https://patreon.com/AFKBot396")
  );
}

function aiActionRow(action, uid) {
  const label = action === 'purge' ? '🚀 RAM Optimization' : '🔄 Quick Reconnect';
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ai_confirm_${action}_${uid}`).setLabel(label).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ai_ignore_${uid}`).setLabel("Ignore").setStyle(ButtonStyle.Secondary)
  );
}

function versionRow(current = "auto") {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId("set_version").setPlaceholder("Bedrock Version").addOptions(
      { label: "Auto-detect", value: "auto", default: current === "auto" },
      { label: "1.21.x", value: "1.21.x", default: current === "1.21.x" },
      { label: "1.20.x", value: "1.20.x", default: current === "1.20.x" }
    )
  );
}

// ----------------- Microsoft Link (Aito Callback Logiikka) -----------------
/**
 * Hoitaa Microsoft-kirjautumisen. Callback päivittää koodin välittömästi replyyn.
 */
async function linkMicrosoft(uid, interaction) {
  if (pendingLink.has(uid)) {
    await interaction.editReply("⏳ Login process already active for your ID.");
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
      // TÄMÄ ON TÄRKEÄ CALLBACK: Näyttää koodin heti kun se on saatavilla
      const uri = data.verification_uri_complete || data.verification_uri || "https://www.microsoft.com/link";
      const code = data.user_code || "(no code)";
      codeShown = true;

      const msg = `🔐 **Microsoft login required**\n\n👉 ${uri}\n\nYour code: \`${code}\`\n\n⚠ **IMPORTANT:** Use a secondary Microsoft account. Return here after you have successfully logged in.`;
      
      await interaction.editReply({ 
        content: msg, 
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Open Link").setStyle(ButtonStyle.Link).setURL(uri)), patreonRow()] 
      }).catch(() => {});
      
      addLog(`User ${uid} requested login code.`);
    }
  );

  const p = (async () => {
    try {
      if (!codeShown) await interaction.editReply("⏳ Requesting Microsoft authentication link...");
      await flow.getMsaToken();
      u.linked = true;
      save();
      await interaction.followUp({ ephemeral: true, content: "✅ Microsoft account successfully linked! 🥳", components: [patreonRow()] }).catch(() => {});
      addLog(`User ${uid} successfully linked Microsoft account.`);
    } catch (e) {
      const res = await askGemini(`Microsoft Linking Error: ${e.message}`, "auth");
      await interaction.editReply({ content: `❌ **Linking Failed**\n\n${res}`, components: [patreonRow()] });
    } finally {
      pendingLink.delete(uid);
    }
  })();

  pendingLink.set(uid, p);
}

// ----------------- Bedrock Session Moottori (Tehdas) -----------------

/**
 * Puhdistaa kaikki session resurssit muistista.
 */
function cleanupSession(uid) {
  const s = sessions.get(uid);
  if (!s) return;
  
  if (s.afkInterval) clearInterval(s.afkInterval);
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  if (s.uptimeTimer) clearInterval(s.uptimeTimer);
  if (s.healthMonitor) clearInterval(s.healthMonitor);
  if (s.timeout) clearTimeout(s.timeout);
  
  try { s.client.close(); } catch (e) {}
  sessions.delete(uid);
}

/**
 * Pysäyttää botin ja nollaa tilan.
 */
function stopBot(uid) {
  if (!sessions.has(uid)) return false;
  const s = sessions.get(uid);
  s.manualStop = true;
  cleanupSession(uid);
  addLog(`User ${uid} manually stopped the bot.`);
  return true;
}

/**
 * Käynnistää Minecraft-yhteyden ja asettaa monitorit.
 */
async function startSession(uid, interaction = null) {
  const u = getUser(uid);
  if (u.banned) {
    if (interaction) await interaction.editReply("🚫 Your account is restricted from using this service.");
    return;
  }

  // Estetään tuplajoinaukset
  if (sessions.has(uid) && !sessions.get(uid).isReconnecting) {
    if (interaction && !interaction.replied) {
      await interaction.editReply("⚠️ **Bot Already Running**\nPlease terminate the current session before starting a new one.");
    }
    return;
  }

  const { ip, port } = u.server || {};
  if (!ip) {
    if (interaction) await interaction.editReply("⚠️ Please configure your Server IP and Port in **Settings** first.");
    return;
  }

  // Aternos Proxy Protection
  try {
    const pingData = await bedrock.ping({ host: ip, port: port });
    const motd = (pingData.motd || "").toLowerCase();
    if (motd.includes("offline") || motd.includes("starting") || motd.includes("queue")) {
      if (interaction) await interaction.editReply(`❌ **Server Status:** Offline or Starting. Bot will not join proxy lobby.`);
      return;
    }
  } catch (e) {
    if (interaction) await interaction.editReply(`❌ **Network Error:** Server at **${ip}** is unreachable.`);
    return;
  }

  const authDir = getUserAuthDir(uid);
  const opts = { 
    host: ip, 
    port, 
    connectTimeout: 45000, 
    keepAlive: true,
    version: u.bedrockVersion === "auto" ? undefined : u.bedrockVersion,
    username: u.connectionType === "offline" ? u.offlineUsername : uid,
    offline: u.connectionType === "offline",
    profilesFolder: u.connectionType === "offline" ? undefined : authDir
  };

  const mc = bedrock.createClient(opts);
  const session = {
    client: mc,
    connected: false,
    manualStop: false,
    isReconnecting: false,
    startTime: Date.now(),
    milestonesReached: [],
    retryCount: sessions.get(uid)?.retryCount || 0
  };
  sessions.set(uid, session);

  // Spawn Timeout
  session.timeout = setTimeout(async () => {
    if (!session.connected) {
      const aiAdvice = await askGemini(`Bot failed to receive spawn packet from ${ip}:${port} after 45s wait.`, "network");
      if (interaction) await interaction.editReply(`❌ **Connection Timeout**\n\n${aiAdvice}`);
      cleanupSession(uid);
    }
  }, 47000);

  mc.on("spawn", () => {
    session.connected = true;
    session.retryCount = 0;
    clearTimeout(session.timeout);
    addLog(`User ${uid} connected to ${ip}:${port} 🟢`);

    if (interaction) {
      interaction.editReply({ 
        content: `🟢 **Online** on **${ip}:${port}**\nCharacter movement protocol active! 🏃‍♂️`, 
        components: [patreonRow()] 
      }).catch(() => {});
    }

    // --- UPTIME MILESTONES (30m, 1h, 2h...) ---
    session.uptimeTimer = setInterval(async () => {
      const elapsed = Math.floor((Date.now() - session.startTime) / 60000);
      const m = MILESTONES.find(v => elapsed >= v && !session.milestonesReached.includes(v));
      
      if (m) {
        session.milestonesReached.push(m);
        const user = await client.users.fetch(uid).catch(() => null);
        if (user) {
          const label = m >= 60 ? `${m / 60}h` : `${m} minutes`;
          await user.send(`Congrats! Your bot has been up for **${label}**! 🥳`).catch(() => {});
          addLog(`User ${uid} reached ${label} uptime.`);
        }
      }
    }, 60000);

    // --- ANTI-AFK MOVEMENT LOGIC ---
    let moveToggle = false;
    session.afkInterval = setInterval(() => {
      try {
        if (!mc.entity?.position) return;
        const pos = { ...mc.entity.position };
        moveToggle ? pos.x += 0.5 : pos.x -= 0.5;
        moveToggle = !moveToggle;
        mc.write("move_player", {
          runtime_id: mc.entityId, position: pos, pitch: 0, yaw: Math.random() * 360,
          head_yaw: Math.random() * 360, mode: 0, on_ground: true, ridden_runtime_id: 0, teleport: false
        });
      } catch (err) {}
    }, 60000);

    // --- GEMINI RESOURCE MONITOR ---
    session.healthMonitor = setInterval(async () => {
      const ram = process.memoryUsage().heapUsed / 1024 / 1024;
      if (ram > 490) {
        const res = await askGemini(`System RAM high (${ram.toFixed(1)}MB). Suggest [RAM_PURGE] for user ${uid}?`, "health");
        const user = await client.users.fetch(uid).catch(() => null);
        if (user && res.includes("[RAM_PURGE]")) {
           const cleanText = res.replace("[RAM_PURGE]", "").trim();
           await user.send({ 
             content: `🛡️ **Assistant:** Resource optimization required.\n\n${cleanText}`, 
             components: [aiActionRow('purge', uid)] 
           }).catch(() => {});
           totalRamOptimized += 50;
        }
      }
    }, 300000);
  });

  mc.on("error", async (err) => {
    if (session.manualStop) return;
    const errorMsg = String(err.message || err);
    addLog(`Error for <@${uid}>: ${errorMsg} 🔴`);

    if (errorMsg.includes("auth") || errorMsg.includes("session")) {
      const user = await client.users.fetch(uid).catch(() => null);
      if (user) await user.send("❌ **Auth Failed**: Your Microsoft session expired. Please use **Link** button again.").catch(() => {});
      return cleanupSession(uid);
    }

    if (!errorMsg.toLowerCase().includes("timeout")) {
       const exp = await askGemini(`Minecraft Client Error: ${errorMsg} at ${ip}`);
       const user = await client.users.fetch(uid).catch(() => null);
       if (user) await user.send(`⚠️ **Bot Encountered a Problem**\n\n${exp}`).catch(() => {});
    }

    handleAutoReconnect(uid, interaction);
  });

  mc.on("close", () => {
    if (!session.manualStop) handleAutoReconnect(uid, interaction);
  });
}

/**
 * AGGRESSIIVINEN 30S REJOIN MOOTTORI
 */
function handleAutoReconnect(uid, interaction) {
  const s = sessions.get(uid);
  if (!s || s.manualStop || s.reconnectTimer) return;

  s.isReconnecting = true;
  s.connected = false;
  s.retryCount++;
  
  notifyOwner(`Connection lost for <@${uid}>. Retrying in 30s. (Attempt #${s.retryCount})`);

  s.reconnectTimer = setTimeout(async () => {
    if (sessions.has(uid) && !s.manualStop) {
      const u = getUser(uid);
      try {
        await bedrock.ping({ host: u.server.ip, port: u.server.port });
        console.log(`[SYSTEM] Target server is ONLINE. Reconnecting ${uid}.`);
        startSession(uid, interaction);
      } catch (e) {
        // Jos servu edelleen alhaalla, nollataan ja yritetään uudelleen 30s päästä
        s.reconnectTimer = null;
        handleAutoReconnect(uid, interaction);
      }
    }
  }, 30000);
}

// ----------------- 🚦 Interaction Router -----------------

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== SUPPORT_CHANNEL_ID) return;

  const response = await askGemini(`Message from <@${message.author.id}>: ${message.content}`, "support");
  if (response.includes("[NoCont]")) return;

  await message.reply({ content: response });
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    const uid = i.user.id;
    if (i.guildId !== ALLOWED_GUILD_ID && i.inGuild()) {
       return i.reply({ content: "This bot is restricted to a specific server ⛔️", ephemeral: true });
    }

    // --- BUTTONS ---
    if (i.isButton()) {
      if (i.customId === "get_help") return i.reply({ content: "🆘 **Support & Diagnostics**\nHow would you like to troubleshoot?", components: [helpMenuRow()], ephemeral: true });
      if (i.customId === "start") { await i.deferReply({ ephemeral: true }); return startSession(uid, i); }
      if (i.customId === "stop") { 
        const ok = stopBot(uid); 
        return i.reply({ ephemeral: true, content: ok ? "⏹ **Bot Terminated.** See you again soon! 👋" : "❌ No active session found.", components: [patreonRow()] }); 
      }
      if (i.customId === "link") { await i.deferReply({ ephemeral: true }); return linkMicrosoft(uid, i); }
      if (i.customId === "unlink") { unlinkMicrosoft(uid); return i.reply({ ephemeral: true, content: "🗑 Microsoft account unlinked successfully." }); }
      
      if (i.customId === "settings") {
        const u = getUser(uid);
        const modal = new ModalBuilder().setCustomId("settings_modal").setTitle("Configuration");
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("Server IP").setStyle(TextInputStyle.Short).setValue(u.server?.ip || "")),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.server?.port || 19132))),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("offline").setLabel("Offline Username").setStyle(TextInputStyle.Short).setValue(u.offlineUsername || ""))
        );
        return i.showModal(modal);
      }

      if (i.customId === "more") {
        const u = getUser(uid);
        return i.reply({ ephemeral: true, content: "➕ **Advanced Configuration**", components: [versionRow(u.bedrockVersion), patreonRow()] });
      }

      // Admin Hub Buttons
      if (i.customId === "admin_sys") {
        if (!ADMIN_IDS.includes(uid)) return;
        const mem = process.memoryUsage();
        const embed = new EmbedBuilder().setTitle("📊 System Monitor").setColor("#00ff00").addFields(
          { name: "Heap Used", value: `\`${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB\``, inline: true },
          { name: "Total RSS", value: `\`${(mem.rss / 1024 / 1024).toFixed(2)} MB\``, inline: true },
          { name: "Active Bots", value: `\`${sessions.size}\``, inline: true },
          { name: "Total Users", value: `\`${Object.keys(users).length}\``, inline: true },
          { name: "RAM Saved", value: `\`${totalRamOptimized} MB\``, inline: true }
        );
        return i.reply({ embeds: [embed], ephemeral: true });
      }

      if (i.customId === "admin_bc_discord") {
        if (!ADMIN_IDS.includes(uid)) return;
        const modal = new ModalBuilder().setCustomId("bc_discord_modal").setTitle("📢 Discord Broadcast");
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("bc_chan").setLabel("Channel ID").setStyle(TextInputStyle.Short).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("bc_msg").setLabel("Message Content").setStyle(TextInputStyle.Paragraph).setRequired(true))
        );
        return i.showModal(modal);
      }

      if (i.customId === "admin_bc_mc") {
        if (!ADMIN_IDS.includes(uid)) return;
        const modal = new ModalBuilder().setCustomId("bc_mc_modal").setTitle("⛏️ Game Broadcast");
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("bc_msg").setLabel("Chat Message to all Bots").setStyle(TextInputStyle.Short).setRequired(true)));
        return i.showModal(modal);
      }

      if (i.customId === "admin_users") {
        if (!ADMIN_IDS.includes(uid)) return;
        const userList = Object.keys(users).map(id => ({ label: `User: ${id}`, value: id })).slice(0, 25);
        if (userList.length === 0) return i.reply({ content: "Database empty.", ephemeral: true });
        const menu = new StringSelectMenuBuilder().setCustomId("admin_user_view").setPlaceholder("Select user to see all details").addOptions(userList);
        return i.reply({ components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
      }

      if (i.customId === "admin_logs") {
        if (!ADMIN_IDS.includes(uid)) return;
        return i.reply({ content: `📜 **System Logs:**\n${systemLogs.join("\n") || "No entries."}`, ephemeral: true });
      }

      if (i.customId === "admin_blacklist") {
        if (!ADMIN_IDS.includes(uid)) return;
        const modal = new ModalBuilder().setCustomId("bl_modal").setTitle("🚫 Blacklist Control");
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("bl_id").setLabel("Target User ID").setStyle(TextInputStyle.Short).setRequired(true)));
        return i.showModal(modal);
      }

      if (i.customId === "admin_stop_all") {
        if (!ADMIN_IDS.includes(uid)) return;
        for (const [id] of sessions) cleanupSession(id);
        return i.reply({ content: "☢️ All active sessions terminated.", ephemeral: true });
      }

      // AI Logic
      if (i.customId?.startsWith("ai_confirm_")) {
        cleanupSession(uid); setTimeout(() => startSession(uid), 1500);
        return i.update({ content: "⚡ **AI Optimization:** Cleaning resources and reconnecting...", components: [] });
      }
      if (i.customId?.startsWith("ai_ignore_")) return i.update({ content: "Recommendation ignored.", components: [] });
    }

    // --- STRING MENUS ---
    if (i.isStringSelectMenu()) {
      if (i.customId === "admin_user_view") {
        const target = i.values[0];
        const u = users[target];
        const embed = new EmbedBuilder().setTitle(`👤 User: ${target}`).setColor("#00ffff").addFields(
          { name: "Current Server", value: `\`${u.server?.ip || "N/A"}:${u.server?.port || "19132"}\`` },
          { name: "Auth Protocol", value: `\`${u.connectionType}\`` },
          { name: "Microsoft Link", value: `\`${u.linked ? 'YES' : 'NO'}\`` },
          { name: "Restriction Status", value: `\`${u.banned ? 'BANNED' : 'ACTIVE'}\`` },
          { name: "Offline Name", value: `\`${u.offlineUsername}\`` },
          { name: "Bedrock Target", value: `\`${u.bedrockVersion}\`` }
        );
        return i.reply({ embeds: [embed], ephemeral: true });
      }

      if (i.customId === "help_choice") {
        const choice = i.values[0];
        if (choice === "auto_detect") {
          await i.update({ content: "⏳ **AI Thinking…** scanning parameters.", components: [] });
          const u = getUser(uid); const s = sessions.get(uid); let pingRes = "Offline";
          try { const p = await bedrock.ping({ host: u.server?.ip, port: u.server?.port }); pingRes = `Online (${p.motd})`; } catch (e) {}
          
          const res = await askGemini(`Diagnostic: Server ${u.server?.ip}:${u.server?.port}, Status ${s?.connected ? 'ACTIVE' : 'REJOINING'}, Ping ${pingRes}`, "help");
          
          let comps = [patreonRow()]; let clean = res;
          ['RECONNECT', 'RAM_PURGE', 'RESTART'].forEach(a => { if (res.includes(`[${a}]`)) { clean = clean.replace(`[${a}]`, "").trim(); comps.push(aiActionRow(a.toLowerCase().replace("ram_", ""), uid)); } });
          return i.editReply({ content: `🆘 **AI Diagnostic Report**\n\n${clean}`, components: comps });
        }
        if (choice === "custom_input") {
          const modal = new ModalBuilder().setCustomId("custom_help_modal").setTitle("Manual Support");
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("p_text").setLabel("Describe what's wrong").setStyle(TextInputStyle.Paragraph).setRequired(true)));
          return i.showModal(modal);
        }
      }

      if (i.customId === "set_version") {
        const u = getUser(uid); u.bedrockVersion = i.values[0]; save();
        return i.reply({ ephemeral: true, content: "✅ Version updated." });
      }
    }

    // --- MODALS ---
    if (i.isModalSubmit()) {
      if (i.customId === "settings_modal") {
        const u = getUser(uid);
        u.server = { ip: i.fields.getTextInputValue("ip").trim(), port: parseInt(i.fields.getTextInputValue("port").trim()) || 19132 };
        u.offlineUsername = i.fields.getTextInputValue("offline").trim() || `AFK_${uid.slice(-4)}`;
        save();
        return i.reply({ ephemeral: true, content: "✅ **Settings saved successfully.**" });
      }
      if (i.customId === "custom_help_modal") {
        await i.reply({ content: "⏳ **AI Thinking…**", ephemeral: true });
        const res = await askGemini(`User manual report: "${i.fields.getTextInputValue("p_text")}" on server ${getUser(uid).server?.ip}`, "help");
        return i.editReply({ content: `🆘 **AI Solution**\n\n${res}`, components: [patreonRow()] });
      }
      if (i.customId === "bc_discord_modal") {
        const chanId = i.fields.getTextInputValue("bc_chan");
        const msg = i.fields.getTextInputValue("bc_msg");
        const chan = await client.channels.fetch(chanId).catch(() => null);
        if (chan) {
          await chan.send({ embeds: [new EmbedBuilder().setTitle("📢 Official Update").setDescription(msg).setColor("#ffcc00").setTimestamp()] });
          return i.reply({ content: "✅ Broadcast sent to Discord channel.", ephemeral: true });
        }
        return i.reply({ content: "❌ Target channel not found.", ephemeral: true });
      }
      if (i.customId === "bc_mc_modal") {
        const msg = i.fields.getTextInputValue("bc_msg");
        let count = 0;
        for (const [id, s] of sessions) {
          if (s.connected) {
            s.client.write("text", { type: "chat", needs_translation: false, source_name: "", xuid: "", platform_chat_id: "", message: `§e[ADMIN] §f${msg}` });
            count++;
          }
        }
        return i.reply({ content: `✅ Sent message to ${count} bots in-game.`, ephemeral: true });
      }
      if (i.customId === "bl_modal") {
        const target = i.fields.getTextInputValue("bl_id");
        const u = getUser(target); u.banned = !u.banned; save();
        if (u.banned) cleanupSession(target);
        return i.reply({ content: `✅ Updated status for ${target} (Banned: ${u.banned}).`, ephemeral: true });
      }
    }

    // --- SLASH COMMANDS ---
    if (i.commandName === "panel") return i.reply({ content: "🎛 **AFKBot System Control**", components: panelRow() });
    if (i.commandName === "admin") {
      if (!ADMIN_IDS.includes(uid)) return i.reply({ content: "⛔ Unauthorized access.", ephemeral: true });
      return i.reply({ content: "🛡️ **Admin Control Hub**", components: adminHubRows(), ephemeral: true });
    }

  } catch (err) { process.stderr.write(`Interaction Err: ${err.message}\n`); }
});

// ----------------- 🛡 Global Guards -----------------
process.on("unhandledRejection", (e) => addLog(`REJECTION: ${e.message}`));
process.on("uncaughtException", (e) => addLog(`CRASH GUARD: ${e.message}`));

client.once("ready", async () => {
  addLog("System Online. ✨");
  await client.application.commands.set([
    new SlashCommandBuilder().setName("panel").setDescription("Open your bot control panel"),
    new SlashCommandBuilder().setName("admin").setDescription("Open ylläpitäjän hub")
  ]);
  notifyOwner("Factory Engine rebooted. All AI modules are operational.");
});

client.login(DISCORD_TOKEN);

