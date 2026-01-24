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
const os = require("os");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("❌ DISCORD_TOKEN missing");
  process.exit(1);
}

// ----------------- Asetukset -----------------
const ALLOWED_GUILD_ID = "1462335230345089254";
const ADMIN_ID = "1144987924123881564";
const LOG_CHANNEL_ID = "1464615030111731753";
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
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages
  ]
});

/**
 * Lähettää lokiviestin määritetylle kanavalle
 */
async function logToDiscord(message) {
  try {
    const channel = await client.channels.fetch(LOG_CHANNEL_ID);
    if (channel) {
      const embed = new EmbedBuilder()
        .setColor("#5865F2")
        .setDescription(message)
        .setTimestamp();
      await channel.send({ embeds: [embed] });
    }
  } catch (e) {
    console.error("Logging error:", e);
  }
}

/**
 * Lähettää DM-viestin käyttäjälle turvallisesti
 */
async function sendUserDM(uid, message) {
  try {
    const user = await client.users.fetch(uid);
    if (user) await user.send(message);
  } catch (e) {
    console.warn(`Could not send DM to ${uid}:`, e.message);
  }
}

function denyIfWrongGuild(i) {
  if (!i.inGuild() || i.guildId !== ALLOWED_GUILD_ID) {
    const msg = "This bot cannot be used in this server ⛔️";
    if (i.deferred) return i.editReply(msg).catch(() => {});
    if (i.replied) return i.followUp({ ephemeral: true, content: msg }).catch(() => {});
    return i.reply({ ephemeral: true, content: msg }).catch(() => {});
  }
  return null;
}

// ----------------- UI helpers -----------------
function panelRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("link").setLabel("🔑 Link Microsoft").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("unlink").setLabel("🗑 Unlink Microsoft").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("start").setLabel("▶ Start").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("stop").setLabel("⏹ Stop").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("more").setLabel("➕ More").setStyle(ButtonStyle.Secondary)
    )
  ];
}

function adminPanelComponents() {
  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin_refresh").setLabel("🔄 Refresh Stats").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin_stop_all").setLabel("🛑 Force Stop All").setStyle(ButtonStyle.Danger)
    )
  ];

  // Jos on aktiivisia botteja, lisätään valikko yksittäistä Force Stopia varten
  if (sessions.size > 0) {
    const options = [];
    let count = 0;
    for (const [uid, session] of sessions) {
      if (count >= 25) break; // Discord menu limit
      options.push({
        label: `User: ${uid}`,
        description: `Started: ${new Date(session.startedAt).toLocaleTimeString()}`,
        value: uid
      });
      count++;
    }

    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("admin_force_stop_select")
          .setPlaceholder("Select bot to Force Stop")
          .addOptions(options)
      )
    );
  }

  return rows;
}

function msaComponents(uri) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel("🌐 Open link").setStyle(ButtonStyle.Link).setURL(uri)
    )
  ];
}

function versionRow(current = "auto") {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("set_version")
    .setPlaceholder("🌐 Bedrock Version")
    .addOptions(
      { label: "Auto", value: "auto", default: current === "auto" },
      { label: "1.21.x", value: "1.21.x", default: current === "1.21.x" },
      { label: "1.20.x", value: "1.20.x", default: current === "1.20.x" },
      { label: "1.19.x", value: "1.19.x", default: current === "1.19.x" }
    );
  return new ActionRowBuilder().addComponents(menu);
}

function connRow(current = "online") {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("set_conn")
    .setPlaceholder("🔌 Connection Type")
    .addOptions(
      { label: "Online (Microsoft)", value: "online", default: current === "online" },
      { label: "Offline (Cracked)", value: "offline", default: current === "offline" }
    );
  return new ActionRowBuilder().addComponents(menu);
}

// ----------------- Slash commands -----------------
client.once("ready", async () => {
  console.log("🟢 Online as", client.user.tag);

  const cmds = [
    new SlashCommandBuilder().setName("panel").setDescription("Open Bedrock AFK panel"),
    new SlashCommandBuilder().setName("admin").setDescription("Open Admin Control Panel (Owner only)")
  ];

  await client.application.commands.set(cmds);
});

// ----------------- Microsoft link -----------------
async function linkMicrosoft(uid, interaction) {
  if (pendingLink.has(uid)) {
    await interaction.editReply("⏳ Login already in progress. Use the last code.");
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
        `🔐 **Microsoft login required**\n\n` +
        `👉 ${uri}\n\n` +
        `Your code: \`${code}\`\n\n` +
        `⚠ **IMPORTANT:** Use a *second* Microsoft account.\n` +
        `Do **NOT** use the account you normally play with.\n\n` +
        `Come back here after login.`;

      await interaction.editReply({ content: msg, components: msaComponents(uri) }).catch(() => {});
    }
  );

  const p = (async () => {
    try {
      if (!codeShown) await interaction.editReply("⏳ Requesting Microsoft login code…");
      await flow.getMsaToken();
      u.linked = true;
      save();
      await interaction.followUp({ ephemeral: true, content: "✅ Microsoft account linked!" }).catch(() => {});
      logToDiscord(`🔑 User <@${uid}> successfully linked a Microsoft account.`);
    } catch (e) {
      await interaction.editReply(`❌ Microsoft login failed:\n${String(e?.message || e)}`).catch(() => {});
    } finally {
      pendingLink.delete(uid);
    }
  })();

  pendingLink.set(uid, p);
}

// ----------------- Bedrock session -----------------
function cleanupSession(uid) {
  const s = sessions.get(uid);
  if (!s) return;
  if (s.timeout) clearTimeout(s.timeout);
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  try { s.client.close(); } catch {}
  sessions.delete(uid);
}

function stopSession(uid) {
  const s = sessions.get(uid);
  if (!s) return false;
  s.manualStop = true; // Estää automaattisen rejoinaamisen
  cleanupSession(uid);
  return true;
}

function startSession(uid, interaction) {
  const u = getUser(uid);
  if (!u.server) {
    if (interaction && !interaction.replied) interaction.editReply("⚠ Set settings first.");
    return;
  }
  
  const existing = sessions.get(uid);
  if (existing && !existing.isReconnecting) {
    if (interaction && !interaction.replied) interaction.editReply("⚠ You already have a running bot.");
    return;
  }

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
    opts.offline = false;
    opts.profilesFolder = authDir;
  }

  const mc = bedrock.createClient(opts);
  
  let currentSession = sessions.get(uid);
  if (!currentSession) {
    currentSession = { client: mc, timeout: null, startedAt: Date.now(), manualStop: false, connected: false };
    sessions.set(uid, currentSession);
  } else {
    currentSession.client = mc;
    currentSession.isReconnecting = false;
  }

  const waitForEntity = setInterval(() => {
    if (!mc.entity || !mc.entityId) return;

    clearInterval(waitForEntity);

    let moveToggle = false;
    const afkInterval = setInterval(() => {
      try {
        const pos = { ...mc.entity.position };
        if (moveToggle) {
           pos.x += 0.5;
        } else {
           pos.x -= 0.5;
        }
        moveToggle = !moveToggle;

        mc.write("move_player", {
          runtime_id: mc.entityId,
          position: pos,
          pitch: 0,
          yaw: Math.random() * 360,
          head_yaw: Math.random() * 360,
          mode: 0,
          on_ground: true,
          ridden_runtime_id: 0,
          teleport: false
        });
      } catch {}
    }, 60 * 1000);

    mc.once("close", () => clearInterval(afkInterval));
    mc.once("error", () => clearInterval(afkInterval));
  }, 1000);

  currentSession.timeout = setTimeout(() => {
    if (sessions.has(uid) && !currentSession.connected) {
      if (interaction && !interaction.replied) interaction.editReply("❌ Connection timeout. Retrying in 2min...");
      mc.close();
    }
  }, 47000);

  mc.on("spawn", () => {
    currentSession.connected = true;
    clearTimeout(currentSession.timeout);
    if (interaction && interaction.deferred) {
        interaction.editReply(`🟢 Connected to **${ip}:${port}** (Auto-move active)` ).catch(() => {});
    }
    logToDiscord(`✅ Bot of <@${uid}> spawned on **${ip}:${port}**`);
  });

  mc.on("error", (e) => {
    clearTimeout(currentSession.timeout);
    if (!currentSession.manualStop) {
        handleAutoReconnect(uid, interaction);
    }
    logToDiscord(`❌ Bot of <@${uid}> error: \`${e.message}\``);
  });

  mc.on("close", () => {
    clearTimeout(currentSession.timeout);
    if (!currentSession.manualStop) {
        handleAutoReconnect(uid, interaction);
    }
    logToDiscord(`🔌 Bot of <@${uid}> connection closed.`);
  });
}

function handleAutoReconnect(uid, interaction) {
    const s = sessions.get(uid);
    if (!s || s.manualStop || s.reconnectTimer) return;

    s.isReconnecting = true;
    s.connected = false;
    
    s.reconnectTimer = setTimeout(() => {
        if (sessions.has(uid) && !s.manualStop) {
            s.reconnectTimer = null;
            startSession(uid, interaction);
        }
    }, 120000); 
}

// ----------------- Admin Helpers -----------------
function getAdminStatsEmbed() {
  const memory = process.memoryUsage();
  const ramMB = (memory.rss / 1024 / 1024).toFixed(2);
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  
  // Lasketaan tallennetut käyttäjät ja levytila (arvio)
  const totalUsers = Object.keys(users).length;
  
  const embed = new EmbedBuilder()
    .setTitle("🛠 Admin Control Panel")
    .setColor("#FF0000")
    .addFields(
      { name: "📊 System Stats", value: `**RAM:** ${ramMB} MB\n**Uptime:** ${hours}h ${minutes}m\n**Active Bots:** ${sessions.size}`, inline: true },
      { name: "📂 Storage", value: `**Linked Users:** ${totalUsers}\n**Data Dir:** /app/data`, inline: true }
    )
    .setFooter({ text: "Owner Access Only" })
    .setTimestamp();

  if (sessions.size > 0) {
    let botList = "";
    for (const [uid, s] of sessions) {
      const status = s.connected ? "🟢 Online" : (s.isReconnecting ? "⏳ Reconnecting" : "🔴 Offline");
      botList += `<@${uid}>: ${status}\n`;
    }
    embed.addFields({ name: "🤖 Active Bots List", value: botList || "None" });
  } else {
    embed.addFields({ name: "🤖 Active Bots List", value: "No bots currently running." });
  }

  return embed;
}

// ----------------- Interactions -----------------
client.on(Events.InteractionCreate, async (i) => {
  try {
    const blocked = denyIfWrongGuild(i);
    if (blocked) return;

    const uid = i.user.id;

    // --- Slash Commands ---
    if (i.isChatInputCommand()) {
      if (i.commandName === "panel") {
        return i.reply({
          content: "🎛 **Bedrock AFK Panel**",
          components: panelRow()
        });
      }

      if (i.commandName === "admin") {
        if (uid !== ADMIN_ID) return i.reply({ content: "⛔ Access denied.", ephemeral: true });
        if (i.channelId !== ADMIN_CHANNEL_ID) return i.reply({ content: `⛔ Admin command can only be used in <#${ADMIN_CHANNEL_ID}>`, ephemeral: true });

        return i.reply({
          embeds: [getAdminStatsEmbed()],
          components: adminPanelComponents(),
          ephemeral: true
        });
      }
    }

    // --- Buttons ---
    if (i.isButton()) {
      // Admin Buttons
      if (i.customId === "admin_refresh") {
        if (uid !== ADMIN_ID) return i.reply({ content: "⛔ Access denied.", ephemeral: true });
        return i.update({ embeds: [getAdminStatsEmbed()], components: adminPanelComponents() });
      }

      if (i.customId === "admin_stop_all") {
        if (uid !== ADMIN_ID) return i.reply({ content: "⛔ Access denied.", ephemeral: true });
        
        const count = sessions.size;
        for (const [targetUid, s] of sessions) {
          stopSession(targetUid);
          await sendUserDM(targetUid, "⚠️ Your bot has been stopped by the owner.");
        }
        
        logToDiscord(`🚨 **Admin Action**: Force Stopped ALL bots (${count} sessions).`);
        return i.reply({ content: `✅ Stopped all ${count} bots and sent DMs.`, ephemeral: true });
      }

      // User Buttons
      if (i.customId === "link") {
        await i.deferReply({ ephemeral: true });
        await i.editReply("⏳ Requesting Microsoft login…");
        return linkMicrosoft(uid, i);
      }

      if (i.customId === "unlink") {
        unlinkMicrosoft(uid);
        logToDiscord(`🗑 User <@${uid}> unlinked their account.`);
        return i.reply({ ephemeral: true, content: "🗑 Microsoft account unlinked for your user." });
      }

      if (i.customId === "settings") {
        const u = getUser(uid);
        const pre = {
          ip: u.server?.ip || "",
          port: u.server?.port || 19132,
          offlineUsername: u.offlineUsername || ""
        };

        const modal = new ModalBuilder().setCustomId("settings_modal").setTitle("⚙ Bedrock Settings");

        const ip = new TextInputBuilder()
          .setCustomId("ip")
          .setLabel("Server IP")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(pre.ip);

        const port = new TextInputBuilder()
          .setCustomId("port")
          .setLabel("Port (19132)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(pre.port));

        const offlineUser = new TextInputBuilder()
          .setCustomId("offline")
          .setLabel("Offline username (cracked)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setValue(pre.offlineUsername);

        modal.addComponents(
          new ActionRowBuilder().addComponents(ip),
          new ActionRowBuilder().addComponents(port),
          new ActionRowBuilder().addComponents(offlineUser)
        );

        return i.showModal(modal);
      }

      if (i.customId === "start") {
        await i.deferReply({ ephemeral: true });
        await i.editReply("⏳ Connecting…");
        logToDiscord(`🚀 User <@${uid}> started their bot.`);
        return startSession(uid, i);
      }

      if (i.customId === "stop") {
        const ok = stopSession(uid);
        if (!ok) return i.reply({ ephemeral: true, content: "No bots running." });
        logToDiscord(`⏹ User <@${uid}> stopped their bot.`);
        return i.reply({ ephemeral: true, content: "⏹ Stopped." });
      }

      if (i.customId === "more") {
        const u = getUser(uid);
        return i.reply({
          ephemeral: true,
          content: "➕ **More options**",
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId("invisible").setLabel("👻 Make bot invisible").setStyle(ButtonStyle.Secondary)
            ),
            versionRow(u.bedrockVersion),
            connRow(u.connectionType)
          ]
        });
      }

      if (i.customId === "invisible") {
        const s = sessions.get(uid);
        if (!s || !s.client) return i.reply({ ephemeral: true, content: "Bot is not running." });
        try {
          s.client.write("command_request", {
            command: "/gamemode survival @s",
            internal: false,
            version: 2
          });
          return i.reply({ ephemeral: true, content: "Attempted to hide bot." });
        } catch {
          return i.reply({ ephemeral: true, content: "Commands not allowed." });
        }
      }
    }

    // --- Select Menus ---
    if (i.isStringSelectMenu()) {
      if (i.customId === "admin_force_stop_select") {
        if (uid !== ADMIN_ID) return i.reply({ content: "⛔ Access denied.", ephemeral: true });
        const targetUid = i.values[0];
        const ok = stopSession(targetUid);
        if (ok) {
          await sendUserDM(targetUid, "⚠️ Your bot has been stopped by the owner.");
          logToDiscord(`🚨 **Admin Action**: Force Stopped bot for <@${targetUid}>`);
          return i.reply({ content: `✅ Bot for <@${targetUid}> stopped.`, ephemeral: true });
        } else {
          return i.reply({ content: "❌ Could not stop bot (maybe already offline).", ephemeral: true });
        }
      }

      const u = getUser(uid);
      if (i.customId === "set_version") {
        u.bedrockVersion = i.values[0];
        save();
        return i.reply({ ephemeral: true, content: `Version set to ${u.bedrockVersion}` });
      }
      if (i.customId === "set_conn") {
        u.connectionType = i.values[0];
        save();
        return i.reply({ ephemeral: true, content: `Connection set to ${u.connectionType}` });
      }
    }

    // --- Modals ---
    if (i.isModalSubmit() && i.customId === "settings_modal") {
      const ip = i.fields.getTextInputValue("ip").trim();
      const port = parseInt(i.fields.getTextInputValue("port").trim(), 10);
      const offline = i.fields.getTextInputValue("offline").trim();

      if (!ip || !Number.isFinite(port)) {
        return i.reply({ ephemeral: true, content: "Bad IP or port." });
      }

      const u = getUser(uid);
      u.server = { ip, port };
      if (offline) u.offlineUsername = offline;
      save();

      return i.reply({ ephemeral: true, content: `Saved ${ip}:${port}` });
    }

  } catch (e) {
    console.error("Interaction error:", e);
    if (!i.replied && !i.deferred) {
      await i.reply({ ephemeral: true, content: "Internal error." }).catch(() => {});
    } else if (i.deferred) {
      await i.editReply("Internal error.").catch(() => {});
    }
  }
});

process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

client.login(DISCORD_TOKEN);

