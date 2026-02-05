/**
 * AFKBot Panel 🎛️
 * Bedrock Only | Server-Side | MOTD Check | 20s Rejoin
 * UI and logic strictly in English as requested.
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
    TextInputStyle
} = require("discord.js");

const bedrock = require("bedrock-protocol");
const { Authflow, Titles } = require("prismarine-auth");
const fs = require("fs");
const path = require("path");

// --- KONFIGURAATIO ---
const CONFIG = {
    TOKEN: process.env.DISCORD_TOKEN,
    ADMIN_ID: "1144987924123881564",
    // Sallitut palvelimet
    ALLOWED_GUILDS: ["1462335230345089254", "1468289465783943354"],
    PATHS: {
        DATA: path.join(__dirname, "data"),
        AUTH: path.join(__dirname, "data", "auth"),
        USERS: path.join(__dirname, "data", "users.json")
    }
};

if (!CONFIG.TOKEN) {
    console.error("❌ Error: DISCORD_TOKEN is missing.");
    process.exit(1);
}

// Luodaan tarvittavat kansiot
if (!fs.existsSync(CONFIG.PATHS.DATA)) fs.mkdirSync(CONFIG.PATHS.DATA);
if (!fs.existsSync(CONFIG.PATHS.AUTH)) fs.mkdirSync(CONFIG.PATHS.AUTH, { recursive: true });

// --- TIETOJEN HALLINTA ---
let users = {};
try {
    users = fs.existsSync(CONFIG.PATHS.USERS) ? JSON.parse(fs.readFileSync(CONFIG.PATHS.USERS, "utf8")) : {};
} catch (e) { users = {}; }

function saveUsers() {
    fs.writeFile(CONFIG.PATHS.USERS, JSON.stringify(users, null, 2), () => {});
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
        saveUsers();
    }
    return users[uid];
}

// --- BOT-ISTUNNOT ---
const sessions = new Map();
const pendingAuth = new Set();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// --- UI KOMPONENTIT ---
function getPanelComponents() {
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("start").setLabel("Start Client").setStyle(ButtonStyle.Success).setEmoji("▶️"),
        new ButtonBuilder().setCustomId("stop").setLabel("Stop Client").setStyle(ButtonStyle.Danger).setEmoji("⏹️"),
        new ButtonBuilder().setCustomId("settings").setLabel("Configure").setStyle(ButtonStyle.Secondary).setEmoji("⚙️")
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("link").setLabel("Link Account").setStyle(ButtonStyle.Primary).setEmoji("🔗"),
        new ButtonBuilder().setCustomId("unlink").setLabel("Unlink / Reset").setStyle(ButtonStyle.Danger).setEmoji("🧹")
    );

    return [row1, row2];
}

// --- MINECRAFT LOGIIKKA ---

async function startBot(uid, interaction = null, isReconnect = false) {
    const user = getUser(uid);

    // Tarkistetaan onko botti jo päällä (vain uudet aloitukset)
    if (!isReconnect && interaction) {
        if (sessions.has(uid)) return interaction.reply({ content: "⚠️ **Bot is already running!**", ephemeral: true });
        if (!user.ip) return interaction.reply({ content: "❌ IP missing. Click **Configure**.", ephemeral: true });
        await interaction.reply({ content: `🔍 **Checking server status...**`, ephemeral: true });
    }

    // 1. MOTD PING TARKISTUS
    try {
        await bedrock.ping({ host: user.ip, port: parseInt(user.port), skipPing: false, connectTimeout: 5000 });
    } catch (e) {
        const errorMsg = `❌ **Cannot join server!**\nTarget: \`${user.ip}:${user.port}\`\nReason: The server is offline or unreachable.`;
        if (!isReconnect && interaction) return interaction.editReply({ content: errorMsg });
        
        // Uudelleenyhdistyksessä ilmoitetaan DM:llä
        notifyUser(uid, errorMsg);
        handleDisconnect(uid); // Jatketaan yrittämistä 20s päästä
        return;
    }

    // 2. YHDISTÄMINEN
    const options = {
        host: user.ip,
        port: parseInt(user.port),
        connectTimeout: 30000,
        skipPing: true,
        offline: !user.onlineMode,
        username: !user.onlineMode ? user.username : undefined,
        profilesFolder: user.onlineMode ? path.join(CONFIG.PATHS.AUTH, uid) : undefined,
        conLog: () => {} 
    };

    try {
        if (!isReconnect && interaction) await interaction.editReply({ content: `🚀 **Connecting to** \`${user.ip}\`...` });

        const bedrockClient = bedrock.createClient(options);
        
        const session = {
            client: bedrockClient,
            afkInt: null,
            manualStop: false
        };
        sessions.set(uid, session);

        // --- EVENTIT ---

        bedrockClient.on('spawn', () => {
            const status = user.onlineMode ? "Online Account" : `Offline: ${user.username}`;
            if (!isReconnect && interaction) {
                interaction.editReply({ content: `✅ **Connected!**\n👤 User: \`${status}\`\n🌍 Server: \`${user.ip}\`` });
            } else if (isReconnect) {
                notifyUser(uid, `♻️ **Reconnected** to \`${user.ip}\`!`);
            }
            
            // AFK Pyöritys (pysyy serverillä)
            session.afkInt = setInterval(() => {
                if(bedrockClient) {
                    try {
                        const yaw = (Date.now() % 360);
                        bedrockClient.write('player_auth_input', { pitch:0, yaw:yaw, position:{x:0,y:0,z:0}, input_mode:'mouse' });
                    } catch(e){}
                }
            }, 10000);
        });

        bedrockClient.on('error', (err) => {
            console.log(`[${uid}] Error: ${err.message}`);
            // Tarkistetaan vaatiiko serveri Xbox-tunnuksen
            if (err.message.toLowerCase().includes("authentication") || err.message.toLowerCase().includes("xbl")) {
                notifyUser(uid, `⚠️ **This Server requires an Xbox account.**\nOffline bots are not allowed on \`${user.ip}\`. Please use the **Link Account** button.`);
                session.manualStop = true; // Pysäytetään automaattinen rejoin
            }
        });

        bedrockClient.on('close', () => {
            handleDisconnect(uid);
        });

    } catch (e) {
        if (!isReconnect && interaction) interaction.editReply({ content: `❌ **Init Error:** ${e.message}` });
    }
}

function handleDisconnect(uid) {
    const session = sessions.get(uid);
    if (!session) return;
    if (session.afkInt) clearInterval(session.afkInt);

    if (session.manualStop) {
        sessions.delete(uid);
    } else {
        // 20s REJOIN LOGIIKKA
        notifyUser(uid, `⚠️ **Lost connection to** \`${getUser(uid).ip}\`. Rejoining in 20 seconds...`);
        setTimeout(() => {
            if (sessions.has(uid) && !sessions.get(uid).manualStop) {
                startBot(uid, null, true);
            }
        }, 20000);
    }
}

function stopBot(uid) {
    const session = sessions.get(uid);
    if (session) {
        session.manualStop = true;
        if (session.afkInt) clearInterval(session.afkInt);
        try { session.client.close(); } catch(e){}
        sessions.delete(uid);
        return true;
    }
    return false;
}

function notifyUser(uid, msg) {
    client.users.fetch(uid).then(u => u.send(msg).catch(()=>{})).catch(()=>{});
}

// --- DISCORD TAPAHTUMAT ---

client.once(Events.ClientReady, () => {
    console.log(`🟢 AFKBot Online: ${client.user.tag}`);
    client.application.commands.set([
        new SlashCommandBuilder().setName("panel").setDescription("Open AFKBot Panel")
    ]);
});

client.on(Events.InteractionCreate, async (i) => {
    const uid = i.user.id;

    try {
        // Slash Komento (Vain palvelimilla)
        if (i.isChatInputCommand() && i.commandName === "panel") {
            if (!i.guildId) return i.reply({ content: "This command must be used in a server.", ephemeral: true });
            if (!CONFIG.ALLOWED_GUILDS.includes(i.guildId)) return i.reply({ content: "⛔ This server is not authorized.", ephemeral: true });
            
            return i.reply({ content: "AFKBot Panel 🎛️", components: getPanelComponents() });
        }

        // Napit
        if (i.isButton()) {
            if (i.customId === "start") return startBot(uid, i, false);
            
            if (i.customId === "stop") {
                const stopped = stopBot(uid);
                return i.reply({ content: stopped ? "⏹ **Bot Stopped.** Auto-rejoin disabled." : "⚠️ **No bot running.**", ephemeral: true });
            }

            if (i.customId === "settings") {
                const u = getUser(uid);
                const modal = new ModalBuilder().setCustomId("settings_modal").setTitle("Bot Configuration");
                
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("Server IP").setStyle(TextInputStyle.Short).setValue(u.ip || "").setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.port)).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("user").setLabel("Offline Username").setStyle(TextInputStyle.Short).setValue(u.username).setRequired(true))
                );
                return i.showModal(modal);
            }

            if (i.customId === "link") return handleAuth(uid, i);
            
            if (i.customId === "unlink") {
                const u = getUser(uid);
                u.linked = false;
                u.onlineMode = false;
                saveUsers();

                const authPath = path.join(CONFIG.PATHS.AUTH, uid);
                try {
                    if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });
                } catch(e) {}

                return i.reply({ content: "🗑️ **Unlinked!** Tokens deleted. Joining as Offline bot now.", ephemeral: true });
            }
        }

        // Modaalit
        if (i.isModalSubmit() && i.customId === "settings_modal") {
            const u = getUser(uid);
            u.ip = i.fields.getTextInputValue("ip");
            u.port = i.fields.getTextInputValue("port");
            u.username = i.fields.getTextInputValue("user");
            saveUsers();
            return i.reply({ content: `✅ **Settings Saved!**\nTarget: \`${u.ip}:${u.port}\` (Private)`, ephemeral: true });
        }

    } catch (e) { console.error(e); }
});

// Linkityksen hallinta
async function handleAuth(uid, i) {
    if (pendingAuth.has(uid)) return i.reply({ content: "Auth already in progress.", ephemeral: true });
    
    await i.deferReply({ ephemeral: true });
    pendingAuth.add(uid);

    // Siivotaan vanhat tiedostot ennen uutta linkitystä
    try {
        const authPath = path.join(CONFIG.PATHS.AUTH, uid);
        if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });
    } catch(e) {}

    const flow = new Authflow(uid, path.join(CONFIG.PATHS.AUTH, uid), { 
        flow: "live", authTitle: Titles.MinecraftNintendoSwitch, deviceType: "Nintendo" 
    }, async (res) => {
        const link = res.verification_uri_complete || res.verification_uri || "https://microsoft.com/link";
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel("Login to Microsoft").setStyle(ButtonStyle.Link).setURL(link)
        );

        i.editReply({ 
            content: `**Action Required:**\n1. Click button below.\n2. Enter code: \`${res.user_code}\`\n3. Wait here...`,
            components: [row]
        });
    });

    try {
        await flow.getMsaToken();
        const u = getUser(uid);
        u.linked = true;
        u.onlineMode = true;
        saveUsers();
        i.followUp({ content: "✅ **Success!** Bot will now join using your Xbox account.", ephemeral: true });
    } catch(e) {
        i.followUp({ content: "❌ **Auth Failed:** " + e.message, ephemeral: true });
    } finally {
        pendingAuth.delete(uid);
    }
}

client.login(CONFIG.TOKEN);

