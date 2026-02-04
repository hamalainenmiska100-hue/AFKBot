/**
 * ULTIMATE MINECRAFT COMPANION
 * Version: 6.0 (Social & Server Browser Edition)
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
    SETUP_GUILD: "1462335230345089254",
    PATHS: {
        DATA: path.join(__dirname, "data"),
        AUTH: path.join(__dirname, "data", "auth"),
        DB: path.join(__dirname, "data", "database.json")
    }
};

if (!CONFIG.TOKEN) process.exit(1);

if (!fs.existsSync(CONFIG.PATHS.DATA)) fs.mkdirSync(CONFIG.PATHS.DATA);
if (!fs.existsSync(CONFIG.PATHS.AUTH)) fs.mkdirSync(CONFIG.PATHS.AUTH, { recursive: true });

// ==========================================
// 2. DATA STORAGE
// ==========================================

class Database {
    constructor() {
        this.data = { users: {}, servers: [] };
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(CONFIG.PATHS.DB)) {
                this.data = JSON.parse(fs.readFileSync(CONFIG.PATHS.DB, "utf8"));
            }
            if (!this.data.servers) this.data.servers = [];
        } catch (e) { this.save(); }
    }

    save() {
        fs.writeFile(CONFIG.PATHS.DB, JSON.stringify(this.data, null, 2), () => {});
    }

    getUser(uid) {
        if (!this.data.users[uid]) {
            this.data.users[uid] = {
                bedrock: { ip: null, port: 19132, username: `Bot_${uid.slice(-4)}` },
                java: { ip: null, port: 19132, username: `Java_${uid.slice(-4)}` },
                settings: { version: 'auto', connectionType: 'offline' },
                linked: false
            };
            this.save();
        }
        return this.data.users[uid];
    }

    addServer(server) {
        this.data.servers.push(server);
        this.save();
    }

    getServers() {
        return this.data.servers;
    }
}

const DB = new Database();

// ==========================================
// 3. SOCIAL & MATCHMAKING SYSTEM
// ==========================================

const matchmakingQueue = new Set(); // Users waiting
const activePairs = new Map(); // uid -> partner_uid

class SocialManager {
    static joinQueue(uid, interaction) {
        if (activePairs.has(uid)) {
            return interaction.reply({ content: "❌ You are already in a chat session. Disconnect first.", ephemeral: true });
        }
        
        if (matchmakingQueue.has(uid)) {
            matchmakingQueue.delete(uid);
            return interaction.reply({ content: "🛑 Left the matchmaking queue.", ephemeral: true });
        }

        // Try match
        if (matchmakingQueue.size > 0) {
            // Match found!
            const partnerId = matchmakingQueue.values().next().value;
            matchmakingQueue.delete(partnerId);
            
            this.createPair(uid, partnerId, interaction.client);
            
            return interaction.update({ 
                content: null, 
                embeds: [new EmbedBuilder().setTitle("🎉 Partner Found!").setDescription(`You are now chatting with <@${partnerId}>.\n\nEverything you type here will be sent to them.`).setColor(0x57F287)],
                components: [this.getChatControls()]
            });
        } else {
            // No match, wait
            matchmakingQueue.add(uid);
            return interaction.update({ 
                content: null,
                embeds: [new EmbedBuilder().setTitle("🔍 Searching for players...").setDescription("Waiting for someone else to join the queue...").setColor(0xFEE75C).setThumbnail("https://media.tenor.com/On7kvXhzml4AAAAj/loading-gif.gif")],
                components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("social_cancel").setLabel("Cancel Search").setStyle(ButtonStyle.Danger))]
            });
        }
    }

    static async createPair(userA, userB, client) {
        activePairs.set(userA, userB);
        activePairs.set(userB, userA);

        const notify = async (targetId, partnerId) => {
            try {
                const u = await client.users.fetch(targetId);
                await u.send({
                    embeds: [new EmbedBuilder().setTitle("🎉 Partner Found!").setDescription(`You are connected with **<@${partnerId}>**!\n\n💬 **Chat Started:** Type logs to chat.\n🎮 **Play:** Use buttons below.`).setColor(0x57F287)],
                    components: [this.getChatControls()]
                });
            } catch(e) {}
        };

        await notify(userB, userA); // User A gets notified via interaction update
    }

    static disconnect(uid, client) {
        const partner = activePairs.get(uid);
        if (partner) {
            activePairs.delete(uid);
            activePairs.delete(partner);
            
            [uid, partner].forEach(async id => {
                try {
                    const u = await client.users.fetch(id);
                    u.send({ embeds: [new EmbedBuilder().setDescription("🛑 **Chat disconnected.**").setColor(0xED4245)] });
                } catch(e){}
            });
        }
    }

    static getChatControls() {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("game_rps").setLabel("Rock Paper Scissors").setStyle(ButtonStyle.Primary).setEmoji("✂️"),
            new ButtonBuilder().setCustomId("game_dice").setLabel("Roll Dice").setStyle(ButtonStyle.Secondary).setEmoji("🎲"),
            new ButtonBuilder().setCustomId("social_leave").setLabel("Disconnect").setStyle(ButtonStyle.Danger).setEmoji("Bye")
        );
    }

    static handleMessage(msg) {
        const partner = activePairs.get(msg.author.id);
        if (partner) {
            msg.client.users.fetch(partner).then(u => {
                u.send(`💬 **${msg.author.username}:** ${msg.content}`);
            }).catch(()=>{});
        }
    }
}

// ==========================================
// 4. MINECRAFT ENGINE (AFK)
// ==========================================

class MinecraftSession {
    constructor(uid, type, interaction) {
        this.uid = uid;
        this.type = type;
        this.interaction = interaction;
        this.client = null;
        this.afkInt = null;
    }

    async start() {
        const user = DB.getUser(this.uid);
        const conf = this.type === 'java' ? user.java : user.bedrock;
        
        if(!conf.ip) return this.interaction.editReply("❌ No IP set. Go to Config.");

        await this.interaction.editReply({ embeds: [new EmbedBuilder().setDescription(`⏳ Connecting to \`${conf.ip}\`...`).setColor(0xFEE75C)]});

        const opts = {
            host: conf.ip,
            port: parseInt(conf.port),
            offline: user.settings.connectionType === 'offline',
            username: user.settings.connectionType === 'offline' ? conf.username : undefined,
            profilesFolder: user.settings.connectionType === 'online' ? path.join(CONFIG.PATHS.AUTH, this.uid) : undefined,
            skipPing: false,
            connectTimeout: 20000,
            conLog: ()=>{}
        };

        if(user.settings.connectionType === 'online' && !user.linked) {
            return this.interaction.editReply("❌ Microsoft account not linked.");
        }

        try {
            this.client = bedrock.createClient(opts);
            this.client.on('spawn', () => {
                this.interaction.editReply({ 
                    embeds: [new EmbedBuilder().setTitle("✅ Connected & AFK").setDescription(`Connected to **${conf.ip}**\nProtocol: ${this.type.toUpperCase()}`).setColor(0x57F287)],
                    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("mc_disconnect").setLabel("Stop Bot").setStyle(ButtonStyle.Danger))]
                });
                this.afkInt = setInterval(() => {
                    if(this.client) this.client.write('player_auth_input', { pitch:0, yaw:0, position:{x:0,y:0,z:0}, input_mode:'mouse' });
                }, 15000);
            });
            this.client.on('error', (e) => this.interaction.editReply(`❌ Error: ${e.message}`));
            this.client.on('close', () => this.stop());
        } catch(e) { this.interaction.editReply(`❌ Init Error: ${e.message}`); }
    }

    stop() {
        if(this.afkInt) clearInterval(this.afkInt);
        if(this.client) { try{this.client.close();}catch(e){} }
        SessionManager.delete(this.uid);
    }
}

const SessionManager = new Map();

// ==========================================
// 5. UI GENERATORS
// ==========================================

const UI = {
    navRow(current) {
        const btns = [
            { id: "nav_home", label: "Home", emoji: "🏠" },
            { id: "nav_servers", label: "Servers", emoji: "🌐" },
            { id: "nav_social", label: "Social", emoji: "👥" },
            { id: "nav_config", label: "Config", emoji: "⚙️" }
        ];
        
        return new ActionRowBuilder().addComponents(
            btns.map(b => new ButtonBuilder()
                .setCustomId(b.id)
                .setLabel(b.label)
                .setEmoji(b.emoji)
                .setStyle(current === b.id ? ButtonStyle.Primary : ButtonStyle.Secondary)
                .setDisabled(current === b.id)
            )
        );
    },

    home(uid) {
        const user = DB.getUser(uid);
        const session = SessionManager.get(uid);
        
        const embed = new EmbedBuilder()
            .setTitle("🎮 Minecraft Companion")
            .setDescription("Welcome back! Select an action below.")
            .setColor(0x5865F2)
            .addFields(
                { name: "🤖 AFK Bot", value: session ? "🟢 **Running**" : "🔴 **Idle**", inline: true },
                { name: "🔑 Account", value: user.linked ? "✅ Linked" : "⚠️ Offline", inline: true }
            );

        const controls = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("start_bedrock").setLabel("Start Bedrock").setStyle(ButtonStyle.Success).setEmoji("🧱").setDisabled(!!session),
            new ButtonBuilder().setCustomId("start_java").setLabel("Start Java").setStyle(ButtonStyle.Success).setEmoji("☕").setDisabled(!!session),
            new ButtonBuilder().setCustomId("mc_disconnect").setLabel("Stop").setStyle(ButtonStyle.Danger).setEmoji("🛑").setDisabled(!session)
        );

        return { embeds: [embed], components: [controls, this.navRow("nav_home")] };
    },

    servers() {
        const list = DB.getServers();
        const display = list.slice(-5).map(s => `🌐 **${s.ip}:${s.port}**\n📝 *${s.desc}*`).join("\n\n") || "No servers shared yet.";

        const embed = new EmbedBuilder()
            .setTitle("🌐 Community Servers")
            .setDescription(display)
            .setColor(0x2B2D31)
            .setFooter({ text: "Share your server to see it here!" });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("share_server").setLabel("Share Server").setStyle(ButtonStyle.Success).setEmoji("Tb"),
            new ButtonBuilder().setCustomId("refresh_servers").setLabel("Refresh").setStyle(ButtonStyle.Secondary)
        );

        return { embeds: [embed], components: [row, this.navRow("nav_servers")] };
    },

    social(uid) {
        const inQueue = matchmakingQueue.has(uid);
        const chatting = activePairs.has(uid);

        const embed = new EmbedBuilder()
            .setTitle("👥 Social Hub")
            .setDescription("Find other Minecraft players, chat, and play mini-games directly in DMs.")
            .addFields(
                { name: "Status", value: chatting ? "💬 **In Chat**" : (inQueue ? "🔍 **Searching...**" : "💤 **Idle**"), inline: true },
                { name: "Online", value: `${matchmakingQueue.size} searching`, inline: true }
            )
            .setColor(0xEB459E);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("social_find").setLabel(inQueue ? "Searching..." : "Find Partner").setStyle(inQueue ? ButtonStyle.Secondary : ButtonStyle.Success).setEmoji("🔍").setDisabled(inQueue || chatting),
            new ButtonBuilder().setCustomId("social_cancel").setLabel("Cancel").setStyle(ButtonStyle.Danger).setDisabled(!inQueue)
        );

        return { embeds: [embed], components: [row, this.navRow("nav_social")] };
    },

    config(uid) {
        const user = DB.getUser(uid);
        const embed = new EmbedBuilder()
            .setTitle("⚙️ Configuration")
            .setDescription(`**Bedrock:** \`${user.bedrock.ip || 'None'}\`\n**Java:** \`${user.java.ip || 'None'}\``)
            .setColor(0x2B2D31);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("edit_config").setLabel("Edit IP/Port").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("link_ms").setLabel("Link Microsoft").setStyle(ButtonStyle.Secondary).setDisabled(user.linked),
            new ButtonBuilder().setCustomId("unlink_ms").setLabel("Unlink").setStyle(ButtonStyle.Danger).setDisabled(!user.linked)
        );

        return { embeds: [embed], components: [row, this.navRow("nav_config")] };
    }
};

// ==========================================
// 6. DISCORD LOGIC
// ==========================================

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages], partials: [Partials.Channel] });

// Message Relay
client.on(Events.MessageCreate, async (msg) => {
    if(msg.author.bot) return;
    if(!msg.guild) {
        // Chat Relay
        SocialManager.handleMessage(msg);
        // If sending panel command
        if(msg.content.toLowerCase() === "panel" || msg.content.toLowerCase() === "/panel") {
            await msg.reply(UI.home(msg.author.id));
        }
    }
});

client.on(Events.InteractionCreate, async (i) => {
    const uid = i.user.id;

    // Server Setup Command
    if(i.guildId) {
        if(i.guildId === CONFIG.SETUP_GUILD && i.commandName === "setup") {
            return i.reply({
                content: "🚀 **Launch App**",
                components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("dm_launch").setLabel("Open App").setStyle(ButtonStyle.Primary).setEmoji("📱"))]
            });
        }
        if(i.customId === "dm_launch") {
            try { await i.user.send(UI.home(uid)); i.reply({content: "✅ Check DMs!", ephemeral:true}); } 
            catch { i.reply({content: "❌ Enable DMs!", ephemeral:true}); }
            return;
        }
        return i.reply({content:"⛔ DMs only.", ephemeral:true});
    }

    try {
        if(i.isChatInputCommand()) {
            if(i.commandName === "panel") i.reply(UI.home(uid));
        }

        if(i.isButton()) {
            // NAV
            if(i.customId === "nav_home") i.update(UI.home(uid));
            if(i.customId === "nav_servers") i.update(UI.servers());
            if(i.customId === "nav_social") i.update(UI.social(uid));
            if(i.customId === "nav_config") i.update(UI.config(uid));

            // ACTIONS
            if(i.customId.startsWith("start_")) {
                const type = i.customId.split("_")[1];
                await i.deferReply();
                const session = new MinecraftSession(uid, type, i);
                SessionManager.set(uid, session);
                session.start();
            }
            if(i.customId === "mc_disconnect") {
                const s = SessionManager.get(uid);
                if(s) s.stop();
                i.update(UI.home(uid));
            }

            // CONFIG
            if(i.customId === "edit_config") {
                const m = new ModalBuilder().setCustomId("conf_modal").setTitle("Config");
                m.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("IP").setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setValue("19132")),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("user").setLabel("Username").setStyle(TextInputStyle.Short).setRequired(true))
                );
                i.showModal(m);
            }
            if(i.customId === "link_ms") handleAuth(uid, i);
            if(i.customId === "unlink_ms") {
                const u = DB.getUser(uid); u.linked = false; u.settings.connectionType='offline'; DB.save();
                i.update(UI.config(uid));
            }

            // SERVERS
            if(i.customId === "share_server") {
                const m = new ModalBuilder().setCustomId("share_modal").setTitle("Share Server");
                m.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("s_ip").setLabel("IP:Port").setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("s_desc").setLabel("Description").setStyle(TextInputStyle.Paragraph).setRequired(true))
                );
                i.showModal(m);
            }
            if(i.customId === "refresh_servers") i.update(UI.servers());

            // SOCIAL
            if(i.customId === "social_find") SocialManager.joinQueue(uid, i);
            if(i.customId === "social_cancel") { matchmakingQueue.delete(uid); i.update(UI.social(uid)); }
            if(i.customId === "social_leave") { SocialManager.disconnect(uid, i.client); i.update(UI.social(uid)); }
            
            // GAMES
            if(i.customId === "game_rps") {
                const moves = ["Rock 🪨", "Paper 📄", "Scissors ✂️"];
                const move = moves[Math.floor(Math.random()*moves.length)];
                const partner = activePairs.get(uid);
                i.reply(`You played **${move}**!`);
                if(partner) i.client.users.cache.get(partner)?.send(`🎮 Partner played **${move}**!`);
            }
            if(i.customId === "game_dice") {
                const roll = Math.floor(Math.random()*6)+1;
                const partner = activePairs.get(uid);
                i.reply(`🎲 You rolled a **${roll}**!`);
                if(partner) i.client.users.cache.get(partner)?.send(`🎲 Partner rolled a **${roll}**!`);
            }
        }

        if(i.isModalSubmit()) {
            if(i.customId === "conf_modal") {
                const u = DB.getUser(uid);
                const ip = i.fields.getTextInputValue("ip");
                const port = i.fields.getTextInputValue("port");
                const usr = i.fields.getTextInputValue("user");
                u.bedrock = {ip,port,username:usr};
                u.java = {ip,port,username:usr};
                DB.save();
                i.update(UI.config(uid));
            }
            if(i.customId === "share_modal") {
                const raw = i.fields.getTextInputValue("s_ip").split(":");
                DB.addServer({ ip: raw[0], port: raw[1]||19132, desc: i.fields.getTextInputValue("s_desc") });
                i.update(UI.servers());
            }
        }
    } catch(e) { console.log(e); }
});

// Auth
function handleAuth(uid, i) {
    i.reply({content: "Check DMs for code.", ephemeral:true});
    new Authflow(uid, path.join(CONFIG.PATHS.AUTH, uid), { flow:"live", authTitle:Titles.MinecraftNintendoSwitch, deviceType:"Nintendo"}, async (res) => {
        i.user.send(`**Code:** \`${res.user_code}\`\n${res.verification_uri_complete}`);
    }).getMsaToken().then(() => {
        const u = DB.getUser(uid); u.linked=true; u.settings.connectionType='online'; DB.save();
        i.user.send("✅ Linked!");
    });
}

client.once('ready', () => {
    console.log("Online");
    client.application.commands.set([
        new SlashCommandBuilder().setName("panel").setDescription("App"),
        new SlashCommandBuilder().setName("setup").setDescription("Setup")
    ]);
});

client.login(CONFIG.TOKEN);


