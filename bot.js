/**
 * AFKBot Panel 🎛️
 * Simple, clean, Bedrock-only edition.
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

// --- CONFIGURATION ---
const CONFIG = {
    TOKEN: process.env.DISCORD_TOKEN,
    ADMIN_ID: "1144987924123881564",
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

// Ensure Storage
if (!fs.existsSync(CONFIG.PATHS.DATA)) fs.mkdirSync(CONFIG.PATHS.DATA);
if (!fs.existsSync(CONFIG.PATHS.AUTH)) fs.mkdirSync(CONFIG.PATHS.AUTH, { recursive: true });

// --- DATA MANAGER ---
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

// --- BOT SESSIONS ---
const sessions = new Map();
const pendingAuth = new Set();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// --- UI GENERATOR ---
function getPanel(uid) {
    const user = getUser(uid);
    const session = sessions.get(uid);
    const isRunning = !!session;

    const embed = new EmbedBuilder()
        .setTitle("AFKBot Panel 🎛️")
        .setDescription("Control your Bedrock AFK client.")
        .setColor(0x2B2D31)
        .addFields(
            { name: "Status", value: isRunning ? "🟢 **Online**" : "🔴 **Offline**", inline: true },
            { name: "Target", value: user.ip ? `\`${user.ip}:${user.port}\`` : "Not Set", inline: true },
            { name: "Account", value: user.linked ? "✅ Linked" : "👤 Offline Name", inline: true }
        );

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("start").setLabel("Start").setStyle(ButtonStyle.Success).setDisabled(isRunning),
        new ButtonBuilder().setCustomId("stop").setLabel("Stop").setStyle(ButtonStyle.Danger).setDisabled(!isRunning),
        new ButtonBuilder().setCustomId("settings").setLabel("Settings").setStyle(ButtonStyle.Secondary).setEmoji("⚙️")
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("link").setLabel("Link Xbox").setStyle(ButtonStyle.Primary).setDisabled(user.linked),
        new ButtonBuilder().setCustomId("unlink").setLabel("Unlink").setStyle(ButtonStyle.Secondary).setDisabled(!user.linked)
    );

    return { embeds: [embed], components: [row1, row2] };
}

// --- MINECRAFT LOGIC ---

async function startBot(uid, interaction) {
    const user = getUser(uid);

    if (!user.ip) {
        return interaction.reply({ content: "❌ IP address is missing. Go to **Settings**.", ephemeral: true });
    }

    await interaction.reply({ content: `🚀 **Connecting to** \`${user.ip}:${user.port}\`...`, ephemeral: true });

    const options = {
        host: user.ip,
        port: parseInt(user.port),
        connectTimeout: 30000,
        skipPing: false,
        offline: !user.onlineMode,
        username: !user.onlineMode ? user.username : undefined,
        profilesFolder: user.onlineMode ? path.join(CONFIG.PATHS.AUTH, uid) : undefined,
        conLog: () => {} // Silent
    };

    try {
        const bedrockClient = bedrock.createClient(options);
        
        const session = {
            client: bedrockClient,
            afkInt: null
        };
        sessions.set(uid, session);

        bedrockClient.on('spawn', () => {
            interaction.editReply({ content: `✅ **Connected to ${user.ip}!**` });
            
            // Simple AFK Rotation
            session.afkInt = setInterval(() => {
                if(bedrockClient) {
                    try {
                        const yaw = (Date.now() % 360);
                        bedrockClient.write('player_auth_input', { pitch:0, yaw:yaw, position:{x:0,y:0,z:0}, input_mode:'mouse' });
                    } catch(e){}
                }
            }, 10000);
        });

        bedrockClient.on('error', (e) => {
            interaction.editReply({ content: `❌ **Error:** ${e.message}` });
            stopBot(uid);
        });

        bedrockClient.on('close', () => {
            stopBot(uid);
        });

    } catch (e) {
        interaction.editReply({ content: `❌ **Init Error:** ${e.message}` });
    }
}

function stopBot(uid) {
    const session = sessions.get(uid);
    if (session) {
        if (session.afkInt) clearInterval(session.afkInt);
        try { session.client.close(); } catch(e){}
        sessions.delete(uid);
    }
}

// --- DISCORD EVENTS ---

client.once(Events.ClientReady, () => {
    console.log(`Bot Online: ${client.user.tag}`);
    client.application.commands.set([
        new SlashCommandBuilder().setName("panel").setDescription("Open AFKBot Panel")
    ]);
});

client.on(Events.InteractionCreate, async (i) => {
    const uid = i.user.id;

    try {
        // Command
        if (i.isChatInputCommand() && i.commandName === "panel") {
            return i.reply(getPanel(uid));
        }

        // Buttons
        if (i.isButton()) {
            if (i.customId === "start") return startBot(uid, i);
            
            if (i.customId === "stop") {
                stopBot(uid);
                return i.reply({ content: "⏹ **Bot Stopped.**", ephemeral: true });
            }

            if (i.customId === "settings") {
                const u = getUser(uid);
                const modal = new ModalBuilder().setCustomId("settings_modal").setTitle("Settings");
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("Server IP").setStyle(TextInputStyle.Short).setValue(u.ip || "").setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.port)).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("user").setLabel("Offline Username").setStyle(TextInputStyle.Short).setValue(u.username).setRequired(true))
                );
                return i.showModal(modal);
            }

            if (i.customId === "link") return handleLink(uid, i);
            
            if (i.customId === "unlink") {
                const u = getUser(uid);
                u.linked = false;
                u.onlineMode = false;
                saveUsers();
                // Refresh panel
                return i.reply({ content: "✅ Unlinked.", ephemeral: true });
            }
        }

        // Modals
        if (i.isModalSubmit() && i.customId === "settings_modal") {
            const u = getUser(uid);
            u.ip = i.fields.getTextInputValue("ip");
            u.port = i.fields.getTextInputValue("port");
            u.username = i.fields.getTextInputValue("user");
            saveUsers();
            return i.reply({ content: "✅ **Settings Saved!**", ephemeral: true });
        }

    } catch (e) {
        console.error(e);
    }
});

// Auth Logic
async function handleLink(uid, i) {
    if (pendingAuth.has(uid)) return i.reply({ content: "Auth already open.", ephemeral: true });
    
    await i.deferReply({ ephemeral: true });
    pendingAuth.add(uid);

    const flow = new Authflow(uid, path.join(CONFIG.PATHS.AUTH, uid), { 
        flow: "live", authTitle: Titles.MinecraftNintendoSwitch, deviceType: "Nintendo" 
    }, async (res) => {
        i.editReply({ 
            content: `**1.** Click: [Login to Microsoft](${res.verification_uri_complete})\n**2.** Code: \`${res.user_code}\`\n**3.** Wait here.` 
        });
    });

    try {
        await flow.getMsaToken();
        const u = getUser(uid);
        u.linked = true;
        u.onlineMode = true;
        saveUsers();
        i.followUp({ content: "✅ **Success!** Account linked.", ephemeral: true });
    } catch(e) {
        i.followUp({ content: "❌ Auth Failed.", ephemeral: true });
    } finally {
        pendingAuth.delete(uid);
    }
}

client.login(CONFIG.TOKEN);


