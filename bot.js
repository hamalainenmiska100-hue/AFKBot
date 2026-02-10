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
const admin = require("firebase-admin");

// --- Dependencies for Chunk Scanning & Bed Detection ---
let Vec3, PrismarineChunk, PrismarineRegistry, MinecraftData;
try {
  Vec3 = require("vec3");
  PrismarineChunk = require("prismarine-chunk");
  PrismarineRegistry = require("prismarine-registry");
  MinecraftData = require("minecraft-data");
} catch (e) {
  console.log("⚠️  Advanced features disabled! Run: npm install vec3 prismarine-chunk prismarine-registry minecraft-data");
}

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("❌ DISCORD_TOKEN missing");
  process.exit(1);
}

// ==========================================================
// 🔥 FIREBASE CONFIGURATION
// ==========================================================
const serviceAccount = {
  "type": "service_account",
  "project_id": "espc-f1445",
  "private_key_id": "d290783e8142e2e98f3bf277e8613fb132226f19",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCxSZdqeu1kEzBQ\ni0pmjtod6ebnulDoC01opnbAflKmXBTFlmqbrv6UEVwdpzxM0jGUvm/9bJ7WFpkj\n7qreNBk+wl0FWeT5Ea9Rcqje58BZwikoY3tGFX2w6Mgj+yCDNo/8gyfQi393aoZ3\nzB1Z0hezy2s3CKTWz4KzzWNBcbHXrNdtSYxEjDsQyHKnymYzgBGOOamN6C4Maxc2\nAVJG8JdXyaxf2AAKYc06E1OcgmV1oVsRfEkPs6wBbNlGNijzpbLQulP7aGBK/mON\n7o5xOt8tV81il8SFHmrA+enmPCW+aY5pGJxBYg3hsQOs4W/ZE2WNWOGhAyfmEE/J\n2o3mzo8nAgMBAAECggEAArkFHMsHg05yIwKIoXuXKPdzJuLrJC0sQquvzjQCc/Cd\nFw3A1GRDH6YGmqP7Xpipz0V/dc5pwBL3xh//usrlClw0zoS7agHWBfOzWT0I7Lf5\nJtgkSAbDd+iTTk4oiStY2cFv5pmF2yElMIjPeJYr7AR3QJCe63ejY7yHRjWHTC8i\nTSutFYAEErVGlFmLFSyCiZlWRcK25kUGpYAvR09y6q0ipizWmFnIZioNSV0C54Q0\nceFizmJ00qFOjk2l2XLCfhIyLeir91Xg8RuiN1aoNE8pZGRTihVHBmsxJQMK44GN\n1zmra2/fdnUIDV/oWxQA3LxsdPYeYg81GySHLiZyiQKBgQDnAFUB14uFkoVC3qE5\nLIaXZmdNH7Mx1EDTZ1vOhKc/g/NCSS9M24rDY3LuSdJXqY040av/IW2qaeGaC08L\nAyBI+5v0ondI3Nx5Adm1SjpK6cwiAHYRztll7G7tGDukR3O/WRlIo5tVofpYy+Lp\nXI+3QmD2cuZR3VN7QeDuWNvy/wKBgQDEeStqNMRIctr1YZxI8z008g8uwBwlTOnP\nLrSTyLbopWfx9TcxSne416gJ6Cr2Y+VYBZx7VRcGyLogbRWfocXnxvRXb53TIuKj\n+Cjb9Q4tAfVMoCL8v/s7FVicWv1aB1EH9xGaTC8HAy41RHQ6sdX6J4qgr45QdPBr\npreJwzNr2QKBgQDZ4r5L1nuLqgB4anW37/+jnruhS11Ciun6fWtjCEyY5GT3CQDM\nhegFFDC8AnWcqhjCl0Kci3NdYjGhkzkjMfep32ni/bt1xp1Opigrj7AcKRqal8TG\nV01HjhOzH0BiW+MZgXkPwwIpa3cvemC1rNECEmJTE12bqh+sCx+WscoFEQKBgEIH\nWtDZpPGYL//xav2VSYempfWXOJ5Mh/NKBgP4m4f6NsG5IHBfT3b+ewnBTdb6YZRA\nZoOIaDGueeb14iOA0asAUROlfkv72GE0wD6Tz8zOcKrs0nVQ69TCasI5ThXYiaH8\npZzOZ6uapQff1pP3OitU6KDx/wkJE9eJ8vrIcFqZAoGAA7Rp434c6svqNHGaaej7\nx3lvhw6ecJx3i3OViAuyQbjZcnpKlZdNS9Vb/X85kwgfcO8AevvlkeaHHOmEZLNW\niVoH2bqZhXlGRJoatZwOTXlRbK3BdbDYqWIxUnrcSzY0P0bGvVn4IVUSEVvYxGdL\nklfj6PiHc3SORrPOewRSWxk=\n-----END PRIVATE KEY-----\n",
  "client_email": "firebase-adminsdk-fbsvc@espc-f1445.iam.gserviceaccount.com"
};

const DATABASE_URL = "https://espc-f1445-default-rtdb.firebaseio.com";

try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: DATABASE_URL
  });
  console.log("🔥 Firebase initialized.");
} catch (e) {
  console.error("🔥 Firebase init failed:", e);
}
const db = admin.database();

// ----------------- Config -----------------
const ALLOWED_GUILD_ID = "1462335230345089254";
const ADMIN_ID = "1144987924123881564";
const LOG_CHANNEL_ID = "1464615030111731753";
const ADMIN_CHANNEL_ID = "1469013237625393163"; 

// ----------------- Storage Paths -----------------
const DATA = path.join(__dirname, "data");
const AUTH_ROOT = path.join(DATA, "auth");
if (!fs.existsSync(DATA)) fs.mkdirSync(DATA);
if (!fs.existsSync(AUTH_ROOT)) fs.mkdirSync(AUTH_ROOT, { recursive: true });

let usersCache = {}; 

// ----------------- Firebase Helpers -----------------
async function getUser(uid) {
  if (usersCache[uid]) return usersCache[uid];
  try {
    const snapshot = await db.ref('users/' + uid).once('value');
    let u = snapshot.val();
    if (!u) u = { connectionType: "online", bedrockVersion: "auto" };
    usersCache[uid] = u;
    return u;
  } catch (e) {
    return { connectionType: "online", bedrockVersion: "auto" };
  }
}

async function saveUser(uid, data) {
  usersCache[uid] = data;
  try { await db.ref('users/' + uid).set(data); } catch (e) {}
}

async function downloadAuth(uid) {
    try {
        const snap = await db.ref(`auth_files/${uid}`).once('value');
        const data = snap.val();
        if (!data) return false;
        const userDir = path.join(AUTH_ROOT, uid);
        if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
        for (const [filename, content] of Object.entries(data)) {
             fs.writeFileSync(path.join(userDir, filename), content, 'utf8');
        }
        return true;
    } catch (e) { return false; }
}

async function uploadAuth(uid) {
    try {
        const userDir = path.join(AUTH_ROOT, uid);
        if (!fs.existsSync(userDir)) return;
        const files = fs.readdirSync(userDir);
        const authData = {};
        for (const file of files) {
            if (file.endsWith('.json') || file.includes('cache')) {
                 authData[file] = fs.readFileSync(path.join(userDir, file), 'utf8');
            }
        }
        if (Object.keys(authData).length > 0) {
            await db.ref(`auth_files/${uid}`).set(authData);
        }
    } catch (e) {}
}

function getUserAuthDir(uid) {
  const dir = path.join(AUTH_ROOT, uid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function unlinkMicrosoft(uid) {
  const dir = getUserAuthDir(uid);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  try { await db.ref(`auth_files/${uid}`).remove(); } catch {}
  const u = await getUser(uid);
  u.linked = false;
  await saveUser(uid, u);
}

// ----------------- Global State -----------------
const sessions = new Map();
const pendingLink = new Map();
const lastMsa = new Map();
let lastAdminMessage = null; 

// ==========================================================
// 👑 LEADER ELECTION SYSTEM (The "Boss" Logic)
// ==========================================================
const MACHINE_ID = Math.random().toString(36).substring(7);
let IS_LEADER = false;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent 
  ]
});

async function runLeaderElection() {
    console.log(`🤖 Machine ID: ${MACHINE_ID} started. Checking for leader...`);
    setInterval(async () => {
        try {
            const leaderRef = db.ref('system/leader');
            const snapshot = await leaderRef.once('value');
            const currentLeader = snapshot.val();
            const now = Date.now();

            if (!currentLeader || (now - currentLeader.heartbeat > 15000)) {
                await leaderRef.set({ id: MACHINE_ID, heartbeat: now });
                if (!IS_LEADER) {
                    console.log("👑 I am now the LEADER. Connecting Discord...");
                    IS_LEADER = true;
                    if (!client.isReady()) client.login(DISCORD_TOKEN);
                }
            } 
            else if (currentLeader.id === MACHINE_ID) {
                await leaderRef.update({ heartbeat: now });
                if (!IS_LEADER) IS_LEADER = true;
            } 
            else {
                if (IS_LEADER) {
                    console.log("⛔ Another leader detected. Stepping down.");
                    process.exit(0);
                }
            }
        } catch (e) { console.error("Leader Election Error:", e); }
    }, 5000);
}

runLeaderElection(); // START THE PROCESS

// ----------------- Discord Handlers -----------------
client.on("error", (e) => console.error("Discord Error:", e.message));

async function logToDiscord(message) {
  if (!IS_LEADER) return;
  try {
    const channel = await client.channels.fetch(LOG_CHANNEL_ID);
    if (channel) {
      const embed = new EmbedBuilder().setColor("#5865F2").setDescription(message).setTimestamp();
      await channel.send({ embeds: [embed] });
    }
  } catch (e) {}
}

function denyIfWrongGuild(i) {
  if (!i.inGuild() || i.guildId !== ALLOWED_GUILD_ID) {
    if (!i.replied && !i.deferred) i.reply({ ephemeral: true, content: "Wrong Server ⛔️" }).catch(()=>{});
    return true;
  }
  return false;
}

function panelRow(isJava = false) {
  const title = isJava ? "Java AFKBot Panel 🎛️" : "Bedrock AFKBot Panel 🎛️";
  const startCustomId = isJava ? "start_java" : "start_bedrock";
  return {
    content: `**${title}**`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("link").setLabel("🔑 Link Microsoft").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("unlink").setLabel("🗑 Unlink Microsoft").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(startCustomId).setLabel("▶ Start").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("stop").setLabel("⏹ Stop").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Secondary)
      )
    ]
  };
}

function adminPanelComponents() {
  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin_refresh").setLabel("🔄 Refresh").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin_stop_all").setLabel("🛑 Stop All").setStyle(ButtonStyle.Danger)
    )
  ];
  if (sessions.size > 0) {
    const options = [];
    let count = 0;
    for (const [uid, session] of sessions) {
      if (count >= 25) break; 
      options.push({ label: `User: ${uid}`, description: `Started: ${new Date(session.startedAt).toLocaleTimeString()}`, value: uid });
      count++;
    }
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId("admin_force_stop_select").setPlaceholder("Select bot to Force Stop").addOptions(options)
    ));
  }
  return rows;
}

function getAdminStatsEmbed() {
  const memory = process.memoryUsage();
  const ramMB = (memory.rss / 1024 / 1024).toFixed(2);
  const uptime = process.uptime();
  const embed = new EmbedBuilder()
    .setTitle(`🛠 Admin Panel (${MACHINE_ID})`)
    .setColor("#2f3136")
    .addFields(
      { name: "📊 Stats", value: `**RAM:** ${ramMB} MB\n**Uptime:** ${Math.floor(uptime/60)}m`, inline: true },
      { name: "🤖 Active", value: `**Total:** ${sessions.size}`, inline: true },
      { name: "👑 Role", value: IS_LEADER ? "Leader" : "Standby", inline: true }
    )
    .setTimestamp();
  if (sessions.size > 0) {
    let botList = "";
    for (const [uid, s] of sessions) botList += `<@${uid}>: ${s.connected?"🟢":"🔴"}\n`;
    embed.addFields({ name: "Registry", value: botList.slice(0, 1024) });
  }
  return embed;
}

// ----------------- Ready Event -----------------
client.once("ready", async () => {
  console.log("🟢 Discord Ready:", client.user.tag);

  const cmds = [
    new SlashCommandBuilder().setName("panel").setDescription("Bedrock Panel"),
    new SlashCommandBuilder().setName("java").setDescription("Java Panel"),
    new SlashCommandBuilder().setName("admin").setDescription("Admin Panel")
  ];
  await client.application.commands.set(cmds);

  setInterval(async () => {
    if (lastAdminMessage && IS_LEADER) {
        try { await lastAdminMessage.edit({ embeds: [getAdminStatsEmbed()], components: adminPanelComponents() }); } catch (e) { lastAdminMessage = null; }
    }
  }, 30000);

  // Restore sessions from Firebase
  try {
      const snap = await db.ref('activeSessions').once('value');
      const savedSessions = snap.val() || {};
      const previousSessions = Object.keys(savedSessions);
      if (previousSessions.length > 0) {
          console.log(`♻️ Restoring ${previousSessions.length} bots...`);
          let delay = 0;
          for (const uid of previousSessions) {
              setTimeout(() => startSession(uid, null, true), delay);
              delay += 5000; 
          }
      }
  } catch(e) {}
});

// ----------------- Auth Logic -----------------
async function linkMicrosoft(uid, interaction) {
  if (pendingLink.has(uid)) return interaction.editReply("⏳ Login already in progress.");
  const authDir = getUserAuthDir(uid);
  
  let codeShown = false;
  const flow = new Authflow(uid, authDir, { flow: "live", authTitle: "AFK Bot", deviceType: "Nintendo" }, async (data) => {
      const uri = data.verification_uri_complete || data.verification_uri;
      const code = data.user_code;
      lastMsa.set(uid, { uri, code, at: Date.now() });
      codeShown = true;
      const msg = `🔐 **Auth Required**\n1. Visit: ${uri}\n2. Code: \`${code}\``;
      try { await interaction.editReply({ content: msg, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Open").setStyle(ButtonStyle.Link).setURL(uri))] }); } catch(e) {}
  });

  const p = (async () => {
    try {
      if (!codeShown) await interaction.editReply("⏳ Requesting code…");
      await flow.getMsaToken();
      const u = await getUser(uid);
      u.linked = true; 
      await saveUser(uid, u);
      await uploadAuth(uid);
      await interaction.followUp({ ephemeral: true, content: "✅ Linked & Synced!" });
    } catch (e) {
      await interaction.editReply(`❌ Failed: ${e.message}`).catch(()=>{});
    } finally { pendingLink.delete(uid); }
  })();
  pendingLink.set(uid, p);
}

// ----------------- Session Logic -----------------
function cleanupSession(uid) {
  const s = sessions.get(uid);
  if (!s) return;
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  if (s.physicsLoop) clearInterval(s.physicsLoop);
  if (s.afkTimeout) clearTimeout(s.afkTimeout);
  if (s.chunkGCLoop) clearInterval(s.chunkGCLoop);
  try { s.client.close(); } catch {}
  sessions.delete(uid);
}

async function stopSession(uid) {
  try { await db.ref('activeSessions/' + uid).remove(); } catch(e) {}
  const s = sessions.get(uid);
  if (!s) return false;
  s.manualStop = true; 
  cleanupSession(uid);
  return true;
}

function handleAutoReconnect(uid) {
    const s = sessions.get(uid);
    if (!s || s.manualStop) return;
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
    s.isReconnecting = true;
    logToDiscord(`⏳ <@${uid}> disconnected. Reconnecting in 60s...`);
    s.reconnectTimer = setTimeout(() => {
        if (sessions.has(uid) && !sessions.get(uid).manualStop) {
            startSession(uid, null, true); 
        } else cleanupSession(uid);
    }, 60000);
}

async function safeReply(interaction, content) {
    if (!interaction) return;
    try {
        if (interaction.replied || interaction.deferred) await interaction.editReply(content);
        else await interaction.reply(content);
    } catch (e) {}
}

async function startSession(uid, interaction, isReconnect = false) {
  if (interaction && !isReconnect) await safeReply(interaction, { content: "🔍 **Initializing...**", embeds: [] });

  const u = await getUser(uid);
  if (!isReconnect) try { await db.ref('activeSessions/' + uid).set(true); } catch(e) {}

  if (!u.server) {
      if (!isReconnect) await safeReply(interaction, "⚠ Set server first.");
      try { await db.ref('activeSessions/' + uid).remove(); } catch(e) {}
      return;
  }
  const { ip, port } = u.server;

  if (sessions.has(uid) && !isReconnect) return safeReply(interaction, "⚠️ Session active.");
  
  await downloadAuth(uid);

  const connectionEmbed = new EmbedBuilder().setColor("#5865F2").setTitle("Bot Init").setThumbnail("https://files.catbox.moe/9mqpoz.gif");

  try {
      if (!isReconnect) {
          connectionEmbed.setDescription(`🔍 **Pinging...** \`${ip}:${port}\``);
          await safeReply(interaction, { embeds: [connectionEmbed] });
      }
      await bedrock.ping({ host: ip, port: parseInt(port) || 19132, timeout: 5000 });
      if (!isReconnect) {
          connectionEmbed.setDescription(`✅ **Found! Joining...** \`${ip}:${port}\``);
          await safeReply(interaction, { embeds: [connectionEmbed] });
      }
  } catch (err) {
      logToDiscord(`❌ Connect fail <@${uid}>: ${ip}:${port}`);
      if (isReconnect) handleAutoReconnect(uid); 
      else await safeReply(interaction, { content: `❌ **Failed**: Server unreachable.`, embeds: [] });
      return; 
  }

  const authDir = getUserAuthDir(uid);
  const opts = { 
      host: ip, port: parseInt(port), connectTimeout: 60000, keepAlive: true, 
      viewDistance: 4, profilesFolder: authDir, username: uid, offline: false
  };
  if (u.connectionType === "offline") { opts.username = u.offlineUsername || `AFK_${uid.slice(-4)}`; opts.offline = true; }

  let mc;
  try { mc = bedrock.createClient(opts); } catch (e) { return safeReply(interaction, "❌ Client error: " + e.message); }
  
  const currentSession = { 
      client: mc, startedAt: Date.now(), manualStop: false, connected: false, isReconnecting: false,
      position: null, velocity: (Vec3) ? new Vec3(0, 0, 0) : null, yaw: 0, pitch: 0, onGround: false,
      isWalking: false, targetPosition: null, isTryingToSleep: false, chunks: new Map(),
      registry: null, Chunk: null, reconnectTimer: null, physicsLoop: null, afkTimeout: null, chunkGCLoop: null,
  };
  sessions.set(uid, currentSession);

  if (Vec3 && PrismarineChunk) {
      try {
          currentSession.registry = PrismarineRegistry('bedrock_1.20.0');
          currentSession.Chunk = PrismarineChunk(currentSession.registry);
      } catch (e) { currentSession.Chunk = null; }
      
      mc.on('level_chunk', (packet) => {
          if (!currentSession.Chunk) return;
          try {
              const chunk = new currentSession.Chunk();
              chunk.load(packet.payload);
              currentSession.chunks.set(`${packet.x},${packet.z}`, chunk);
          } catch(e) {}
      });
      currentSession.chunkGCLoop = setInterval(() => { if (currentSession.chunks.size > 50) currentSession.chunks.clear(); }, 10000);

      currentSession.physicsLoop = setInterval(() => {
          if (!currentSession.connected || !currentSession.position) return;
          const gravity = 0.08; 
          const moveVector = { x: 0, z: 0 };
          if (currentSession.isWalking && currentSession.targetPosition) {
              const distance = currentSession.position.distanceTo(currentSession.targetPosition);
              if (distance > 0.5) {
                  const direction = currentSession.targetPosition.minus(currentSession.position).normalize();
                  moveVector.x = direction.x; moveVector.z = direction.z;
              } else currentSession.isWalking = false;
          }
          if (!currentSession.onGround) currentSession.velocity.y -= gravity;
          if (currentSession.velocity.y < -3.92) currentSession.velocity.y = -3.92;
          currentSession.position.add(currentSession.velocity);
          if (currentSession.position.y < -64) { currentSession.position.y = 320; currentSession.velocity.y = 0; }
          try {
              mc.write("player_auth_input", {
                 pitch: currentSession.pitch, yaw: currentSession.yaw,
                 position: { x: currentSession.position.x, y: currentSession.position.y, z: currentSession.position.z },
                 move_vector: moveVector, head_yaw: currentSession.yaw, input_data: 0n,
                 input_mode: "mouse", play_mode: "screen", interaction_model: "touch", tick: 0n
              });
          } catch (e) {}
      }, 50); 
  }

  const performAntiAfk = () => {
      if (!sessions.has(uid)) return;
      const s = sessions.get(uid);
      if (!s.connected || !s.position) { s.afkTimeout = setTimeout(performAntiAfk, 5000); return; }
      try {
          scanForBedAndSleep(uid);
          const action = Math.random();
          if (action > 0.5 && !s.isWalking) s.isWalking = true;
          else {
              s.yaw += (Math.random() - 0.5) * 20; 
              s.pitch += (Math.random() - 0.5) * 10;
              if (s.onGround && Math.random() > 0.9) { s.velocity.y = 0.42; s.onGround = false; }
          }
          mc.write('animate', { action_id: 1, runtime_entity_id: s.entityId || 0n });
      } catch (e) {}
      s.afkTimeout = setTimeout(performAntiAfk, Math.random() * 20000 + 10000);
  };

  function scanForBedAndSleep(uid) {
      const s = sessions.get(uid);
      if (!s || !s.Chunk || !s.position || s.isTryingToSleep) return;
      const searchRadius = 3;
      const playerPos = s.position.floored();
      for (let x = -searchRadius; x <= searchRadius; x++) {
          for (let y = -searchRadius; y <= searchRadius; y++) {
              for (let z = -searchRadius; z <= searchRadius; z++) {
                  const checkPos = playerPos.offset(x, y, z);
                  const chunk = s.chunks.get(`${Math.floor(checkPos.x / 16)},${Math.floor(checkPos.z / 16)}`);
                  if (chunk) {
                      const block = chunk.getBlock(checkPos);
                      if (block && block.name.includes('bed')) {
                          logToDiscord(`🛌 Bed found <@${uid}>. Sleeping.`);
                          s.isTryingToSleep = true;
                          mc.write('inventory_transaction', { transaction: { transaction_type: 'item_use_on_block', action_type: 0, block_position: checkPos, block_face: 1, hotbar_slot: 0, item_in_hand: { network_id: 0 }, player_position: s.position, click_position: { x: 0, y: 0, z: 0 } } });
                          mc.write('player_action', { runtime_entity_id: s.entityId || 0n, action: 'start_sleeping', position: checkPos, result_code: 0, face: 0 });
                          return; 
                      }
                  }
              }
          }
      }
  }

  mc.on("spawn", () => {
    logToDiscord(`✅ <@${uid}> spawned on **${ip}:${port}**`);
    if (!isReconnect) safeReply(interaction, { content: `🟢 **Online** on \`${ip}:${port}\``, embeds: [] });
  });

  mc.on("start_game", (packet) => {
      if (Vec3) {
          currentSession.position = new Vec3(packet.player_position.x, packet.player_position.y, packet.player_position.z);
          currentSession.targetPosition = currentSession.position.clone();
      }
      currentSession.entityId = packet.runtime_entity_id;
      currentSession.connected = true;
      currentSession.isReconnecting = false;
      performAntiAfk();
  });
  
  mc.on("move_player", (packet) => {
      if (packet.runtime_id === currentSession.entityId && currentSession.position) {
          if (packet.position.y > currentSession.position.y) { currentSession.onGround = true; currentSession.velocity.y = 0; } 
          else currentSession.onGround = false;
          currentSession.isTryingToSleep = false;
          currentSession.position.set(packet.position.x, packet.position.y, packet.position.z);
      }
  });
  
  mc.on("respawn", (packet) => {
      logToDiscord(`💀 <@${uid}> died.`);
      if (currentSession.position) {
          currentSession.position.set(packet.position.x, packet.position.y, packet.position.z);
          currentSession.targetPosition = currentSession.position.clone();
          currentSession.velocity.set(0,0,0);
          currentSession.isTryingToSleep = false;
      }
  });

  mc.on("error", (e) => { if (!currentSession.manualStop) handleAutoReconnect(uid); });
  mc.on("close", () => { if (!currentSession.manualStop) handleAutoReconnect(uid); logToDiscord(`🔌 <@${uid}> closed.`); });
}

// ----------------- Interaction Event -----------------
client.on(Events.InteractionCreate, async (i) => {
  try {
    if (denyIfWrongGuild(i)) return;
    const uid = i.user.id;

    if (i.isChatInputCommand()) {
      if (i.commandName === "panel") return safeReply(i, panelRow(false));
      if (i.commandName === "java") return safeReply(i, panelRow(true));
      if (i.commandName === "admin") {
        if (uid !== ADMIN_ID || i.channelId !== ADMIN_CHANNEL_ID) return safeReply(i, { content: "⛔ Denied.", ephemeral: true });
        await i.deferReply();
        const msg = await i.editReply({ embeds: [getAdminStatsEmbed()], components: adminPanelComponents(), fetchReply: true });
        lastAdminMessage = msg;
        return;
      }
    }

    if (i.isButton()) {
      if (i.customId === "settings") {
         // No defer here, modal must show immediately
      } else {
         try {
             if (i.customId === "confirm_start" || i.customId === "admin_refresh") await i.deferUpdate();
             else await i.deferReply({ ephemeral: true });
         } catch(e) {}
      }

      if (i.customId === "admin_refresh") return i.editReply({ embeds: [getAdminStatsEmbed()], components: adminPanelComponents() }).catch(()=>{});
      
      if (i.customId === "start_bedrock") {
        if (sessions.has(uid)) return safeReply(i, { ephemeral: true, content: "⚠️ Active session exists." });
        const embed = new EmbedBuilder().setTitle("Connect?").setColor("#2ECC71");
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("confirm_start").setLabel("Start").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
        );
        return i.editReply({ embeds: [embed], components: [row] }).catch(()=>{});
      }

      if (i.customId === "start_java") {
        if (sessions.has(uid)) return safeReply(i, { ephemeral: true, content: "⚠️ Active session exists." });
        const embed = new EmbedBuilder().setTitle("Java Check").setDescription("Need Geyser+Floodgate").setColor("#E67E22");
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("confirm_start").setLabel("Confirm").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
        );
        return i.editReply({ embeds: [embed], components: [row] }).catch(()=>{});
      }

      if (i.customId === "confirm_start") return startSession(uid, i, false);
      if (i.customId === "cancel") return i.editReply({ content: "❌ Cancelled.", embeds: [], components: [] }).catch(()=>{});
      if (i.customId === "stop") { const ok = await stopSession(uid); return safeReply(i, { ephemeral: true, content: ok ? "⏹ Stopped." : "None active." }); }
      if (i.customId === "link") return linkMicrosoft(uid, i);
      if (i.customId === "unlink") { await unlinkMicrosoft(uid); return safeReply(i, { ephemeral: true, content: "🗑 Unlinked." }); }

      if (i.customId === "settings") {
        const u = await getUser(uid);
        const modal = new ModalBuilder().setCustomId("settings_modal").setTitle("Config");
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("IP").setStyle(TextInputStyle.Short).setRequired(true).setValue(u.server?.ip || "")),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setRequired(true).setValue(String(u.server?.port || 19132)))
        );
        return i.showModal(modal);
      }
    }

    if (i.isModalSubmit() && i.customId === "settings_modal") {
        await i.deferReply({ ephemeral: true });
        const ip = i.fields.getTextInputValue("ip").trim();
        const port = parseInt(i.fields.getTextInputValue("port").trim(), 10);
        let u = await getUser(uid);
        u.server = { ip, port };
        await saveUser(uid, u);
        return safeReply(i, { ephemeral: true, content: `✅ Saved: **${ip}:${port}**` });
    }

  } catch (e) { console.error("Inter error:", e); }
});

client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || message.channel.id !== '1462398161074000143' || !IS_LEADER) return;
    const content = message.content.toLowerCase();
    if (['afk', 'afkbot'].some(word => content.includes(word))) {
        try {
            const reaction = await message.react('<a:loading:1470137639339299053>');
            setTimeout(async () => { try { await reaction.remove(); await message.reply("What bout me? 😁"); } catch (e) {} }, 3000);
        } catch (e) {}
    }
});

process.on("unhandledRejection", (e) => console.error("Unhandled:", e));
// Note: client.login() is called automatically inside runLeaderElection()
