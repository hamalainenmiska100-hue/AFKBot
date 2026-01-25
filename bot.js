/**
 * Bedrock AFK Bot - Mega Factory V5
 * Kaikki ominaisuudet yhdessä tiedostossa.
 * Ei tiivistämistä. Ei poistoja.
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

// --- KONFIGURAATIO & API AVAIMET ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

// Gemini API Avaimet - Käytetään molempia tasapainottamaan kuormaa ja eri tehtäviä
const GEMINI_KEYS = [
  "AIzaSyAZbj5F2X-FLM6NSqz_3K1sciQMepX6JMA", // Avain 1: UX & Virheet
  "AIzaSyD51YhFcYCTp5HNOUZOZe14ymIhamILoOg"  // Avain 2: Terveys & Diagnostiikka
];
const GEMINI_MODEL = "gemini-2.5-flash-lite";

// Tärkeät ID:t
const OWNER_ID = "1144987924123881564"; 
const ADMIN_IDS = [OWNER_ID]; 
const ALLOWED_GUILD_ID = "1462335230345089254";

// Uptime-virstanpylväät (minuutteina): 30min, 1h, 2h, 4h, 6h, 8h, 12h, 24h
const MILESTONES = [30, 60, 120, 240, 360, 480, 720, 1440];

// ----------------- Pysyvä Tallennus (Fly.io Volume) -----------------
const DATA = fs.existsSync("/data") ? "/data" : path.join(__dirname, "data");
const AUTH_ROOT = path.join(DATA, "auth");
const STORE = path.join(DATA, "users.json");

// Luodaan hakemistot jos niitä ei ole
if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
if (!fs.existsSync(AUTH_ROOT)) fs.mkdirSync(AUTH_ROOT, { recursive: true });

// Ladataan käyttäjätiedot
let users = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, "utf8")) : {};

/**
 * Tallentaa käyttäjätietokannan levylle.
 */
function save() {
  try {
    fs.writeFileSync(STORE, JSON.stringify(users, null, 2));
  } catch (e) {
    console.error("Tallennusvirhe:", e);
  }
}

/**
 * Hakee käyttäjän datan tai alustaa uuden.
 */
function getUser(uid) {
  if (!users[uid]) {
    users[uid] = {};
  }
  if (!users[uid].delayMs) users[uid].delayMs = 5000;
  if (!users[uid].connectionType) users[uid].connectionType = "online";
  if (!users[uid].bedrockVersion) users[uid].bedrockVersion = "auto";
  if (!users[uid].offlineUsername) users[uid].offlineUsername = `AFK_${uid.slice(-4)}`;
  return users[uid];
}

/**
 * Hakee käyttäjän Microsoft-autentikaatiokansion.
 */
function getUserAuthDir(uid) {
  const dir = path.join(AUTH_ROOT, uid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Poistaa Microsoft-linkityksen.
 */
function unlinkMicrosoft(uid) {
  const dir = getUserAuthDir(uid);
  try { 
    fs.rmSync(dir, { recursive: true, force: true }); 
  } catch (e) {}
  const u = getUser(uid);
  u.linked = false;
  save();
}

// ----------------- Runtime Tila -----------------
const sessions = new Map(); // Aktiiviset botit ja niiden resurssit
const pendingLink = new Map(); // Käynnissä olevat linkitykset
let currentKeyIndex = 0;

/**
 * Kierrättää Gemini-avaimia kuormituksen mukaan.
 */
function getGeminiKey() {
  const key = GEMINI_KEYS[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % GEMINI_KEYS.length;
  return key;
}

// ----------------- Omistajan Lokitus (Owner Logs) -----------------
/**
 * Lähettää järjestelmäilmoituksen suoraan omistajan DM-viesteihin.
 */
async function notifyOwner(content) {
  try {
    const owner = await client.users.fetch(OWNER_ID).catch(() => null);
    if (owner) {
      const time = new Date().toLocaleTimeString('fi-FI');
      await owner.send(`\`[${time}]\` 📡 **Järjestelmäloki:** ${content}`).catch(() => {});
    }
  } catch (e) {
    console.error("Omistajalle ilmoittaminen epäonnistui.");
  }
}

// ----------------- Gemini AI Intelligence Hub -----------------
/**
 * Käyttää Geminiä analysoimaan teknisiä tietoja, virheitä tai RAM-käyttöä.
 */
async function askGemini(prompt, type = "general") {
  const apiKey = getGeminiKey();
  const systemInstruction = `You are the AFKBot System Intelligence, the central processor for a professional Minecraft Bedrock Factory.
  Context: This bot maintains a player's presence on Bedrock servers to prevent AFK kicks.
  Role: ${type === 'help' ? 'Diagnostic specialist. Analyze server health and provide clear fixes.' : 'System monitor. Optimize backend and explain errors.'}
  
  Instructions:
  - Be professional, modern, and technical. Avoid dramatic or "cringe" language.
  - Explain errors clearly in simple English.
  - If you detect an issue the bot can handle, suggest an action in brackets: [RAM_PURGE], [RECONNECT], [RESTART], or [WAIT].
  - Always tell the user exactly what they should do on their end.
  - Never mention you are an AI. You are the Factory Core.`;

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
    const result = data.candidates?.[0]?.content?.parts?.[0]?.text || "System diagnostics unavailable. Please check settings manually.";
    
    // Lokitetaan päätös omistajalle
    notifyOwner(`AI Engine (${type}) processed a request. Context: ${prompt.substring(0, 50)}... -> Result: ${result.substring(0, 100)}...`);
    
    return result;
  } catch (e) {
    return "The AI diagnostic module is currently recalibrating. Standard protocols are active.";
  }
}

// ----------------- Discord Client -----------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User]
});

// ----------------- UI Rakentajat -----------------

function panelRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("link").setLabel("🔑 Link Microsoft").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("unlink").setLabel("🗑 Unlink Microsoft").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("start").setLabel("▶ Start Bot").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("stop").setLabel("⏹ Stop Bot").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("get_help").setLabel("🆘 Get Help").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("more").setLabel("➕ More Options").setStyle(ButtonStyle.Secondary)
    )
  ];
}

function msaComponents(uri) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel("🌐 Open Login Link").setStyle(ButtonStyle.Link).setURL(uri)
    )
  ];
}

function patreonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("Donate & Support 💸")
      .setStyle(ButtonStyle.Link)
      .setURL("https://patreon.com/AFKBot396")
  );
}

function aiActionConfirmRow(action, uid) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ai_confirm_${action}_${uid}`).setLabel("Confirm AI Action").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ai_ignore_${uid}`).setLabel("Ignore Assistant").setStyle(ButtonStyle.Secondary)
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

// ----------------- Microsoft Link (Aito Alkuperäinen Logiikka) -----------------
/**
 * Hoitaa Microsoft-kirjautumisen täsmälleen alkuperäisellä tavalla callbackeineen.
 */
async function linkMicrosoft(uid, interaction) {
  if (pendingLink.has(uid)) {
    await interaction.editReply("⏳ Login process is already active. Please use the existing code.");
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
      // TÄMÄ ON ALKUPERÄINEN CALLBACK: Näyttää koodin heti kun se saadaan
      const uri = data.verification_uri_complete || data.verification_uri || "https://www.microsoft.com/link";
      const code = data.user_code || "(no code)";
      codeShown = true;

      const msg = `🔐 **Microsoft login required**\n\n👉 ${uri}\n\nYour code: \`${code}\`\n\n⚠ **IMPORTANT:** Please use a secondary Microsoft account. Come back here after you have logged in.`;
      
      await interaction.editReply({ 
        content: msg, 
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Open Link").setStyle(ButtonStyle.Link).setURL(uri)), patreonRow()] 
      }).catch(() => {});
      
      notifyOwner(`Käyttäjä <@${uid}> aloitti Microsoft-kirjautumisen.`);
    }
  );

  const p = (async () => {
    try {
      if (!codeShown) await interaction.editReply("⏳ Requesting Microsoft authentication code…");
      await flow.getMsaToken();
      u.linked = true;
      save();
      await interaction.followUp({ ephemeral: true, content: "✅ Microsoft account successfully linked!", components: [patreonRow()] }).catch(() => {});
      notifyOwner(`Käyttäjä <@${uid}> linkitti tilinsä onnistuneesti.`);
    } catch (e) {
      const aiAdvice = await askGemini(`Auth Linking Failed: ${e.message}`, "auth");
      await interaction.editReply({ content: `❌ **Linking Failed**\n\n${aiAdvice}`, components: [patreonRow()] });
    } finally {
      pendingLink.delete(uid);
    }
  })();
  pendingLink.set(uid, p);
}

// ----------------- Bedrock Session Moottori (Tehdas) -----------------

/**
 * Puhdistaa session kaikki resurssit täydellisesti.
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
 * Pysäyttää botin ja siivoaa muistin.
 */
function stopBot(uid) {
  if (!sessions.has(uid)) return false;
  const s = sessions.get(uid);
  s.manualStop = true;
  cleanupSession(uid);
  notifyOwner(`Käyttäjä <@${uid}> pysäytti botin.`);
  return true;
}

/**
 * Käynnistää Minecraft-session ja asettaa monitorit.
 */
async function startSession(uid, interaction = null) {
  const u = getUser(uid);
  if (!u.server) {
    if (interaction) await interaction.editReply("⚠ Please configure your IP and Port in Settings first.");
    return;
  }

  // AMMATTIMAINEN START-ESTO: Estetään päällekkäiset botit
  if (sessions.has(uid) && !sessions.get(uid).isReconnecting) {
    if (interaction && !interaction.replied) {
      await interaction.editReply("⚠️ **Active Session Detected**\nYour AFK bot is already operational. To restart or change servers, please terminate the current session by tapping the **Stop Bot** button first.");
    }
    return;
  }

  const { ip, port } = u.server;

  // ATERNOS / PROXY PROTECTION: Ping ennen yhdistämistä
  try {
    const ping = await bedrock.ping({ host: ip, port: port });
    const motd = (ping.motd || "").toLowerCase();
    if (motd.includes("offline") || motd.includes("starting") || motd.includes("queue")) {
      if (interaction) await interaction.editReply(`❌ Server Status: **Offline/Starting**. Bot will not connect to a proxy lobby. Please start your server first.`);
      return;
    }
  } catch (e) {
    if (interaction) await interaction.editReply(`❌ **Network Error**: The server at **${ip}** is currently unreachable.`);
    return;
  }

  const authDir = getUserAuthDir(uid);
  const opts = { 
    host: ip, 
    port, 
    connectTimeout: 45000, 
    keepAlive: true,
    version: u.bedrockVersion === "auto" ? undefined : u.bedrockVersion
  };

  if (u.connectionType === "offline") {
    opts.username = u.offlineUsername;
    opts.offline = true;
  } else {
    opts.username = uid;
    opts.profilesFolder = authDir;
  }

  const mc = bedrock.createClient(opts);
  const session = {
    client: mc,
    connected: false,
    manualStop: false,
    isReconnecting: false,
    startTime: Date.now(),
    milestones: [],
    retryCount: sessions.get(uid)?.retryCount || 0
  };
  sessions.set(uid, session);

  // Join Timeout
  session.timeout = setTimeout(async () => {
    if (!session.connected) {
      const help = await askGemini(`Bot failed to receive spawn packet from ${ip}:${port} after 45s wait.`, "network");
      if (interaction) await interaction.editReply(`❌ **Spawn Timeout**\n\n${help}`);
      cleanupSession(uid);
    }
  }, 47000);

  mc.on("spawn", () => {
    session.connected = true;
    session.retryCount = 0;
    clearTimeout(session.timeout);
    notifyOwner(`Käyttäjä <@${uid}> liittyi palvelimelle **${ip}:${port}**.`);

    if (interaction) {
      let msg = `🟢 Connected to **${ip}:${port}** (Auto-move active)`;
      const comps = [];
      if (Math.random() < 0.7) {
        msg += "\n\nHelp us keep AFKBot up by donating through Patreon!";
        comps.push(patreonRow());
      }
      interaction.editReply({ content: msg, components: comps }).catch(() => {});
    }

    // --- UPTIME MILESTONES (30min, 1h, 2h...) ---
    session.uptimeTimer = setInterval(async () => {
      const mins = Math.floor((Date.now() - session.startTime) / 60000);
      const m = MILESTONES.find(v => mins >= v && !session.milestones.includes(v));
      
      if (m) {
        session.milestones.push(m);
        const user = await client.users.fetch(uid).catch(() => null);
        if (user) {
          const timeLabel = m >= 60 ? `${m / 60}h` : `${m} minutes`;
          await user.send(`Congrats! Your bot has been up for **${timeLabel}**! 🥳`).catch(() => {});
          notifyOwner(`Käyttäjä <@${uid}> saavutti ${timeLabel} uptime-virstanpylvään.`);
        }
      }
    }, 60000);

    // --- ANTI-AFK MOVEMENT (Modern & Simple) ---
    let toggle = false;
    session.afkInterval = setInterval(() => {
      try {
        if (!mc.entity?.position) return;
        const pos = { ...mc.entity.position };
        toggle ? pos.x += 0.5 : pos.x -= 0.5;
        toggle = !toggle;
        mc.write("move_player", {
          runtime_id: mc.entityId, position: pos, pitch: 0, yaw: Math.random() * 360,
          head_yaw: Math.random() * 360, mode: 0, on_ground: true, ridden_runtime_id: 0, teleport: false
        });
      } catch (err) {}
    }, 60000);

    // --- GEMINI HEALTH & RAM ASSISTANT ---
    session.healthMonitor = setInterval(async () => {
      const ram = process.memoryUsage().heapUsed / 1024 / 1024;
      if (ram > 480) { // Jos backendin RAM ylittyy
        const analysis = await askGemini(`High RAM usage detected (${ram.toFixed(1)}MB). Suggest RAM_PURGE for user ${uid}?`, "health");
        const user = await client.users.fetch(uid).catch(() => null);
        if (user) {
          await user.send({ 
            content: `🛡️ **System Assistant:** I've detected high resource usage. To ensure stability, I recommend an automated optimization.\n\n${analysis}`,
            components: [aiActionConfirmRow('purge', uid)]
          }).catch(() => {});
        }
        notifyOwner(`VAROITUS: Korkea muistinkäyttö (${ram.toFixed(1)}MB). Gemini ehdotti optimointia käyttäjälle ${uid}.`);
      }
    }, 300000);
  });

  mc.on("error", async (err) => {
    if (session.manualStop) return;
    const errorMsg = String(err.message || err);
    notifyOwner(`Virhe käyttäjällä <@${uid}>: ${errorMsg}`);

    if (errorMsg.includes("auth") || errorMsg.includes("session")) {
      const user = await client.users.fetch(uid).catch(() => null);
      if (user) await user.send("❌ **Authentication Expired**: Your session has expired. Please re-link Microsoft in the panel.").catch(() => {});
      return cleanupSession(uid);
    }

    // Jos virhe on tuntematon, Gemini selittää sen
    if (!errorMsg.toLowerCase().includes("timeout")) {
        const explanation = await askGemini(`Minecraft Client Error: ${errorMsg} at ${ip}`, "error");
        const user = await client.users.fetch(uid).catch(() => null);
        if (user) await user.send(`⚠️ **Bot Encountered an Error**\n\n${explanation}`).catch(() => {});
    }

    handleAutoReconnect(uid, interaction);
  });

  mc.on("close", () => {
    if (!session.manualStop) handleAutoReconnect(uid, interaction);
  });
}

/**
 * AGGRESSIIVINEN 30S REJOIN MOOTTORI: Tarkistaa pingin 30s välein kunnes pääsee takaisin.
 */
function handleAutoReconnect(uid, interaction) {
  const s = sessions.get(uid);
  if (!s || s.manualStop || s.reconnectTimer) return;

  s.isReconnecting = true;
  s.connected = false;
  s.retryCount++;

  notifyOwner(`Yhteys katkesi käyttäjältä <@${uid}>. Yritetään uudelleen 30s kuluttua. (Yritys #${s.retryCount})`);

  s.reconnectTimer = setTimeout(async () => {
    if (sessions.has(uid) && !s.manualStop) {
      const u = getUser(uid);
      // TARKISTETAAN ONKO SERVU PÄÄLLÄ
      try {
        await bedrock.ping({ host: u.server.ip, port: u.server.port });
        console.log(`[TEHDAS] Palvelin ${u.server.ip} on ONLINE. Uudelleenkytkeytyminen aloitettu käyttäjälle ${uid}.`);
        startSession(uid, interaction);
      } catch (e) {
        // Jos servu on edelleen alhaalla, nollataan ajastin ja yritetään uudelleen 30s päästä
        s.reconnectTimer = null;
        handleAutoReconnect(uid, interaction);
      }
    }
  }, 30000);
}

// ----------------- Interaction Router (Kaikki Komennot) -----------------
client.on(Events.InteractionCreate, async (i) => {
  try {
    const uid = i.user.id;
    if (i.guildId !== ALLOWED_GUILD_ID && i.inGuild()) {
       return i.reply({ content: "This bot cannot be used in this server ⛔️", ephemeral: true });
    }

    // --- ADMIN HALLINTA (Suomeksi) ---
    if (i.commandName === "admin") {
      if (!ADMIN_IDS.includes(uid)) return i.reply({ content: "Pääsy evätty. Et ole admin.", ephemeral: true });
      await i.deferReply({ ephemeral: false });
      return i.editReply({ embeds: [buildAdminEmbed()], components: buildAdminComponents() });
    }

    if (i.customId?.startsWith("admin_")) {
      if (!ADMIN_IDS.includes(uid)) return;
      if (i.customId === "admin_refresh") return i.update({ embeds: [buildAdminEmbed()], components: buildAdminComponents() });
      if (i.customId === "admin_stop_all") {
        const currentCount = sessions.size;
        for (const [id] of sessions) {
          cleanupSession(id);
          const user = await client.users.fetch(id).catch(() => null);
          if (user) await user.send("Your bot was stopped by the owner for system maintenance ⚠️").catch(() => {});
        }
        notifyOwner(`Kaikki ${currentCount} bottia pysäytetty adminin toimesta.`);
        return i.update({ embeds: [buildAdminEmbed()], components: buildAdminComponents() });
      }
    }

    // --- AI ACTION VAHVISTUKSET ---
    if (i.customId?.startsWith("ai_confirm_purge_")) {
      const target = i.customId.split("_")[3];
      if (uid !== target) return i.reply({ content: "Access denied.", ephemeral: true });
      await i.update({ content: "⚡ **AI Optimization:** Purging RAM and reconnecting session...", components: [] });
      cleanupSession(target);
      setTimeout(() => startSession(target), 1500);
      return;
    }

    if (i.customId?.startsWith("ai_ignore_")) {
      await i.update({ content: "Optimization ignored. Stability not guaranteed.", components: [] });
      return;
    }

    // --- KÄYTTÄJÄ PANEELI ---
    if (i.commandName === "panel") {
      return i.reply({ content: "🎛 **AFKBot System Control**", components: panelRow() });
    }

    if (i.isButton()) {
      // --- GET HELP (DIAGNOSTIIKKA) ---
      if (i.customId === "get_help") {
        await i.reply({ content: "⏳ **AI Thinking...** Collecting server diagnostics and testing connection.", ephemeral: true });
        const u = getUser(uid);
        const s = sessions.get(uid);
        let pingResult = "Server Unreachable";
        try {
           const p = await bedrock.ping({ host: u.server?.ip, port: u.server?.port });
           pingResult = `Online (MOTD: ${p.motd})`;
        } catch (e) {
           pingResult = `Offline or Error (${e.message})`;
        }

        const diagPrompt = `User Help Request Diagnostic:
        - Target Server: ${u.server?.ip}:${u.server?.port}
        - Connection Protocol: ${u.connectionType}
        - Current Session Status: ${s ? (s.connected ? 'ACTIVE' : 'RECONNECTING') : 'INACTIVE'}
        - Real-time Ping Result: ${pingResult}
        
        Analyze why the user might be having trouble and provide advice.`;
        
        const aiResponse = await askGemini(diagPrompt, "help");
        return i.editReply({ content: `🆘 **AI Diagnostic Report**\n\n${aiResponse}`, components: [patreonRow()] });
      }

      if (i.customId === "start") {
        await i.deferReply({ ephemeral: true });
        return startSession(uid, i);
      }
      
      if (i.customId === "stop") {
        const ok = stopBot(uid);
        let msg = ok ? "⏹ **Bot Terminated.**" : "❌ No active session found.";
        if (ok && Math.random() < 0.7) {
          msg += "\n\nHelp us keep AFKBot up by donating through Patreon!";
          return i.reply({ ephemeral: true, content: msg, components: [patreonRow()] });
        }
        return i.reply({ ephemeral: true, content: msg });
      }

      if (i.customId === "link") {
        await i.deferReply({ ephemeral: true });
        return linkMicrosoft(uid, i);
      }

      if (i.customId === "unlink") {
        unlinkMicrosoft(uid);
        notifyOwner(`Käyttäjä <@${uid}> poisti Microsoft-linkityksen.`);
        return i.reply({ ephemeral: true, content: "🗑 Microsoft account unlinked." });
      }

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
    }

    if (i.isModalSubmit() && i.customId === "settings_modal") {
      const u = getUser(uid);
      u.server = { ip: i.fields.getTextInputValue("ip").trim(), port: parseInt(i.fields.getTextInputValue("port").trim()) || 19132 };
      u.offlineUsername = i.fields.getTextInputValue("offline").trim() || `AFK_${uid.slice(-4)}`;
      save();
      notifyOwner(`Käyttäjä <@${uid}> päivitti palvelimen: ${u.server.ip}:${u.server.port}`);
      return i.reply({ ephemeral: true, content: "✅ Settings saved successfully." });
    }

    if (i.isStringSelectMenu() && i.customId === "set_version") {
      const u = getUser(uid);
      u.bedrockVersion = i.values[0];
      save();
      return i.reply({ ephemeral: true, content: `✅ Target version set to: **${u.bedrockVersion}**` });
    }

  } catch (err) {
    console.error("Interaction Exception:", err);
    notifyOwner(`KRIITTINEN INTERAKTIOVIRHE: ${err.message}`);
  }
});

// ----------------- Admin Embed (Suomeksi) -----------------
function buildAdminEmbed() {
  const activeBots = Array.from(sessions.entries()).map(([id, s]) => {
    const uptimeMins = Math.floor((Date.now() - s.startTime) / 60000);
    return `👤 <@${id}>\nUptime: \`${uptimeMins} min\` | Yritykset: \`${s.retryCount}\` | Tila: \`${s.connected ? "🟢 Online" : "🟡 Yhdistää"}\``;
  }).join("\n\n") || "Ei aktiivisia botteja.";

  return new EmbedBuilder()
    .setTitle("🛡️ AFKBot Hallintapaneeli")
    .setColor("#ff0000")
    .addFields(
      { name: "Tehdas-tilastot", value: `Käyttäjiä DB:ssä: \`${Object.keys(users).length}\`\nAktiivisia sessioita: \`${sessions.size}\`` },
      { name: "Aktiiviset Botit", value: activeBots }
    )
    .setTimestamp()
    .setFooter({ text: "Mega Factory Backend Engine" });
}

function buildAdminComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("admin_refresh").setLabel("🔄 Päivitä").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("admin_stop_all").setLabel("☢️ Pysäytä Kaikki").setStyle(ButtonStyle.Danger)
  )];
}

// ----------------- Crash Guard & Lifecycle -----------------
process.on("unhandledRejection", (error) => {
  console.error("Guarded Unhandled Rejection:", error);
  notifyOwner(`Unhandled Rejection: \`${error.message}\``);
});

process.on("uncaughtException", (error) => {
  console.error("Guarded Uncaught Exception (Prevention):", error);
  notifyOwner(`KRIITTINEN PROSESSIVIRHE: \`${error.message}\``);
});

client.once("ready", async () => {
  console.log(`🟢 AFKBot MEGA FACTORY V5 ONLINE: ${client.user.tag}`);
  notifyOwner("Botti on käynnistynyt ja kaikki tehdasmoottorit ovat online-tilassa.");
  
  const cmds = [
    new SlashCommandBuilder().setName("panel").setDescription("Open system control panel"),
    new SlashCommandBuilder().setName("admin").setDescription("Open administrator control panel")
  ];
  await client.application.commands.set(cmds);
});

client.login(DISCORD_TOKEN);

