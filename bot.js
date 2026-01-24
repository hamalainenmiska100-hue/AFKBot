/**
 * Bedrock AFK Bot - Professional Edition
 * Integrated with LootLabs Reward Wall & Divine Physics v4
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
const crypto = require("crypto");
const axios = require("axios");

// ----------------- Configuration -----------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ALLOWED_GUILD_ID = "1462335230345089254";
const ADMIN_CHANNEL_ID = "1464615993320935447";

// ----------------- LootLabs Integration -----------------
const LOOTLABS_API_KEY = "33e661bfba65b1587c3c41d39dbdee9f2fe0a3f8ad624240c9289bed0c22c2bd";
// Replace this with your actual LootLabs link that redirects to your site/instructions
const LOOTLABS_BASE_LINK = "https://lootlabs.com/your-specific-link"; 
const AD_COOLDOWN_MS = 2 * 24 * 60 * 60 * 1000; // 48 hours

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
  if (!users[uid].lastAdTime) users[uid].lastAdTime = 0;
  return users[uid];
}

function getUserAuthDir(uid) {
  const dir = path.join(AUTH_ROOT, uid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ----------------- Runtime State -----------------
const sessions = new Map();
const pendingLink = new Map();
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const lerp = (start, end, amt) => (1 - amt) * start + amt * end;

// ----------------- UI Builders -----------------
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

// ----------------- Microsoft Auth Flow -----------------
async function linkMicrosoft(uid, interaction) {
  if (pendingLink.has(uid)) return interaction.editReply("⏳ Login already in progress. Check your previous code.");
  const authDir = getUserAuthDir(uid);
  const u = getUser(uid);
  
  const flow = new Authflow(uid, authDir, {
    flow: "live",
    authTitle: Titles.MinecraftNintendoSwitch,
    deviceType: "Nintendo"
  }, async (data) => {
    const uri = data.verification_uri_complete || data.verification_uri;
    const code = data.user_code;
    await interaction.editReply({
      content: `🔐 **Login Required**\nURL: ${uri}\nCode: \`${code}\``,
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Open Link").setStyle(ButtonStyle.Link).setURL(uri))]
    }).catch(() => {});
  });

  const promise = (async () => {
    try {
      await flow.getMsaToken();
      u.linked = true;
      save();
      await interaction.followUp({ ephemeral: true, content: "✅ Microsoft account linked successfully! 🥳" });
    } catch (e) {
      await interaction.editReply(`❌ Login failed: ${e.message}`);
    } finally {
      pendingLink.delete(uid);
    }
  })();
  pendingLink.set(uid, promise);
}

// ----------------- LootLabs Verification -----------------
async function checkLootLabsConversion(userId) {
  try {
    // API endpoint to check if user completed the link
    const response = await axios.get(`https://lootlabs.gg/api/v1/conversions`, {
      params: { 
        api_key: LOOTLABS_API_KEY,
        user_id: userId 
      }
    });
    
    // Check if there is a conversion recorded for this user recently
    if (response.data && response.data.length > 0) {
      return true;
    }
    return false;
  } catch (err) {
    console.error("LootLabs API Error:", err.message);
    return false;
  }
}

// ----------------- Minecraft Logic -----------------
function stopSession(uid) {
  const s = sessions.get(uid);
  if (!s) return false;
  s.manualStop = true;
  if (s.physicsLoop) clearInterval(s.physicsLoop);
  if (s.rejoinTimeout) clearTimeout(s.rejoinTimeout);
  try { s.client.close(); } catch {}
  sessions.delete(uid);
  return true;
}

/**
 * Handles the actual connection logic after all checks (Ads/Settings) are passed
 */
function actualConnect(uid, interaction) {
  const u = getUser(uid);
  interaction.editReply("⏳ Connecting... 🔌").catch(() => {});

  const mc = bedrock.createClient({
    host: u.server.ip,
    port: u.server.port || 19132,
    profilesFolder: getUserAuthDir(uid),
    username: uid,
    offline: u.connectionType === "offline",
    // Skin Fix to prevent being invisible
    skinData: { 
      DeviceOS: 11, 
      DeviceId: crypto.randomUUID(), 
      SkinId: "Standard_Steve", 
      UIProfile: 0 
    }
  });

  const session = {
    client: mc,
    manualStop: false,
    packetCount: 0,
    serverInfo: u.server,
    // Physics v4 State
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0, pitch: 0, targetYaw: 0, targetPitch: 0,
    isMoving: false, onGround: true, tick: 0, nextThink: 0
  };
  sessions.set(uid, session);

  mc.on('packet', () => session.packetCount++);

  mc.on("spawn", () => {
    // Update status to connected
    interaction.editReply(`🟢 Connected to **${u.server.ip}:${u.server.port || 19132}** 🎮`).catch(() => {});
    if (mc.entity?.position) session.pos = { ...mc.entity.position };

    // --- DIVINE PHYSICS ENGINE v4 (20 TPS) ---
    session.physicsLoop = setInterval(() => {
      if (!mc.entityId) return;
      session.tick++;

      // Humanized Decision Making
      if (session.tick >= session.nextThink) {
        const r = Math.random();
        if (r < 0.4) {
          session.isMoving = true;
          session.targetYaw = (session.targetYaw + (Math.random() * 120 - 60)) % 360;
          session.nextThink = session.tick + 70 + Math.random() * 100;
        } else if (r < 0.6) {
          session.isMoving = false;
          session.targetPitch = Math.random() * 30 - 15;
          session.nextThink = session.tick + 100 + Math.random() * 180;
        } else {
          session.targetYaw += Math.random() * 20 - 10;
          session.nextThink = session.tick + 30 + Math.random() * 60;
        }
        
        // Random Jump Logic
        if (session.isMoving && Math.random() < 0.06 && session.onGround) {
          session.vel.y = 0.42; 
          session.onGround = false;
        }
      }

      // Smooth Camera Rotation (Lerp)
      session.yaw = lerp(session.yaw, session.targetYaw, 0.1);
      session.pitch = lerp(session.pitch, session.targetPitch, 0.05);

      // Physics Calculation (Gravity & Friction)
      const friction = session.onGround ? 0.91 : 0.98;
      if (session.isMoving) {
        const rad = (session.yaw + 90) * (Math.PI / 180);
        session.vel.x += Math.cos(rad) * 0.085;
        session.vel.z += Math.sin(rad) * 0.085;
      }

      session.vel.y -= 0.08; // Gravity constant
      session.vel.x *= friction; 
      session.vel.z *= friction; 
      session.vel.y *= 0.98;

      session.pos.x += session.vel.x; 
      session.pos.y += session.vel.y; 
      session.pos.z += session.vel.z;

      // Simple ground check
      const ground = mc.entity?.position?.y || session.pos.y;
      if (session.pos.y < ground - 0.1) {
        session.pos.y = ground; 
        session.vel.y = 0; 
        session.onGround = true;
      }

      try {
        mc.write("move_player", {
          runtime_id: mc.entityId, 
          position: session.pos, 
          pitch: session.pitch,
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
    if (session.physicsLoop) clearInterval(session.physicsLoop);
    // Automatic rejoin after 2 minutes
    if (!session.manualStop) {
      console.log(`[REJOIN] Bot for ${uid} disconnected. Rejoining in 120s...`);
      session.rejoinTimeout = setTimeout(() => {
        if (!session.manualStop) actualConnect(uid, interaction);
      }, 120000);
    } else {
      sessions.delete(uid);
    }
  });

  mc.on("error", (e) => {
    interaction.editReply(`❌ Error: ${e.message}`).catch(() => {});
    stopSession(uid);
  });
}

// ----------------- Interaction Logic -----------------
client.on(Events.InteractionCreate, async (i) => {
  const uid = i.user.id;
  if (i.guildId !== ALLOWED_GUILD_ID) return;

  if (i.isChatInputCommand()) {
    if (i.commandName === "panel") {
      const embed = new EmbedBuilder()
        .setTitle("🤖 AFK Bot Control Panel")
        .setColor(0x5865F2)
        .setDescription("Manage your Bedrock AFK bot session easily. ✨")
        .setFooter({ text: "💰 Support AFKBot by completing the LootLabs wall!" });

      return i.reply({ embeds: [embed], components: panelRow() });
    }

    if (i.commandName === "admin" && i.channelId === ADMIN_CHANNEL_ID) {
      const sub = i.options.getSubcommand();
      if (sub === "info") {
        const mem = process.memoryUsage().rss / 1024 / 1024;
        let s = ""; 
        sessions.forEach((v, k) => s += `👤 <@${k}> | IP: ${v.serverInfo.ip} | Pkts: ${v.packetCount} | Status: ${v.isDisconnected ? "REJOINING" : "LIVE"}\n`);
        
        const emb = new EmbedBuilder().setTitle("🖥 System Admin Dashboard").setColor(0x00FF00)
          .addFields(
            { name: "🧠 RAM", value: `${mem.toFixed(1)}MB`, inline: true }, 
            { name: "🎮 Bots", value: `${sessions.size}`, inline: true }
          )
          .setDescription(s || "No bots currently running.");
        return i.reply({ embeds: [emb] });
      }
      if (sub === "stop-all") {
        sessions.forEach((_, id) => stopSession(id));
        return i.reply("🛑 All active bots have been forced to stop.");
      }
    } else if (i.commandName === "admin") {
      return i.reply({ ephemeral: true, content: "❌ Command restricted to the admin channel." });
    }
  }

  if (i.isButton()) {
    if (i.customId === "link") { await i.deferReply({ ephemeral: true }); return linkMicrosoft(uid, i); }
    
    if (i.customId === "start") {
      await i.deferReply({ ephemeral: true });
      const u = getUser(uid);

      // Initial Checks
      if (!u.server?.ip) return i.editReply("❌ Please configure the server in **Settings** first. ⚙");
      if (u.connectionType === "online" && !u.linked) return i.editReply("❌ Please **Link Microsoft** account first. 🔑");
      if (sessions.has(uid)) return i.editReply("❌ Bot is already running. 🏃");

      // --- Reward Wall Check ---
      const now = Date.now();
      if (now - u.lastAdTime > AD_COOLDOWN_MS) {
        const adEmbed = new EmbedBuilder()
          .setTitle("📢 Ad Completion Required")
          .setColor(0xFFA500)
          .setDescription(
            "**We are sorry but this is to keep AFKBot up!** 🥺\n\n" +
            "Please complete the link wall to continue. This supports our hosting costs.\n\n" +
            "**This will be prompted only once every 2 days.** 📅"
          );

        const adRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel("🔗 Open LootLabs Link").setStyle(ButtonStyle.Link).setURL(LOOTLABS_BASE_LINK + `?user_id=${uid}`),
          new ButtonBuilder().setCustomId("verify_ad").setLabel("✅ I've Completed It").setStyle(ButtonStyle.Success)
        );

        return i.editReply({ embeds: [adEmbed], components: [adRow] });
      }

      // If ad is fresh, connect directly
      return actualConnect(uid, i);
    }

    if (i.customId === "verify_ad") {
      await i.deferReply({ ephemeral: true });
      const success = await checkLootLabsConversion(uid);
      
      if (success) {
        const u = getUser(uid);
        u.lastAdTime = Date.now();
        save();
        await i.editReply("✅ Verification successful! Starting your bot... 🚀");
        return actualConnect(uid, i);
      } else {
        return i.editReply("❌ **Completion not detected.** Make sure you finished the link wall. 🥺");
      }
    }

    if (i.customId === "stop") {
      const ok = stopSession(uid);
      return i.reply({ ephemeral: true, content: ok ? "⏹ Bot stopped. Auto-rejoin disabled." : "❌ No bot running." });
    }

    if (i.customId === "unlink") {
      const u = getUser(uid);
      u.linked = false;
      save();
      return i.reply({ ephemeral: true, content: "🗑 Microsoft account unlinked successfully." });
    }

    if (i.customId === "settings") {
      const u = getUser(uid);
      const mod = new ModalBuilder().setCustomId("sets").setTitle("Server Configuration");
      const ip = new TextInputBuilder().setCustomId("ip").setLabel("Server IP").setStyle(TextInputStyle.Short).setValue(u.server?.ip || "");
      const port = new TextInputBuilder().setCustomId("port").setLabel("Port (e.g. 19132)").setStyle(TextInputStyle.Short).setValue(String(u.server?.port || 19132));
      mod.addComponents(new ActionRowBuilder().addComponents(ip), new ActionRowBuilder().addComponents(port));
      return i.showModal(mod);
    }
  }

  if (i.isModalSubmit() && i.customId === "sets") {
    const u = getUser(uid);
    u.server = { 
      ip: i.fields.getTextInputValue("ip").trim(), 
      port: parseInt(i.fields.getTextInputValue("port").trim()) || 19132 
    };
    save();
    return i.reply({ ephemeral: true, content: "✅ Settings saved! 💾" });
  }
});

// ----------------- Startup -----------------
client.once("ready", () => {
  client.application.commands.set([
    new SlashCommandBuilder().setName("panel").setDescription("User AFK Panel"),
    new SlashCommandBuilder().setName("admin").setDescription("Global Admin Control")
      .addSubcommand(s => s.setName("info").setDescription("Global stats & RAM"))
      .addSubcommand(s => s.setName("stop-all").setDescription("Kill all bots"))
  ]);
  console.log(`✅ AFKBot Online as ${client.user.tag}`);
});

process.on("unhandledRejection", e => console.error("Unhandled rejection:", e));

client.login(DISCORD_TOKEN);

