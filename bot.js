/**
 * Bedrock AFK Bot - EXPANDED PRODUCTION VERSION
 * Verifioitu ja korjattu: Tammikuu 24, 2026
 * * Toiminnot: 
 * - 30s Rejoin Loop
 * - Aggressive RAM Optimization
 * - Admin Control Panel (Live Updates)
 * - Microsoft Authflow (No Timeout)
 * - Post-Deployment Auto-Restore
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
// CONFIGURATION (ADMIN & CHANNELS)
// ----------------------------------------------------------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ALLOWED_GUILD_ID = "1462335230345089254";
const ADMIN_ID = "1144987924123881564";
const LOG_CHANNEL_ID = "1464615030111731753";
const ADMIN_CHANNEL_ID = "1464615993320935447";
const REJOIN_DELAY = 30000; // 30 seconds
const CONNECT_TIMEOUT = 25000; // 25 seconds

if (!DISCORD_TOKEN) {
  console.error("❌ CRITICAL ERROR: DISCORD_TOKEN is missing.");
  process.exit(1);
}

// ----------------------------------------------------------------
// STORAGE (PERSISTENCE ON VOLUME)
// ----------------------------------------------------------------
const DATA_DIR = path.join(__dirname, "data");
const AUTH_DIR = path.join(DATA_DIR, "auth");
const STORE_FILE = path.join(DATA_DIR, "users.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

let users = {};
if (fs.existsSync(STORE_FILE)) {
  try {
    users = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch (err) {
    console.error("Failed to parse users.json, starting empty.");
    users = {};
  }
}

function saveDatabase() {
  fs.writeFileSync(STORE_FILE, JSON.stringify(users, null, 2));
}

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
let adminPanelMessage = null;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages
  ]
});

// ----------------------------------------------------------------
// LOGGING & SECURITY
// ----------------------------------------------------------------

async function postToLogs(message, color = "#5865F2") {
  try {
    const channel = await client.channels.fetch(LOG_CHANNEL_ID);
    if (channel && channel.isTextBased()) {
      const embed = new EmbedBuilder()
        .setColor(color)
        .setDescription(message)
        .setTimestamp();
      await channel.send({ embeds: [embed] });
    }
  } catch (err) {
    console.error("Logging error:", err.message);
  }
}

async function sendDM(uid, text) {
  try {
    const user = await client.users.fetch(uid);
    if (user) await user.send(text);
  } catch (err) {}
}

function validateGuild(interaction) {
  if (!interaction.inGuild() || interaction.guildId !== ALLOWED_GUILD_ID) {
    const msg = "This bot is restricted to the production guild ⛔";
    if (interaction.deferred || interaction.replied) interaction.editReply(msg).catch(() => {});
    else interaction.reply({ ephemeral: true, content: msg }).catch(() => {});
    return false;
  }
  return true;
}

// ----------------------------------------------------------------
// BOT SESSION LOGIC (RAM & REJOIN OPTIMIZED)
// ----------------------------------------------------------------

function cleanupSession(uid) {
  const s = sessions.get(uid);
  if (!s) return;
  
  if (s.timeout) clearTimeout(s.timeout);
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  if (s.afkInterval) clearInterval(s.afkInterval);
  
  try {
    if (s.client) {
      s.client.removeAllListeners();
      s.client.close();
      s.client = null;
    }
  } catch (err) {}
  
  sessions.delete(uid);
  if (global.gc) global.gc(); // Trigger GC if available
}

function stopBot(uid, manual = true) {
  const session = sessions.get(uid);
  if (manual) {
    const profile = getUser(uid);
    profile.active = false;
    saveDatabase();
  }
  
  if (!session) return false;
  if (manual) session.manualStop = true;
  
  cleanupSession(uid);
  return true;
}

function startBot(uid, interaction = null) {
  const profile = getUser(uid);
  if (!profile.server || !profile.server.ip) {
    if (interaction && !interaction.replied) {
      interaction.editReply("⚠️ Server IP is not set. Go to **Settings**.");
    }
    return;
  }
  
  if (sessions.has(uid) && !sessions.get(uid).isRetrying) {
    if (interaction && !interaction.replied) {
      interaction.editReply("⚠️ Bot is already online.");
    }
    return;
  }

  // Mark as active for persistence
  profile.active = true;
  saveDatabase();

  const ip = profile.server.ip;
  const port = parseInt(profile.server.port) || 19132;

  const options = {
    host: ip,
    port: port,
    connectTimeout: CONNECT_TIMEOUT,
    keepAlive: true,
    version: profile.bedrockVersion === "auto" ? undefined : profile.bedrockVersion
  };

  if (profile.connectionType === "offline") {
    options.username = profile.offlineUsername || `AFK_${uid.slice(-4)}`;
    options.offline = true;
  } else {
    options.username = uid;
    options.offline = false;
    options.profilesFolder = getAuthPath(uid);
  }

  const mc = bedrock.createClient(options);
  let state = sessions.get(uid) || { startedAt: Date.now(), manualStop: false, connected: false, pkts: 0, isRetrying: false };
  state.client = mc;
  state.isRetrying = false;
  sessions.set(uid, state);

  // --- AGGRESSIVE RAM OPTIMIZATION: PACKET STRIPPING ---
  mc.on('packet', (packet) => {
    state.pkts++;
    const name = packet.data.name;
    // Destroy heavy world data/chunks/entities immediately
    if (name.includes('chunk') || name.includes('level') || name.includes('metadata') || name.includes('entity') || name.includes('player_list')) {
      if (packet.data.payload) packet.data.payload = null;
      packet.data = null; 
    }
  });

  // GeyserMC Support: Success Status
  mc.on('play_status', (p) => {
    if ((p.status === 'player_spawn' || p.status === 'login_success') && !state.connected) {
      handleSuccessfulJoin(uid, mc, state, interaction, ip, port);
    }
  });

  mc.on("spawn", () => {
    if (!state.connected) handleSuccessfulJoin(uid, mc, state, interaction, ip, port);
  });

  state.timeout = setTimeout(() => {
    if (sessions.has(uid) && !state.connected) {
      if (interaction && interaction.deferred) {
        interaction.editReply("❌ Connection Timeout (25s). Check if server is online.");
      }
      mc.close();
    }
  }, CONNECT_TIMEOUT);

  mc.on("error", (err) => {
    clearTimeout(state.timeout);
    postToLogs(`❌ Error for <@${uid}>: \`${err.message}\``, "#FF0000");
    if (!state.manualStop) triggerRejoin(uid, interaction);
  });

  mc.on("close", () => {
    clearTimeout(state.timeout);
    postToLogs(`🔌 Bot for <@${uid}> disconnected.`, "#808080");
    if (!state.manualStop) triggerRejoin(uid, interaction);
  });
}

function handleSuccessfulJoin(uid, mc, state, interaction, ip, port) {
  state.connected = true;
  clearTimeout(state.timeout);
  if (interaction && interaction.deferred) {
    interaction.editReply(`🟢 Successfully joined **${ip}:${port}**`);
  }
  postToLogs(`✅ Bot for <@${uid}> is now Online at ${ip}`, "#00FF00");

  // AFK Movement Loop
  state.afkInterval = setInterval(() => {
    try {
      if (!mc.entityId) return;
      mc.write("move_player", {
        runtime_id: mc.entityId, position: mc.entity?.position || {x:0,y:0,z:0}, pitch: 0, yaw: 0, head_yaw: 0,
        mode: 0, on_ground: true, ridden_runtime_id: 0, teleport: false
      });
    } catch (e) {}
  }, 60000);
}

// ----------------- 30s REJOIN LOOP -----------------
function triggerRejoin(uid, interaction) {
  const s = sessions.get(uid);
  if (!s || s.manualStop || s.reconnectTimer) return;

  s.isRetrying = true;
  s.connected = false;
  s.reconnectTimer = setTimeout(() => {
    if (sessions.has(uid) && !s.manualStop) {
      s.reconnectTimer = null;
      startBot(uid, interaction);
    }
  }, REJOIN_DELAY);
}

// ----------------- MICROSOFT AUTH (TIMEOUT SAFE) -----------------

async function handleMsLink(uid, interaction) {
  if (activeLinks.has(uid)) {
    return interaction.editReply("⏳ A login request is already in progress.");
  }

  // Reply immediately to keep the interaction alive
  await interaction.editReply("⏳ Requesting login from Microsoft... This may take a few seconds.");

  const authDir = getAuthPath(uid);
  const profile = getUser(uid);

  try {
    const flow = new Authflow(uid, authDir, {
      flow: "live",
      authTitle: Titles.MinecraftNintendoSwitch,
      deviceType: "Nintendo"
    }, async (data) => {
      const loginEmbed = new EmbedBuilder()
        .setTitle("🔐 Microsoft Account Link")
        .setDescription(`Code: **\`${data.user_code}\`**\n\n1. Click button below\n2. Enter the code\n\n*Bote will update when you are done.*`)
        .setColor("#5865F2");
      
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel("Open Microsoft Link").setStyle(ButtonStyle.Link).setURL(data.verification_uri_complete)
      );

      await interaction.editReply({ content: null, embeds: [loginEmbed], components: [row] });
    });

    const flowPromise = (async () => {
      try {
        await flow.getMsaToken();
        profile.linked = true;
        saveDatabase();
        await interaction.followUp({ ephemeral: true, content: "✅ Success! Microsoft account linked." });
        postToLogs(`🔑 User <@${uid}> successfully linked.`);
      } catch (err) {
        await interaction.followUp({ ephemeral: true, content: `❌ Authentication failed: ${err.message}` });
      } finally {
        activeLinks.delete(uid);
      }
    })();

    activeLinks.set(uid, flowPromise);

  } catch (err) {
    await interaction.editReply(`❌ Failed to start auth: ${err.message}`);
    activeLinks.delete(uid);
  }
}

// ----------------- ADMIN DASHBOARD -----------------

function getAdminEmbed() {
  const mem = process.memoryUsage();
  const rss = (mem.rss / 1024 / 1024).toFixed(2);
  const uptimeSeconds = process.uptime();
  
  const embed = new EmbedBuilder()
    .setTitle("🛠 Admin Control Panel")
    .setColor("#2F3136")
    .addFields(
      { name: "📊 System Stats", value: `**RAM:** ${rss} MB\n**Uptime:** ${Math.floor(uptimeSeconds/3600)}h ${Math.floor((uptimeSeconds%3600)/60)}m\n**Active Bots:** ${sessions.size}`, inline: true },
      { name: "📂 Storage", value: `**Linked:** ${Object.keys(users).length}\n**Auto-Restore:** ON`, inline: true }
    )
    .setTimestamp();

  if (sessions.size > 0) {
    let botList = "";
    for (const [id, s] of sessions) {
      const status = s.connected ? "🟢 Online" : (s.isRetrying ? "🟠 Retrying" : "🔴 Error");
      botList += `${status} <@${id}> (${s.pkts || 0} pkts)\n`;
    }
    embed.addFields({ name: "🤖 Active Bots List", value: botList.slice(0, 1024) });
  } else {
    embed.addFields({ name: "🤖 Active Bots List", value: "No bots running." });
  }

  return embed;
}

function getAdminControls() {
  const rows = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("adm_refresh").setLabel("Refresh Stats").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("adm_stop_all").setLabel("Force Stop All").setStyle(ButtonStyle.Danger)
  )];
  
  if (sessions.size > 0) {
    const opts = Array.from(sessions.keys()).slice(0, 25).map(id => ({ label: `User: ${id}`, value: id }));
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId("adm_force_stop").setPlaceholder("Force Stop specific session").addOptions(opts)
    ));
  }
  return rows;
}

// ----------------- DISCORD HANDLERS -----------------

client.once("ready", async () => {
  console.log(`🟢 Production instance ready: ${client.user.tag}`);
  
  const commands = [
    new SlashCommandBuilder().setName("panel").setDescription("User AFK Control Panel"),
    new SlashCommandBuilder().setName("admin").setDescription("Global Administrator Panel")
  ];
  await client.application.commands.set(commands);

  // --- FIXED AUTO-RESTORE (ReferenceError fixed) ---
  const activeUserIds = Object.keys(users).filter(id => users[id].active === true);
  if (activeUserIds.length > 0) {
    postToLogs(`♻️ **Auto-Restore**: System online. Reconnecting ${activeUserIds.length} sessions...`);
    activeUserIds.forEach((id, idx) => {
      setTimeout(() => startBot(id), idx * 3000); // 3s staggered start
    });
  }

  // Admin Auto-Refresh (30s)
  setInterval(async () => {
    if (adminPanelMessage) {
      try { 
        await adminPanelMessage.edit({ embeds: [getAdminEmbed()], components: getAdminControls() }); 
      } catch (e) { adminPanelMessage = null; }
    }
  }, 30000);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!validateGuild(interaction)) return;
    const uid = interaction.user.id;

    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "panel") {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("btn_link").setLabel("Link Microsoft").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("btn_unlink").setLabel("Unlink").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("btn_start").setLabel("Start Bot").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("btn_stop").setLabel("Stop Bot").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("btn_settings").setLabel("Settings").setStyle(ButtonStyle.Secondary)
        );
        return interaction.reply({ content: "🎛 **AFK Bot Control Panel**", components: [row] });
      }
      
      if (interaction.commandName === "admin") {
        if (uid !== ADMIN_ID) return interaction.reply({ content: "⛔ Unauthorized.", ephemeral: true });
        adminPanelMessage = await interaction.reply({ embeds: [getAdminEmbed()], components: getAdminControls(), fetchReply: true });
        return;
      }
    }

    if (interaction.isButton()) {
      const cid = interaction.customId;

      if (cid === "adm_refresh") {
        if (uid !== ADMIN_ID) return;
        return interaction.update({ embeds: [getAdminEmbed()], components: getAdminControls() });
      }
      
      if (cid === "adm_stop_all") {
        if (uid !== ADMIN_ID) return;
        const total = sessions.size;
        for (const [id, s] of sessions) { 
          stopBot(id, true); 
          await sendDM(id, "⚠️ Your AFK bot was stopped by the owner."); 
        }
        return interaction.reply({ content: `✅ All ${total} sessions terminated.`, ephemeral: true });
      }

      if (cid === "btn_link") { 
        await interaction.deferReply({ ephemeral: true }); 
        return handleMsLink(uid, interaction); 
      }
      
      if (cid === "btn_unlink") {
        const p = getAuthPath(uid);
        if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
        const profile = getUser(uid); profile.linked = false; profile.active = false; saveDatabase();
        return interaction.reply({ content: "🗑 Account Unlinked.", ephemeral: true });
      }
      
      if (cid === "btn_start") { 
        await interaction.deferReply({ ephemeral: true }); 
        return startBot(uid, interaction); 
      }
      
      if (cid === "btn_stop") {
        if (stopBot(uid, true)) {
          postToLogs(`⏹ User <@${uid}> manually stopped their bot.`);
          return interaction.reply({ content: "⏹ Bot Stopped.", ephemeral: true });
        }
        return interaction.reply({ content: "No active bot found.", ephemeral: true });
      }
      
      if (cid === "btn_settings") {
        const profile = getUser(uid);
        const modal = new ModalBuilder().setCustomId("modal_save").setTitle("Bot Configuration");
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("Server IP").setStyle(TextInputStyle.Short).setValue(profile.server?.ip || "")),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(profile.server?.port || 19132))),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("off").setLabel("Offline Name").setStyle(TextInputStyle.Short).setValue(profile.offlineUsername || ""))
        );
        return interaction.showModal(modal);
      }
    }

    if (interaction.isModalSubmit() && interaction.customId === "modal_save") {
      const p = getUser(uid);
      p.server = { ip: interaction.fields.getTextInputValue("ip").trim(), port: interaction.fields.getTextInputValue("port").trim() };
      p.offlineUsername = interaction.fields.getTextInputValue("off").trim();
      saveDatabase();
      return interaction.reply({ content: "✅ Settings saved successfully.", ephemeral: true });
    }
    
    if (interaction.isStringSelectMenu() && interaction.customId === "adm_force_stop") {
      if (uid !== ADMIN_ID) return;
      const target = interaction.values[0];
      if (stopBot(target, true)) { 
        await sendDM(target, "⚠️ Your AFK bot was stopped by the owner."); 
        return interaction.reply({ content: `✅ Session for <@${target}> terminated.`, ephemeral: true }); 
      }
    }
  } catch (err) { console.error("Interaction Handler Error:", err); }
});

process.on("unhandledRejection", (e) => console.error("Unhandled Promise:", e));
client.login(DISCORD_TOKEN);

