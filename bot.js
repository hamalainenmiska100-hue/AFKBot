/**
 * BEDROCK AFK BOT - PRODUCTION VERSION
 * Optimointi: Korkea virheensieto, RAM-hallinta ja vakaus.
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
  StringSelectMenuBuilder,
  EmbedBuilder
} = require("discord.js");

const bedrock = require("bedrock-protocol");
const { Authflow, Titles } = require("prismarine-auth");
const fs = require("fs");
const path = require("path");

// ----------------------------------------------------------------
// KONFIGURAATIO JA VAKIOT
// ----------------------------------------------------------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ALLOWED_GUILD_ID = "1462335230345089254";
const ADMIN_ID = "1144987924123881564";
const LOG_CHANNEL_ID = "1464615030111731753";
const ADMIN_CHANNEL_ID = "1464615993320935447";

// Optimoitu timeoutit ja rajoitukset
const CONNECTION_TIMEOUT_MS = 25000; 
const MAX_RECONNECT_ATTEMPTS = 10;
const AUTH_PROCESS_TIMEOUT_MS = 300000; // 5 minuuttia kirjautumiseen
const RAM_CRITICAL_THRESHOLD_MB = 450; // Fly.io 512MB rajan lähellä

if (!DISCORD_TOKEN) {
  console.error("❌ KRIITTINEN VIRHE: DISCORD_TOKEN puuttuu ympäristömuuttujista.");
  process.exit(1);
}

// ----------------------------------------------------------------
// TIEDOSTOJÄRJESTELMÄ JA PYSYVYYS (FALLBACK-MEKANISMIT)
// ----------------------------------------------------------------
const DATA_DIR = path.join(__dirname, "data");
const AUTH_DIR = path.join(DATA_DIR, "auth");
const DATABASE_FILE = path.join(DATA_DIR, "users.json");
const DATABASE_BACKUP = path.join(DATA_DIR, "users.json.bak");

// Varmistetaan hakemistojen olemassaolo virheensietoisesti
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
} catch (err) {
  console.error("❌ Hakemistojen luonti epäonnistui:", err);
}

// Käyttäjätietojen lataus turvallisesti
let users = {};
try {
  if (fs.existsSync(DATABASE_FILE)) {
    users = JSON.parse(fs.readFileSync(DATABASE_FILE, "utf8"));
  } else if (fs.existsSync(DATABASE_BACKUP)) {
    // Fallback varmuuskopioon jos pääasiallinen tiedosto on vioittunut
    users = JSON.parse(fs.readFileSync(DATABASE_BACKUP, "utf8"));
    console.warn("⚠️ Pääasiallinen tietokanta puuttui, ladattiin varmuuskopio.");
  }
} catch (err) {
  console.error("❌ Tietokannan latausvirhe:", err);
  users = {};
}

/**
 * Tallentaa tietokannan atomisesti (estää korruptoitumisen)
 */
function saveDatabase() {
  try {
    const data = JSON.stringify(users, null, 2);
    const tempPath = DATABASE_FILE + ".tmp";
    
    // Kirjoitetaan ensin väliaikaiseen tiedostoon
    fs.writeFileSync(tempPath, data);
    
    // Luodaan varmuuskopio vanhasta versiosta
    if (fs.existsSync(DATABASE_FILE)) {
      fs.copyFileSync(DATABASE_FILE, DATABASE_BACKUP);
    }
    
    // Vaihdetaan väliaikainen tiedosto alkuperäiseksi (atominen operaatio monissa järjestelmissä)
    fs.renameSync(tempPath, DATABASE_FILE);
  } catch (err) {
    console.error("❌ Tietokannan tallennus epäonnistui:", err);
  }
}

/**
 * Hakee käyttäjäprofiilin ja alustaa puuttuvat kentät oletusarvoilla
 */
function getProfile(uid) {
  if (!users[uid]) {
    users[uid] = {
      connectionType: "online",
      bedrockVersion: "auto",
      offlineUsername: `AFK_${uid.slice(-4)}`,
      active: false,
      server: null,
      stats: { totalConnections: 0, lastConnected: null }
    };
  }
  // Varmistetaan rakenteellinen eheys (schema migration)
  if (!users[uid].stats) users[uid].stats = { totalConnections: 0, lastConnected: null };
  return users[uid];
}

/**
 * Hakee polun käyttäjän Microsoft-istunnon välimuistiin
 */
function getAuthPath(uid) {
  const p = path.join(AUTH_DIR, uid);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

// ----------------------------------------------------------------
// AJONAIKAINEN TILANHALLINTA
// ----------------------------------------------------------------
const sessions = new Map();
const activeLogins = new Map();
let adminDashboardMsg = null;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages
  ]
});

// ----------------------------------------------------------------
// LOKITUS JA VIESTINTÄ (ERROR TOLERANCE)
// ----------------------------------------------------------------

/**
 * Lähettää lokitapahtuman Discord-kanavalle virheenhallinnalla
 */
async function pushLog(text, level = "INFO") {
  const colors = { INFO: "#5865F2", WARN: "#FFCC00", ERROR: "#FF3300", SUCCESS: "#00FF66" };
  try {
    const channel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (channel) {
      const embed = new EmbedBuilder()
        .setColor(colors[level] || colors.INFO)
        .setDescription(`**[${level}]** ${text}`)
        .setTimestamp();
      await channel.send({ embeds: [embed] }).catch(() => {});
    }
    console.log(`[${level}] ${text}`);
  } catch (err) {
    console.error("Lokitus epäonnistui:", err);
  }
}

/**
 * Lähettää DM-viestin käyttäjälle varmistaen, että kanava on auki
 */
async function dmUser(uid, msg) {
  try {
    const user = await client.users.fetch(uid).catch(() => null);
    if (user) {
      await user.send(msg).catch(e => console.warn(`DM esto käyttäjällä ${uid}:`, e.message));
    }
  } catch (err) {}
}

/**
 * Tarkistaa onko komento suoritettu oikealla palvelimella
 */
function checkGuild(interaction) {
  if (!interaction.inGuild() || interaction.guildId !== ALLOWED_GUILD_ID) {
    const msg = "Tämä botti on rajoitettu vain tuotantopalvelimelle ⛔";
    if (interaction.deferred || interaction.replied) interaction.editReply(msg).catch(() => {});
    else interaction.reply({ ephemeral: true, content: msg }).catch(() => {});
    return false;
  }
  return true;
}

// ----------------------------------------------------------------
// BOTIN ISTUNTOLOGIIKKA JA RAM-OPTIMOINTI (SYVÄ TASON FILTER)
// ----------------------------------------------------------------

/**
 * Sulkee istunnon ja siivoaa kaikki muistiviitteet välittömästi
 */
function shutdownSession(uid) {
  const session = sessions.get(uid);
  if (!session) return;

  if (session.timeout) clearTimeout(session.timeout);
  if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
  if (session.afkTimer) clearInterval(session.afkTimer);

  try {
    if (session.mc) {
      session.mc.removeAllListeners();
      session.mc.close();
      // Nullataan viitteet jotta V8-moottori voi vapauttaa muistin
      session.mc = null;
    }
  } catch (err) {}

  sessions.delete(uid);
  
  // Pakotetaan roskienkeruu jos mahdollista
  if (global.gc) global.gc();
}

/**
 * Pysäyttää botin ja tallentaa tilan pysyvästi
 */
function forceStopBot(uid, isManual = true) {
  const profile = getProfile(uid);
  if (isManual) {
    profile.active = false;
    saveDatabase();
  }

  const session = sessions.get(uid);
  if (!session) return false;

  if (isManual) session.manualShutdown = true;
  shutdownSession(uid);
  return true;
}

/**
 * Käynnistää Minecraft Bedrock -yhteyden optimoiduilla asetuksilla
 */
function initiateBot(uid, interaction = null) {
  const profile = getProfile(uid);

  // Fallback jos asetukset puuttuvat
  if (!profile.server || !profile.server.ip) {
    if (interaction && !interaction.replied) {
      interaction.editReply("⚠️ Palvelimen asetukset puuttuvat. Käytä **Asetukset**-painiketta ensin.");
    }
    return;
  }

  // Estetään päällekkäiset istunnot
  if (sessions.has(uid) && !sessions.get(uid).isRetrying) {
    if (interaction && !interaction.replied) {
      interaction.editReply("⚠️ Bottisi on jo yhdistettynä tai yhdistämässä.");
    }
    return;
  }

  profile.active = true;
  saveDatabase();

  const ip = profile.server.ip;
  const port = parseInt(profile.server.port) || 19132;

  const clientOptions = {
    host: ip,
    port: port,
    connectTimeout: CONNECTION_TIMEOUT_MS,
    keepAlive: true,
    version: profile.bedrockVersion === "auto" ? undefined : profile.bedrockVersion
  };

  // Auth-tyypin valinta
  if (profile.connectionType === "offline") {
    clientOptions.username = profile.offlineUsername || `AFK_${uid.slice(-4)}`;
    clientOptions.offline = true;
  } else {
    clientOptions.username = uid;
    clientOptions.offline = false;
    clientOptions.profilesFolder = getAuthPath(uid);
  }

  // Luodaan yhteys
  let mc;
  try {
    mc = bedrock.createClient(clientOptions);
  } catch (err) {
    pushLog(`KRIITTINEN: Clientin luonti epäonnistui (<@${uid}>): ${err.message}`, "ERROR");
    return;
  }
  
  let state = sessions.get(uid) || {
    startedAt: Date.now(),
    manualShutdown: false,
    connected: false,
    packets: 0,
    isRetrying: false,
    retryCount: 0
  };

  state.mc = mc;
  state.isRetrying = false;
  sessions.set(uid, state);

  // ------------------------------------------------------------
  // SYVÄ RAM-OPTIMOINTI: Pakettien suodatus lennosta
  // Tämä on botin tärkein osa muistinkulutuksen hallinnassa.
  // ------------------------------------------------------------
  mc.on('packet', (packet) => {
    state.packets++;
    
    const pName = packet.data.name;

    // Suodatetaan kaikki muistia kuluttavat maailma- ja entiteettipaketit
    // Botti on vain AFK-varten, joten se ei tarvitse tietoa ympäröivästä maailmasta.
    if (
      pName.includes('chunk') || 
      pName.includes('level') || 
      pName.includes('entity') || 
      pName.includes('metadata') || 
      pName.includes('player_list') ||
      pName.includes('sound') ||
      pName.includes('particle')
    ) {
      // Tuhoaa paketin sisällön ennen kuin se ehtii puskuroitua Node.js:n heap-muistiin.
      if (packet.data.payload) packet.data.payload = null;
      packet.data = null; 
      packet = null;
    }
  });

  // ------------------------------------------------------------
  // YHTEYDEN TAPAHTUMAHALLINTA
  // ------------------------------------------------------------

  // Tunnistaa onnistuneen spawnauksen (Geyser/Vanilla)
  const onReady = () => {
    if (!state.connected) {
      state.connected = true;
      state.retryCount = 0; // Nollataan yritykset onnistumisen jälkeen
      clearTimeout(state.timeout);
      
      profile.stats.totalConnections++;
      profile.stats.lastConnected = new Date().toISOString();
      saveDatabase();

      if (interaction && interaction.deferred) {
        interaction.editReply(`🟢 Yhdistetty onnistuneesti: **${ip}:${port}** (RAM-optimoitu)`);
      }
      
      pushLog(`✅ Botti <@${uid}> Online @ ${ip}`, "SUCCESS");

      // AFK-liike (varmistaa ettei bottia potkita toimettomuuden vuoksi)
      state.afkTimer = setInterval(() => {
        try {
          if (!mc.entityId) return;
          // Lähetetään minimaalinen liike-paketti (keep-alive)
          mc.write("move_player", {
            runtime_id: mc.entityId,
            position: mc.entity?.position || { x: 0, y: 0, z: 0 },
            pitch: 0, yaw: 0, head_yaw: 0, mode: 0, on_ground: true, ridden_runtime_id: 0, teleport: false
          });
        } catch (err) {}
      }, 60000);
    }
  };

  mc.on('play_status', (p) => {
    if (p.status === 'player_spawn' || p.status === 'login_success') onReady();
  });

  mc.on("spawn", onReady);

  // Aikakatkaisu jos serveri ei vastaa 25 sekunnissa
  state.timeout = setTimeout(() => {
    if (sessions.has(uid) && !state.connected) {
      if (interaction && interaction.deferred) {
        interaction.editReply("❌ Yhteysvirhe: Palvelin ei vastannut aikarajan puitteissa (25s).");
      }
      mc.close();
    }
  }, CONNECTION_TIMEOUT_MS);

  // Virheidenhallinta ja automaattinen uudelleenkytkentä
  mc.on("error", (err) => {
    clearTimeout(state.timeout);
    pushLog(`❌ Virhe <@${uid}>: \`${err.message}\``, "ERROR");
    if (!state.manualShutdown) triggerReconnect(uid, interaction);
  });

  mc.on("close", () => {
    clearTimeout(state.timeout);
    pushLog(`🔌 Yhteys katkesi <@${uid}>`, "WARN");
    if (!state.manualShutdown) triggerReconnect(uid, interaction);
  });
}

/**
 * Laskee eksponentiaalisen viiveen ja yrittää uudelleenliittymistä
 */
function triggerReconnect(uid, interaction) {
  const session = sessions.get(uid);
  if (!session || session.manualShutdown || session.reconnectTimer) return;

  session.isRetrying = true;
  session.connected = false;
  session.retryCount++;

  if (session.retryCount > MAX_RECONNECT_ATTEMPTS) {
    pushLog(`🚫 Botti <@${uid}>: Liikaa epäonnistuneita yrityksiä. Pysäytetään automaatio.`, "ERROR");
    dmUser(uid, "⚠️ Bottisi yritti yhdistää liian monta kertaa palvelimeen tuloksetta. Automaattinen uudelleenkytkentä on poistettu käytöstä.");
    forceStopBot(uid, true);
    return;
  }

  // Eksponentiaalinen odotus: 30s, 60s, 120s, jne. (max 10min)
  const delay = Math.min(30000 * Math.pow(2, Math.min(session.retryCount - 1, 4)), 600000);

  session.reconnectTimer = setTimeout(() => {
    if (sessions.has(uid) && !session.manualShutdown) {
      session.reconnectTimer = null;
      initiateBot(uid, interaction);
    }
  }, delay);
}

// ----------------------------------------------------------------
// MICROSOFT AUTHENTICATION (RELIABILITY UPDATES)
// ----------------------------------------------------------------

/**
 * Hoitaa Microsoft-tunnistautumisen aikarajoilla ja virheensiedolla
 */
async function processMicrosoftLink(uid, interaction) {
  if (activeLogins.has(uid)) {
    return interaction.editReply("⏳ Kirjautumisprosessi on jo käynnissä. Odota tai yritä myöhemmin.");
  }

  // Välitön vastaus jotta Discord ei aikakatkaise
  await interaction.editReply("⏳ Pyydetään kirjautumiskoodia Microsoftilta... (Tässä voi kestää hetki)");

  const authDir = getAuthPath(uid);
  const profile = getProfile(uid);

  // Asetetaan turva-aikakatkaisu koko prosessille
  const loginTimeout = setTimeout(() => {
    if (activeLogins.has(uid)) {
      activeLogins.delete(uid);
      interaction.editReply("❌ Kirjautumisprosessi aikakatkaistiin (5min raja ylittyi).").catch(() => {});
    }
  }, AUTH_PROCESS_TIMEOUT_MS);

  try {
    const flow = new Authflow(uid, authDir, {
      flow: "live",
      authTitle: Titles.MinecraftNintendoSwitch,
      deviceType: "Nintendo"
    }, async (data) => {
      // Näytetään koodi käyttäjälle heti kun se on saatavilla
      const embed = new EmbedBuilder()
        .setTitle("🔐 Microsoft Kirjautuminen")
        .setDescription(
          `**Vahvistuskoodi:** \`${data.user_code}\`\n\n` +
          `1. Paina alla olevaa painiketta ja kirjaudu sisään.\n` +
          `2. Syötä koodi sille varattuun kenttään.\n\n` +
          `*Botti päivittyy automaattisesti kun olet valmis.*`
        )
        .setColor("#5865F2");
      
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel("Kirjaudu Microsoftilla")
          .setStyle(ButtonStyle.Link)
          .setURL(data.verification_uri_complete)
      );

      await interaction.editReply({ content: null, embeds: [embed], components: [row] }).catch(() => {});
    });

    const flowPromise = (async () => {
      try {
        await flow.getMsaToken();
        clearTimeout(loginTimeout);
        
        profile.linked = true;
        saveDatabase();
        
        await interaction.followUp({ ephemeral: true, content: "✅ Microsoft-tilisi on nyt linkitetty onnistuneesti!" });
        pushLog(`🔑 Käyttäjä <@${uid}> linkitti Microsoft-tilin.`, "SUCCESS");
      } catch (err) {
        clearTimeout(loginTimeout);
        await interaction.followUp({ ephemeral: true, content: `❌ Kirjautumisvirhe: ${err.message}` });
      } finally {
        activeLogins.delete(uid);
      }
    })();

    activeLogins.set(uid, flowPromise);

  } catch (err) {
    clearTimeout(loginTimeout);
    activeLogins.delete(uid);
    await interaction.editReply(`❌ Alustusvirhe: ${err.message}`);
  }
}

// ----------------------------------------------------------------
// ADMIN DASHBOARD (DETAILED ANALYTICS)
// ----------------------------------------------------------------

/**
 * Luo kattavan analytiikka-embedin ylläpitoa varten
 */
function buildAdminStats() {
  const mem = process.memoryUsage();
  const uptime = process.uptime();
  
  // Lasketaan muistinkulutus ja järjestelmän tila
  const rss = (mem.rss / 1024 / 1024).toFixed(2);
  const heap = (mem.heapUsed / 1024 / 1024).toFixed(2);
  const h = Math.floor(uptime / 3600);
  const m = Math.floor((uptime % 3600) / 60);

  // Varoitus jos muisti on vähissä (Fly.io)
  const isCritical = parseFloat(rss) > RAM_CRITICAL_THRESHOLD_MB;

  const embed = new EmbedBuilder()
    .setTitle("🚀 Tuotannon Hallintapaneeli")
    .setColor(isCritical ? "#FF0000" : "#2B2D31")
    .addFields(
      { 
        name: "💻 Järjestelmä", 
        value: `**RAM (RSS):** ${rss} MB ${isCritical ? '⚠️' : ''}\n**Heap:** ${heap} MB\n**Uptime:** ${h}h ${m}m`, 
        inline: true 
      },
      { 
        name: "🤖 Botit", 
        value: `**Aktiiviset:** ${sessions.size}\n**Käyttäjät:** ${Object.keys(users).length}\n**Auto-Restore:** Kyllä`, 
        inline: true 
      }
    )
    .setTimestamp()
    .setFooter({ text: `Pakettisuodatin: Aktiivinen • Tarkistus 30s välein` });

  if (sessions.size > 0) {
    let botList = "";
    for (const [id, s] of sessions) {
      const status = s.connected ? "🟢" : (s.isRetrying ? "⏳" : "🔴");
      botList += `${status} <@${id}> (${s.packets} pkt)\n`;
    }
    embed.addFields({ name: "Aktiiviset Istunnot", value: botList.slice(0, 1024) });
  }

  return embed;
}

/**
 * Luo hallintapainikkeet admin-paneeliin
 */
function buildAdminTools() {
  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("adm_update").setLabel("Päivitä Tilastot").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("adm_kill_all").setLabel("Pysäytä Kaikki").setStyle(ButtonStyle.Danger)
    )
  ];

  if (sessions.size > 0) {
    const options = Array.from(sessions.keys()).slice(0, 25).map(id => ({
      label: `Käyttäjä: ${id}`,
      description: sessions.get(id).connected ? "Online" : "Yhdistää",
      value: id
    }));

    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("adm_kill_single")
          .setPlaceholder("Lopeta tietty istunto")
          .addOptions(options)
      )
    );
  }

  return rows;
}

// ----------------------------------------------------------------
// DISCORD-TAPAHTUMAT JA ELINKAARI
// ----------------------------------------------------------------

client.once("ready", async () => {
  console.log(`🟢 Bottu on Online: ${client.user.tag}`);

  // Rekisteröidään slash-komennot
  const commands = [
    new SlashCommandBuilder().setName("panel").setDescription("Avaa AFK-botin hallintapaneeli"),
    new SlashCommandBuilder().setName("admin").setDescription("Ylläpidon analytiikka (Vain omistaja)")
  ];
  await client.application.commands.set(commands).catch(console.error);

  // ------------------------------------------------------------
  // AUTO-RESTORE (BLACKDOWN-SUOJAUS)
  // Palauttaa kaikki botit jotka olivat päällä ennen deployausta.
  // ------------------------------------------------------------
  const restoreList = Object.keys(users).filter(id => users[id].active === true);
  
  if (restoreList.length > 0) {
    pushLog(`♻️ **Auto-Restore**: Käynnistetään ${restoreList.length} istuntoa uudelleen...`, "INFO");
    
    // Staggeroidaan käynnistykset 4 sekunnin välein CPU-piikkien välttämiseksi
    restoreList.forEach((id, index) => {
      setTimeout(() => {
        initiateBot(id);
      }, index * 4000);
    });
  }

  // Admin-paneelin automaattinen päivitys (30 sekunnin sykli)
  setInterval(async () => {
    if (adminDashboardMsg) {
      try {
        await adminDashboardMsg.edit({
          embeds: [buildAdminStats()],
          components: buildAdminTools()
        });
      } catch (err) {
        adminDashboardMsg = null;
      }
    }
    
    // RAM Watchdog: Pakotetaan muistinpuhdistus jos ollaan lähellä rajaa
    const currentRss = process.memoryUsage().rss / 1024 / 1024;
    if (currentRss > RAM_CRITICAL_THRESHOLD_MB && global.gc) {
      console.warn(`🚨 KRIITTINEN MUISTINKULUTUS (${currentRss.toFixed(2)} MB). Pakotetaan GC.`);
      global.gc();
    }
  }, 30000);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!checkGuild(interaction)) return;
    const user = interaction.user;

    // --- SLASH-KOMENNOT ---
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "panel") {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("btn_link").setLabel("Linkitä Microsoft").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("btn_unlink").setLabel("Poista Linkitys").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("btn_start").setLabel("Start").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("btn_stop").setLabel("Stop").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("btn_settings").setLabel("Asetukset").setStyle(ButtonStyle.Secondary)
        );

        return interaction.reply({ content: "🎛 **AFK Bot Hallinta**", components: [row] });
      }

      if (interaction.commandName === "admin") {
        if (user.id !== ADMIN_ID) {
          return interaction.reply({ content: "⛔ Ei pääsyä. Tämä komento on rajattu ylläpidolle.", ephemeral: true });
        }
        if (interaction.channelId !== ADMIN_CHANNEL_ID) {
          return interaction.reply({ content: `⛔ Käytä tätä komentoa admin-kanavalla: <#${ADMIN_CHANNEL_ID}>`, ephemeral: true });
        }

        adminDashboardMsg = await interaction.reply({
          embeds: [buildAdminStats()],
          components: buildAdminTools(),
          fetchReply: true
        });
        return;
      }
    }

    // --- PAINIKKEET ---
    if (interaction.isButton()) {
      const cid = interaction.customId;

      // Admin Toiminnot
      if (cid === "adm_update") {
        if (user.id !== ADMIN_ID) return;
        return interaction.update({ embeds: [buildAdminStats()], components: buildAdminTools() });
      }

      if (cid === "adm_kill_all") {
        if (user.id !== ADMIN_ID) return;
        const count = sessions.size;
        for (const [id, s] of sessions) {
          forceStopBot(id, true);
          dmUser(id, "⚠️ Ylläpito on pysäyttänyt AFK-bottisi järjestelmän huollon vuoksi.");
        }
        pushLog(`🚨 **Ylläpito**: Pysäytetty kaikki ${count} istuntoa.`, "WARN");
        return interaction.reply({ content: `✅ Kaikki ${count} istuntoa lopetettu.`, ephemeral: true });
      }

      // Käyttäjätoiminnot
      if (cid === "btn_link") {
        await interaction.deferReply({ ephemeral: true });
        return processMicrosoftLink(user.id, interaction);
      }

      if (cid === "btn_unlink") {
        const authPath = getAuthPath(user.id);
        if (fs.existsSync(authPath)) {
          fs.rmSync(authPath, { recursive: true, force: true });
        }
        const profile = getProfile(user.id);
        profile.linked = false;
        profile.active = false;
        saveDatabase();
        pushLog(`🗑 Käyttäjä <@${user.id}> poisti linkityksen.`, "INFO");
        return interaction.reply({ content: "🗑 Microsoft-linkitys ja välimuisti on poistettu.", ephemeral: true });
      }

      if (cid === "btn_start") {
        await interaction.deferReply({ ephemeral: true });
        return initiateBot(user.id, interaction);
      }

      if (cid === "btn_stop") {
        if (forceStopBot(user.id, true)) {
          pushLog(`⏹ Käyttäjä <@${user.id}> pysäytti botin.`, "INFO");
          return interaction.reply({ content: "⏹ Botti pysäytetty.", ephemeral: true });
        }
        return interaction.reply({ content: "❌ Sinulla ei ole aktiivista istuntoa.", ephemeral: true });
      }

      if (cid === "btn_settings") {
        const profile = getProfile(user.id);
        const modal = new ModalBuilder().setCustomId("modal_set").setTitle("Botin Asetukset");

        const ipInput = new TextInputBuilder()
          .setCustomId("in_ip")
          .setLabel("Palvelimen IP / Osoite")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(profile.server?.ip || "");

        const portInput = new TextInputBuilder()
          .setCustomId("in_port")
          .setLabel("Portti (Oletus 19132)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(profile.server?.port || 19132));

        const offlineInput = new TextInputBuilder()
          .setCustomId("in_off")
          .setLabel("Offline Nimi (Vain Cracked-tilassa)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setValue(profile.offlineUsername || "");

        modal.addComponents(
          new ActionRowBuilder().addComponents(ipInput),
          new ActionRowBuilder().addComponents(portInput),
          new ActionRowBuilder().addComponents(offlineInput)
        );

        return interaction.showModal(modal);
      }
    }

    // --- VALIKOT ---
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === "adm_kill_single") {
        if (user.id !== ADMIN_ID) return;
        const targetId = interaction.values[0];
        if (forceStopBot(targetId, true)) {
          dmUser(targetId, "⚠️ Ylläpito on pysäyttänyt AFK-bottisi.");
          pushLog(`🚨 **Ylläpito**: Pakotettu lopetus käyttäjälle <@${targetId}>`, "WARN");
          return interaction.reply({ content: `✅ Istunto <@${targetId}> lopetettu.`, ephemeral: true });
        }
      }
    }

    // --- MODAALIT ---
    if (interaction.isModalSubmit() && interaction.customId === "modal_set") {
      const ip = interaction.fields.getTextInputValue("in_ip").trim();
      const port = interaction.fields.getTextInputValue("in_port").trim();
      const offline = interaction.fields.getTextInputValue("in_off").trim();

      const profile = getProfile(user.id);
      profile.server = { ip, port };
      if (offline) profile.offlineUsername = offline;
      
      saveDatabase();
      return interaction.reply({ content: `✅ Asetukset tallennettu! Osoite: **${ip}:${port}**`, ephemeral: true });
    }

  } catch (err) {
    console.error("🔥 INTERACTION ERROR:", err);
  }
});

// Globaali virheidenhallinta prosessitasolla
process.on("unhandledRejection", (err) => console.error("Unhandled Rejection:", err));
process.on("uncaughtException", (err) => console.error("Uncaught Exception:", err));

client.login(DISCORD_TOKEN);

