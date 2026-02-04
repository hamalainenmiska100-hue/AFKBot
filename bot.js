/**
 * DM-ONLY MINECRAFT CLIENT CONTROLLER
 * Operates exclusively in Direct Messages.
 */

const {
    Client,
    GatewayIntentBits,
    Partials,
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

// ==========================================
// 1. CONFIGURATION
// ==========================================

const CONFIG = {
    TOKEN: process.env.DISCORD_TOKEN,
    ADMIN_ID: "1144987924123881564", 
    SETUP_GUILD: "1462335230345089254", // Server where /setup works
    PATHS: {
        DATA: path.join(__dirname, "data"),
        AUTH: path.join(__dirname, "data", "auth"),
        USERS: path.join(__dirname, "data", "users.json")
    }
};

if (!CONFIG.TOKEN) {
    console.error("Error: DISCORD_TOKEN is missing.");
    process.exit(1);
}

// Ensure Storage
if (!fs.existsSync(CONFIG.PATHS.DATA)) fs.mkdirSync(CONFIG.PATHS.DATA);
if (!fs.existsSync(CONFIG.PATHS.AUTH)) fs.mkdirSync(CONFIG.PATHS.AUTH, { recursive: true });

// ==========================================
// 2. DATA STORAGE
// ==========================================

class DataManager {
    constructor() {
        this.users = {};
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(CONFIG.PATHS.USERS)) {
                this.users = JSON.parse(fs.readFileSync(CONFIG.PATHS.USERS, "utf8"));
            }
        } catch (e) { this.users = {}; }
    }

    save() {
        fs.writeFile(CONFIG.PATHS.USERS, JSON.stringify(this.users, null, 2), () => {});
    }

    getUser(uid) {
        if (!this.users[uid]) this.users[uid] = {};
        const u = this.users[uid];

        // Ensure defaults
        if (!u.bedrock) u.bedrock = { ip: null, port: 19132, username: `Bot_${uid.slice(-4)}` };
        if (!u.java) u.java = { ip: null, port: 19132, username: `Java_${uid.slice(-4)}` };
        if (!u.settings) u.settings = { version: 'auto', connectionType: 'offline' };
        
        return u;
    }
}

const DB = new DataManager();

// ==========================================
// 3. MINECRAFT CLIENT ENGINE
// ==========================================

class MinecraftClient {
    constructor(uid, type, interaction) {
        this.uid = uid;
        this.type = type; // 'bedrock' or 'java'
        this.interaction = interaction;
        this.client = null;
        this.afkInterval = null;
        this.connected = false;
    }

    async connect() {
        const user = DB.getUser(this.uid);
        const config = this.type === 'java' ? user.java : user.bedrock;
        const settings = user.settings;

        if (!config.ip) {
            return this.updateUI("❌ **Config Error:** Server IP is missing. Check settings.");
        }

        // Notify user
        await this.interaction.update({
            content: `⏳ **Connecting to** \`${config.ip}:${config.port}\`...`,
            embeds: [],
            components: []
        });

        const options = {
            host: config.ip,
            port: parseInt(config.port),
            connectTimeout: 30000,
            skipPing: false,
            offline: settings.connectionType === 'offline',
            username: settings.connectionType === 'offline' ? config.username : undefined,
            profilesFolder: settings.connectionType === 'online' ? path.join(CONFIG.PATHS.AUTH, this.uid) : undefined,
            version: settings.version === 'auto' ? undefined : settings.version,
            conLog: () => {} 
        };

        if (settings.connectionType === 'online' && !user.linked) {
            return this.updateUI("❌ **Auth Error:** Microsoft account not linked.");
        }

        try {
            this.client = bedrock.createClient(options);
            this.handleEvents();
        } catch (e) {
            this.updateUI(`❌ **Init Error:** ${e.message}`);
            SessionManager.remove(this.uid);
        }
    }

    handleEvents() {
        this.client.on('spawn', () => {
            this.connected = true;
            this.startAFK();
            
            const embed = new EmbedBuilder()
                .setTitle("🟢 Connected")
                .setDescription(`**Host:** ${this.client.options.host}\n**Protocol:** ${this.type.toUpperCase()}`)
                .setColor(0x57F287);

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId("disconnect").setLabel("Disconnect").setStyle(ButtonStyle.Danger).setEmoji("🔌"),
                new ButtonBuilder().setCustomId("send_cmd").setLabel("Command").setStyle(ButtonStyle.Secondary).setEmoji("⌨️")
            );

            this.interaction.editReply({ content: "", embeds: [embed], components: [row] }).catch(()=>{});
        });

        this.client.on('close', () => {
            if (this.connected) this.updateUI("⚠️ **Disconnected from server.**");
            this.cleanup();
        });

        this.client.on('error', (err) => {
            if (!this.connected) {
                this.updateUI(`❌ **Connection Failed:** ${err.message}`);
                this.cleanup();
            }
        });

        this.client.on('kick', (p) => {
            this.updateUI(`🛑 **Kicked:** ${p.message || 'Unknown reason'}`);
            this.cleanup();
        });
    }

    startAFK() {
        this.afkInterval = setInterval(() => {
            if (this.client) {
                try {
                    const yaw = (Date.now() % 360);
                    this.client.write('player_auth_input', {
                        pitch: 0, yaw: yaw, head_yaw: yaw,
                        position: { x: 0, y: 0, z: 0 },
                        move_vector: { x: 0, z: 0 },
                        input_data: { _value: 0n },
                        input_mode: 'mouse', play_mode: 'normal', tick: 0n, delta: { x: 0, y: 0, z: 0 }
                    });
                } catch (e) {}
            }
        }, 15000);
    }

    sendChat(msg) {
        if (this.client && this.connected) {
            this.client.write('text', {
                type: 'chat',
                needs_translation: false,
                source_name: this.client.username,
                xuid: '',
                message: msg
            });
        }
    }

    updateUI(msg) {
        this.interaction.editReply({ content: msg, embeds: [], components: [] }).catch(()=>{});
    }

    cleanup() {
        if (this.afkInterval) clearInterval(this.afkInterval);
        if (this.client) {
            try { this.client.close(); } catch(e){}
            this.client.removeAllListeners();
            this.client = null;
        }
        this.connected = false;
        SessionManager.remove(this.uid);
    }
}

// ==========================================
// 4. SESSION MANAGER
// ==========================================

class SessionManager {
    static sessions = new Map();

    static start(uid, type, interaction) {
        if (this.sessions.has(uid)) {
            interaction.reply({ content: "❌ You already have a session active.", ephemeral: true });
            return;
        }
        const session = new MinecraftClient(uid, type, interaction);
        this.sessions.set(uid, session);
        session.connect();
    }

    static stop(uid) {
        const s = this.sessions.get(uid);
        if (s) {
            s.updateUI("⏹ **Stopped by user.**");
            s.cleanup();
        }
    }

    static remove(uid) {
        this.sessions.delete(uid);
    }

    static get(uid) {
        return this.sessions.get(uid);
    }
}

// ==========================================
// 5. DISCORD LOGIC
// ==========================================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel, Partials.Message]
});

// --- UI HELPERS ---

function getMainMenuPayload() {
    const embed = new EmbedBuilder()
        .setTitle("Minecraft Control Panel")
        .setDescription("Select a protocol to start. This bot only works in DMs.")
        .setColor(0x2B2D31);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("start_bedrock").setLabel("Bedrock").setStyle(ButtonStyle.Primary).setEmoji("🧱"),
        new ButtonBuilder().setCustomId("start_java").setLabel("Java (Geyser)").setStyle(ButtonStyle.Success).setEmoji("☕"),
        new ButtonBuilder().setCustomId("settings").setLabel("Settings").setStyle(ButtonStyle.Secondary).setEmoji("⚙️")
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("link_account").setLabel("Link Microsoft").setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [row, row2] };
}

// --- EVENTS ---

client.on(Events.ClientReady, () => {
    console.log(`Bot Active: ${client.user.tag}`);
    client.application.commands.set([
        new SlashCommandBuilder().setName("panel").setDescription("Open Control Panel"),
        new SlashCommandBuilder().setName("setup").setDescription("Show Setup Message (Specific Server Only)")
    ]);
});

// 1. DM HANDLER
client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot) return;
    if (!msg.guild) {
        await msg.reply(getMainMenuPayload());
    }
});

// 2. INTERACTION HANDLER
client.on(Events.InteractionCreate, async (i) => {
    const uid = i.user.id;

    // --- GUILD HANDLING ---
    if (i.guildId) {
        // Special logic for the Setup Guild
        if (i.guildId === CONFIG.SETUP_GUILD) {
            
            // /setup Command
            if (i.isChatInputCommand() && i.commandName === "setup") {
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("trigger_dm").setLabel("Open a DM").setStyle(ButtonStyle.Primary).setEmoji("📩")
                );
                return i.reply({ content: "📢 **We've moved to DM only system.**", components: [row] });
            }

            // Open DM Button
            if (i.isButton() && i.customId === "trigger_dm") {
                try {
                    await i.user.send(getMainMenuPayload());
                    return i.reply({ content: "✅ **DM Opened!** Check your Direct Messages tab.", ephemeral: true });
                } catch (e) {
                    return i.reply({ content: "❌ **Could not DM you.** Please check your privacy settings.", ephemeral: true });
                }
            }
        }

        // Reject everything else in guilds
        return i.reply({ content: "⛔ **This bot operates in DMs only.**", ephemeral: true });
    }

    // --- DM HANDLING ---
    try {
        if (i.isChatInputCommand() && i.commandName === "panel") {
            return i.reply(getMainMenuPayload());
        }

        if (i.isButton()) {
            const id = i.customId;

            if (id === "start_bedrock" || id === "start_java") {
                const type = id.split("_")[1];
                const u = DB.getUser(uid);
                const conf = type === 'java' ? u.java : u.bedrock;

                const embed = new EmbedBuilder()
                    .setTitle(`${type === 'java' ? 'Java' : 'Bedrock'} Launcher`)
                    .setDescription(`**Target:** \`${conf.ip || 'Not Set'}:${conf.port}\`\n**User:** \`${conf.username}\`\n\nClick Launch to connect.`)
                    .setColor(0x5865F2);

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`launch_${type}`).setLabel("Launch").setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
                );

                return i.reply({ embeds: [embed], components: [row], ephemeral: true });
            }

            if (id.startsWith("launch_")) {
                const type = id.split("_")[1];
                await i.deferUpdate(); 
                SessionManager.start(uid, type, i);
                return;
            }

            if (id === "settings") {
                const u = DB.getUser(uid);
                const modal = new ModalBuilder().setCustomId("settings_modal").setTitle("Configuration");
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("b_ip").setLabel("Bedrock IP").setStyle(TextInputStyle.Short).setValue(u.bedrock.ip || "").setRequired(false)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("j_ip").setLabel("Java IP").setStyle(TextInputStyle.Short).setValue(u.java.ip || "").setRequired(false)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("user").setLabel("Offline Username").setStyle(TextInputStyle.Short).setValue(u.bedrock.username).setRequired(true))
                );
                return i.showModal(modal);
            }

            if (id === "disconnect") {
                i.deferUpdate();
                SessionManager.stop(uid);
            }

            if (id === "send_cmd") {
                const modal = new ModalBuilder().setCustomId("cmd_modal").setTitle("Send Command");
                modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("cmd_text").setLabel("Command (no /)").setStyle(TextInputStyle.Short).setRequired(true)));
                return i.showModal(modal);
            }

            if (id === "link_account") return handleAuth(uid, i);
            if (id === "cancel") return i.update({ content: "Cancelled.", embeds: [], components: [] });
        }

        if (i.isModalSubmit()) {
            if (i.customId === "settings_modal") {
                const u = DB.getUser(uid);
                u.bedrock.ip = i.fields.getTextInputValue("b_ip");
                u.java.ip = i.fields.getTextInputValue("j_ip");
                const name = i.fields.getTextInputValue("user");
                u.bedrock.username = name;
                u.java.username = name;
                DB.save();
                return i.reply({ content: "✅ Settings saved.", ephemeral: true });
            }

            if (i.customId === "cmd_modal") {
                const s = SessionManager.get(uid);
                if (s && s.connected) {
                    const cmd = i.fields.getTextInputValue("cmd_text");
                    s.sendChat(`/${cmd}`);
                    return i.reply({ content: `📤 Sent: /${cmd}`, ephemeral: true });
                }
                return i.reply({ content: "❌ Not connected.", ephemeral: true });
            }
        }

    } catch (err) {
        console.error("Interaction Error:", err);
    }
});

// --- AUTH ---
const pendingAuth = new Map();

function handleAuth(uid, interaction) {
    if (pendingAuth.has(uid)) return interaction.reply({ content: "Auth pending.", ephemeral: true });
    
    const flow = new Authflow(uid, path.join(CONFIG.PATHS.AUTH, uid), { 
        flow: "live", 
        authTitle: Titles.MinecraftNintendoSwitch, 
        deviceType: "Nintendo" 
    }, async (res) => {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel("Login").setStyle(ButtonStyle.Link).setURL(res.verification_uri_complete || res.verification_uri)
        );
        interaction.editReply({ content: `**Code:** \`${res.user_code}\``, components: [row] }).catch(()=>{});
    });

    interaction.deferReply({ ephemeral: true });
    pendingAuth.set(uid, true);

    flow.getMsaToken().then(() => {
        const u = DB.getUser(uid);
        u.settings.connectionType = 'online';
        u.linked = true;
        DB.save();
        interaction.followUp({ content: "✅ Account linked!", ephemeral: true });
    }).catch(e => {
        interaction.followUp({ content: `❌ Failed: ${e.message}`, ephemeral: true });
    }).finally(() => {
        pendingAuth.delete(uid);
    });
}

client.login(CONFIG.TOKEN);


