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

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("❌ DISCORD_TOKEN missing");
  process.exit(1);
}

const ALLOWED_GUILD_ID = "1462335230345089254";
const ADMIN_CHANNEL_ID = "1464615993320935447";

// ----------------- Storage -----------------
const DATA = path.join(__dirname, "data");
const AUTH_ROOT = path.join(DATA, "auth");
const STORE = path.join(DATA, "users.json");

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA);
if (!fs.existsSync(AUTH_ROOT)) fs.mkdirSync(AUTH_ROOT, { recursive: true });

let users = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, "utf8")) : {};
function save() {
  fs.writeFileSync(STORE, JSON.stringify(users, null, 2));
}

function getUser(uid) {
  if (!users[uid]) users[uid] = {};
  if (!users[uid].delayMs) users[uid].delayMs = 5000;
  if (!users[uid].connectionType) users[uid].connectionType = "online";
  if (!users[uid].bedrockVersion) users[uid].bedrockVersion = "auto";
  if (!users[uid].offlineUsername) users[uid].offlineUsername = `AFK_${uid.slice(-4)}`;
  return users[uid];
}

function getUserAuthDir(uid) {
  const dir = path.join(AUTH_ROOT, uid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function unlinkMicrosoft(uid) {
  const dir = getUserAuthDir(uid);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  const u = getUser(uid);
  u.linked = false;
  save();
}

// ----------------- Runtime -----------------
const sessions = new Map();
const pendingLink = new Map();
const lastMsa = new Map();

// ----------------- Discord client -----------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

function denyIfWrongGuild(i) {
  if (!i.inGuild() || i.guildId !== ALLOWED_GUILD_ID) {
    const msg = "This bot cannot be used in this server ⛔️";
    if (i.deferred) return i.editReply(msg).catch(() => {});
    if (i.replied) return i.followUp({ ephemeral: true, content: msg }).catch(() => {});
    return i.reply({ ephemeral: true, content: msg }).catch(() => {});
  }
  return null;
}

// ----------------- UI Helpers -----------------
function panelRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("link").setLabel("🔑 Link Microsoft").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("unlink").setLabel("🗑 Unlink Account").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("start").setLabel("▶ Start").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("stop").setLabel("⏹ Stop").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Secondary)
    )
  ];
}

// ----------------- Slash Commands -----------------
client.once("ready", async () => {
  console.log("🟢 Bot is online as", client.user.tag);
  
  const cmds = [
    new SlashCommandBuilder().setName("panel").setDescription("Open Bedrock AFK Control Panel"),
    new SlashCommandBuilder()
      .setName("admin")
      .setDescription("Admin restricted commands")
      .addSubcommand(sub => sub.setName("info").setDescription("View global bot statistics and running sessions"))
      .addSubcommand(sub => 
        sub.setName("stop-user")
          .setDescription("Force stop a specific user's bot")
          .addUserOption(opt => opt.setName("target").setDescription("The user to stop").setRequired(true))
      )
      .addSubcommand(sub => sub.setName("stop-all").setDescription("Force stop ALL currently running bots"))
  ];

  await client.application.commands.set(cmds);
});

// ----------------- Microsoft Link Flow -----------------
async function linkMicrosoft(uid, interaction) {
  if (pendingLink.has(uid)) {
    await interaction.editReply("⏳ Login is already in progress.");
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
      const uri = data.verification_uri_complete || data.verification_uri || "https://www.microsoft.com/link";
      const code = data.user_code || "(no code)";
      lastMsa.set(uid, { uri, code, at: Date.now() });
      codeShown = true;

      const msg = `🔐 **Microsoft Login Required**\n\n👉 ${uri}\n\nYour code: \`${code}\`\n\nReturn here once you have signed in.`;
      await interaction.editReply({ 
        content: msg, 
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("🌐 Open Link").setStyle(ButtonStyle.Link).setURL(uri))]
      }).catch(() => {});
    }
  );

  const p = (async () => {
    try {
      if (!codeShown) await interaction.editReply("⏳ Requesting login code…");
      await flow.getMsaToken();
      u.linked = true;
      save();
      await interaction.followUp({ ephemeral: true, content: "✅ Microsoft account linked successfully!" }).catch(() => {});
    } catch (e) {
      await interaction.editReply(`❌ Login failed: ${String(e.message)}`).catch(() => {});
    } finally {
      pendingLink.delete(uid);
    }
  })();
  pendingLink.set(uid, p);
}

// ----------------- Bedrock Session & Physics -----------------

function cleanupSession(uid) {
  const s = sessions.get(uid);
  if (!s) return;
  if (s.timeout) clearTimeout(s.timeout);
  if (s.physicsLoop) clearInterval(s.physicsLoop);
  if (s.rejoinTimeout) clearTimeout(s.rejoinTimeout);
  try { s.client.close(); } catch {}
  sessions.delete(uid);
}

function stopSession(uid) {
  if (!sessions.has(uid)) return false;
  const s = sessions.get(uid);
  s.manualStop = true;
  cleanupSession(uid);
  return true;
}

function startSession(uid, interaction) {
  const u = getUser(uid);
  if (!u.server) {
    if (interaction && !interaction.replied) interaction.editReply("⚠ Please configure settings first.").catch(() => {});
    return;
  }

  if (sessions.has(uid) && !sessions.get(uid).isDisconnected) return;

  const { ip, port } = u.server;
  const authDir = getUserAuthDir(uid);

  const opts = {
    host: ip,
    port,
    connectTimeout: 47000,
    keepAlive: true
  };

  if (u.connectionType === "offline") {
    opts.username = u.offlineUsername || `AFK_${uid.slice(-4)}`;
    opts.offline = true;
  } else {
    opts.username = uid;
    opts.profilesFolder = authDir;
  }

  const mc = bedrock.createClient(opts);
  
  const session = { 
    client: mc, 
    timeout: null, 
    physicsLoop: null, 
    rejoinTimeout: null, 
    manualStop: false,
    isDisconnected: false,
    packetCount: 0,
    // Physics State
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    isMoving: false,
    serverInfo: { ip, port }
  };
  sessions.set(uid, session);

  // Track packets
  mc.on('packet', () => session.packetCount++);

  session.timeout = setTimeout(() => {
    if (sessions.has(uid) && !session.isDisconnected) {
      cleanupSession(uid);
      if (interaction) interaction.editReply("❌ Connection timed out.").catch(() => {});
    }
  }, 47000);

  mc.on("spawn", () => {
    clearTimeout(session.timeout);
    if (interaction) interaction.editReply(`🟢 Bot is online on **${ip}:${port}**. Realistic physics active.`).catch(() => {});

    if (mc.entity?.position) {
      session.pos = { ...mc.entity.position };
    }

    session.physicsLoop = setInterval(() => {
      if (!mc.entityId) return;

      const friction = 0.91;
      const acceleration = 0.08;
      
      const now = Date.now();
      if (!session.nextActionTime || now > session.nextActionTime) {
        session.isMoving = !session.isMoving;
        session.nextActionTime = now + (session.isMoving ? 3000 : 20000 + Math.random() * 10000);
        
        if (session.isMoving) {
          session.moveDir = Math.random() > 0.5 ? 1 : -1;
          session.yaw = Math.random() * 360; 
        }
      }

      if (session.isMoving) {
        const rad = (session.yaw + 90) * (Math.PI / 180);
        session.vel.x += Math.cos(rad) * acceleration * session.moveDir;
        session.vel.z += Math.sin(rad) * acceleration * session.moveDir;
      }

      session.vel.x *= friction;
      session.vel.z *= friction;

      if (Math.abs(session.vel.x) < 0.001) session.vel.x = 0;
      if (Math.abs(session.vel.z) < 0.001) session.vel.z = 0;

      session.pos.x += session.vel.x;
      session.pos.z += session.vel.z;

      if (session.vel.x !== 0 || session.vel.z !== 0 || session.isMoving) {
        try {
          mc.write("move_player", {
            runtime_id: mc.entityId,
            position: session.pos,
            pitch: session.pitch,
            yaw: session.yaw,
            head_yaw: session.yaw,
            mode: 0,
            on_ground: true,
            ridden_runtime_id: 0,
            teleport: false
          });
        } catch {}
      }
    }, 50); 
  });

  mc.on("close", () => {
    session.isDisconnected = true;
    if (session.physicsLoop) clearInterval(session.physicsLoop);
    
    // --- AUTO REJOIN (2 Minutes) ---
    if (!session.manualStop) {
      console.log(`Bot disconnected (${uid}). Rejoining in 2 minutes...`);
      session.rejoinTimeout = setTimeout(() => {
        if (!session.manualStop) startSession(uid, interaction);
      }, 120000);
    } else {
      cleanupSession(uid);
    }
  });

  mc.on("error", (e) => {
    session.isDisconnected = true;
    console.error("MC Protocol Error:", e);
  });
}

// ----------------- Interactions -----------------
client.on(Events.InteractionCreate, async (i) => {
  try {
    const blocked = denyIfWrongGuild(i);
    if (blocked) return;

    const uid = i.user.id;

    if (i.isChatInputCommand()) {
      if (i.commandName === "panel") {
        return i.reply({ content: "🎛 **Bedrock AFK Control Panel**", components: panelRow() });
      }

      if (i.commandName === "admin") {
        if (i.channelId !== ADMIN_CHANNEL_ID) {
          return i.reply({ ephemeral: true, content: "❌ This command can only be used in the admin channel." });
        }

        const sub = i.options.getSubcommand();

        if (sub === "info") {
          const usedMem = process.memoryUsage().rss / 1024 / 1024;
          const activeSessions = sessions.size;
          
          let sessionText = "";
          sessions.forEach((s, userId) => {
            sessionText += `👤 <@${userId}>\n📍 IP: \`${s.serverInfo.ip}:${s.serverInfo.port}\`\n📦 Pkts: \`${s.packetCount}\`\n⚡ Status: \`${s.isDisconnected ? "Retrying..." : "Online"}\`\n\n`;
          });

          const embed = new EmbedBuilder()
            .setTitle("🤖 Global Bot Status")
            .setColor(0x5865F2)
            .addFields(
              { name: "🧠 RAM Usage", value: `\`${usedMem.toFixed(2)} MB\``, inline: true },
              { name: "🎮 Active Bots", value: `\`${activeSessions}\``, inline: true },
              { name: "🕒 Uptime", value: `<t:${Math.floor(client.readyTimestamp / 1000)}:R>`, inline: true }
            )
            .setDescription(sessionText || "No active sessions.")
            .setTimestamp();

          return i.reply({ embeds: [embed] });
        }

        if (sub === "stop-user") {
          const target = i.options.getUser("target");
          const ok = stopSession(target.id);
          return i.reply({ content: ok ? `✅ Force stopped bot for <@${target.id}>.` : `❌ No active bot for <@${target.id}>.` });
        }

        if (sub === "stop-all") {
          const count = sessions.size;
          sessions.forEach((_, userId) => stopSession(userId));
          return i.reply({ content: `⏹ Force stopped **${count}** bots.` });
        }
      }
    }

    if (i.isButton()) {
      if (i.customId === "link") {
        await i.deferReply({ ephemeral: true });
        return linkMicrosoft(uid, i);
      }
      if (i.customId === "start") {
        await i.deferReply({ ephemeral: true });
        await i.editReply("⏳ Connecting with physics engine…");
        return startSession(uid, i);
      }
      if (i.customId === "stop") {
        stopSession(uid);
        return i.reply({ ephemeral: true, content: "⏹ Bot stopped. Auto-rejoin disabled." });
      }
      if (i.customId === "settings") {
        const u = getUser(uid);
        const modal = new ModalBuilder().setCustomId("settings_modal").setTitle("⚙ Bedrock Settings");
        const ip = new TextInputBuilder().setCustomId("ip").setLabel("Server IP").setStyle(TextInputStyle.Short).setValue(u.server?.ip || "");
        const port = new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.server?.port || 19132));
        modal.addComponents(new ActionRowBuilder().addComponents(ip), new ActionRowBuilder().addComponents(port));
        return i.showModal(modal);
      }
    }

    if (i.isModalSubmit() && i.customId === "settings_modal") {
      const ip = i.fields.getTextInputValue("ip").trim();
      const port = parseInt(i.fields.getTextInputValue("port").trim(), 10);
      const u = getUser(uid);
      u.server = { ip, port };
      save();
      return i.reply({ ephemeral: true, content: `Settings saved: ${ip}:${port}` });
    }

  } catch (e) {
    console.error("Interaction error:", e);
  }
});

client.login(DISCORD_TOKEN);

