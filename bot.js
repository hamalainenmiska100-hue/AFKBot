/**
 * Bedrock AFK Bot - Mega Factory Ultimate Edition
 * TÄMÄ ON TÄYSI KOODI. EI TIIVISTYKSIÄ. EI POISTOJA.
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

// Gemini API-avaimet kahdessa eri slotissa kuormantasausta varten
const GEMINI_KEYS = [
  "AIzaSyAZbj5F2X-FLM6NSqz_3K1sciQMepX6JMA", // UX & Virheet
  "AIzaSyD51YhFcYCTp5HNOUZOZe14ymIhamILoOg"  // Terveys & Diagnostiikka
];
const GEMINI_MODEL = "gemini-2.5-flash-lite";

// Tärkeät ID-tunnukset
const OWNER_ID = "1144987924123881564"; 
const ADMIN_IDS = [OWNER_ID]; 
const ALLOWED_GUILD_ID = "1462335230345089254";

// Uptime-virstanpylväät minuuteissa
const MILESTONES = [30, 60, 120, 240, 360, 480, 720, 1440];

// ----------------- Pysyvä Tallennus (Fly.io Volume) -----------------
const DATA = fs.existsSync("/data") ? "/data" : path.join(__dirname, "data");
const AUTH_ROOT = path.join(DATA, "auth");
const STORE = path.join(DATA, "users.json");

// Alustetaan kansiorakenne
if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
if (!fs.existsSync(AUTH_ROOT)) fs.mkdirSync(AUTH_ROOT, { recursive: true });

// Ladataan käyttäjätietokanta
let users = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, "utf8")) : {};

/**
 * Tallentaa nykyisen käyttäjädatan users.json-tiedostoon
 */
function save() {
  try {
    fs.writeFileSync(STORE, JSON.stringify(users, null, 2));
  } catch (e) {
    console.error("Tallennusvirhe backendissä:", e);
  }
}

/**
 * Hakee käyttäjän objektin tai luo oletusasetukset
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
 * Palauttaa Microsoft-kirjautumistiedostojen polun
 */
function getUserAuthDir(uid) {
  const dir = path.join(AUTH_ROOT, uid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Katkaisee Microsoft-linkityksen ja poistaa tiedostot
 */
function unlinkMicrosoft(uid) {
  const dir = getUserAuthDir(uid);
  try { 
    fs.rmSync(dir, { recursive: true, force: true }); 
  } catch (e) {
    console.error("Auth-tiedostojen poisto epäonnistui:", e);
  }
  const u = getUser(uid);
  u.linked = false;
  save();
}

// ----------------- Runtime-moottorit -----------------
const sessions = new Map(); // Aktiiviset botit ja niiden resurssit
const pendingLink = new Map(); // Käynnissä olevat Auth-prosessit
let currentKeyIndex = 0;

/**
 * Valitsee vapaan Gemini-avaimen kierrättämällä
 */
function getGeminiKey() {
  const key = GEMINI_KEYS[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % GEMINI_KEYS.length;
  return key;
}

// ----------------- Omistajan Lokitus (Owner Logs) -----------------
/**
 * Lähettää tärkeät järjestelmätapahtumat suoraan omistajalle DM-viestinä
 */
async function notifyOwner(content) {
  try {
    const owner = await client.users.fetch(OWNER_ID).catch(() => null);
    if (owner) {
      const now = new Date().toLocaleTimeString('fi-FI');
      await owner.send(`\`[${now}]\` 📡 **System Log:** ${content}`).catch(() => {});
    }
  } catch (e) {
    console.error("Omistajalle ilmoittaminen epäonnistui.");
  }
}

// ----------------- Gemini AI "Factory Intelligence" -----------------
/**
 * Käyttää Geminiä diagnostiikkaan ja virheanalyysiin.
 * Tukee toimintoehdotuksia hakasulkeilla.
 */
async function askGemini(prompt, type = "general") {
  const apiKey = getGeminiKey();
  
  const systemInstruction = `You are the AFKBot Mega Factory Core Intelligence.
  Current Context: Professional Minecraft Bedrock AFK service.
  Task: ${type === 'help' ? 'Diagnostic Expert. Analyze server pings and session data.' : 'System Monitor.'}
  
  Operational Rules:
  1. Be professional, technical, and simple. Avoid over-dramatic or conversational language.
  2. If an action is required, use these EXACT brackets: [RECONNECT], [RAM_PURGE], [RESTART], [WAIT].
  3. Explain exactly what the user must do on their end.
  4. Never say you are an AI. You are the System Interface.
  5. Analyze provided ping results to determine if the server is offline or unreachable.`;

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
    const result = data.candidates?.[0]?.content?.parts?.[0]?.text || "System diagnostics failed. Please manually check settings.";
    
    // Ilmoitetaan AI-päätöksestä omistajalle
    notifyOwner(`AI Engine (${type}) analyzed request. Response length: ${result.length} chars.`);
    
    return result;
  } catch (e) {
    return "The AI Intelligence module is temporarily recalibrating. Standard protocols active.";
  }
}

// ----------------- Discord Client Alustus -----------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User]
});

// ----------------- UI-rakentajat (Moderni & Tehokas) -----------------

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

function aiConfirmationRow(action, uid) {
  const label = action === 'purge' ? 'Confirm RAM Optimization' : 'Confirm AI Reconnect';
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ai_confirm_${action}_${uid}`).setLabel(label).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ai_ignore_${uid}`).setLabel("Ignore Assistant").setStyle(ButtonStyle.Secondary)
  );
}

function versionRow(current = "auto") {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId("set_version").setPlaceholder("Select Bedrock Version").addOptions(
      { label: "Auto-detect", value: "auto", default: current === "auto" },
      { label: "1.21.x", value: "1.21.x", default: current === "1.21.x" },
      { label: "1.20.x", value: "1.20.x", default: current === "1.20.x" }
    )
  );
}

// ----------------- Microsoft Link (Aito Alkuperäinen Callback-logiikka) -----------------
/**
 * Hoitaa Microsoft-autentikaation täsmälleen alkuperäisellä tavalla callbackien kanssa.
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
      // TÄMÄ ON ALKUPERÄINEN CALLBACK: Päivittää viestin koodilla heti
      const uri = data.verification_uri_complete || data.verification_uri || "https://www.microsoft.com/link";
      const code = data.user_code || "(no code)";
      codeShown = true;

      const msg = `🔐 **Microsoft Login Required**\n\n👉 ${uri}\n\nYour code: \`${code}\`\n\n⚠ **IMPORTANT:** Use a secondary Microsoft account. Come back here after login.`;
      
      await interaction.editReply({ 
        content: msg, 
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Open Link").setStyle(ButtonStyle.Link).setURL(uri)), patreonRow()] 
      }).catch(() => {});
      
      notifyOwner(`Käyttäjä <@${uid}> aloitti kirjautumisprosessin.`);
    }
  );

  const p = (async () => {
    try {
      if (!codeShown) await interaction.editReply("⏳ Requesting authentication code…");
      await flow.getMsaToken();
      u.linked = true;
      save();
      await interaction.followUp({ ephemeral: true, content: "✅ Microsoft account successfully linked!", components: [patreonRow()] }).catch(() => {});
      notifyOwner(`Käyttäjä <@${uid}> linkitti tilinsä.`);
    } catch (e) {
      const aiAdvice = await askGemini(`Auth Linking Failed: ${e.message}`, "auth");
      await interaction.editReply({ content: `❌ **Linking Failed**\n\n${aiAdvice}`, components: [patreonRow()] });
    } finally {
      pendingLink.delete(uid);
    }
  })();
  pendingLink.set(uid, p);
}

// ----------------- Bedrock Session Moottori (Teollisuustaso) -----------------

/**
 * Puhdistaa session kaikki resurssit muistista ja sulkee yhteyden.
 */
function cleanupSessionResources(uid) {
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
 * Pysäyttää botin manuaalisesti ja ilmoittaa siitä.
 */
function stopBotManually(uid) {
  if (!sessions.has(uid)) return false;
  const s = sessions.get(uid);
  s.manualStop = true;
  cleanupSessionResources(uid);
  notifyOwner(`Käyttäjä <@${uid}> sammutti botin.`);
  return true;
}

/**
 * Käynnistää Minecraft-session ja asettaa kaikki monitorointijärjestelmät.
 */
async function startSession(uid, interaction = null) {
  const u = getUser(uid);
  if (!u.server) {
    if (interaction) await interaction.editReply("⚠ Please configure your IP and Port in Settings first.");
    return;
  }

  // AMMATTIMAINEN START-ESTO
  if (sessions.has(uid) && !sessions.get(uid).isReconnecting) {
    if (interaction && !interaction.replied) {
      const msg = "⚠️ **Active Session Detected**\nYour AFK bot is already operational. To restart or change servers, please terminate the current session by tapping the **Stop Bot** button first.";
      await interaction.editReply(msg);
    }
    return;
  }

  const { ip, port } = u.server;

  // ATERNOS / PROXY PROTECTION
  try {
    const ping = await bedrock.ping({ host: ip, port: port });
    const motd = (ping.motd || "").toLowerCase();
    if (motd.includes("offline") || motd.includes("starting") || motd.includes("queue")) {
      if (interaction) await interaction.editReply(`❌ Server Status: **Offline/Starting**. The bot will not join a proxy lobby.`);
      return;
    }
  } catch (e) {
    if (interaction) await interaction.editReply(`❌ **Network Error**: The server at **${ip}** is unreachable.`);
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
    milestonesReached: [],
    retryCount: sessions.get(uid)?.retryCount || 0
  };
  sessions.set(uid, session);

  // Join Timeout (Spawn packet odotus)
  session.timeout = setTimeout(async () => {
    if (!session.connected) {
      const helpText = await askGemini(`Bot failed to receive spawn packet from ${ip}:${port} after 45s.`, "network");
      if (interaction) await interaction.editReply(`❌ **Connection Timeout**\n\n${helpText}`);
      cleanupSessionResources(uid);
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

    // --- UPTIME MILESTONES ENGINE ---
    session.uptimeTimer = setInterval(async () => {
      const elapsedMins = Math.floor((Date.now() - session.startTime) / 60000);
      const milestone = MILESTONES.find(m => elapsedMins >= m && !session.milestonesReached.includes(m));
      
      if (milestone) {
        session.milestonesReached.push(milestone);
        const user = await client.users.fetch(uid).catch(() => null);
        if (user) {
          const timeLabel = milestone >= 60 ? `${milestone / 60}h` : `${milestone} minutes`;
          await user.send(`Congrats! Your bot has been up for **${timeLabel}**! 🥳`).catch(() => {});
          notifyOwner(`Käyttäjä <@${uid}> saavutti ${timeLabel} uptime-rajan.`);
        }
      }
    }, 60000);

    // --- ANTI-AFK MOVEMENT LOGIC ---
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

    // --- GEMINI RESOURCE MONITORING ---
    session.healthMonitor = setInterval(async () => {
      const ram = process.memoryUsage().heapUsed / 1024 / 1024;
      if (ram > 480) {
        const analysis = await askGemini(`System RAM high (${ram.toFixed(1)}MB). Session ${uid} optimization?`, "health");
        const user = await client.users.fetch(uid).catch(() => null);
        if (user && analysis.includes("[RAM_PURGE]")) {
          const cleanTxt = analysis.replace("[RAM_PURGE]", "").trim();
          await user.send({ 
            content: `🛡️ **Assistant:** I recommend a quick resource optimization.\n\n${cleanTxt}`,
            components: [aiConfirmationRow('purge', uid)]
          }).catch(() => {});
        }
        notifyOwner(`VAROITUS: Korkea RAM-käyttö (${ram.toFixed(1)}MB). Gemini analysoi.`);
      }
    }, 300000);
  });

  mc.on("error", async (err) => {
    if (session.manualStop) return;
    const errorMsg = String(err.message || err);
    notifyOwner(`Yhteysvirhe (<@${uid}>): ${errorMsg}`);

    if (errorMsg.includes("auth") || errorMsg.includes("session")) {
      const user = await client.users.fetch(uid).catch(() => null);
      if (user) await user.send("❌ **Authentication Expired**: Please re-link Microsoft in the panel.").catch(() => {});
      return cleanupSessionResources(uid);
    }

    if (!errorMsg.toLowerCase().includes("timeout")) {
        const explanation = await askGemini(`Client Error: ${errorMsg} at ${ip}`, "error");
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
 * AGGRESSIIVINEN 30S REJOIN MOOTTORI
 */
function handleAutoReconnect(uid, interaction) {
  const s = sessions.get(uid);
  if (!s || s.manualStop || s.reconnectTimer) return;

  s.isReconnecting = true;
  s.connected = false;
  s.retryCount++;

  notifyOwner(`Yhteys katkesi (<@${uid}>). Yritetään uudelleen 30s kuluttua.`);

  s.reconnectTimer = setTimeout(async () => {
    if (sessions.has(uid) && !s.manualStop) {
      const u = getUser(uid);
      try {
        await bedrock.ping({ host: u.server.ip, port: u.server.port });
        console.log(`[TEHDAS] Servu ONLINE. Uudelleenliittyminen aloitettu.`);
        startSession(uid, interaction);
      } catch (e) {
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
      if (!ADMIN_IDS.includes(uid)) return i.reply({ content: "Pääsy evätty.", ephemeral: true });
      await i.deferReply({ ephemeral: false });
      return i.editReply({ embeds: [buildAdminEmbed()], components: buildAdminComponents() });
    }

    if (i.customId?.startsWith("admin_")) {
      if (!ADMIN_IDS.includes(uid)) return;
      if (i.customId === "admin_refresh") return i.update({ embeds: [buildAdminEmbed()], components: buildAdminComponents() });
      if (i.customId === "admin_stop_all") {
        for (const [id] of sessions) {
          cleanupSessionResources(id);
          const user = await client.users.fetch(id).catch(() => null);
          if (user) await user.send("Your bot was stopped by the owner for maintenance ⚠️").catch(() => {});
        }
        return i.update({ embeds: [buildAdminEmbed()], components: buildAdminComponents() });
      }
    }

    // --- AI ACTION VAHVISTUKSET ---
    if (i.customId?.startsWith("ai_confirm_")) {
      const parts = i.customId.split("_");
      const action = parts[2];
      const target = parts[3];
      if (uid !== target) return i.reply({ content: "Not your session.", ephemeral: true });
      
      await i.update({ content: "⚡ **AI Optimization Active:** Reconnecting for performance...", components: [] });
      cleanupSessionResources(target);
      setTimeout(() => startSession(target), 1500);
      return;
    }

    if (i.customId?.startsWith("ai_ignore_")) {
      await i.update({ content: "Optimization ignored by user.", components: [] });
      return;
    }

    // --- KÄYTTÄJÄ PANEELI ---
    if (i.commandName === "panel") {
      return i.reply({ content: "🎛 **AFKBot System Control**", components: panelRow() });
    }

    if (i.isButton()) {
      // --- GET HELP (DIAGNOSTIIKKA) ---
      if (i.customId === "get_help") {
        await i.reply({ content: "⏳ **AI Thinking...** Collecting server health and diagnostics.", ephemeral: true });
        const u = getUser(uid);
        const s = sessions.get(uid);
        let pingInfo = "Offline/Unreachable";
        try {
           const p = await bedrock.ping({ host: u.server?.ip, port: u.server?.port });
           pingInfo = `Online (MOTD: ${p.motd})`;
        } catch (e) {
           pingInfo = `Error: ${e.message}`;
        }

        const diagPrompt = `Diagnostic Data:
        - Target: ${u.server?.ip}:${u.server?.port}
        - Protocol: ${u.connectionType}
        - Current Session: ${s ? (s.connected ? 'Connected' : 'Reconnecting') : 'Inactive'}
        - Ping Test: ${pingInfo}
        Analyze and suggest solutions. Use brackets for actions.`;
        
        const aiRes = await askGemini(diagPrompt, "help");
        
        // PARSERI: Etsitään hakasulkeet, piilotetaan ne ja lisätään nappi
        let components = [patreonRow()];
        let cleanText = aiRes;
        
        const actions = ['RECONNECT', 'RAM_PURGE', 'RESTART'];
        actions.forEach(act => {
           if (aiRes.includes(`[${act}]`)) {
              cleanText = cleanText.replace(`[${act}]`, "").trim();
              components.push(aiConfirmationRow(act.toLowerCase().replace("ram_", ""), uid));
           }
        });

        return i.editReply({ content: `🆘 **AI Diagnostic Report**\n\n${cleanText}`, components });
      }

      if (i.customId === "start") {
        await i.deferReply({ ephemeral: true });
        return startSession(uid, i);
      }
      
      if (i.customId === "stop") {
        const ok = stopBotManually(uid);
        let msg = ok ? "⏹ **Bot Terminated.** Session closed." : "❌ No active session found.";
        return i.reply({ ephemeral: true, content: msg, components: [patreonRow()] });
      }

      if (i.customId === "link") {
        await i.deferReply({ ephemeral: true });
        return linkMicrosoft(uid, i);
      }

      if (i.customId === "unlink") {
        unlinkMicrosoft(uid);
        return i.reply({ ephemeral: true, content: "🗑 Microsoft link removed." });
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
      return i.reply({ ephemeral: true, content: "✅ Settings saved successfully." });
    }

    if (i.isStringSelectMenu() && i.customId === "set_version") {
      const u = getUser(uid);
      u.bedrockVersion = i.values[0];
      save();
      return i.reply({ ephemeral: true, content: `✅ Version set to: **${u.bedrockVersion}**` });
    }

  } catch (err) {
    console.error("Interaktio-virhe:", err);
    notifyOwner(`CRITICAL INTERACTION ERROR: ${err.message}`);
  }
});

// ----------------- Admin-näkymä (Suomeksi) -----------------
function buildAdminEmbed() {
  const bots = Array.from(sessions.entries()).map(([id, s]) => {
    const mins = Math.floor((Date.now() - s.startTime) / 60000);
    return `👤 <@${id}>\nUptime: \`${mins} min\` | Yritykset: \`${s.retryCount}\` | Tila: \`${s.connected ? "🟢 Online" : "🟡 Reconnect"}\``;
  }).join("\n\n") || "Ei aktiivisia botteja.";

  return new EmbedBuilder()
    .setTitle("🛡️ AFKBot Hallintapaneeli")
    .setColor("#ff0000")
    .addFields(
      { name: "Tehdas-stats", value: `Käyttäjiä DB:ssä: \`${Object.keys(users).length}\`\nSessioita nyt: \`${sessions.size}\`` },
      { name: "Aktiiviset Botit", value: bots }
    )
    .setTimestamp();
}

function buildAdminComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("admin_refresh").setLabel("🔄 Päivitä").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("admin_stop_all").setLabel("☢️ Force Stop All").setStyle(ButtonStyle.Danger)
  )];
}

// ----------------- Crash Guard & Prosessin Hallinta -----------------
process.on("unhandledRejection", (error) => {
  console.error("Guarded Unhandled Rejection:", error);
  notifyOwner(`Unhandled Rejection: \`${error.message}\``);
});

process.on("uncaughtException", (error) => {
  console.error("Guarded Uncaught Exception:", error);
  notifyOwner(`KRIITTINEN VIRHE: \`${error.message}\``);
});

client.once("ready", async () => {
  console.log(`🟢 MEGA FACTORY ONLINE: ${client.user.tag}`);
  notifyOwner("Botti on käynnistynyt ja tehdasmoottori on valmiustilassa.");
  
  const cmds = [
    new SlashCommandBuilder().setName("panel").setDescription("System control panel"),
    new SlashCommandBuilder().setName("admin").setDescription("Admin panel")
  ];
  await client.application.commands.set(cmds);
});

client.login(DISCORD_TOKEN);

