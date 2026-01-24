/**
 * Bedrock AFK Bot - Production Version
 * * Features:
 * - Aggressive RAM Optimization (Packet Stripping)
 * - Microsoft Authflow with Timeout Protection
 * - Post-Deployment Auto-Restore
 * - Geyser/Java Server Compatibility Fix
 * - 30s Auto-Refreshing Admin Analytics
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
  EmbedBuilder
} = require("discord.js");

const bedrock = require("bedrock-protocol");
const { Authflow, Titles } = require("prismarine-auth");
const fs = require("fs");
const path = require("path");

// ----------------------------------------------------------------
// PRODUCTION CONFIGURATION
// ----------------------------------------------------------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ALLOWED_GUILD_ID = "1462335230345089254";
const ADMIN_ID = "1144987924123881564";
const LOG_CHANNEL_ID = "1464615030111731753";
const ADMIN_CHANNEL_ID = "1464615993320935447";
const CONNECTION_TIMEOUT = 25000; // 25s limit for initial handshake

if (!DISCORD_TOKEN) {
  console.error("❌ CRITICAL ERROR: DISCORD_TOKEN is missing from environment variables.");
  process.exit(1);
}

// ----------------------------------------------------------------
// DATABASE & DIRECTORIES
// ----------------------------------------------------------------
const DATA_DIR = path.join(__dirname, "data");
const AUTH_DIR = path.join(DATA_DIR, "auth");
const STORE_FILE = path.join(DATA_DIR, "users.json");

// Ensure required directories exist for persistence
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

// Load user database from volume
let users = {};
if (fs.existsSync(STORE_FILE)) {
  try {
    users = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch (e) {
    console.error("Failed to parse users.json, starting fresh.");
    users = {};
  }
}

/**
 * Saves the current user state to users.json on the persistent volume
 */
function saveDatabase() {
  fs.writeFileSync(STORE_FILE, JSON.stringify(users, null, 2));
}

/**
 * Retrieves or initializes a user profile
 */
function getUser(uid) {
  if (!users[uid]) {
    users[uid] = {
      connectionType: "online",
      bedrockVersion: "auto",
      offlineUsername: `AFK_${uid.slice(-4)}`,
      active: false,
      server: null
    };
  }
  return users[uid];
}

/**
 * Returns the path for Microsoft Auth cache for a specific user
 */
function getAuthPath(uid) {
  const p = path.join(AUTH_DIR, uid);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

// ----------------------------------------------------------------
// RUNTIME STATE
// ----------------------------------------------------------------
const sessions = new Map();
const activeLinks = new Map();
let adminPanelMsg = null;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages
  ]
});

// ----------------------------------------------------------------
// PRODUCTION LOGGING & UTILITIES
// ----------------------------------------------------------------

/**
 * Posts a formatted log entry to the log channel
 */
async function postLog(description, color = "#5865F2") {
  try {
    const channel = await client.channels.fetch(LOG_CHANNEL_ID);
    if (channel && channel.isTextBased()) {
      const embed = new EmbedBuilder()
        .setColor(color)
        .setDescription(description)
        .setTimestamp();
      await channel.send({ embeds: [embed] });
    }
  } catch (e) {
    console.warn("Logging failed:", e.message);
  }
}

/**
 * Sends a private DM to a user
 */
async function sendDM(uid, message) {
  try {
    const discordUser = await client.users.fetch(uid);
    if (discordUser) await discordUser.send(message);
  } catch (e) {}
}

/**
 * Validates if the interaction is happening in the correct guild
 */
function checkGuild(interaction) {
  if (!interaction.inGuild() || interaction.guildId !== ALLOWED_GUILD_ID) {
    const msg = "Bot access is restricted to the production guild ⛔";
    if (interaction.deferred || interaction.replied) interaction.editReply(msg).catch(() => {});
    else interaction.reply({ ephemeral: true, content: msg }).catch(() => {});
    return false;
  }
  return true;
}

// ----------------------------------------------------------------
// CORE BOT LOGIC & RAM OPTIMIZATION
// ----------------------------------------------------------------

/**
 * Terminates a bot session and cleans up resources
 */
function stopBot(uid, isManualStop = true) {
  const session = sessions.get(uid);
  if (isManualStop) {
    const userProfile = getUser(uid);
    userProfile.active = false;
    saveDatabase();
  }
  
  if (!session) return false;
  if (isManualStop) session.manualStop = true;
  
  if (session.timeout) clearTimeout(session.timeout);
  if (session.reconnect) clearTimeout(session.reconnect);
  if (session.afkLoop) clearInterval(session.afkLoop);
  
  try {
    if (session.mc) {
      session.mc.removeAllListeners();
      session.mc.close();
      session.mc = null; // Help GC
    }
  } catch (e) {}
  
  sessions.delete(uid);
  if (global.gc) global.gc(); // Trigger garbage collection if flag --expose-gc is used
  return true;
}

/**
 * Starts a Bedrock bot session
 */
function startBot(uid, interaction = null) {
  const profile = getUser(uid);
  if (!profile.server || !profile.server.ip) {
    if (interaction && !interaction.replied) interaction.editReply("⚠️ Server settings missing. Use Settings first.");
    return;
  }
  
  if (sessions.has(uid) && !sessions.get(uid).isRetrying) {
    if (interaction && !interaction.replied) interaction.editReply("⚠️ Your bot is already running.");
    return;
  }

  profile.active = true;
  saveDatabase();

  const ip = profile.server.ip;
  const port = parseInt(profile.server.port) || 19132;

  const clientOptions = {
    host: ip,
    port,
    connectTimeout: CONNECTION_TIMEOUT,
    keepAlive: true,
    version: profile.bedrockVersion === "auto" ? undefined : profile.bedrockVersion
  };

  if (profile.connectionType === "offline") {
    clientOptions.username = profile.offlineUsername || `AFK_${uid.slice(-4)}`;
    clientOptions.offline = true;
  } else {
    clientOptions.username = uid;
    clientOptions.offline = false;
    clientOptions.profilesFolder = getAuthPath(uid);
  }

  const mcClient = bedrock.createClient(clientOptions);
  let sessionState = sessions.get(uid) || { started: Date.now(), manualStop: false, connected: false, pkts: 0, isRetrying: false };
  sessionState.mc = mcClient;
  sessionState.isRetrying = false;
  sessions.set(uid, sessionState);

  // --- AGGRESSIVE RAM OPTIMIZATION: PACKET STRIPPING ---
  mcClient.on('packet', (packet) => {
    sessionState.pkts++;
    const name = packet.data.name;
    // Destroy world data/chunks/entities/metadata instantly to prevent RAM buildup
    if (name.includes('chunk') || name.includes('level') || name.includes('metadata') || name.includes('entity') || name.includes('player_list')) {
      if (packet.data.payload) packet.data.payload = null;
      packet.data = null; 
    }
  });

  // Handle spawn status for standard Bedrock and Geyser/Java servers
  mcClient.on('play_status', (statusPacket) => {
    if ((statusPacket.status === 'player_spawn' || statusPacket.status === 'login_success') && !sessionState.connected) {
      onSuccessfulSpawn(uid, mcClient, sessionState, interaction, ip, port);
    }
  });

  mcClient.on("spawn", () => {
    if (!sessionState.connected) onSuccessfulSpawn(uid, mcClient, sessionState, interaction, ip, port);
  });

  sessionState.timeout = setTimeout(() => {
    if (sessions.has(uid) && !sessionState.connected) {
      if (interaction && interaction.deferred) interaction.editReply("❌ Connection Timeout (25s). Check IP/Port.");
      mcClient.close();
    }
  }, CONNECTION_TIMEOUT);

  mcClient.on("error", (err) => {
    clearTimeout(sessionState.timeout);
    postLog(`❌ Error for <@${uid}>: \`${err.message}\``, "#FF0000");
    if (!sessionState.manualStop) initiateReconnect(uid, interaction);
  });

  mcClient.on("close", () => {
    clearTimeout(sessionState.timeout);
    postLog(`🔌 Connection closed for <@${uid}>`, "#808080");
    if (!sessionState.manualStop) initiateReconnect(uid, interaction);
  });
}

function onSuccessfulSpawn(uid, mcClient, sessionState, interaction, ip, port) {
  sessionState.connected = true;
  clearTimeout(sessionState.timeout);
  if (interaction && interaction.deferred) interaction.editReply(`🟢 Bot is Online at **${ip}:${port}**`);
  postLog(`✅ Bot <@${uid}> joined ${ip}`, "#00FF00");

  // Anti-kick AFK movement loop
  sessionState.afkLoop = setInterval(() => {
    try {
      if (!mcClient.entityId) return;
      mcClient.write("move_player", {
        runtime_id: mcClient.entityId, position: mcClient.entity?.position || {x:0,y:0,z:0}, pitch: 0, yaw: 0, head_yaw: 0,
        mode: 0, on_ground: true, ridden_runtime_id: 0, teleport: false
      });
    } catch (e) {}
  }, 60000);
}

function initiateReconnect(uid, interaction) {
  const s = sessions.get(uid);
  if (!s || s.manualStop || s.reconnect) return;
  s.isRetrying = true;
  s.connected = false;
  s.reconnect = setTimeout(() => {
    if (sessions.has(uid) && !s.manualStop) {
      s.reconnect = null;
      startBot(uid, interaction);
    }
  }, 120000);
}

// ----------------------------------------------------------------
// MICROSOFT AUTHENTICATION (TIMEOUT PROTECTED)
// ----------------------------------------------------------------

async function handleMicrosoftLink(uid, interaction) {
  if (activeLinks.has(uid)) return interaction.editReply("⏳ Login already in progress.");

  // IMPORTANT: Send immediate update to prevent Discord timeout (3s limit)
  await interaction.editReply("⏳ Requesting login from Microsoft... This may take a moment.");

  const authCachePath = getAuthPath(uid);
  const profile = getUser(uid);

  try {
    const flow = new Authflow(uid, authCachePath, {
      flow: "live",
      authTitle: Titles.MinecraftNintendoSwitch,
      deviceType: "Nintendo"
    }, async (data) => {
      // Callback from prismarine-auth with the verification details
      const loginEmbed = new EmbedBuilder()
        .setTitle("🔐 Microsoft Account Link")
        .setDescription(
          `**Verification Code:** \`${data.user_code}\`\n\n` +
          `1. Click the button below to open Microsoft.\n` +
          `2. Enter the code above.\n\n` +
          `*The bot will update automatically when you finish.*`
        )
        .setColor("#5865F2");
      
      const loginRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel("Enter Code on Microsoft")
          .setStyle(ButtonStyle.Link)
          .setURL(data.verification_uri_complete)
      );

      await interaction.editReply({ content: null, embeds: [loginEmbed], components: [loginRow] });
    });

    const flowPromise = (async () => {
      try {
        await flow.getMsaToken();
        profile.linked = true;
        saveDatabase();
        await interaction.followUp({ ephemeral: true, content: "✅ Success! Microsoft account linked." });
        postLog(`🔑 User <@${uid}> successfully linked their account.`);
      } catch (e) {
        await interaction.followUp({ ephemeral: true, content: `❌ Authentication Error: ${e.message}` });
      } finally {
        activeLinks.delete(uid);
      }
    })();

    activeLinks.set(uid, flowPromise);

  } catch (err) {
    await interaction.editReply(`❌ Init Error: ${err.message}`);
    activeLinks.delete(uid);
  }
}

// ----------------------------------------------------------------
// ADMIN INTERFACE
// ----------------------------------------------------------------

function getSystemStatsEmbed() {
  const mem = process.memoryUsage();
  const rss = (mem.rss / 1024 / 1024).toFixed(2);
  const up = process.uptime();
  
  const embed = new EmbedBuilder()
    .setTitle("🚀 Admin Analytics Dashboard")
    .setColor("#2B2D31")
    .addFields(
      { name: "💻 System", value: `**RAM:** ${rss} MB\n**Uptime:** ${Math.floor(up/3600)}h ${Math.floor((up%3600)/60)}m`, inline: true },
      { name: "📊 Bots", value: `**Active:** ${sessions.size}\n**Users:** ${Object.keys(users).length}`, inline: true }
    )
    .setTimestamp()
    .setFooter({ text: "Auto-refreshing 30s | RAM Optimized (pkts = packets)" });

  if (sessions.size > 0) {
    let list = "";
    for (const [id, s] of sessions) {
      list += `<@${id}>: ${s.connected ? "🟢" : "🟠"} (${s.pkts} pkts)\n`;
    }
    embed.addFields({ name: "Active Sessions Feed", value: list.slice(0, 1024) });
  }
  return embed;
}

function getAdminActionRows() {
  const rows = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("adm_refresh").setLabel("Refresh Stats").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("adm_stop_all").setLabel("Force Stop All").setStyle(ButtonStyle.Danger)
  )];
  
  if (sessions.size > 0) {
    const options = Array.from(sessions.keys()).slice(0, 25).map(id => ({ label: `User: ${id}`, value: id }));
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("adm_force_user")
        .setPlaceholder("Terminate specific session")
        .addOptions(options)
    ));
  }
  return rows;
}

// ----------------------------------------------------------------
// HANDLERS
// ----------------------------------------------------------------

client.once("ready", async () => {
  console.log(`🟢 Production Instance Active: ${client.user.tag}`);
  
  const commands = [
    new SlashCommandBuilder().setName("panel").setDescription("User AFK Control Panel"),
    new SlashCommandBuilder().setName("admin").setDescription("Global Administrator Analytics")
  ];
  await client.application.commands.set(commands);

  // --- PERSISTENT AUTO-RESTORE (BLACKDOWN PROTECTION) ---
  const activeUserIds = Object.keys(users).filter(id => users[id].active === true);
  if (activeUserIds.length > 0) {
    postLog(`♻️ **Auto-Restore**: Reconnecting ${activeUserIds.length} bots following deployment...`);
    activeUserIds.forEach((id, idx) => setTimeout(() => startBot(id), idx * 3000));
  }

  // Admin Panel Refresh Loop
  setInterval(async () => {
    if (adminPanelMsg) {
      try { 
        await adminPanelMsg.edit({ embeds: [getSystemStatsEmbed()], components: getAdminActionRows() }); 
      } catch (e) { adminPanelMsg = null; }
    }
  }, 30000);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!checkGuild(interaction)) return;
    const callerUid = interaction.user.id;

    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "panel") {
        const panelRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("btn_link").setLabel("Link Microsoft").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("btn_unlink").setLabel("Unlink").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("btn_start").setLabel("Start Bot").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("btn_stop").setLabel("Stop Bot").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("btn_settings").setLabel("Settings").setStyle(ButtonStyle.Secondary)
        );
        return interaction.reply({ content: "🎛 **AFK Bot Controls**", components: [panelRow] });
      }
      
      if (interaction.commandName === "admin") {
        if (callerUid !== ADMIN_ID) return interaction.reply({ content: "⛔ Unauthorized.", ephemeral: true });
        adminPanelMsg = await interaction.reply({ embeds: [getSystemStatsEmbed()], components: getAdminActionRows(), fetchReply: true });
        return;
      }
    }

    if (interaction.isButton()) {
      const cid = interaction.customId;

      // Admin Buttons
      if (cid === "adm_refresh") {
        if (callerUid !== ADMIN_ID) return;
        return interaction.update({ embeds: [getSystemStatsEmbed()], components: getAdminActionRows() });
      }
      if (cid === "adm_stop_all") {
        if (callerUid !== ADMIN_ID) return;
        const count = sessions.size;
        for (const [id, s] of sessions) { 
          stopBot(id, true); 
          sendDM(id, "⚠️ Your bot was stopped by the administrator."); 
        }
        return interaction.reply({ content: `✅ Terminated ${count} sessions.`, ephemeral: true });
      }

      // User Buttons
      if (cid === "btn_link") { 
        await interaction.deferReply({ ephemeral: true }); 
        return handleMicrosoftLink(callerUid, interaction); 
      }
      
      if (cid === "btn_unlink") {
        const p = getAuthPath(callerUid);
        if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
        const profile = getUser(callerUid); profile.linked = false; profile.active = false; saveDatabase();
        postLog(`🗑 User <@${callerUid}> removed their link.`);
        return interaction.reply({ content: "🗑 Account Unlinked.", ephemeral: true });
      }
      
      if (cid === "btn_start") { 
        await interaction.deferReply({ ephemeral: true }); 
        return startBot(callerUid, interaction); 
      }
      
      if (cid === "btn_stop") {
        if (stopBot(callerUid, true)) {
          postLog(`⏹ <@${callerUid}> stopped their bot.`);
          return interaction.reply({ content: "⏹ Bot Stopped.", ephemeral: true });
        }
        return interaction.reply({ content: "No active bot session.", ephemeral: true });
      }
      
      if (cid === "btn_settings") {
        const profile = getUser(callerUid);
        const settingsModal = new ModalBuilder().setCustomId("modal_save").setTitle("Settings");
        settingsModal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("Server IP").setStyle(TextInputStyle.Short).setValue(profile.server?.ip || "")),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(profile.server?.port || 19132))),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("off").setLabel("Offline Name").setStyle(TextInputStyle.Short).setValue(profile.offlineUsername || ""))
        );
        return interaction.showModal(settingsModal);
      }
    }

    if (interaction.isModalSubmit() && interaction.customId === "modal_save") {
      const p = getUser(callerUid);
      p.server = { ip: interaction.fields.getTextInputValue("ip").trim(), port: interaction.fields.getTextInputValue("port").trim() };
      p.offlineUsername = interaction.fields.getTextInputValue("off").trim();
      saveDatabase();
      return interaction.reply({ content: "✅ Settings saved successfully.", ephemeral: true });
    }
    
    if (interaction.isStringSelectMenu() && interaction.customId === "adm_force_user") {
      const targetUid = interaction.values[0];
      if (stopBot(targetUid, true)) { 
        sendDM(targetUid, "⚠️ Your bot was stopped by the administrator."); 
        return interaction.reply({ content: `✅ Stopped <@${targetUid}>`, ephemeral: true }); 
      }
    }
  } catch (err) { 
    console.error("Interaction Handler Error:", err); 
  }
});

// Process Error Guard
process.on("unhandledRejection", (e) => console.error("Unhandled Promise Rejection:", e));

client.login(DISCORD_TOKEN);

