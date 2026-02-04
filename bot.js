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
  EmbedBuilder,
  AttachmentBuilder
} = require("discord.js");

const bedrock = require("bedrock-protocol");
const { Authflow, Titles } = require("prismarine-auth");
const fs = require("fs");
const path = require("path");

// IMPORT ROBUST SIMPLE CLIENT
const SimpleClient = require('./SimpleClient');

// ----------------- CRITICAL CONFIGURATION -----------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("❌ CRITICAL ERROR: DISCORD_TOKEN is missing!");
  process.exit(1);
}

// Allowed Guilds
const ALLOWED_GUILDS = [
    "1462335230345089254", 
    "1468289465783943354"
];
const ADMIN_ID = "1144987924123881564";

// ----------------- STORAGE SYSTEM -----------------
const DATA_DIR = path.join(__dirname, "data");
const AUTH_DIR = path.join(DATA_DIR, "auth");
const USER_FILE = path.join(DATA_DIR, "users.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

let users = {};
try {
  users = fs.existsSync(USER_FILE) ? JSON.parse(fs.readFileSync(USER_FILE, "utf8")) : {};
} catch (e) {
  console.error("⚠️ Failed to load users.json, creating new database.");
  users = {};
}

async function saveDatabase() {
    try {
        await fs.promises.writeFile(USER_FILE, JSON.stringify(users, null, 2));
    } catch (e) {
        console.error("Save failed:", e);
    }
}

function getUser(uid) {
  if (!users[uid]) users[uid] = {};
  
  if (!users[uid].connectionType) users[uid].connectionType = "online";
  if (!users[uid].bedrockVersion) users[uid].bedrockVersion = "auto";
  if (!users[uid].offlineUsername) users[uid].offlineUsername = `AFK_${uid.slice(-4)}`;
  
  if (!users[uid].java) {
    users[uid].java = {
      server: null,
      offlineUsername: `Java_${uid.slice(-4)}`,
      selectedVersion: "auto",
      authType: "offline"
    };
  }
  if (!users[uid].java.authType) users[uid].java.authType = "offline";
  
  return users[uid];
}

function getUserAuthDir(uid) {
  const dir = path.join(AUTH_DIR, uid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ----------------- GLOBAL STATE -----------------
const sessions = new Map();     // Bedrock
const javaSessions = new Map(); // Java (Now uses SimpleClient)
const pendingAuth = new Map();  // Auth flows
let adminDashboardMessage = null;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] });

// ----------------- SESSION MANAGEMENT -----------------

function destroySession(uid, type) {
    const map = type === 'java' ? javaSessions : sessions;
    const s = map.get(uid);
    
    if (!s) return;

    // Clear interval tracking
    if (s.uptimeInterval) clearInterval(s.uptimeInterval);
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);

    // Bedrock Cleanup
    try {
        if (type === 'bedrock' && s.client) {
            s.client.close();
            s.client.removeAllListeners();
        }
    } catch (e) { console.error("Bedrock close error:", e.message); }

    // Java Cleanup (SimpleClient)
    try {
        if (type === 'java' && s.simpleClient) {
            s.simpleClient.disconnect();
            s.simpleClient.removeAllListeners();
        }
    } catch (e) { console.error("Java close error:", e.message); }

    map.delete(uid);
    console.log(`[${type.toUpperCase()}] Session destroyed for ${uid}`);
    updateAdminDashboard();
}

// ----------------- BEDROCK ENGINE -----------------

async function startBedrock(uid, interaction, versionOverride) {
    const u = getUser(uid);
    if (!u.server) return interaction.reply({ content: "❌ No server set! Go to Settings.", ephemeral: true });
    
    if (sessions.has(uid)) return interaction.reply({ content: "❌ Bot already running.", ephemeral: true });

    const authDir = getUserAuthDir(uid);
    const { ip, port } = u.server;

    await interaction.update({ content: `🧱 **Connecting to ${ip}:${port}...**`, components: [], embeds: [] });

    const options = {
        host: ip,
        port: port,
        connectTimeout: 30000,
        skipPing: false,
        version: versionOverride === "auto" ? undefined : versionOverride,
        offline: u.connectionType === "offline",
        username: u.connectionType === "offline" ? (u.offlineUsername || `AFK_${uid.slice(-4)}`) : undefined,
        profilesFolder: u.connectionType === "online" ? authDir : undefined,
        conLog: console.log
    };

    if (u.connectionType === "online" && !u.linked) {
        return interaction.followUp({ content: "❌ Microsoft Account not linked! Use 'Link Xbox' first.", ephemeral: true });
    }

    let bedClient;
    try {
        bedClient = bedrock.createClient(options);
    } catch (e) {
        return interaction.followUp({ content: `❌ Init Error: ${e.message}`, ephemeral: true });
    }

    const session = {
        client: bedClient,
        connected: false,
        startTime: Date.now(),
        manualStop: false,
        opts: options,
        pos: { x: 0, y: 0, z: 0 },
        congratsHours: 0
    };
    sessions.set(uid, session);

    bedClient.on('spawn', () => {
        session.connected = true;
        console.log(`[BEDROCK] ${uid} spawned on ${options.host}`);
        interaction.followUp({ content: `✅ **Connected to ${options.host}!**`, ephemeral: true });
        updateAdminDashboard();
        // Bedrock AFK logic is simple, handled here
        session.afkInterval = setInterval(() => {
            try {
                const yaw = Math.random() * 360;
                bedClient.write("player_auth_input", {
                    pitch: 0, yaw: yaw, head_yaw: yaw,
                    position: session.pos,
                    move_vector: { x: 0, z: 0 },
                    input_data: { _value: 0n },
                    input_mode: 'mouse', play_mode: 'normal', tick: 0n, delta: { x: 0, y: 0, z: 0 }
                });
            } catch(e){}
        }, 10000);
    });

    bedClient.on('error', (err) => console.log(`[BEDROCK ERR] ${uid}:`, err.message));
    bedClient.on('close', () => handleDisconnect(uid, session, 'bedrock'));
    bedClient.on('move_player', (packet) => {
        if (packet.runtime_id === bedClient.entityId) session.pos = packet.position;
    });

    startUptimeTracker(uid, session, 'bedrock');
}

// ----------------- JAVA ENGINE (Using SimpleClient) -----------------

async function startJava(uid, interaction, versionOverride) {
    const u = getUser(uid);
    if (!u.java.server) return interaction.reply({ content: "❌ No server set! Go to Settings.", ephemeral: true });
    
    if (javaSessions.has(uid)) return interaction.reply({ content: "❌ Bot already running.", ephemeral: true });

    const { ip, port } = u.java.server;
    
    await interaction.update({ content: `☕ **Connecting to ${ip}:${port}...**`, components: [], embeds: [] });

    const authType = u.java.authType || 'offline';

    // 1. Prepare Options for SimpleClient
    const options = {
        host: ip,
        port: port,
        version: versionOverride, // 'auto' or specific string
        auth: authType,
        username: authType === 'offline' ? (u.java.offlineUsername || `Java_${uid.slice(-4)}`) : undefined,
        profilesFolder: getUserAuthDir(uid) // For Microsoft Token caching
    };

    // 2. Initialize SimpleClient
    const simpleClient = new SimpleClient(options);
    
    const session = {
        simpleClient: simpleClient,
        connected: false,
        startTime: Date.now(),
        manualStop: false,
        opts: options,
        congratsHours: 0
    };
    javaSessions.set(uid, session);

    // 3. Setup Bridge Listeners
    simpleClient.on('spawn', () => {
        session.connected = true;
        interaction.followUp({ content: `✅ **Connected to ${ip}!** (Using Robust Client)`, ephemeral: true });
        updateAdminDashboard();
        startUptimeTracker(uid, session, 'java');
    });

    simpleClient.on('msaCode', (data) => {
         const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel("Login to Microsoft").setStyle(ButtonStyle.Link).setURL(data.verification_uri)
        );
        interaction.followUp({ 
            content: `🔐 **Microsoft Authentication Required**\nCode: \`${data.user_code}\`\nClick the link below to authorize.`, 
            components: [row],
            ephemeral: true 
        });
    });

    simpleClient.on('error', (err) => {
        if (interaction && !session.connected) {
             if (err.message.includes('Invalid credentials')) {
                 interaction.followUp({ content: "❌ **Auth Error:** Invalid credentials or 'Cracked Mode' required.", ephemeral: true });
             } else if (err.message.includes("ECONNRESET")) {
                 interaction.followUp({ content: "❌ **Connection Reset:** Server blocked the connection or version mismatch.", ephemeral: true });
             } else {
                 interaction.followUp({ content: `❌ **Error:** ${err.message}`, ephemeral: true });
             }
        }
    });

    simpleClient.on('end', () => {
        handleDisconnect(uid, session, 'java');
    });

    // 4. Trigger Connection
    simpleClient.connect();
}


// ----------------- SHARED LOGIC -----------------

function startUptimeTracker(uid, session, type) {
    session.uptimeInterval = setInterval(async () => {
        session.congratsHours++;
        try {
            const user = await client.users.fetch(uid);
            user.send(`🎉 **Congrats!** Your ${type === 'java' ? "Java" : "Bedrock"} bot has been online for **${session.congratsHours} hours**!`).catch(() => {});
        } catch (e) {}
    }, 3600 * 1000);
}

function handleDisconnect(uid, session, type) {
    if (session.uptimeInterval) clearInterval(session.uptimeInterval);

    if (session.manualStop) {
        destroySession(uid, type);
    } else {
        console.log(`[${type.toUpperCase()}] Disconnected ${uid}. Reconnecting in 30s...`);
        updateAdminDashboard();
        
        session.reconnectTimer = setTimeout(() => {
            const map = type === 'java' ? javaSessions : sessions;
            if (map.has(uid) && !map.get(uid).manualStop) {
                console.log(`[${type.toUpperCase()}] Reconnecting ${uid} now...`);
                if (type === 'java') {
                    // Create new SimpleClient instance
                    destroySession(uid, 'java'); // Clean old one first
                    // We need to re-trigger startJava logic, but interaction is gone.
                    // Simplified: We recreate the session manually.
                    // Note: This simple recursive logic might need the original interaction for full UI feedback,
                    // but for reconnects, console logs are fine.
                    const u = getUser(uid);
                    const opts = session.opts;
                    const newClient = new SimpleClient(opts);
                    // Attach basic listeners for reconnect
                    newClient.on('spawn', () => { 
                        const newSess = { simpleClient: newClient, connected: true, startTime: Date.now(), opts: opts, congratsHours: session.congratsHours };
                        javaSessions.set(uid, newSess);
                        startUptimeTracker(uid, newSess, 'java');
                    });
                    newClient.on('end', () => handleDisconnect(uid, javaSessions.get(uid), 'java'));
                    newClient.connect();
                } 
                else {
                    createBedrockInstance(uid, session.opts, null);
                }
            } else {
                destroySession(uid, type);
            }
        }, 30000);
    }
}

// ----------------- UI BUILDERS -----------------

function getVersionSelector(type, current) {
    const jv = [
        { label: "Auto-Detect (Best)", value: "auto" },
        { label: "1.21.4", value: "1.21.4" },
        { label: "1.21.3", value: "1.21.3" },
        { label: "1.21.1", value: "1.21.1" },
        { label: "1.20.6", value: "1.20.6" },
        { label: "1.20.4", value: "1.20.4" },
        { label: "1.20.1", value: "1.20.1" },
        { label: "1.19.4", value: "1.19.4" },
        { label: "1.16.5", value: "1.16.5" },
        { label: "1.8.9", value: "1.8.9" }
    ];
    const bv = [
        { label: "Auto-Detect (Best)", value: "auto" },
        { label: "1.21.60", value: "1.21.60" }, { label: "1.21.50", value: "1.21.50" }
    ];

    const list = type === 'java' ? jv : bv;
    const safeCurrent = list.find(x => x.value === current) ? current : "auto";

    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(type === 'java' ? "sel_java_ver" : "sel_bed_ver")
            .setPlaceholder(`Selected: ${safeCurrent}`)
            .addOptions(list.map(v => ({ label: v.label, value: v.value, default: v.value === safeCurrent })))
    );
}

function getPanel(type) {
    if (type === 'bedrock') {
        return [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId("pre_bedrock").setLabel("▶ Start").setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId("stop_bedrock").setLabel("⏹ Stop").setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId("link").setLabel("🔑 Link Xbox").setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId("unlink").setLabel("⛓ Unlink").setStyle(ButtonStyle.Secondary)
            ),
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId("set_bedrock").setLabel("⚙ Settings").setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId("tech_bedrock").setLabel("🛠 Technical").setStyle(ButtonStyle.Secondary)
            )
        ];
    } else {
        return [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId("pre_java").setLabel("▶ Start Java").setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId("stop_java").setLabel("⏹ Stop Java").setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId("set_java").setLabel("⚙ Settings").setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId("tech_java").setLabel("🛠 Technical").setStyle(ButtonStyle.Secondary)
            )
        ];
    }
}

// ----------------- INTERACTION HANDLER -----------------

client.on(Events.InteractionCreate, async (i) => {
    if (i.guildId && !ALLOWED_GUILDS.includes(i.guildId)) return;
    
    const uid = i.user.id;

    try {
        if (i.isChatInputCommand()) {
            if (i.commandName === "panel") return i.reply({ content: "**Bedrock Bot Panel 🤖**", components: getPanel('bedrock') });
            if (i.commandName === "java") return i.reply({ content: "**Java Bot Panel 🤖**", components: getPanel('java') });
            if (i.commandName === "admin" && uid === ADMIN_ID) {
                const data = await generateAdminData();
                adminDashboardMessage = await i.reply({ ...data, fetchReply: true });
            }
        }

        if (i.isButton()) {
            const id = i.customId;

            // PRE-FLIGHT
            if (id === "pre_bedrock" || id === "pre_java") {
                const type = id === "pre_java" ? "java" : "bedrock";
                const u = getUser(uid);
                
                const serverData = type === "java" ? u.java.server : u.server;
                if (!serverData) return i.reply({ content: "❌ **Configuration Missing!** Please click 'Settings' first.", ephemeral: true });

                const ver = type === "java" ? u.java.selectedVersion : u.bedrockVersion;
                const verRow = getVersionSelector(type, ver);
                
                let content = `**Pre-Flight Check (${type === 'java' ? 'Java' : 'Bedrock'})**\nTarget: \`${serverData.ip}:${serverData.port}\``;
                if (type === 'java') {
                    content += `\nAuth Mode: **${u.java.authType.toUpperCase()}**`;
                }
                
                const confirmRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`start_${type}`).setLabel("✅ Connect Now").setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
                );

                return i.reply({ 
                    content: content + `\n\n*Does this look correct? Select version if auto-detect fails.*`,
                    components: [verRow, confirmRow], 
                    ephemeral: true 
                });
            }

            if (id === "start_bedrock") return startBedrock(uid, i, getUser(uid).bedrockVersion || "auto");
            if (id === "start_java") return startJava(uid, i, getUser(uid).java.selectedVersion || "auto");
            
            if (id === "cancel") return i.update({ content: "❌ Cancelled.", components: [], embeds: [] });

            if (id === "stop_bedrock") {
                const s = sessions.get(uid);
                if (!s) return i.reply({ content: "❌ No Bedrock bot running.", ephemeral: true });
                s.manualStop = true;
                destroySession(uid, 'bedrock');
                return i.reply({ content: "⏹ **Stopping Bedrock Bot...**", ephemeral: true });
            }
            if (id === "stop_java") {
                const s = javaSessions.get(uid);
                if (!s) return i.reply({ content: "❌ No Java bot running.", ephemeral: true });
                s.manualStop = true;
                destroySession(uid, 'java');
                return i.reply({ content: "⏹ **Stopping Java Bot...**", ephemeral: true });
            }

            if (id === "set_bedrock") {
                const u = getUser(uid);
                const m = new ModalBuilder().setCustomId("modal_bedrock").setTitle("Bedrock Settings");
                const ip = new TextInputBuilder().setCustomId("ip").setLabel("IP").setStyle(TextInputStyle.Short).setValue(u.server?.ip || "").setRequired(true);
                const port = new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.server?.port || 19132));
                const user = new TextInputBuilder().setCustomId("off").setLabel("Offline Username").setStyle(TextInputStyle.Short).setValue(u.offlineUsername || "");
                m.addComponents(new ActionRowBuilder().addComponents(ip), new ActionRowBuilder().addComponents(port), new ActionRowBuilder().addComponents(user));
                return i.showModal(m);
            }
            if (id === "set_java") {
                const u = getUser(uid);
                const m = new ModalBuilder().setCustomId("modal_java").setTitle("Java Settings");
                const ip = new TextInputBuilder().setCustomId("ip").setLabel("IP").setStyle(TextInputStyle.Short).setValue(u.java.server?.ip || "").setRequired(true);
                const port = new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.java.server?.port || 25565));
                const user = new TextInputBuilder().setCustomId("user").setLabel("Username (For Offline/Cracked)").setStyle(TextInputStyle.Short).setValue(u.java.offlineUsername || "");
                m.addComponents(new ActionRowBuilder().addComponents(ip), new ActionRowBuilder().addComponents(port), new ActionRowBuilder().addComponents(user));
                return i.showModal(m);
            }

            if (id === "link") return handleLink(uid, i);
            if (id === "unlink") { unlinkMicrosoft(uid); return i.reply({ content: "🗑 Unlinked.", ephemeral: true }); }
            
            if (id === "tech_bedrock") return i.reply({ content: "🛠 **Bedrock Technical**", components: [getTechMenu('bedrock')], ephemeral: true });
            if (id === "tech_java") return i.reply({ content: "🛠 **Java Technical**", components: [getTechMenu('java')], ephemeral: true });
            
            if (id === "admin_refresh" && uid === ADMIN_ID) {
                i.deferUpdate();
                updateAdminDashboard();
            }

            // --- TOGGLE JAVA AUTH ---
            if (id === "toggle_auth") {
                const u = getUser(uid);
                u.java.authType = u.java.authType === 'microsoft' ? 'offline' : 'microsoft';
                saveDatabase();
                return i.update({ content: `✅ **Auth Mode Updated!**\nNew Mode: **${u.java.authType.toUpperCase()}**`, components: [] });
            }
        }

        if (i.isStringSelectMenu()) {
            if (i.customId === "sel_java_ver") {
                const u = getUser(uid);
                u.java.selectedVersion = i.values[0];
                saveDatabase();
                const verRow = getVersionSelector('java', i.values[0]);
                const confirmRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`start_java`).setLabel("✅ Connect Now").setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
                );
                return i.update({ components: [verRow, confirmRow] });
            }
            if (i.customId === "sel_bed_ver") {
                const u = getUser(uid);
                u.bedrockVersion = i.values[0];
                saveDatabase();
                const verRow = getVersionSelector('bedrock', i.values[0]);
                const confirmRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`start_bedrock`).setLabel("✅ Connect Now").setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
                );
                return i.update({ components: [verRow, confirmRow] });
            }
            
            if (i.customId === "act_bedrock" || i.customId === "act_java") {
                const isJava = i.customId === "act_java";
                const s = isJava ? javaSessions.get(uid) : sessions.get(uid);
                
                if (!s || !s.connected) return i.reply({ content: "❌ Bot not connected.", ephemeral: true });
                
                const val = i.values[0];
                if (val === "coords") {
                    return i.reply({ content: `📍 **Position:** (Not available in Simple Mode)`, ephemeral: true });
                }
                if (val === "reconnect") {
                    if (isJava) s.simpleClient.disconnect(); else s.client.close();
                    return i.reply({ content: "🔄 **Restarting session...**", ephemeral: true });
                }
                if (val === "cmd") {
                    const m = new ModalBuilder().setCustomId(`cmd_${isJava ? 'java' : 'bed'}`).setTitle("Send Command");
                    const inp = new TextInputBuilder().setCustomId("txt").setLabel("Command (no /)").setStyle(TextInputStyle.Short).setRequired(true);
                    m.addComponents(new ActionRowBuilder().addComponents(inp));
                    return i.showModal(m);
                }
                if (val === "map_render") {
                    return i.reply({ content: "❌ Map render is disabled in Robust Mode to save memory.", ephemeral: true });
                }
            }
        }

        if (i.isModalSubmit()) {
            if (i.customId === "modal_bedrock") {
                const u = getUser(uid);
                u.server = { ip: i.fields.getTextInputValue("ip"), port: parseInt(i.fields.getTextInputValue("port")) };
                u.offlineUsername = i.fields.getTextInputValue("off");
                saveDatabase();
                return i.reply({ content: "✅ Bedrock settings saved.", ephemeral: true });
            }
            if (i.customId === "modal_java") {
                const u = getUser(uid);
                u.java.server = { ip: i.fields.getTextInputValue("ip"), port: parseInt(i.fields.getTextInputValue("port")) };
                u.java.offlineUsername = i.fields.getTextInputValue("user");
                saveDatabase();
                
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("toggle_auth").setLabel(`Switch Auth Mode (Current: ${u.java.authType})`).setStyle(ButtonStyle.Secondary)
                );
                
                return i.reply({ content: "✅ Java settings saved.", components: [row], ephemeral: true });
            }
            if (i.customId.startsWith("cmd_")) {
                const isJava = i.customId === "cmd_java";
                const s = isJava ? javaSessions.get(uid) : sessions.get(uid);
                const cmd = i.fields.getTextInputValue("txt");
                
                if (s) {
                    if (isJava) s.simpleClient.chat(`/${cmd}`);
                    else s.client.write("command_request", { command: `/${cmd}`, origin: { type: 0, uuid: "", request_id: "", player_entity_id: undefined }, internal: false, version: 52 });
                    return i.reply({ content: `📤 Sent: /${cmd}`, ephemeral: true });
                }
                return i.reply({ content: "❌ Session lost.", ephemeral: true });
            }
        }

    } catch (err) {
        console.error("Interaction Error:", err);
    }
});

function handleLink(uid, interaction) {
    if (pendingAuth.has(uid)) return interaction.reply({ content: "⏳ Auth already pending.", ephemeral: true });
    
    const flow = new Authflow(uid, getUserAuthDir(uid), { flow: "live", authTitle: Titles.MinecraftNintendoSwitch, deviceType: "Nintendo" }, async (res) => {
        const link = res.verification_uri_complete || res.verification_uri;
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Login to Microsoft").setStyle(ButtonStyle.Link).setURL(link));
        interaction.editReply({ content: `🔐 **Code:** \`${res.user_code}\``, components: [row] }).catch(()=>{});
    });

    interaction.deferReply({ ephemeral: true });
    pendingAuth.set(uid, true);

    flow.getMsaToken().then(() => {
        const u = getUser(uid);
        u.linked = true;
        saveDatabase();
        interaction.followUp({ content: "✅ **Linked Successfully!**", ephemeral: true });
    }).catch(e => {
        interaction.followUp({ content: `❌ Auth Failed: ${e.message}`, ephemeral: true });
    }).finally(() => {
        pendingAuth.delete(uid);
    });
}

async function generateAdminData() {
    const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    const embed = new EmbedBuilder().setTitle("🛡️ Admin Panel").setColor(0xFF0000)
        .setDescription(`**RAM:** ${mem}MB | **Bedrock:** ${sessions.size} | **Java:** ${javaSessions.size}`);
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("admin_refresh").setLabel("Refresh").setStyle(ButtonStyle.Primary));
    return { embeds: [embed], components: [row] };
}
async function updateAdminDashboard() {
    if (adminDashboardMessage) adminDashboardMessage.edit(await generateAdminData()).catch(() => adminDashboardMessage = null);
}

// ----------------- STARTUP -----------------
client.once("ready", async () => {
    console.log(`🟢 Bot Online: ${client.user.tag}`);
    client.application.commands.set([
        new SlashCommandBuilder().setName("panel").setDescription("Bedrock Panel"),
        new SlashCommandBuilder().setName("java").setDescription("Java Panel"),
        new SlashCommandBuilder().setName("admin").setDescription("Admin Panel")
    ]);
});

process.on("uncaughtException", (e) => console.error("Uncaught:", e));
process.on("unhandledRejection", (e) => console.error("Unhandled:", e));

client.login(DISCORD_TOKEN);


