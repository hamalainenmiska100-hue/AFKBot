/**
 * AFKBot Panel 🎛️ - STABLE EDITION
 * Bedrock Only | Static UI | Ephemeral Actions | 20s Rejoin
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
  EmbedBuilder
} = require("discord.js");

const bedrock = require("bedrock-protocol");
const { Authflow, Titles } = require("prismarine-auth");
const fs = require("fs");
const path = require("path");

// ----------------- CONFIGURATION -----------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ALLOWED_GUILDS = ["1462335230345089254", "1468289465783943354"];
const ADMIN_ID = "1144987924123881564";

const PATHS = {
  DATA: path.join(__dirname, "data"),
  AUTH: path.join(__dirname, "data", "auth"),
  USERS: path.join(__dirname, "data", "users.json")
};

if (!DISCORD_TOKEN) {
  console.error("❌ CRTICAL ERROR: DISCORD_TOKEN is missing!");
  process.exit(1);
}

// Ensure directories exist
if (!fs.existsSync(PATHS.DATA)) fs.mkdirSync(PATHS.DATA);
if (!fs.existsSync(PATHS.AUTH)) fs.mkdirSync(PATHS.AUTH, { recursive: true });

// ----------------- DATA STORAGE -----------------
let users = {};
try {
  users = fs.existsSync(PATHS.USERS) ? JSON.parse(fs.readFileSync(PATHS.USERS, "utf8")) : {};
} catch (e) {
  users = {};
}

function saveDatabase() {
  fs.writeFile(PATHS.USERS, JSON.stringify(users, null, 2), (err) => {
    if (err) console.error("❌ Save error:", err);
  });
}

function getUser(uid) {
  if (!users[uid]) {
    users[uid] = {
      ip: null,
      port: 19132,
      username: `Bot_${uid.slice(-4)}`,
      onlineMode: false,
      linked: false
    };
    saveDatabase();
  }
  return users[uid];
}

// ----------------- GLOBAL STATE -----------------
const sessions = new Map(); // uid -> { client, afkInt, manualStop }
const pendingAuth = new Set();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ----------------- CORE LOGIC -----------------

/**
 * Flash-fast joining logic with MOTD check and Rejoin support.
 */
async function startBot(uid, interaction = null, isReconnect = false) {
  const u = getUser(uid);

  // 1. UI GUARD (Initial join only)
  if (!isReconnect && interaction) {
    if (sessions.has(uid)) return interaction.reply({ content: "⚠️ **Bot is already running.**", ephemeral: true });
    if (!u.ip) return interaction.reply({ content: "❌ IP missing. Click **Configure**.", ephemeral: true });
    await interaction.reply({ content: `🚀 **Initiating Flash Join to** \`${u.ip}:${u.port}\`...`, ephemeral: true });
  }

  // 2. MOTD CHECK (Ping before join)
  try {
    await bedrock.ping({ host: u.ip, port: parseInt(u.port), skipPing: false, connectTimeout: 5000 });
  } catch (e) {
    const errorMsg = `❌ **Server Offline!**\nTarget: \`${u.ip}:${u.port}\` was unreachable.`;
    if (!isReconnect && interaction) return interaction.editReply({ content: errorMsg });
    
    // For reconnects, notify via DM and stop trying to prevent infinite offline loops
    notifyUser(uid, errorMsg);
    sessions.delete(uid);
    return;
  }

  // 3. CONNECTION OPTIONS
  const options = {
    host: u.ip,
    port: parseInt(u.port),
    connectTimeout: 30000,
    skipPing: true,
    offline: !u.onlineMode,
    username: !u.onlineMode ? u.username : undefined,
    profilesFolder: u.onlineMode ? path.join(PATHS.AUTH, uid) : undefined,
    conLog: () => {} // Speed optimization: suppress protocol logs
  };

  try {
    const bedClient = bedrock.createClient(options);
    
    const session = {
      client: bedClient,
      afkInt: null,
      manualStop: false,
      pos: { x: 0, y: 0, z: 0 }
    };
    sessions.set(uid, session);

    // 4. EVENT LISTENERS (Original Logic)
    bedClient.on('spawn', () => {
      console.log(`[BEDROCK] ${uid} spawned`);
      
      if (!isReconnect && interaction) {
        interaction.editReply({ content: `✅ **Connected!**\nUser: \`${options.username || 'Online'}\`\nServer: \`${u.ip}\`` });
      } else if (isReconnect) {
        notifyUser(uid, `♻️ **Reconnected** to \`${u.ip}\`!`);
      }

      // High-frequency AFK Rotation (Minimal CPU usage)
      session.afkInt = setInterval(() => {
        if (bedClient) {
          try {
            const yaw = (Date.now() % 360);
            bedClient.write('player_auth_input', {
              pitch: 0, yaw: yaw, head_yaw: yaw,
              position: session.pos,
              move_vector: { x: 0, z: 0 },
              input_data: { _value: 0n },
              input_mode: 'mouse', play_mode: 'normal', tick: 0n, delta: { x: 0, y: 0, z: 0 }
            });
          } catch (e) {}
        }
      }, 10000);
    });

    bedClient.on('move_player', (packet) => {
      if (packet.runtime_id === bedClient.entityId) session.pos = packet.position;
    });

    bedClient.on('error', (err) => console.log(`[${uid}] ERR:`, err.message));

    bedClient.on('close', () => {
      console.log(`[${uid}] Disconnected`);
      handleDisconnect(uid);
    });

    bedClient.on('kick', (p) => {
      if (!isReconnect && interaction) interaction.followUp({ content: `🛑 **Kicked:** ${p.message}`, ephemeral: true });
    });

  } catch (e) {
    if (!isReconnect && interaction) interaction.editReply({ content: `❌ **Init Error:** ${e.message}` });
  }
}

function handleDisconnect(uid) {
  const s = sessions.get(uid);
  if (!s) return;

  if (s.afkInt) clearInterval(s.afkInt);

  if (s.manualStop) {
    sessions.delete(uid);
  } else {
    // 20s REJOIN LOGIC
    notifyUser(uid, `⚠️ **Connection Dropped.** Rejoining \`${getUser(uid).ip}\` in 20 seconds...`);
    
    setTimeout(() => {
      // Safety check if user clicked stop during the 20s wait
      if (sessions.has(uid) && !sessions.get(uid).manualStop) {
        startBot(uid, null, true);
      }
    }, 20000);
  }
}

function notifyUser(uid, msg) {
  client.users.fetch(uid).then(u => u.send(msg).catch(() => {})).catch(() => {});
}

// ----------------- UI COMPONENTS -----------------

function getLauncherPanel() {
  const embed = new EmbedBuilder()
    .setTitle("AFKBot Panel 🎛️")
    .setDescription("Flash Join AFK Client for Minecraft Bedrock.\nManage your personal sessions privately.")
    .setColor(0x2B2D31)
    .setFooter({ text: "High Performance Build • No Chunks" });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("btn_start").setLabel("Start Client").setStyle(ButtonStyle.Success).setEmoji("▶️"),
    new ButtonBuilder().setCustomId("btn_stop").setLabel("Stop Client").setStyle(ButtonStyle.Danger).setEmoji("⏹️"),
    new ButtonBuilder().setCustomId("btn_settings").setLabel("Configure").setStyle(ButtonStyle.Secondary).setEmoji("⚙️")
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("btn_link").setLabel("Link Account").setStyle(ButtonStyle.Primary).setEmoji("🔗"),
    new ButtonBuilder().setCustomId("btn_unlink").setLabel("Unlink / Reset").setStyle(ButtonStyle.Danger).setEmoji("🧹")
  );

  return { embeds: [embed], components: [row1, row2] };
}

// ----------------- INTERACTION HANDLER -----------------

client.on(Events.InteractionCreate, async (i) => {
  const uid = i.user.id;

  try {
    // 1. COMMANDS
    if (i.isChatInputCommand() && i.commandName === "panel") {
      if (!ALLOWED_GUILDS.includes(i.guildId)) return i.reply({ content: "⛔ Guild not authorized.", ephemeral: true });
      return i.reply(getLauncherPanel());
    }

    // 2. BUTTONS
    if (i.isButton()) {
      const id = i.customId;

      if (id === "btn_start") return startBot(uid, i, false);

      if (id === "btn_stop") {
        const s = sessions.get(uid);
        if (s) {
          s.manualStop = true;
          if (s.afkInt) clearInterval(s.afkInt);
          try { s.client.close(); } catch (e) {}
          sessions.delete(uid);
          return i.reply({ content: "⏹ **Bot Stopped.** Auto-rejoin disabled.", ephemeral: true });
        }
        return i.reply({ content: "⚠️ **No bot running.**", ephemeral: true });
      }

      if (id === "btn_settings") {
        const u = getUser(uid);
        const modal = new ModalBuilder().setCustomId("modal_config").setTitle("Configure Client");
        
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("Server IP").setStyle(TextInputStyle.Short).setValue(u.ip || "").setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.port || 19132)).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("user").setLabel("Offline Username").setStyle(TextInputStyle.Short).setValue(u.username).setRequired(true))
        );
        return i.showModal(modal);
      }

      if (id === "btn_link") return handleAuth(uid, i);

      if (id === "btn_unlink") {
        const u = getUser(uid);
        u.linked = false;
        u.onlineMode = false;
        saveDatabase();

        // DESTRUCTIVE TOKEN CLEARING
        const authPath = path.join(PATHS.AUTH, uid);
        try {
          if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });
        } catch (e) {}

        return i.reply({ content: "🗑️ **Reset Complete.** Microsoft tokens deleted. Mode: Offline.", ephemeral: true });
      }
    }

    // 3. MODALS
    if (i.isModalSubmit() && i.customId === "modal_config") {
      const u = getUser(uid);
      u.ip = i.fields.getTextInputValue("ip");
      u.port = i.fields.getTextInputValue("port");
      u.username = i.fields.getTextInputValue("user");
      saveDatabase();
      return i.reply({ content: `✅ **Settings Saved!**\nTarget: \`${u.ip}:${u.port}\`\nUser: \`${u.username}\``, ephemeral: true });
    }

  } catch (e) { console.error("Inter error:", e); }
});

// ----------------- AUTH HANDLER -----------------

async function handleAuth(uid, i) {
  if (pendingAuth.has(uid)) return i.reply({ content: "Auth already in progress.", ephemeral: true });

  await i.deferReply({ ephemeral: true });
  pendingAuth.add(uid);

  // Clear folder to ensure fresh link
  try {
    const authPath = path.join(PATHS.AUTH, uid);
    if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });
  } catch (e) {}

  const flow = new Authflow(uid, path.join(PATHS.AUTH, uid), {
    flow: "live", authTitle: Titles.MinecraftNintendoSwitch, deviceType: "Nintendo"
  }, async (res) => {
    const link = res.verification_uri_complete || res.verification_uri || "https://microsoft.com/link";
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel("👉 Login to Microsoft").setStyle(ButtonStyle.Link).setURL(link)
    );

    i.editReply({
      content: `**Action Required:**\n1. Click button below.\n2. Code: \`${res.user_code}\`\n3. Wait for confirmation.`,
      components: [row]
    });
  });

  try {
    await flow.getMsaToken();
    const u = getUser(uid);
    u.linked = true;
    u.onlineMode = true;
    saveDatabase();
    i.followUp({ content: "✅ **Linked!** Bot will now join as your account.", ephemeral: true });
  } catch (e) {
    i.followUp({ content: `❌ **Failed:** ${e.message}`, ephemeral: true });
  } finally {
    pendingAuth.delete(uid);
  }
}

// ----------------- STARTUP -----------------

client.once(Events.ClientReady, () => {
  console.log(`🟢 AFKBot Online: ${client.user.tag}`);
  client.application.commands.set([
    new SlashCommandBuilder().setName("panel").setDescription("Open Launcher Panel")
  ]);
});

client.login(DISCORD_TOKEN);

