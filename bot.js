/**
 * Bedrock AFK Bot - "Divine Physics" v4
 * Integrated with LootLabs.gg Creator API
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
const AD_COOLDOWN_MS = 2 * 24 * 60 * 60 * 1000; // 48 Hours

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
      new ButtonBuilder().setCustomId("unlink").setLabel("🗑 Unlink Account").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("start").setLabel("▶ Start Bot").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("stop").setLabel("⏹ Stop Bot").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Secondary)
    )
  ];
}

// ----------------- Microsoft Auth -----------------
async function linkMicrosoft(uid, interaction) {
  if (pendingLink.has(uid)) return interaction.editReply("⏳ Login already in progress. Check the last code provided.");
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
      content: `🔐 **Microsoft Login**\nURL: ${uri}\nCode: \`${code}\` 🔑`,
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("🌐 Open Link").setStyle(ButtonStyle.Link).setURL(uri))]
    }).catch(() => {});
  });

  const promise = (async () => {
    try {
      await flow.getMsaToken();
      u.linked = true;
      save();
      await interaction.followUp({ ephemeral: true, content: "✅ Success! Microsoft account linked. 🥳" });
    } catch (e) {
      await interaction.editReply(`❌ Error: ${e.message}`);
    } finally {
      pendingLink.delete(uid);
    }
  })();
  pendingLink.set(uid, promise);
}

// ----------------- LootLabs API -----------------

/**
 * Creates a dynamic link for the user using LootLabs Creator API
 */
async function createLootLabsLink(userId) {
  try {
    const response = await axios.post('https://creators.lootlabs.gg/api/public/content_locker', {
      title: `AFKBot-Auth-${userId.slice(-4)}`,
      url: `https://discord.com/users/${userId}`, // Destination doesn't matter much as we check conversion
      tier_id: 3, // Profit Maximization
      number_of_tasks: 3,
      theme: 3 // Minecraft Theme
    }, {
      headers: { 'Authorization': `Bearer ${LOOTLABS_API_KEY}` }
    });

    if (response.data && response.data.message && response.data.message.loot_url) {
      return response.data.message.loot_url;
    }
    return null;
  } catch (err) {
    console.error("LootLabs Create Link Error:", err.response?.data || err.message);
    return null;
  }
}

/**
 * Verifies if the user has completed a conversion
 */
async function verifyConversion(userId) {
  try {
    // Note: We use the conversion check API. LootLabs API token is needed in headers.
    const response = await axios.get(`https://creators.lootlabs.gg/api/v1/conversions`, {
      params: { api_key: LOOTLABS_API_KEY, user_id: userId }
    });
    
    // If conversion exists for this user ID, return true
    return response.data && response.data.length > 0;
  } catch (err) {
    // If the endpoint fails or is different, we handle it
    console.error("LootLabs Verify Error:", err.message);
    return false;
  }
}

// ----------------- Minecraft Session -----------------
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

function actualConnect(uid, interaction) {
  const u = getUser(uid);
  interaction.editReply("⏳ Connecting... 🔌").catch(() => {});

  const mc = bedrock.createClient({
    host: u.server.ip,
    port: u.server.port || 19132,
    profilesFolder: getUserAuthDir(uid),
    username: uid,
    offline: u.connectionType === "offline",
    // Steve Skin Fix
    skinData: { DeviceOS: 11, DeviceId: crypto.randomUUID(), SkinId: "Standard_Steve", UIProfile: 0 }
  });

  const session = {
    client: mc,
    manualStop: false,
    packetCount: 0,
    serverInfo: u.server,
    // Physics State
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0, pitch: 0, targetYaw: 0, targetPitch: 0,
    isMoving: false, onGround: true, tick: 0, nextThink: 0
  };
  sessions.set(uid, session);

  mc.on('packet', () => session.packetCount++);

  mc.on("spawn", () => {
    interaction.editReply(`🟢 Connected to **${u.server.ip}:${u.server.port || 19132}** 🎮`).catch(() => {});
    if (mc.entity?.position) session.pos = { ...mc.entity.position };

    // --- DIVINE PHYSICS ENGINE (50ms Loop) ---
    session.physicsLoop = setInterval(() => {
      if (!mc.entityId) return;
      session.tick++;

      // Decision logic
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
          session.nextThink = session.tick + 30 + Math.random() * 50;
        }
        if (session.isMoving && Math.random() < 0.06 && session.onGround) {
          session.vel.y = 0.42; session.onGround = false;
        }
      }

      // Physics Interpolation
      session.yaw = lerp(session.yaw, session.targetYaw, 0.1);
      session.pitch = lerp(session.pitch, session.targetPitch, 0.05);

      const friction = session.onGround ? 0.91 : 0.98;
      if (session.isMoving) {
        const rad = (session.yaw + 90) * (Math.PI / 180);
        session.vel.x += Math.cos(rad) * 0.085;
        session.vel.z += Math.sin(rad) * 0.085;
      }

      session.vel.y -= 0.08; // Gravity
      session.vel.x *= friction; session.vel.z *= friction; session.vel.y *= 0.98;
      session.pos.x += session.vel.x; session.pos.y += session.vel.y; session.pos.z += session.vel.z;

      const ground = mc.entity?.position?.y || session.pos.y;
      if (session.pos.y < ground - 0.1) {
        session.pos.y = ground; session.vel.y = 0; session.onGround = true;
      }

      try {
        mc.write("move_player", {
          runtime_id: mc.entityId, position: session.pos, pitch: session.pitch,
          yaw: session.yaw, head_yaw: session.yaw, mode: 0, on_ground: session.onGround,
          ridden_runtime_id: 0, teleport: false
        });
      } catch {}
    }, 50);
  });

  mc.on("close", () => {
    if (session.physicsLoop) clearInterval(session.physicsLoop);
    if (!session.manualStop) {
      session.rejoinTimeout = setTimeout(() => actualConnect(uid, interaction), 120000);
    } else {
      sessions.delete(uid);
    }
  });

  mc.on("error", (e) => {
    interaction.editReply(`❌ Error: ${e.message}`).catch(() => {});
    stopSession(uid);
  });
}

// ----------------- Interaction Handler -----------------
client.on(Events.InteractionCreate, async (i) => {
  const uid = i.user.id;
  if (i.guildId !== ALLOWED_GUILD_ID) return;

  if (i.isChatInputCommand()) {
    if (i.commandName === "panel") {
      const embed = new EmbedBuilder()
        .setTitle("🤖 AFK Bot Controller")
        .setColor(0x5865F2)
        .setDescription("Manage your AFK bot sessions below. ✨")
        .setFooter({ text: "💰 Support AFKBot development by completing link tasks!" });

      return i.reply({ embeds: [embed], components: panelRow() });
    }

    if (i.commandName === "admin" && i.channelId === ADMIN_CHANNEL_ID) {
      const sub = i.options.getSubcommand();
      if (sub === "info") {
        const mem = process.memoryUsage().rss / 1024 / 1024;
        let s = ""; sessions.forEach((v, k) => s += `👤 <@${k}> | IP: ${v.serverInfo.ip} | Pkts: ${v.packetCount}\n`);
        const emb = new EmbedBuilder().setTitle("🖥 Admin Panel").setColor(0x00FF00)
          .addFields({ name: "🧠 RAM", value: `${mem.toFixed(1)}MB`, inline: true }, { name: "🎮 Active", value: `${sessions.size}`, inline: true })
          .setDescription(s || "No bots online.");
        return i.reply({ embeds: [emb] });
      }
      if (sub === "stop-all") { sessions.forEach((_, id) => stopSession(id)); return i.reply("🛑 All bots terminated."); }
    }
  }

  if (i.isButton()) {
    if (i.customId === "link") { await i.deferReply({ ephemeral: true }); return linkMicrosoft(uid, i); }
    
    if (i.customId === "start") {
      await i.deferReply({ ephemeral: true });
      const u = getUser(uid);

      if (!u.server?.ip) return i.editReply("❌ Set server IP in **Settings** first. ⚙");
      if (u.connectionType === "online" && !u.linked) return i.editReply("❌ **Link Microsoft** account first. 🔑");
      if (sessions.has(uid)) return i.editReply("❌ Bot is already running. 🏃");

      // --- LOOTLABS 48H CHECK ---
      const now = Date.now();
      if (now - u.lastAdTime > AD_COOLDOWN_MS) {
        const lootUrl = await createLootLabsLink(uid);
        if (!lootUrl) return i.editReply("❌ Failed to generate Reward Link. Please try again later. 🥺");

        const adEmbed = new EmbedBuilder()
          .setTitle("📢 Support Required")
          .setColor(0xFFA500)
          .setDescription(
            "**We are sorry but this is to keep AFKBot up!** 🥺\n\n" +
            "Please complete the link wall to continue. This helps us pay for the bot hosting.\n\n" +
            "**This will be prompted only once a 2 days.** 📅"
          )
          .setFooter({ text: "Thank you for supporting us!" });

        const adRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel("🔗 Open Reward Link").setStyle(ButtonStyle.Link).setURL(lootUrl),
          new ButtonBuilder().setCustomId("verify_ad").setLabel("✅ I've Completed It").setStyle(ButtonStyle.Success)
        );

        return i.editReply({ embeds: [adEmbed], components: [adRow] });
      }

      return actualConnect(uid, i);
    }

    if (i.customId === "verify_ad") {
      await i.deferReply({ ephemeral: true });
      // In a real scenario, LootLabs conversion check happens here
      // For this script, we check if the user completed it
      const success = await verifyConversion(uid);
      
      if (success) {
        const u = getUser(uid);
        u.lastAdTime = Date.now();
        save();
        await i.editReply("✅ Verification detected! Launching bot... 🚀");
        return actualConnect(uid, i);
      } else {
        return i.editReply("❌ **No conversion found.** Please ensure you reached the final page of the link. 🥺");
      }
    }

    if (i.customId === "stop") {
      stopSession(uid);
      return i.reply({ ephemeral: true, content: "⏹ Bot stopped. Auto-rejoin disabled." });
    }

    if (i.customId === "unlink") {
      const u = getUser(uid); u.linked = false; save();
      return i.reply({ ephemeral: true, content: "🗑 Account unlinked." });
    }

    if (i.customId === "settings") {
      const u = getUser(uid);
      const mod = new ModalBuilder().setCustomId("sets").setTitle("Server Config");
      const ip = new TextInputBuilder().setCustomId("ip").setLabel("IP").setStyle(TextInputStyle.Short).setValue(u.server?.ip || "");
      const port = new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.server?.port || 19132));
      mod.addComponents(new ActionRowBuilder().addComponents(ip), new ActionRowBuilder().addComponents(port));
      return i.showModal(mod);
    }
  }

  if (i.isModalSubmit() && i.customId === "sets") {
    const u = getUser(uid);
    u.server = { ip: i.fields.getTextInputValue("ip"), port: parseInt(i.fields.getTextInputValue("port")) || 19132 };
    save();
    return i.reply({ ephemeral: true, content: "✅ Settings saved! 💾" });
  }
});

// ----------------- Lifecycle -----------------
client.once("ready", () => {
  client.application.commands.set([
    new SlashCommandBuilder().setName("panel").setDescription("User Control Panel"),
    new SlashCommandBuilder().setName("admin").setDescription("Admin System")
      .addSubcommand(s => s.setName("info").setDescription("Global Stats"))
      .addSubcommand(s => s.setName("stop-all").setDescription("Kill all bots"))
  ]);
  console.log(`✅ AFKBot Online: ${client.user.tag}`);
});

process.on("unhandledRejection", e => console.error("Unhandled:", e));

client.login(DISCORD_TOKEN);

