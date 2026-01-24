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
// CONFIGURATION & CONSTANTS
// ----------------------------------------------------------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ALLOWED_GUILD_ID = "1462335230345089254";
const ADMIN_ID = "1144987924123881564";
const LOG_CHANNEL_ID = "1464615030111731753";
const ADMIN_CHANNEL_ID = "1464615993320935447";
const CONNECTION_TIMEOUT = 25000; // 25 seconds

if (!DISCORD_TOKEN) {
  console.error("❌ ERROR: DISCORD_TOKEN is missing from environment variables.");
  process.exit(1);
}

// ----------------------------------------------------------------
// STORAGE & PERSISTENCE
// ----------------------------------------------------------------
const DATA_FOLDER = path.join(__dirname, "data");
const AUTH_CACHE_FOLDER = path.join(DATA_FOLDER, "auth");
const USER_DATABASE_FILE = path.join(DATA_FOLDER, "users.json");

// Ensure directories exist
if (!fs.existsSync(DATA_FOLDER)) {
  fs.mkdirSync(DATA_FOLDER);
}
if (!fs.existsSync(AUTH_CACHE_FOLDER)) {
  fs.mkdirSync(AUTH_CACHE_FOLDER, { recursive: true });
}

// Load users from local storage
let users = {};
if (fs.existsSync(USER_DATABASE_FILE)) {
  try {
    users = JSON.parse(fs.readFileSync(USER_DATABASE_FILE, "utf8"));
  } catch (err) {
    console.error("❌ ERROR: Failed to parse users.json", err);
    users = {};
  }
}

/**
 * Saves the current user state to the JSON file
 */
function saveDatabase() {
  fs.writeFileSync(USER_DATABASE_FILE, JSON.stringify(users, null, 2));
}

/**
 * Gets or initializes a user object
 */
function getUserProfile(userId) {
  if (!users[userId]) {
    users[userId] = {
      connectionType: "online",
      bedrockVersion: "auto",
      offlineUsername: `AFK_${userId.slice(-4)}`,
      active: false,
      server: null
    };
  }
  return users[userId];
}

/**
 * Returns the path to a specific user's auth cache
 */
function getUserAuthPath(userId) {
  const userPath = path.join(AUTH_CACHE_FOLDER, userId);
  if (!fs.existsSync(userPath)) {
    fs.mkdirSync(userPath, { recursive: true });
  }
  return userPath;
}

// ----------------------------------------------------------------
// RUNTIME STATE MANAGEMENT
// ----------------------------------------------------------------
const activeSessions = new Map();
const loginProcesses = new Map();
let globalAdminPanelMessage = null;

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages
  ]
});

// ----------------------------------------------------------------
// LOGGING & NOTIFICATIONS
// ----------------------------------------------------------------

/**
 * Sends an embed log to the specified log channel
 */
async function postLog(description, color = "#5865F2") {
  try {
    const channel = await discordClient.channels.fetch(LOG_CHANNEL_ID);
    if (channel && channel.isTextBased()) {
      const logEmbed = new EmbedBuilder()
        .setColor(color)
        .setDescription(description)
        .setTimestamp();
      await channel.send({ embeds: [logEmbed] });
    }
  } catch (err) {
    console.error("⚠️ Logging failure:", err.message);
  }
}

/**
 * Sends a direct message to a user
 */
async function sendDirectMessage(userId, content) {
  try {
    const user = await discordClient.users.fetch(userId);
    if (user) {
      await user.send(content);
    }
  } catch (err) {
    console.warn(`⚠️ Could not DM user ${userId}:`, err.message);
  }
}

/**
 * Security check for the production server
 */
function validateGuild(interaction) {
  if (!interaction.inGuild() || interaction.guildId !== ALLOWED_GUILD_ID) {
    const response = "This bot is restricted to the official production server ⛔";
    if (interaction.deferred || interaction.replied) {
      interaction.editReply(response).catch(() => {});
    } else {
      interaction.reply({ ephemeral: true, content: response }).catch(() => {});
    }
    return false;
  }
  return true;
}

// ----------------------------------------------------------------
// CORE BOT SESSION LOGIC (RAM OPTIMIZED)
// ----------------------------------------------------------------

/**
 * Fully cleans up a session and its associated memory
 */
function terminateSession(userId) {
  const session = activeSessions.get(userId);
  if (!session) return;

  if (session.connectionTimeout) clearTimeout(session.connectionTimeout);
  if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
  if (session.afkMovementInterval) clearInterval(session.afkMovementInterval);

  try {
    if (session.minecraftClient) {
      session.minecraftClient.removeAllListeners();
      session.minecraftClient.close();
      // Set to null to assist Garbage Collection
      session.minecraftClient = null;
    }
  } catch (err) {
    console.error(`Error closing client for ${userId}:`, err);
  }

  activeSessions.delete(userId);
  
  // Suggest Garbage Collection if the engine supports it
  if (global.gc) {
    global.gc();
  }
}

/**
 * Stops a bot session and updates the persistent database
 */
function stopBotSession(userId, isManualAction = true) {
  const session = activeSessions.get(userId);
  
  if (isManualAction) {
    const profile = getUserProfile(userId);
    profile.active = false;
    saveDatabase();
  }

  if (!session) return false;

  if (isManualAction) {
    session.isManualStop = true;
  }

  terminateSession(userId);
  return true;
}

/**
 * Initiates a Minecraft Bedrock connection
 */
function startBotSession(userId, interaction = null) {
  const profile = getUserProfile(userId);

  if (!profile.server || !profile.server.ip) {
    if (interaction && !interaction.replied) {
      interaction.editReply("⚠️ Server configuration is missing. Please go to **Settings** first.");
    }
    return;
  }

  // Prevent duplicate sessions
  if (activeSessions.has(userId)) {
    const existing = activeSessions.get(userId);
    if (!existing.isReconnecting) {
      if (interaction && !interaction.replied) {
        interaction.editReply("⚠️ Your bot is already online or connecting.");
      }
      return;
    }
  }

  // Set persistence
  profile.active = true;
  saveDatabase();

  const serverIp = profile.server.ip;
  const serverPort = parseInt(profile.server.port) || 19132;

  const connectionOptions = {
    host: serverIp,
    port: serverPort,
    connectTimeout: CONNECTION_TIMEOUT,
    keepAlive: true,
    version: profile.bedrockVersion === "auto" ? undefined : profile.bedrockVersion
  };

  if (profile.connectionType === "offline") {
    connectionOptions.username = profile.offlineUsername || `AFK_${userId.slice(-4)}`;
    connectionOptions.offline = true;
  } else {
    connectionOptions.username = userId;
    connectionOptions.offline = false;
    connectionOptions.profilesFolder = getUserAuthPath(userId);
  }

  const mcClient = bedrock.createClient(connectionOptions);
  
  let sessionState = activeSessions.get(userId) || {
    startedAt: Date.now(),
    isManualStop: false,
    connected: false,
    packetCounter: 0,
    isReconnecting: false
  };

  sessionState.minecraftClient = mcClient;
  sessionState.isReconnecting = false;
  activeSessions.set(userId, sessionState);

  // ------------------------------------------------------------
  // RAM OPTIMIZATION: HEAVY PACKET FILTERING
  // This prevents the bot from storing chunk and entity data in RAM.
  // ------------------------------------------------------------
  mcClient.on('packet', (packet) => {
    sessionState.packetCounter++;
    
    const packetName = packet.data.name;

    // List of memory-heavy world data packets we do NOT need
    if (
      packetName === 'level_chunk' || 
      packetName === 'subchunk' || 
      packetName === 'level_event' ||
      packetName === 'level_sound_event' ||
      packetName === 'level_event_generic' ||
      packetName === 'player_list' ||
      packetName === 'add_entity' ||
      packetName === 'add_player' ||
      packetName === 'remove_entity' ||
      packetName === 'mob_equipment_packet' ||
      packetName === 'mob_armor_equipment' ||
      packetName === 'metadata_dictionary'
    ) {
      // Void the payload to free memory immediately
      if (packet.data.payload) packet.data.payload = null;
      packet.data = null; 
    }
  });

  // ------------------------------------------------------------
  // CONNECTION HANDLING
  // ------------------------------------------------------------

  // Support for Geyser and standard Bedrock servers
  mcClient.on('play_status', (packet) => {
    if ((packet.status === 'player_spawn' || packet.status === 'login_success') && !sessionState.connected) {
      onSuccessfulSpawn(userId, mcClient, sessionState, interaction, serverIp, serverPort);
    }
  });

  mcClient.on("spawn", () => {
    if (!sessionState.connected) {
      onSuccessfulSpawn(userId, mcClient, sessionState, interaction, serverIp, serverPort);
    }
  });

  // Timeout logic
  sessionState.connectionTimeout = setTimeout(() => {
    if (activeSessions.has(userId) && !sessionState.connected) {
      if (interaction && interaction.deferred) {
        interaction.editReply("❌ Connection timed out (25s). The server might be offline or slow.");
      }
      mcClient.close();
    }
  }, CONNECTION_TIMEOUT);

  mcClient.on("error", (err) => {
    clearTimeout(sessionState.connectionTimeout);
    postLog(`❌ Error for <@${userId}>: \`${err.message}\``, "#FF0000");
    if (!sessionState.isManualStop) {
      initiateAutoReconnect(userId, interaction);
    }
  });

  mcClient.on("close", () => {
    clearTimeout(sessionState.connectionTimeout);
    postLog(`🔌 Connection closed for <@${userId}>`, "#808080");
    if (!sessionState.isManualStop) {
      initiateAutoReconnect(userId, interaction);
    }
  });
}

/**
 * Runs logic when the bot successfully enters the world
 */
function onSuccessfulSpawn(userId, mcClient, sessionState, interaction, ip, port) {
  sessionState.connected = true;
  clearTimeout(sessionState.connectionTimeout);
  
  if (interaction && interaction.deferred) {
    interaction.editReply(`🟢 Successfully online at **${ip}:${port}** (Persistent Session)`);
  }
  
  postLog(`✅ Bot for <@${userId}> is now **Online** at ${ip}`, "#00FF00");

  // AFK Movement Logic (Anti-Kick)
  sessionState.afkMovementInterval = setInterval(() => {
    try {
      if (!mcClient.entityId) return;
      
      const currentPos = mcClient.entity?.position || { x: 0, y: 0, z: 0 };
      
      // Send a minimal movement packet to stay active
      mcClient.write("move_player", {
        runtime_id: mcClient.entityId,
        position: currentPos,
        pitch: 0,
        yaw: 0,
        head_yaw: 0,
        mode: 0,
        on_ground: true,
        ridden_runtime_id: 0,
        teleport: false
      });
    } catch (err) {}
  }, 60000); // 1 minute interval
}

/**
 * Handles automatic reconnection attempts
 */
function initiateAutoReconnect(userId, interaction) {
  const session = activeSessions.get(userId);
  if (!session || session.isManualStop || session.reconnectTimer) return;

  session.isReconnecting = true;
  session.connected = false;

  // Wait 2 minutes before retrying
  session.reconnectTimer = setTimeout(() => {
    if (activeSessions.has(userId) && !session.isManualStop) {
      session.reconnectTimer = null;
      startBotSession(userId, interaction);
    }
  }, 120000);
}

// ----------------------------------------------------------------
// MICROSOFT AUTHENTICATION FLOW
// ----------------------------------------------------------------

/**
 * Handles the Microsoft linking process
 */
async function handleMicrosoftLink(userId, interaction) {
  if (loginProcesses.has(userId)) {
    return interaction.editReply("⏳ A login process is already active for your account.");
  }

  const authPath = getUserAuthPath(userId);
  const profile = getUserProfile(userId);

  const flow = new Authflow(userId, authPath, {
    flow: "live",
    authTitle: Titles.MinecraftNintendoSwitch,
    deviceType: "Nintendo"
  }, async (data) => {
    const authEmbed = new EmbedBuilder()
      .setTitle("🔐 Microsoft Authentication")
      .setDescription(
        `Please follow these steps to link your account:\n\n` +
        `1. Go to: **${data.verification_uri_complete}**\n` +
        `2. Confirm the code: **\`${data.user_code}\`**\n\n` +
        `*Tip: Use a dedicated AFK account, not your main account.*`
      )
      .setColor("#5865F2");
    
    const actionRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel("Open Login Page")
        .setStyle(ButtonStyle.Link)
        .setURL(data.verification_uri_complete)
    );

    await interaction.editReply({ content: null, embeds: [authEmbed], components: [actionRow] });
  });

  const linkPromise = (async () => {
    try {
      await flow.getMsaToken();
      profile.linked = true;
      saveDatabase();
      
      await interaction.followUp({ ephemeral: true, content: "✅ Your Microsoft account has been linked successfully!" });
      postLog(`🔑 User <@${userId}> linked a Microsoft account.`);
    } catch (err) {
      await interaction.followUp({ ephemeral: true, content: `❌ Authentication failed: ${err.message}` });
    } finally {
      loginProcesses.delete(userId);
    }
  })();

  loginProcesses.set(userId, linkPromise);
}

// ----------------------------------------------------------------
// ADMIN INTERFACE & DASHBOARD
// ----------------------------------------------------------------

/**
 * Generates the system analytics embed
 */
function generateAdminEmbed() {
  const memUsage = process.memoryUsage();
  const uptimeSeconds = process.uptime();
  
  const ramMb = (memUsage.rss / 1024 / 1024).toFixed(2);
  const hours = Math.floor(uptimeSeconds / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);

  const statsEmbed = new EmbedBuilder()
    .setTitle("🚀 Production Admin Dashboard")
    .setColor("#2B2D31")
    .addFields(
      { 
        name: "💻 System Status", 
        value: `**RAM Usage:** ${ramMb} MB\n**Uptime:** ${hours}h ${minutes}m\n**Active Bots:** ${activeSessions.size}`, 
        inline: true 
      },
      { 
        name: "📂 Storage Stats", 
        value: `**Linked Users:** ${Object.keys(users).length}\n**Volume:** /app/data\n**Auto-Restore:** ENABLED`, 
        inline: true 
      }
    )
    .setTimestamp()
    .setFooter({ text: "Real-time Analytics • No Chunks Loaded" });

  if (activeSessions.size > 0) {
    let sessionList = "";
    for (const [id, s] of activeSessions) {
      const statusIcon = s.connected ? "🟢" : (s.isReconnecting ? "⏳" : "🔴");
      sessionList += `${statusIcon} <@${id}> (${s.packetCounter} pkts)\n`;
    }
    statsEmbed.addFields({ name: "🤖 Live Session Feed", value: sessionList.slice(0, 1024) });
  } else {
    statsEmbed.addFields({ name: "🤖 Live Session Feed", value: "No active bot connections." });
  }

  return statsEmbed;
}

/**
 * Generates buttons and menus for the admin panel
 */
function generateAdminControls() {
  const controlRows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("adm_refresh").setLabel("Refresh Stats").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("adm_stop_all").setLabel("Force Stop All").setStyle(ButtonStyle.Danger)
    )
  ];

  if (activeSessions.size > 0) {
    const botOptions = Array.from(activeSessions.keys()).slice(0, 25).map(id => {
      const s = activeSessions.get(id);
      return {
        label: `User: ${id}`,
        description: s.connected ? "Status: Online" : "Status: Connecting",
        value: id
      };
    });

    controlRows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("adm_force_stop")
          .setPlaceholder("Select a session to terminate")
          .addOptions(botOptions)
      )
    );
  }

  return controlRows;
}

// ----------------------------------------------------------------
// DISCORD INTERACTION HANDLERS
// ----------------------------------------------------------------

discordClient.once("ready", async () => {
  console.log(`🟢 Bot Production Instance is Live: ${discordClient.user.tag}`);

  const slashCommands = [
    new SlashCommandBuilder().setName("panel").setDescription("Access the AFK Bot control panel"),
    new SlashCommandBuilder().setName("admin").setDescription("Access production analytics (Owner only)")
  ];

  await discordClient.application.commands.set(slashCommands);

  // ------------------------------------------------------------
  // AUTO-RESTORE LOGIC (Survivor Mode)
  // This reconnects all bots that were active before a deployment.
  // ------------------------------------------------------------
  const activeUserIds = Object.keys(users).filter(id => users[id].active === true);
  
  if (activeUserIds.length > 0) {
    postLog(`♻️ **Auto-Restore Initiated**: Deployment finished. Reconnecting ${activeUserIds.length} sessions...`);
    
    // Stagger starts every 3 seconds to avoid CPU spikes
    activeUserIds.forEach((id, index) => {
      setTimeout(() => {
        startBotSession(id);
      }, index * 3000);
    });
  }

  // Admin Dashboard Auto-Refresh Loop
  setInterval(async () => {
    if (globalAdminPanelMessage) {
      try {
        await globalAdminPanelMessage.edit({
          embeds: [generateAdminEmbed()],
          components: generateAdminControls()
        });
      } catch (err) {
        globalAdminPanelMessage = null; // Reset if message was deleted
      }
    }
  }, 30000); // 30 seconds
});

discordClient.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!validateGuild(interaction)) return;
    const callerId = interaction.user.id;

    // --- SLASH COMMANDS ---
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "panel") {
        const panelEmbed = new EmbedBuilder()
          .setTitle("🎛 AFK Bot Control Center")
          .setDescription("Use the buttons below to manage your Minecraft AFK bot.")
          .setColor("#2F3136");

        const userRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("btn_link").setLabel("Link Microsoft").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("btn_unlink").setLabel("Unlink").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("btn_start").setLabel("Start Bot").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("btn_stop").setLabel("Stop Bot").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("btn_settings").setLabel("Settings").setStyle(ButtonStyle.Secondary)
        );

        return interaction.reply({ embeds: [panelEmbed], components: [userRow] });
      }

      if (interaction.commandName === "admin") {
        if (callerId !== ADMIN_ID) {
          return interaction.reply({ content: "⛔ Access denied. This command is restricted to the bot owner.", ephemeral: true });
        }
        if (interaction.channelId !== ADMIN_CHANNEL_ID) {
          return interaction.reply({ content: `⛔ Please use this command in the admin channel: <#${ADMIN_CHANNEL_ID}>`, ephemeral: true });
        }

        const adminMsg = await interaction.reply({
          embeds: [generateAdminEmbed()],
          components: generateAdminControls(),
          fetchReply: true
        });
        globalAdminPanelMessage = adminMsg;
        return;
      }
    }

    // --- BUTTON CLICKS ---
    if (interaction.isButton()) {
      const cid = interaction.customId;

      // Admin Actions
      if (cid === "adm_refresh") {
        if (callerId !== ADMIN_ID) return;
        return interaction.update({ embeds: [generateAdminEmbed()], components: generateAdminControls() });
      }

      if (cid === "adm_stop_all") {
        if (callerId !== ADMIN_ID) return;
        const total = activeSessions.size;
        for (const [uid, session] of activeSessions) {
          stopBotSession(uid, true);
          await sendDirectMessage(uid, "⚠️ Your AFK bot has been force-stopped by the administrator.");
        }
        postLog(`🚨 **Admin Action**: Force-stopped all ${total} sessions.`);
        return interaction.reply({ content: `✅ All ${total} sessions have been terminated.`, ephemeral: true });
      }

      // User Actions
      if (cid === "btn_link") {
        await interaction.deferReply({ ephemeral: true });
        return handleMicrosoftLink(callerId, interaction);
      }

      if (cid === "btn_unlink") {
        const authPath = getUserAuthPath(callerId);
        if (fs.existsSync(authPath)) {
          fs.rmSync(authPath, { recursive: true, force: true });
        }
        const profile = getUserProfile(callerId);
        profile.linked = false;
        profile.active = false;
        saveDatabase();
        postLog(`🗑 User <@${callerId}> removed their Microsoft link.`);
        return interaction.reply({ content: "🗑 Your Microsoft link and session cache have been cleared.", ephemeral: true });
      }

      if (cid === "btn_start") {
        await interaction.deferReply({ ephemeral: true });
        return startBotSession(callerId, interaction);
      }

      if (cid === "btn_stop") {
        if (stopBotSession(callerId, true)) {
          postLog(`⏹ User <@${callerId}> stopped their bot.`);
          return interaction.reply({ content: "⏹ Bot session stopped.", ephemeral: true });
        }
        return interaction.reply({ content: "❌ You don't have an active bot session.", ephemeral: true });
      }

      if (cid === "btn_settings") {
        const profile = getUserProfile(callerId);
        const settingsModal = new ModalBuilder().setCustomId("modal_settings").setTitle("Bot Configuration");

        const ipInput = new TextInputBuilder()
          .setCustomId("field_ip")
          .setLabel("Server IP / Address")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. survival.example.com")
          .setRequired(true)
          .setValue(profile.server?.ip || "");

        const portInput = new TextInputBuilder()
          .setCustomId("field_port")
          .setLabel("Port (Default 19132)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("19132")
          .setRequired(true)
          .setValue(String(profile.server?.port || 19132));

        const offlineNameInput = new TextInputBuilder()
          .setCustomId("field_offline")
          .setLabel("Offline Username (Cracked mode only)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setValue(profile.offlineUsername || "");

        settingsModal.addComponents(
          new ActionRowBuilder().addComponents(ipInput),
          new ActionRowBuilder().addComponents(portInput),
          new ActionRowBuilder().addComponents(offlineNameInput)
        );

        return interaction.showModal(settingsModal);
      }
    }

    // --- MENU SELECTIONS ---
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === "adm_force_stop") {
        if (callerId !== ADMIN_ID) return;
        const targetId = interaction.values[0];
        if (stopBotSession(targetId, true)) {
          await sendDirectMessage(targetId, "⚠️ Your AFK bot has been force-stopped by the administrator.");
          postLog(`🚨 **Admin Action**: Force-stopped bot for <@${targetId}>`);
          return interaction.reply({ content: `✅ Session for <@${targetId}> has been terminated.`, ephemeral: true });
        }
      }
    }

    // --- MODAL SUBMISSIONS ---
    if (interaction.isModalSubmit() && interaction.customId === "modal_settings") {
      const newIp = interaction.fields.getTextInputValue("field_ip").trim();
      const newPort = interaction.fields.getTextInputValue("field_port").trim();
      const newOffline = interaction.fields.getTextInputValue("field_offline").trim();

      const profile = getUserProfile(callerId);
      profile.server = { ip: newIp, port: newPort };
      if (newOffline) profile.offlineUsername = newOffline;
      
      saveDatabase();
      return interaction.reply({ content: `✅ Settings saved! Server: **${newIp}:${newPort}**`, ephemeral: true });
    }

  } catch (err) {
    console.error("🔥 CRITICAL INTERACTION ERROR:", err);
  }
});

// Process-level error handling to keep the bot alive
process.on("unhandledRejection", (err) => console.error("Unhandled Promise Rejection:", err));
process.on("uncaughtException", (err) => console.error("Uncaught Exception:", err));

discordClient.login(DISCORD_TOKEN);

