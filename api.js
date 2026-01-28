const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const bedrock = require("bedrock-protocol");
const { Authflow, Titles } = require("prismarine-auth");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.API_PORT || 3000;

// --- Middlewares ---
app.use(cors()); // Sallii kutsut mistä tahansa domainista (esim. paikallinen HTML-tiedosto)
app.use(bodyParser.json());

// --- Tallennus ja polut ---
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
  if (!users[uid].bedrockVersion) users[uid].bedrockVersion = "auto";
  if (!users[uid].offlineUsername) users[uid].offlineUsername = `AFK_${uid.slice(-4)}`;
  return users[uid];
}

function getUserAuthDir(uid) {
  const dir = path.join(AUTH_ROOT, uid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// --- Runtime-sessioiden hallinta ---
const sessions = new Map();
const lastMsa = new Map();

// --- Botin ydintoiminnot ---

function cleanupSession(uid) {
  const s = sessions.get(uid);
  if (!s) return;
  if (s.timeout) clearTimeout(s.timeout);
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  try { s.client.close(); } catch {}
  sessions.delete(uid);
}

function startSession(uid) {
  const u = getUser(uid);
  if (!u.server || !u.server.ip) return { error: "Server settings missing" };

  const existing = sessions.get(uid);
  if (existing && !existing.isReconnecting) return { error: "Bot is already running" };

  const { ip, port } = u.server;
  const authDir = getUserAuthDir(uid);

  const opts = {
    host: ip,
    port: parseInt(port),
    connectTimeout: 47000,
    keepAlive: true,
    version: u.bedrockVersion === "auto" ? undefined : u.bedrockVersion
  };

  if (u.connectionType === "offline") {
    opts.username = u.offlineUsername || `AFK_${uid.slice(-4)}`;
    opts.offline = true;
  } else {
    opts.username = uid;
    opts.offline = false;
    opts.profilesFolder = authDir;
  }

  try {
    const mc = bedrock.createClient(opts);
    
    let s = sessions.get(uid) || { startedAt: Date.now(), manualStop: false };
    s.client = mc;
    s.connected = false;
    s.isReconnecting = false;
    sessions.set(uid, s);

    // Anti-AFK Liikkuminen (liikkuu minuutin välein)
    const waitForEntity = setInterval(() => {
      if (!mc.entity || !mc.entityId) return;
      clearInterval(waitForEntity);

      let toggle = false;
      const moveInterval = setInterval(() => {
        try {
          const pos = { ...mc.entity.position };
          pos.x += toggle ? 0.4 : -0.4;
          toggle = !toggle;

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
      }, 60000);
      mc.once("close", () => clearInterval(moveInterval));
    }, 1000);

    mc.on("spawn", () => {
      s.connected = true;
      console.log(`[API] Bot ${uid} connected to ${ip}`);
    });

    const handleDisconnect = () => {
      if (!s.manualStop) {
        console.log(`[API] Bot ${uid} lost connection. Reconnecting in 30s...`);
        s.connected = false;
        s.isReconnecting = true;
        s.reconnectTimer = setTimeout(() => startSession(uid), 30000);
      }
    };

    mc.on("error", handleDisconnect);
    mc.on("close", handleDisconnect);

    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
}

// --- API Endpointit ---

// 1. Botin tila
app.get("/api/status/:uid", (req, res) => {
  const { uid } = req.params;
  const s = sessions.get(uid);
  const u = getUser(uid);
  res.json({
    active: !!s,
    connected: s?.connected || false,
    reconnecting: s?.isReconnecting || false,
    settings: u
  });
});

// 2. Päivitä asetukset
app.post("/api/settings/:uid", (req, res) => {
  const { uid } = req.params;
  const { ip, port, connectionType, bedrockVersion, offlineUsername } = req.body;
  const u = getUser(uid);

  if (ip) u.server = { ip, port: parseInt(port) || 19132 };
  if (connectionType) u.connectionType = connectionType;
  if (bedrockVersion) u.bedrockVersion = bedrockVersion;
  if (offlineUsername) u.offlineUsername = offlineUsername;

  save();
  res.json({ success: true, user: u });
});

// 3. Käynnistä
app.post("/api/start/:uid", (req, res) => {
  const result = startSession(req.params.uid);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// 4. Pysäytä
app.post("/api/stop/:uid", (req, res) => {
  const s = sessions.get(req.params.uid);
  if (!s) return res.status(404).json({ error: "No bot running" });
  s.manualStop = true;
  cleanupSession(req.params.uid);
  res.json({ success: true });
});

// 5. Microsoft Linkitys (Device Code)
app.get("/api/auth/link/:uid", async (req, res) => {
  const { uid } = req.params;
  const authDir = getUserAuthDir(uid);

  const flow = new Authflow(uid, authDir, {
    flow: "live",
    authTitle: Titles.MinecraftNintendoSwitch,
    deviceType: "Nintendo"
  }, (data) => {
    lastMsa.set(uid, {
      uri: data.verification_uri_complete || data.verification_uri,
      code: data.user_code
    });
  });

  flow.getMsaToken().then(() => {
    getUser(uid).linked = true;
    save();
    lastMsa.delete(uid);
  }).catch(() => {});

  // Odotetaan hetki että koodi generoidaan
  setTimeout(() => {
    res.json(lastMsa.get(uid) || { error: "Generating code..." });
  }, 2000);
});

// 6. Ghost Mode (Invisibility)
app.post("/api/action/:uid", (req, res) => {
  const { action } = req.body;
  const s = sessions.get(req.params.uid);
  if (!s || !s.connected) return res.status(400).json({ error: "Bot not connected" });

  if (action === "invisible") {
    s.client.write("command_request", {
      command: "/gamemode survival @s",
      internal: false,
      version: 2
    });
    return res.json({ success: true });
  }
  res.status(400).json({ error: "Invalid action" });
});

app.listen(PORT, () => {
  console.log(`🚀 API Palvelin käynnissä portissa ${PORT}`);
});

