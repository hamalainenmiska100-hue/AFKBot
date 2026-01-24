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

// ----------------- Configuration -----------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("❌ DISCORD_TOKEN missing from environment variables");
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
  if (!users[uid].connectionType) users[uid].connectionType = "online";
  return users[uid];
}

function getUserAuthDir(uid) {
  const dir = path.join(AUTH_ROOT, uid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ----------------- Runtime -----------------
const sessions = new Map();
const pendingLink = new Map();
const lastMsa = new Map();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ----------------- Physics Helpers -----------------
const lerp = (start, end, amt) => (1 - amt) * start + amt * end;

// ----------------- UI Helpers -----------------
function panelRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("link").setLabel("🔑 Link Microsoft").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("unlink").setLabel("🗑 Unlink").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("start").setLabel("▶ Start Bot").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("stop").setLabel("⏹ Stop Bot").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Secondary)
    )
  ];
}

// ----------------- Microsoft Link Logic -----------------
async function linkMicrosoft(uid, interaction) {
  if (pendingLink.has(uid)) {
    await interaction.editReply("⏳ Login already in progress. Check the previous code.").catch(() => {});
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

      const msg = 
        `🔐 **Microsoft Login Required**\n\n` +
        `1. Go to: **${uri}**\n` +
        `2. Enter Code: \`${code}\`\n\n` +
        `⚠ Use a dedicated AFK account. This message will update when done.`;

      await interaction.editReply({ 
        content: msg, 
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("🌐 Open Link").setStyle(ButtonStyle.Link).setURL(uri))]
      }).catch(() => {});
    }
  );

  const p = (async () => {
    try {
      if (!codeShown) await interaction.editReply("⏳ Requesting Microsoft login code…").catch(() => {});
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

// ----------------- Bot Session Logic -----------------
function cleanupSession(uid) {
  const s = sessions.get(uid);
  if (!s) return;
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
    if (interaction && !interaction.replied) interaction.editReply("⚠ Configure settings first.").catch(() => {});
    return;
  }
  if (sessions.has(uid) && !sessions.get(uid).isDisconnected) return;

  const { ip, port } = u.server;
  const mc = bedrock.createClient({
    host: ip,
    port: port || 19132,
    profilesFolder: getUserAuthDir(uid),
    username: uid,
    offline: u.connectionType === "offline",
    connectTimeout: 45000
  });

  const session = {
    client: mc,
    manualStop: false,
    isDisconnected: false,
    packetCount: 0,
    serverInfo: { ip, port },
    // Advanced Physics State
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    targetYaw: 0,
    targetPitch: 0,
    isMoving: false,
    onGround: true,
    tickCount: 0,
    nextDecisionTick: 0
  };
  sessions.set(uid, session);

  mc.on('packet', () => session.packetCount++);

  mc.on("spawn", () => {
    if (interaction) interaction.editReply(`🟢 **Divine Physics Engine** active on **${ip}:${port}**`).catch(() => {});
    if (mc.entity?.position) session.pos = { ...mc.entity.position };

    // --- DIVINE PHYSICS LOOP (20 TPS) ---
    session.physicsLoop = setInterval(() => {
      if (!mc.entityId) return;
      session.tickCount++;

      // 1. Human Decision Logic
      if (session.tickCount >= session.nextDecisionTick) {
        const roll = Math.random();
        if (roll < 0.3) { 
          session.isMoving = true;
          session.targetYaw = (session.targetYaw + (Math.random() * 160 - 80)) % 360;
          session.nextDecisionTick = session.tickCount + 80 + Math.random() * 120;
        } else if (roll < 0.5) { 
          session.isMoving = false;
          session.targetPitch = Math.random() * 40 - 20;
          session.nextDecisionTick = session.tickCount + 100 + Math.random() * 200;
        } else { 
          session.targetYaw += Math.random() * 15 - 7.5;
          session.nextDecisionTick = session.tickCount + 30 + Math.random() * 60;
        }
        
        if (session.isMoving && Math.random() < 0.05 && session.onGround) {
          session.vel.y = 0.42; 
          session.onGround = false;
        }
      }

      // 2. Camera Smoothing
      session.yaw = lerp(session.yaw, session.targetYaw, 0.15);
      session.pitch = lerp(session.pitch, session.targetPitch, 0.1);

      // 3. Human Noise (Breathing & Jitter)
      const breathing = Math.sin(session.tickCount * 0.05) * 0.4;
      const jitter = (Math.random() - 0.5) * 0.1;
      const finalPitch = session.pitch + breathing + jitter;

      // 4. Locomotion & Forces
      const friction = session.onGround ? 0.91 : 0.98;
      const accel = session.onGround ? 0.1 : 0.02;

      if (session.isMoving) {
        const rad = (session.yaw + 90) * (Math.PI / 180);
        session.vel.x += Math.cos(rad) * accel;
        session.vel.z += Math.sin(rad) * accel;
      }

      session.vel.y -= 0.08; // Gravity
      session.vel.x *= friction;
      session.vel.z *= friction;
      session.vel.y *= 0.98;

      session.pos.x += session.vel.x;
      session.pos.y += session.vel.y;
      session.pos.z += session.vel.z;

      // Simple Floor Collision
      const floor = mc.entity?.position?.y || session.pos.y;
      if (session.pos.y < floor - 0.1) {
        session.pos.y = floor;
        session.vel.y = 0;
        session.onGround = true;
      }

      // 5. Sync
      try {
        mc.write("move_player", {
          runtime_id: mc.entityId,
          position: session.pos,
          pitch: finalPitch,
          yaw: session.yaw,
          head_yaw: session.yaw,
          mode: 0,
          on_ground: session.onGround,
          ridden_runtime_id: 0,
          teleport: false
        });
      } catch {}
    }, 50);
  });

  mc.on("close", () => {
    session.isDisconnected = true;
    if (session.physicsLoop) clearInterval(session.physicsLoop);
    
    // Auto-rejoin logic (2 minutes)
    if (!session.manualStop) {
      console.log(`[DISCONNECT] ${uid} - Rejoining in 120s...`);
      session.rejoinTimeout = setTimeout(() => {
        if (!session.manualStop) startSession(uid, interaction);
      }, 120000);
    } else {
      cleanupSession(uid);
    }
  });

  mc.on("error", (e) => {
    console.error(`[MC ERROR] ${uid}:`, e);
    session.isDisconnected = true;
  });
}

// ----------------- Interactions -----------------
client.on(Events.InteractionCreate, async (i) => {
  const uid = i.user.id;

  if (i.guildId !== ALLOWED_GUILD_ID) {
    return i.reply({ ephemeral: true, content: "⛔ Restricted access." }).catch(() => {});
  }

  if (i.isChatInputCommand()) {
    if (i.commandName === "panel") {
      return i.reply({ content: "🎛 **Divine Bedrock Manager**\nStatus: Online | Multitenant-Ready", components: panelRow() });
    }

    if (i.commandName === "admin" && i.channelId === ADMIN_CHANNEL_ID) {
      const sub = i.options.getSubcommand();
      
      if (sub === "info") {
        const mem = process.memoryUsage().rss / 1024 / 1024;
        let stats = "";
        sessions.forEach((s, id) => {
          stats += `👤 <@${id}> | IP: \`${s.serverInfo.ip}\` | Pkts: \`${s.packetCount}\` | ${s.isDisconnected ? "REJOINING" : "LIVE"}\n`;
        });

        const embed = new EmbedBuilder()
          .setTitle("🛠 Global System Stats")
          .setColor(0x00FF00)
          .addFields(
            { name: "RAM", value: `\`${mem.toFixed(1)}MB\``, inline: true },
            { name: "Active", value: `\`${sessions.size}\``, inline: true }
          )
          .setDescription(stats || "No sessions active.");
        return i.reply({ embeds: [embed] });
      }

      if (sub === "stop-all") {
        const count = sessions.size;
        sessions.forEach((_, id) => stopSession(id));
        return i.reply(`🛑 Terminated **${count}** sessions.`);
      }
    } else if (i.commandName === "admin") {
      return i.reply({ ephemeral: true, content: "❌ Admins only. Use the correct channel." });
    }
  }

  if (i.isButton()) {
    if (i.customId === "link") {
      await i.deferReply({ ephemeral: true });
      return linkMicrosoft(uid, i);
    }
    
    if (i.customId === "start") {
      await i.deferReply({ ephemeral: true });
      startSession(uid, i);
    }
    
    if (i.customId === "stop") {
      const ok = stopSession(uid);
      i.reply({ ephemeral: true, content: ok ? "⏹ Session stopped." : "❌ No active session." });
    }

    if (i.customId === "unlink") {
      const u = getUser(uid);
      u.linked = false;
      save();
      i.reply({ ephemeral: true, content: "🗑 Microsoft link removed." });
    }

    if (i.customId === "settings") {
      const u = getUser(uid);
      const modal = new ModalBuilder().setCustomId("sets").setTitle("Server Config");
      const ip = new TextInputBuilder().setCustomId("ip").setLabel("IP").setStyle(TextInputStyle.Short).setValue(u.server?.ip || "");
      const port = new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.server?.port || 19132));
      modal.addComponents(new ActionRowBuilder().addComponents(ip), new ActionRowBuilder().addComponents(port));
      i.showModal(modal);
    }
  }

  if (i.isModalSubmit() && i.customId === "sets") {
    const u = getUser(uid);
    u.server = { ip: i.fields.getTextInputValue("ip"), port: parseInt(i.fields.getTextInputValue("port")) };
    save();
    i.reply({ ephemeral: true, content: "✅ Settings saved." });
  }
});

// ----------------- Initialization -----------------
client.once("ready", () => {
  console.log(`✅ System Online: ${client.user.tag}`);
  client.application.commands.set([
    new SlashCommandBuilder().setName("panel").setDescription("User AFK Panel"),
    new SlashCommandBuilder().setName("admin").setDescription("Global Admin Control")
      .addSubcommand(s => s.setName("info").setDescription("System stats"))
      .addSubcommand(s => s.setName("stop-all").setDescription("Kill all bots"))
  ]);
});

process.on("unhandledRejection", e => console.error("Unhandled:", e));

client.login(DISCORD_TOKEN);

