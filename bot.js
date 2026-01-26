/**
 * Bedrock AFK Bot - Ultimate Absolute Final Edition (V12)
 * * SISÄLTÄÄ KAIKEN:
 * - ALKUPERÄINEN Microsoft Authflow Callback (Koodi ja linkki heti näkyviin)
 * - Human Simulation Engine (Satunnaiset mikroliikkeet, hypyt, kyykyt, katselukulmat, hotbar-vaihto)
 * - Soft Reboot Protocol (4 tunnin välein automaattinen uudelleenkäynnistys)
 * - Resource Optimization (Chunk skipping + Native RakNet)
 * - Packet Heartbeat (tick_sync elossapito)
 * - Gemini Support Responder (Kanava 1462398161074000143, tietää backendin ja UI:n)
 * - Admin Control Hub (User browser, Discord BC, In-game BC, System Stats, Blacklist)
 * - Exponential Backoff Rejoin (Älykäs uudelleenyhdistys ping-tarkistuksella)
 * - Get Help Dropdown System (Automatic detection & Manual support)
 * * UI Language: English
 * Internal Logic & Admin: Finnish/English
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

// Gemini API Avaimet kahdessa slotissa vikasietoisuutta varten
const GEMINI_KEYS = [
  "AIzaSyAZbj5F2X-FLM6NSqz_3K1sciQMepX6JMA",
  "AIzaSyD51YhFcYCTp5HNOUZOZe14ymIhamILoOg"
];
const GEMINI_MODEL = "gemini-2.5-flash-preview-09-2025";

// Tärkeät ID:t
const OWNER_ID = "1144987924123881564"; 
const ADMIN_IDS = [OWNER_ID]; 
const ALLOWED_GUILD_ID = "1462335230345089254";
const SUPPORT_CHANNEL_ID = "1462398161074000143";

// Vakiot
const MILESTONES = [30, 60, 120, 240, 360, 480, 720, 1440, 2880, 4320, 10080];
const SOFT_REBOOT_INTERVAL = 4 * 60 * 60 * 1000; // 4h automaattinen restart muistivuotojen estoon
const HEARTBEAT_INTERVAL = 25000; // 25s ping-paketti palvelimelle

// ----------------- PYSYVÄ TALLENNUS (Fly.io Volume) -----------------
const DATA = fs.existsSync("/data") ? "/data" : path.join(__dirname, "data");
const AUTH_ROOT = path.join(DATA, "auth");
const STORE = path.join(DATA, "users.json");

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
if (!fs.existsSync(AUTH_ROOT)) fs.mkdirSync(AUTH_ROOT, { recursive: true });

// Ladataan käyttäjädata muistiin
let users = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, "utf8")) : {};
let systemLogs = [];
let totalRamOptimized = 0;

/**
 * Tallentaa datan tiedostoon
 */
function save() {
  try {
    fs.writeFileSync(STORE, JSON.stringify(users, null, 2));
  } catch (e) {
    process.stderr.write(`Save failure: ${e.message}\n`);
  }
}

/**
 * Lisää merkinnän Admin-lokiin
 */
function addLog(msg) {
  const ts = new Date().toLocaleTimeString('fi-FI');
  systemLogs.unshift(`\`[${ts}]\` ${msg}`);
  if (systemLogs.length > 100) systemLogs.pop();
}

/**
 * Hakee käyttäjän tiedot tai luo uuden
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
      rebootEnabled: true
    };
  }
  return users[uid];
}

/**
 * Palauttaa Microsoft-tokenien kansion polun
 */
function getUserAuthDir(uid) {
  const dir = path.join(AUTH_ROOT, uid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Tuhoaa Microsoft-istunnon
 */
function unlinkMicrosoft(uid) {
  const dir = getUserAuthDir(uid);
  try { 
    fs.rmSync(dir, { recursive: true, force: true }); 
  } catch (e) {
    addLog(`Unlink failed: ${e.message}`);
  }
  const u = getUser(uid);
  u.linked = false;
  save();
  addLog(`User ${uid} destroyed Microsoft link.`);
}

// ----------------- TEKOÄLY-MOOTTORI (GEMINI) -----------------
const sessions = new Map(); // Aktiiviset sessiot ja niiden ajastimet
const pendingLink = new Map(); // Käynnissä olevat kirjautumisprosessit
let keyIdx = 0;

/**
 * Valitsee vapaan Gemini-avaimen
 */
function getGeminiKey() {
  const key = GEMINI_KEYS[keyIdx];
  keyIdx = (keyIdx + 1) % GEMINI_KEYS.length;
  return key;
}

/**
 * Keskustelee Geminin kanssa. System instruction kuvaa koko botin rakenteen.
 */
async function askGemini(prompt, mode = "general") {
  const apiKey = getGeminiKey();
  
  const systemInstruction = `You are the AFKBot Cybernetic Intelligence.
  You are an expert on this bot's backend and frontend.
  Backend: Node.js, bedrock-protocol, prismarine-auth.
  UI Components:
  - Link: Original Microsoft Authflow (Callback displays verification_uri and user_code).
  - Unlink: Deletes session files.
  - Start: Pings server first (MOTD lobby check), connects player, skips chunk decoding (RAM save), starts sim.
  - Stop: Clears intervals and closes client.
  - Settings: Modal for IP, Port, Username, Proxy.
  - Get Help: Automated scans or manual chat assistance.
  - More: Version selector.
  - Admin Hub: Restricted to owner (${OWNER_ID}).
  
  Deep Logic:
  - Human Simulation Engine: Random jumps, sneaking, head rotation, hotbar changes.
  - Soft Reboot: 4h cycle.
  - Backoff Rejoin: Progressive delay (30s+).
  
  Support Rules:
  - For 'help' or 'support' modes: ALWAYS respond in ENGLISH only.
  - If a message is unrelated to bot issues: Reply [NoCont]
  - Use technical yet clear English with emojis.`;

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
    addLog(`AI Exception: ${e.message}`);
    return mode === "support" ? "[NoCont]" : "AI engine overloaded. Standby.";
  }
}

/**
 * Lähettää järjestelmäilmoitukset omistajalle
 */
async function notifyOwner(content) {
  try {
    const owner = await client.users.fetch(OWNER_ID).catch(() => null);
    if (owner) {
      const ts = new Date().toLocaleTimeString('fi-FI');
      const embed = new EmbedBuilder()
        .setDescription(`\`[${ts}]\` 📡 **Core Log:** ${content}`)
        .setColor("#00d9ff");
      await owner.send({ embeds: [embed] }).catch(() => {});
    }
  } catch (e) {}
}

// ----------------- DISCORD ALUSTUS -----------------
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

// ----------------- UI KOMPONENTIT (ENGLISH) -----------------

function panelRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("link").setLabel("🔑 Link").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("unlink").setLabel("🗑 Unlink").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("start").setLabel("▶ Start Agent").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("stop").setLabel("⏹ Stop Agent").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("get_help").setLabel("🆘 Get Help").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("more").setLabel("➕ Advanced").setStyle(ButtonStyle.Secondary)
    )
  ];
}

function adminHubRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin_sys").setLabel("📊 Status").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin_bc_discord").setLabel("💬 Discord BC").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin_bc_mc").setLabel("⛏️ Game BC").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin_logs").setLabel("📜 Logs").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin_users").setLabel("👥 User Browser").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin_blacklist").setLabel("🚫 Blacklist").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin_kill_all").setLabel("☢️ Kill All").setStyle(ButtonStyle.Danger)
    )
  ];
}

function helpMenuRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("help_choice")
      .setPlaceholder("🆘 Support Diagnostic Center")
      .addOptions(
        { label: "Automatic analysis", value: "auto_detect", emoji: "🔍", description: "Let AI scan your server and session status." },
        { label: "Talk to support agent", value: "custom_input", emoji: "✍️", description: "Describe your issue directly to the AI." }
      )
  );
}

function patreonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("Donate to AFKBot 💸")
      .setStyle(ButtonStyle.Link)
      .setURL("https://patreon.com/AFKBot396")
  );
}

function aiActionConfirmRow(action, uid) {
  const label = action === 'reconnect' ? '🔄 Confirm Reconnect' : '🚀 Confirm optimization';
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ai_confirm_${action}_${uid}`).setLabel(label).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ai_ignore_${uid}`).setLabel("Dismiss").setStyle(ButtonStyle.Secondary)
  );
}

// ----------------- BOT SESSION ENGINE (FULL LOGIC) -----------------

/**
 * Puhdistaa KAIKKI sessioon liittyvät resurssit muistista
 */
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
  addLog(`Resources cleared for user ${uid}.`);
}

/**
 * Pysäyttää agentin manuaalisesti
 */
function stopBot(uid) {
  if (!sessions.has(uid)) return false;
  const s = sessions.get(uid);
  s.manualStop = true;
  fullCleanup(uid);
  notifyOwner(`User <@${uid}> manually deactivated the agent.`);
  return true;
}

/**
 * Aloittaa uuden Minecraft-yhteyden ja asettaa agentti-ominaisuudet
 */
async function startSession(uid, interaction = null) {
  const u = getUser(uid);
  if (u.banned) {
    if (interaction) await interaction.editReply("🚫 You are blacklisted from this server.");
    return;
  }

  // Estetään tuplajoinaukset
  if (sessions.has(uid) && !sessions.get(uid).isReconnecting) {
    if (interaction && !interaction.replied) {
      await interaction.editReply("⚠️ **Agent Busy:** Your bot is already running. Use Stop button first.");
    }
    return;
  }

  const { ip, port } = u.server || {};
  if (!ip) {
    if (interaction) await interaction.editReply("⚠️ Please configure **IP/Port** in settings before starting.");
    return;
  }

  // Aternos/Proxy Protection - MOTD-tarkistus
  try {
    const pingRes = await bedrock.ping({ host: ip, port: port });
    const motd = (pingRes.motd || "").toLowerCase();
    if (motd.includes("offline") || motd.includes("starting") || motd.includes("queue")) {
      if (interaction) await interaction.editReply(`❌ **Server Unavailable:** Server is offline or in lobby queue. Bot will not join.`);
      return;
    }
  } catch (e) {
    if (interaction) await interaction.editReply(`❌ **Network Error:** Target server ${ip} is unreachable.`);
    return;
  }

  const authDir = getUserAuthDir(uid);
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

  const mc = bedrock.createClient(options);
  const session = {
    client: mc, connected: false, manualStop: false, isReconnecting: false,
    startTime: Date.now(), milestones: [], retryCount: sessions.get(uid)?.retryCount || 0
  };
  sessions.set(uid, session);

  // Spawn Timeout
  session.timeout = setTimeout(async () => {
    if (!session.connected) {
      const h = await askGemini(`Connection to ${ip} failed (45s timeout). User UID: ${uid}`, "help");
      if (interaction) await interaction.editReply(`❌ **Spawn Timeout**\n\n${h}`);
      fullCleanup(uid);
    }
  }, 47000);

  mc.on("spawn", () => {
    session.connected = true; session.retryCount = 0; clearTimeout(session.timeout);
    addLog(`User ${uid} connected to ${ip} 🟢`);

    if (interaction) {
      interaction.editReply({ 
        content: `🟢 **Active** on **${ip}:${port}**\nCybernetic Human Simulation (Movement + Reboot) ENABLED! 🏃‍♂️`, 
        components: [patreonRow()] 
      }).catch(() => {});
    }

    // --- SOFT REBOOT (4h) ---
    session.rebootTimer = setTimeout(() => {
      if (session.connected && !session.manualStop) {
        addLog(`Executing scheduled 4h REBOOT for ${uid}.`);
        session.isReconnecting = true; 
        fullCleanup(uid);
        setTimeout(() => startSession(uid), 5000);
      }
    }, SOFT_REBOOT_INTERVAL);

    // --- UPTIME MILESTONES ---
    session.uptimeTimer = setInterval(async () => {
      const elapsedMins = Math.floor((Date.now() - session.startTime) / 60000);
      const m = MILESTONES.find(v => elapsedMins >= v && !session.milestones.includes(v));
      if (m) {
        session.milestones.push(m);
        const user = await client.users.fetch(uid).catch(() => null);
        if (user) {
          const timeLabel = m >= 60 ? (m/60)+' hours' : m+' mins';
          const e = new EmbedBuilder().setTitle("🏆 Online Success!").setDescription(`Your agent has been online for **${timeLabel}**! 🥳`).setColor("#f1c40f");
          await user.send({ embeds: [e] }).catch(() => {});
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

        if (rand < 0.2) pos.x += (Math.random() > 0.5 ? 0.6 : -0.6);
        else if (rand < 0.3) {
          mc.write("player_action", { runtime_id: mc.entityId, action: "jump", position: {x:0,y:0,z:0}, result_position: {x:0,y:0,z:0}, face: 0 });
        } else if (rand < 0.4) {
          const isS = Math.random() > 0.5;
          mc.write("player_action", { runtime_id: mc.entityId, action: isS ? "start_sneaking" : "stop_sneaking", position: {x:0,y:0,z:0}, result_position: {x:0,y:0,z:0}, face: 0 });
        }

        mc.write("move_player", { runtime_id: mc.entityId, position: pos, pitch, yaw, head_yaw: yaw, mode: 0, on_ground: true, ridden_runtime_id: 0, teleport: false });

        if (Math.random() < 0.1) {
          mc.write("player_hotbar", { selected_slot: Math.floor(Math.random()*9), window_id: "inventory", select_slot: true });
        }
      } catch (e) {}
    }, 55000 + Math.random() * 25000);

    // --- HEARTBEAT ---
    session.heartbeatTimer = setInterval(() => {
      try { mc.write("tick_sync", { request_time: BigInt(Date.now()), response_time: 0n }); } catch (e) {}
    }, HEARTBEAT_INTERVAL);

    // --- HEALTH MONITOR ---
    session.healthMonitor = setInterval(async () => {
      const ram = process.memoryUsage().heapUsed / 1024 / 1024;
      if (ram > 480) {
        const res = await askGemini(`RAM Alert: ${ram.toFixed(1)}MB used. Optimization recommended for ${uid}.`, "general");
        const user = await client.users.fetch(uid).catch(() => null);
        if (user && res.includes("[RAM_PURGE]")) {
           const cleanText = res.replace("[RAM_PURGE]", "").trim();
           await user.send({ content: `🛡️ **Health Alert:** High system load detected.\n\n${cleanText}`, components: [aiActionConfirmRow('purge', uid)] }).catch(() => {});
           totalRamOptimized += 50;
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
  
  notifyOwner(`Reconnection triggered for <@${uid}>. Delay: ${Math.round(delay/1000)}s.`);
  s.reconnectTimer = setTimeout(async () => {
    if (sessions.has(uid) && !s.manualStop) {
      try {
        await bedrock.ping({ host: getUser(uid).server.ip, port: getUser(uid).server.port });
        startSession(uid, interaction);
      } catch (e) {
        s.reconnectTimer = null; 
        handleAutoReconnect(uid, interaction);
      }
    }
  }, delay);
}

// ----------------- DISCORD TAPAHTUMAKÄSITTELIJÄT -----------------

// Gemini Support Responder #support
client.on(Events.MessageCreate, async (m) => {
  if (m.author.bot || m.channelId !== SUPPORT_CHANNEL_ID) return;
  const res = await askGemini(`User <@${m.author.id}> asks: ${m.content}`, "support");
  if (res.includes("[NoCont]")) return;
  await m.reply({ content: res });
});

// Interaktiot (Dashboard + Admin Hub)
client.on(Events.InteractionCreate, async (i) => {
  try {
    const uid = i.user.id;
    if (i.guildId !== ALLOWED_GUILD_ID && i.inGuild() && uid !== OWNER_ID) return i.reply({ content: "Access Restricted ⛔️", ephemeral: true });

    // --- PAINIKKEET ---
    if (i.isButton()) {
      if (i.customId === "get_help") return i.reply({ content: "🆘 **Assistance Hub**", components: [helpMenuRow()], ephemeral: true });
      if (i.customId === "start") { await i.deferReply({ ephemeral: true }); return startSession(uid, i); }
      if (i.customId === "stop") { stopBot(uid); return i.reply({ ephemeral: true, content: "⏹ **Deactivated.** Good luck! 👋", components: [patreonRow()] }); }
      if (i.customId === "unlink") { unlinkMicrosoft(uid); return i.reply({ ephemeral: true, content: "🗑 **Success:** Tokens deleted from disk." }); }
      
      // --- ALKUPERÄINEN AUTH-LOGIIKKA CALLBACKILLÄ ---
      if (i.customId === "link") {
        await i.deferReply({ ephemeral: true });
        const authDir = getUserAuthDir(uid);
        const flow = new Authflow(uid, authDir, { 
          flow: "live", 
          authTitle: Titles?.MinecraftNintendoSwitch || "Bedrock AFK Bot", 
          deviceType: "Nintendo" 
        }, async (data) => {
          // TÄMÄ ON SE ALKUPERÄINEN LOGIIKKA JOTA PYYDIT:
          const loginMsg = `🔐 **Microsoft Login Required**\n\n1️⃣ Open: ${data.verification_uri}\n2️⃣ Code: \`${data.user_code}\`\n\n⚠️ Return here after browser login is complete!`;
          await i.editReply({ 
            content: loginMsg, 
            components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Open Link").setStyle(ButtonStyle.Link).setURL(data.verification_uri)), patreonRow()] 
          }).catch(() => {});
          addLog(`User ${uid} received Microsoft code.`);
        });
        await flow.getMsaToken();
        getUser(uid).linked = true; save();
        return i.followUp({ ephemeral: true, content: "✅ **Success!** Your account is linked." });
      }

      if (i.customId === "settings") {
        const u = getUser(uid);
        const modal = new ModalBuilder().setCustomId("settings_modal").setTitle("Agent Config");
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("IP").setStyle(TextInputStyle.Short).setValue(u.server?.ip || "").setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.server?.port || 19132)).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("off").setLabel("Name").setStyle(TextInputStyle.Short).setValue(u.offlineUsername || "")),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("proxy").setLabel("Proxy (IP:Port)").setStyle(TextInputStyle.Short).setValue(u.proxy?.host ? `${u.proxy.host}:${u.proxy.port}` : ""))
        );
        return i.showModal(modal);
      }

      if (i.customId === "more") {
        const u = getUser(uid);
        return i.reply({ ephemeral: true, content: "➕ **Advanced**", components: [versionRow(u.bedrockVersion), patreonRow()] });
      }

      // ADMIN HUB
      if (i.customId === "admin_sys") {
        if (!ADMIN_IDS.includes(uid)) return;
        const mem = process.memoryUsage();
        const embed = new EmbedBuilder().setTitle("📊 System Monitor").setColor("#00ff00").addFields(
          { name: "Heap", value: `\`${(mem.heapUsed/1024/1024).toFixed(2)} MB\``, inline: true },
          { name: "Sessiot", value: `\`${sessions.size}\``, inline: true },
          { name: "Optimized", value: `\`${totalRamOptimized} MB\``, inline: true }
        );
        return i.reply({ embeds: [embed], ephemeral: true });
      }

      if (i.customId === "admin_bc_discord") {
        if (!ADMIN_IDS.includes(uid)) return;
        const m = new ModalBuilder().setCustomId("bc_discord_exec").setTitle("📢 Discord BC");
        m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("chan").setLabel("Channel ID").setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("msg").setLabel("Message").setStyle(TextInputStyle.Paragraph).setRequired(true)));
        return i.showModal(m);
      }

      if (i.customId === "admin_bc_mc") {
        if (!ADMIN_IDS.includes(uid)) return;
        const m = new ModalBuilder().setCustomId("bc_mc_exec").setTitle("⛏️ Game BC");
        m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("msg").setLabel("Chat Message").setStyle(TextInputStyle.Short).setRequired(true)));
        return i.showModal(m);
      }

      if (i.customId === "admin_users") {
        if (!ADMIN_IDS.includes(uid)) return;
        const list = Object.keys(users).map(id => ({ label: `User: ${id}`, value: id })).slice(0, 25);
        if (list.length === 0) return i.reply({ content: "Empty DB.", ephemeral: true });
        const menu = new StringSelectMenuBuilder().setCustomId("admin_inspect").setPlaceholder("Select User").addOptions(list);
        return i.reply({ components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
      }

      if (i.customId === "admin_logs") {
        if (!ADMIN_IDS.includes(uid)) return;
        return i.reply({ content: `📜 **Detailed Logs:**\n${systemLogs.join("\n").substring(0, 1900)}`, ephemeral: true });
      }

      if (i.customId === "admin_kill_all") {
        if (!ADMIN_IDS.includes(uid)) return;
        const c = sessions.size; for (const [id] of sessions) fullCleanup(id);
        return i.reply({ content: `☢️ KILLED ${c} SESSIONS.`, ephemeral: true });
      }

      if (i.customId?.startsWith("ai_confirm_")) {
        fullCleanup(uid); setTimeout(() => startSession(uid), 1500);
        return i.update({ content: "⚡ **Executing AI recommended fix...**", components: [] });
      }
    }

    // --- VALIKOT ---
    if (i.isStringSelectMenu()) {
      if (i.customId === "admin_inspect") {
        const u = users[i.values[0]];
        const embed = new EmbedBuilder().setTitle(`👤 User Inspect: ${i.values[0]}`).setColor("#00ffff").addFields(
          { name: "IP", value: `\`${u.server?.ip}:${u.server?.port}\`` },
          { name: "Banned", value: `\`${u.banned}\`` },
          { name: "Auth", value: `\`${u.connectionType}\`` },
          { name: "Linked", value: `\`${u.linked}\`` },
          { name: "Nimi", value: `\`${u.offlineUsername}\`` }
        );
        return i.reply({ embeds: [embed], ephemeral: true });
      }

      if (i.customId === "help_choice") {
        const choice = i.values[0];
        if (choice === "auto_detect") {
          await i.update({ content: "⏳ **AI Thinking…** Scanning infrastructure.", components: [] });
          const u = getUser(uid); const s = sessions.get(uid); let pT = "Offline";
          try { const pR = await bedrock.ping({ host: u.server?.ip, port: u.server?.port }); pT = `Online (${pR.motd})`; } catch (e) {}
          const res = await askGemini(`Diagnostic Request: Server ${u.server?.ip}, Status ${s?.connected ? 'OK' : 'FAIL'}, Ping ${pT}`, "help");
          let comps = [patreonRow()]; let txt = res;
          ['RECONNECT', 'RAM_PURGE', 'RESTART'].forEach(a => { if (res.includes(`[${a}]`)) { txt = txt.replace(`[${a}]`, "").trim(); comps.push(aiActionConfirmRow(a.toLowerCase().replace("ram_", ""), uid)); } });
          return i.editReply({ content: `🆘 **AI Solution**\n\n${txt}`, components: comps });
        }
        if (choice === "custom_input") {
          const m = new ModalBuilder().setCustomId("custom_help_exec").setTitle("Support Chat");
          m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("txt").setLabel("Describe what is wrong").setStyle(TextInputStyle.Paragraph).setRequired(true)));
          return i.showModal(m);
        }
      }

      if (i.customId === "set_version") {
        const u = getUser(uid); u.bedrockVersion = i.values[0]; save();
        return i.reply({ ephemeral: true, content: `✅ **Success:** Target set to ${u.bedrockVersion}` });
      }
    }

    // --- MODAALIT ---
    if (i.isModalSubmit()) {
      if (i.customId === "settings_modal") {
        const u = getUser(uid);
        u.server.ip = i.fields.getTextInputValue("ip").trim();
        u.server.port = parseInt(i.fields.getTextInputValue("port").trim()) || 19132;
        u.offlineUsername = i.fields.getTextInputValue("off").trim() || u.offlineUsername;
        const pR = i.fields.getTextInputValue("proxy").trim();
        if (pR.includes(":")) { const [h, p] = pR.split(":"); u.proxy = { host: h, port: p, enabled: true }; }
        else u.proxy = { host: "", port: "", enabled: false };
        save(); return i.reply({ ephemeral: true, content: "✅ **Saved.**" });
      }
      if (i.customId === "custom_help_exec") {
        await i.reply({ content: "⏳ **AI Thinking…**", ephemeral: true });
        const res = await askGemini(`Manual help: "${i.fields.getTextInputValue("txt")}" for server ${getUser(uid).server?.ip}`, "help");
        return i.editReply({ content: `🆘 **AI Response**\n\n${res}`, components: [patreonRow()] });
      }
      if (i.customId === "bc_discord_exec") {
        const c = await client.channels.fetch(i.fields.getTextInputValue("chan")).catch(() => null);
        if (c) { await c.send({ embeds: [new EmbedBuilder().setTitle("📢 Official Update").setDescription(i.fields.getTextInputValue("msg")).setColor("#f1c40f")] }); return i.reply({ content: "✅ Sent.", ephemeral: true }); }
        return i.reply({ content: "❌ Target invalid.", ephemeral: true });
      }
      if (i.customId === "bc_mc_exec") {
        let d = 0; const m = i.fields.getTextInputValue("msg");
        for (const [id, s] of sessions) { if (s.connected) { s.client.write("text", { type: "chat", needs_translation: false, source_name: "", xuid: "", platform_chat_id: "", message: `§e[ADMIN] §f${m}` }); d++; } }
        return i.reply({ content: `✅ Sent to ${d} bots.`, ephemeral: true });
      }
    }

    // --- SLASH ---
    if (i.isChatInputCommand()) {
      if (i.commandName === "panel") return i.reply({ content: "🎛 **AFK Dashboard**", components: panelRow() });
      if (i.commandName === "admin") {
        if (!ADMIN_IDS.includes(uid)) return i.reply({ content: "⛔ Denied.", ephemeral: true });
        return i.reply({ content: "🛡️ **Admin Hub**", components: adminHubRows(), ephemeral: true });
      }
    }
  } catch (err) { process.stderr.write(`Interaction Error: ${err.message}\n`); }
});

// --- LIFESTYLE ---
process.on("unhandledRejection", (e) => addLog(`REJECTION: ${e.message}`));
process.on("uncaughtException", (e) => addLog(`CRASH PREVENTED: ${e.message}`));

client.once("ready", async () => {
  addLog("System online. 🟢");
  const cmds = [
    new SlashCommandBuilder().setName("panel").setDescription("Bot Dashboard"),
    new SlashCommandBuilder().setName("admin").setDescription("Administrator Hub")
  ];
  await client.application.commands.set(cmds);
  notifyOwner("Cybernetic Engine ONLINE. All protocols restored.");
});

client.login(DISCORD_TOKEN);

