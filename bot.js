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
  EmbedBuilder,
  ActivityType,
  Partials
} = require("discord.js");

const bedrock = require("bedrock-protocol");
const { Authflow } = require("prismarine-auth");
const fs = require("fs");
const path = require("path");
const Vec3 = require("vec3");

// --- CONFIGURATION ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN; // Make sure this is in your .env file
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");

// Ensure data directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(path.join(DATA_DIR, "auth"))) fs.mkdirSync(path.join(DATA_DIR, "auth"));

// Load User Data
let users = fs.existsSync(USERS_FILE) ? JSON.parse(fs.readFileSync(USERS_FILE, "utf8")) : {};
const saveUsers = () => fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));

// Active Bot Sessions
const sessions = new Map();
const pendingAuth = new Map();

// --- DISCORD CLIENT WITH ALL INTENTS ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // Required to see member list
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

// --- HELPER FUNCTIONS ---
function getUser(id) {
  if (!users[id]) users[id] = { linked: false, server: null };
  return users[id];
}

// --- BEDROCK BOT LOGIC ---
async function startBedrockBot(userId, interaction) {
  const userConfig = getUser(userId);
  
  if (!userConfig.server) {
    return interaction.reply({ content: "❌ **Error:** Please configure your Server IP and Port in 'Settings' first.", ephemeral: true });
  }

  // Prevent double sessions
  if (sessions.has(userId)) {
    return interaction.reply({ content: "⚠️ You already have a bot running!", ephemeral: true });
  }

  await interaction.reply({ content: `🔄 **Connecting to ${userConfig.server.ip}:${userConfig.server.port}...**`, ephemeral: true });

  const authDir = path.join(DATA_DIR, "auth", userId);

  // Create the Bedrock Client
  const bot = bedrock.createClient({
    host: userConfig.server.ip,
    port: parseInt(userConfig.server.port),
    profilesFolder: authDir,
    username: userId, // Uses specific profile for this user
    offline: false,   // MUST be false for Xbox Live auth (required for most servers)
    skipPing: true,
    viewDistance: 20
  });

  const session = {
    client: bot,
    position: new Vec3(0, 0, 0),
    velocity: new Vec3(0, 0, 0),
    yaw: 0,
    pitch: 0,
    onGround: false,
    entityId: null,
    physicsLoop: null,
    afkInterval: null
  };

  sessions.set(userId, session);

  // --- PHYSICS ENGINE (REQUIRED FOR BEDROCK) ---
  // Without this, the server will kick the bot for "hovering" or not sending inputs.
  function startPhysics() {
    session.physicsLoop = setInterval(() => {
      // 1. Gravity Logic
      if (!session.onGround) {
        session.velocity.y -= 0.08; // Standard gravity
        if (session.velocity.y < -3.92) session.velocity.y = -3.92; // Terminal velocity
      } else {
        session.velocity.y = 0;
      }

      // 2. Update Position
      session.position.add(session.velocity);

      // 3. Void Safety
      if (session.position.y < -64) {
        session.position.y = 100;
        session.velocity.y = 0;
      }

      // 4. Send Packet to Server
      try {
        bot.write('player_auth_input', {
          pitch: session.pitch,
          yaw: session.yaw,
          position: { x: session.position.x, y: session.position.y, z: session.position.z },
          move_vector: { x: 0, z: 0 },
          head_yaw: session.yaw,
          input_data: 0n,
          input_mode: 'mouse',
          play_mode: 'screen',
          interaction_model: 'touch',
          tick: 0n
        });
      } catch (e) {
        // Connection closed
        clearInterval(session.physicsLoop);
      }
    }, 50); // 20 Ticks per second
  }

  // --- ANTI-AFK LOGIC ---
  function startAntiAfk() {
    session.afkInterval = setInterval(() => {
      if (!sessions.has(userId)) return;
      
      // Randomly look around
      session.yaw += (Math.random() - 0.5) * 10;
      session.pitch = (Math.random() * 90) - 45;
      
      // Swing arm
      try {
        bot.write('animate', {
          action_id: 1, // Swing arm
          runtime_entity_id: session.entityId
        });
      } catch(e) {}
    }, 5000 + Math.random() * 5000);
  }

  // --- EVENTS ---
  bot.on('spawn', () => {
    interaction.followUp({ content: `✅ **Connected!** Bot is online at \`${userConfig.server.ip}\`.`, ephemeral: true });
  });

  bot.on('start_game', (packet) => {
    session.entityId = packet.runtime_entity_id;
    session.position = new Vec3(packet.player_position.x, packet.player_position.y, packet.player_position.z);
    
    // CRITICAL: Tells the server we are initialized so we show up in the player list
    bot.write('set_local_player_as_initialized', { runtime_entity_id: packet.runtime_entity_id });
    
    startPhysics();
    startAntiAfk();
  });

  bot.on('move_player', (packet) => {
    // Sync position if server teleports us
    if (packet.runtime_id === session.entityId) {
      session.position.set(packet.position.x, packet.position.y, packet.position.z);
      session.velocity.set(0, 0, 0);
    }
  });

  bot.on('disconnect', (packet) => {
    console.log(`[${userId}] Disconnected: ${packet.message}`);
    stopBedrockBot(userId);
  });

  bot.on('error', (err) => {
    console.error(`[${userId}] Error:`, err);
    stopBedrockBot(userId);
  });

  bot.on('close', () => {
    stopBedrockBot(userId);
  });
}

function stopBedrockBot(userId) {
  const session = sessions.get(userId);
  if (!session) return;

  clearInterval(session.physicsLoop);
  clearInterval(session.afkInterval);
  try { session.client.close(); } catch (e) {}
  sessions.delete(userId);
}

// --- MICROSOFT LINKING LOGIC ---
async function linkAccount(userId, interaction) {
  const authDir = path.join(DATA_DIR, "auth", userId);
  
  if (pendingAuth.has(userId)) return interaction.reply({ content: "⏳ Link already in progress.", ephemeral: true });

  await interaction.deferReply({ ephemeral: true });
  pendingAuth.set(userId, true);

  try {
    const flow = new Authflow(userId, authDir, { flow: "live", authTitle: "BedrockBot" }, async (code) => {
      const link = code.verification_uri;
      const userCode = code.user_code;
      
      const embed = new EmbedBuilder()
        .setTitle("🔐 Link Microsoft Account")
        .setDescription(`To enable the bot to join servers, you must link a Microsoft account.\n\n1. Click the button below\n2. Enter code: \`${userCode}\``)
        .setColor("#2b2d31");

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel("Login with Microsoft").setStyle(ButtonStyle.Link).setURL(link)
      );

      await interaction.editReply({ embeds: [embed], components: [row] });
    });

    await flow.getMsaToken();
    getUser(userId).linked = true;
    saveUsers();
    await interaction.followUp({ content: "✅ **Success!** Microsoft account linked.", ephemeral: true });

  } catch (e) {
    await interaction.followUp({ content: `❌ **Failed:** ${e.message}`, ephemeral: true });
  } finally {
    pendingAuth.delete(userId);
  }
}

// --- DISCORD INTERACTION HANDLER ---
client.on(Events.InteractionCreate, async (i) => {
  const userId = i.user.id;

  // 1. Slash Command
  if (i.isChatInputCommand()) {
    if (i.commandName === "panel") {
      const embed = new EmbedBuilder()
        .setTitle("🤖 Bedrock AFK Control")
        .setDescription("Manage your AFK bot. Make sure to **Settings** -> **Link** -> **Start**.")
        .setColor("#5865F2");

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("start").setLabel("▶ Start").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("stop").setLabel("⏹ Stop").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("link").setLabel("🔗 Link Account").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Secondary)
      );

      return i.reply({ embeds: [embed], components: [row] });
    }
  }

  // 2. Buttons
  if (i.isButton()) {
    if (i.customId === "start") return startBedrockBot(userId, i);
    
    if (i.customId === "stop") {
      stopBedrockBot(userId);
      return i.reply({ content: "⏹ **Bot Stopped.**", ephemeral: true });
    }

    if (i.customId === "link") return linkAccount(userId, i);

    if (i.customId === "settings") {
      const config = getUser(userId);
      const modal = new ModalBuilder().setCustomId("settings_modal").setTitle("Server Configuration");
      
      const ipInput = new TextInputBuilder()
        .setCustomId("ip")
        .setLabel("Server IP")
        .setStyle(TextInputStyle.Short)
        .setValue(config.server?.ip || "")
        .setRequired(true);

      const portInput = new TextInputBuilder()
        .setCustomId("port")
        .setLabel("Port")
        .setStyle(TextInputStyle.Short)
        .setValue(config.server?.port || "19132")
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(ipInput), new ActionRowBuilder().addComponents(portInput));
      return i.showModal(modal);
    }
  }

  // 3. Modals
  if (i.isModalSubmit() && i.customId === "settings_modal") {
    const ip = i.fields.getTextInputValue("ip");
    const port = i.fields.getTextInputValue("port");

    getUser(userId).server = { ip, port };
    saveUsers();

    return i.reply({ content: `✅ **Saved!** Target: \`${ip}:${port}\``, ephemeral: true });
  }
});

// --- STARTUP ---
client.once("ready", async () => {
  console.log(`🟢 Logged in as ${client.user.tag}`);
  
  // Register Command
  const cmd = new SlashCommandBuilder().setName("panel").setDescription("Open the Bedrock Bot Panel");
  await client.application.commands.set([cmd]);

  // Set Status
  client.user.setActivity("Minecraft Bedrock", { type: ActivityType.Playing });
});

// Login
client.login(DISCORD_TOKEN);
