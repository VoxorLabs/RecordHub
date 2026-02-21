"use strict";

/**
 * RecordHub — Automated Session Recording Sidecar
 *
 * Controls OBS Studio via WebSocket to automatically record event sessions.
 * Triggered by RoomAgent kiosk session lifecycle or time-based polling.
 * Produces professional recordings with PiP (presenter over slides).
 *
 * Port: 3299
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const { exec } = require("child_process");
const express = require("express");
const cors = require("cors");

// ─── Paths ───
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const PUBLIC_DIR = path.join(ROOT, "public");
const RECORDINGS_DIR = path.join(ROOT, "recordings");

// ─── Defaults ───
const DEFAULTS = {
  port: 3299,
  presenterHubBase: "http://10.0.0.166:8088",
  roomAgentBase: "http://localhost:3199",
  room: "",
  obsWebSocketUrl: "ws://localhost:4455",
  obsPassword: "",
  pollMs: 5000,
  heartbeatMs: 10000,
  recordingsRoot: RECORDINGS_DIR,
  autoRemuxToMp4: true,
  pipSceneName: "Session Recording",
  titleSourceName: "Lower Third",
  verbose: true,
};

// ─── State ───
const STATE = {
  obsConnected: false,
  obsVersion: null,
  recording: false,
  currentSession: null,   // { id, title, presenter, room, date, start, startedAt }
  lastPollAt: null,
  lastHeartbeatAt: null,
  totalRecordings: 0,
  errors: [],
  recordingStartedAt: null,
  lastOutputPath: null,
};

// ─── Config ───
function ensureDirs() {
  [DATA_DIR, RECORDINGS_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

function readConfig() {
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, "config.json"), "utf8");
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeConfig(cfg) {
  const toSave = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (cfg[k] !== undefined) toSave[k] = cfg[k];
  }
  fs.writeFileSync(path.join(DATA_DIR, "config.json"), JSON.stringify(toSave, null, 2));
}

// ─── Logging ───
function log(...args) {
  const ts = new Date().toISOString();
  console.log(`${ts} - RECORDHUB`, ...args);
}

function addError(msg) {
  STATE.errors.unshift({ ts: new Date().toISOString(), msg });
  if (STATE.errors.length > 50) STATE.errors.length = 50;
}

// ─── OBS WebSocket ───
let obs = null;

async function connectObs() {
  const cfg = readConfig();
  try {
    // Dynamic import for obs-websocket-js (ESM-compatible)
    const OBSWebSocket = require("obs-websocket-js").default || require("obs-websocket-js");
    obs = new OBSWebSocket();

    await obs.connect(cfg.obsWebSocketUrl, cfg.obsPassword || undefined);
    STATE.obsConnected = true;

    // Get version info
    try {
      const ver = await obs.call("GetVersion");
      STATE.obsVersion = ver.obsVersion || ver.obsWebSocketVersion || "unknown";
      log("OBS CONNECTED", "version=" + STATE.obsVersion);
    } catch {
      STATE.obsVersion = "connected";
      log("OBS CONNECTED");
    }

    obs.on("ConnectionClosed", () => {
      log("OBS DISCONNECTED");
      STATE.obsConnected = false;
      STATE.obsVersion = null;
      // Auto-reconnect after 5 seconds
      setTimeout(connectObs, 5000);
    });

    obs.on("ConnectionError", (err) => {
      log("OBS CONNECTION ERROR", err.message);
      STATE.obsConnected = false;
      addError("OBS connection error: " + err.message);
    });

    // Listen for recording state changes from OBS
    obs.on("RecordStateChanged", (data) => {
      log("OBS RECORD STATE", data.outputState);
      if (data.outputState === "OBS_WEBSOCKET_OUTPUT_STOPPED") {
        STATE.recording = false;
        if (data.outputPath) {
          STATE.lastOutputPath = data.outputPath;
          handleRecordingStopped(data.outputPath);
        }
      } else if (data.outputState === "OBS_WEBSOCKET_OUTPUT_STARTED") {
        STATE.recording = true;
      }
    });

  } catch (e) {
    STATE.obsConnected = false;
    log("OBS CONNECT FAILED", e.message);
    addError("OBS connect failed: " + e.message);
    // Retry in 10 seconds
    setTimeout(connectObs, 10000);
  }
}

async function obsStartRecord() {
  if (!obs || !STATE.obsConnected) throw new Error("OBS not connected");
  await obs.call("StartRecord");
  STATE.recording = true;
  STATE.recordingStartedAt = Date.now();
  log("RECORDING STARTED");
}

async function obsStopRecord() {
  if (!obs || !STATE.obsConnected) throw new Error("OBS not connected");
  try {
    const result = await obs.call("StopRecord");
    STATE.recording = false;
    log("RECORDING STOPPED", result.outputPath || "");
    return result.outputPath || null;
  } catch (e) {
    // If not recording, that's fine
    if (e.message && e.message.includes("not active")) {
      STATE.recording = false;
      return null;
    }
    throw e;
  }
}

async function obsGetRecordStatus() {
  if (!obs || !STATE.obsConnected) return { recording: false };
  try {
    const status = await obs.call("GetRecordStatus");
    return {
      recording: status.outputActive || false,
      duration: status.outputDuration || 0,
      bytes: status.outputBytes || 0,
    };
  } catch {
    return { recording: false };
  }
}

async function obsUpdateLowerThird(title, presenter) {
  if (!obs || !STATE.obsConnected) return;
  const cfg = readConfig();
  try {
    await obs.call("SetInputSettings", {
      inputName: cfg.titleSourceName,
      inputSettings: {
        text: `${title}  —  ${presenter}`,
      },
    });
    log("LOWER THIRD UPDATED", title, "—", presenter);
  } catch (e) {
    // Not critical — text source may not exist
    log("LOWER THIRD UPDATE SKIP", e.message);
  }
}

async function obsSwitchScene(sceneName) {
  if (!obs || !STATE.obsConnected) return;
  try {
    await obs.call("SetCurrentProgramScene", { sceneName });
    log("SCENE SWITCHED", sceneName);
  } catch (e) {
    log("SCENE SWITCH SKIP", e.message);
  }
}

// ─── Recording File Management ───
function sanitizeFilename(s) {
  return String(s || "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .substring(0, 100);
}

async function handleRecordingStopped(outputPath) {
  if (!outputPath || !STATE.currentSession) return;
  const cfg = readConfig();
  const s = STATE.currentSession;

  try {
    // Build target filename
    const date = (s.date || "").replace(/-/g, "");
    const time = (s.start || "").replace(/[: ]/g, "").replace(/AM|PM/gi, "");
    const presenter = sanitizeFilename(s.presenter || "Unknown");
    const title = sanitizeFilename(s.title || "Session");
    const ext = path.extname(outputPath);
    const newName = `${date}_${time}_${presenter}_${title}${ext}`;

    // Target directory
    const roomDir = path.join(cfg.recordingsRoot, sanitizeFilename(s.room || cfg.room || "Room"));
    const dateDir = path.join(roomDir, s.date || "undated");
    await fsp.mkdir(dateDir, { recursive: true });

    const destPath = path.join(dateDir, newName);

    // Move file
    try {
      await fsp.rename(outputPath, destPath);
      log("RECORDING MOVED", destPath);
    } catch {
      // Cross-device? Copy + delete
      await fsp.copyFile(outputPath, destPath);
      await fsp.unlink(outputPath);
      log("RECORDING COPIED", destPath);
    }

    STATE.totalRecordings++;
    STATE.lastOutputPath = destPath;

    // Auto-remux MKV → MP4
    if (cfg.autoRemuxToMp4 && ext.toLowerCase() === ".mkv") {
      remuxToMp4(destPath);
    }
  } catch (e) {
    log("RECORDING MOVE ERROR", e.message);
    addError("Recording move error: " + e.message);
  }
}

function remuxToMp4(mkvPath) {
  const mp4Path = mkvPath.replace(/\.mkv$/i, ".mp4");
  // Try ffmpeg first, fall back to OBS's own remux
  const cmd = `ffmpeg -i "${mkvPath}" -codec copy "${mp4Path}" -y`;
  exec(cmd, { windowsHide: true }, (err) => {
    if (err) {
      log("REMUX SKIP (ffmpeg not available)", path.basename(mkvPath));
    } else {
      log("REMUXED TO MP4", path.basename(mp4Path));
      // Optionally delete the MKV
      // fs.unlink(mkvPath, () => {});
    }
  });
}

// ─── Session Detection ───
let pollTimer = null;
let heartbeatTimer = null;

function parseTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const t = timeStr.trim();
  // Handle "2:00 PM" format
  const m12 = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (m12) {
    let h = parseInt(m12[1], 10);
    const min = parseInt(m12[2], 10);
    if (m12[3].toUpperCase() === "PM" && h !== 12) h += 12;
    if (m12[3].toUpperCase() === "AM" && h === 12) h = 0;
    return new Date(`${dateStr}T${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:00`);
  }
  // Handle "14:00" format
  const m24 = t.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) {
    return new Date(`${dateStr}T${t}:00`);
  }
  return null;
}

function findCurrentSession(sessions) {
  if (!sessions || !sessions.length) return null;
  const now = new Date();
  const todayStr = now.toISOString().split("T")[0];

  // Filter today's sessions and sort by start time
  const today = sessions
    .filter(s => (s.date || "") === todayStr)
    .map(s => {
      const startDt = parseTime(s.date, s.start);
      return { ...s, _startDt: startDt };
    })
    .filter(s => s._startDt)
    .sort((a, b) => a._startDt - b._startDt);

  if (!today.length) return null;

  // Find the session that's currently running (started but next hasn't started yet)
  for (let i = 0; i < today.length; i++) {
    const s = today[i];
    const nextStart = today[i + 1] ? today[i + 1]._startDt : null;

    if (now >= s._startDt) {
      if (!nextStart || now < nextStart) {
        return s;
      }
    }
  }
  return null;
}

async function pollRoomAgent() {
  const cfg = readConfig();
  try {
    const res = await fetch(`${cfg.roomAgentBase}/api/kiosk-data`, {
      signal: AbortSignal.timeout(4000),
    });
    const data = await res.json();
    STATE.lastPollAt = Date.now();

    if (!data.ok || !data.sessions) return;

    const current = findCurrentSession(data.sessions);

    if (current && (!STATE.currentSession || STATE.currentSession.id !== current.id)) {
      // New session detected — start recording
      if (STATE.recording) {
        log("SESSION CHANGED — stopping previous recording");
        try { await obsStopRecord(); } catch (e) { log("STOP ERROR", e.message); }
        // Small delay for OBS to finalize
        await new Promise(r => setTimeout(r, 2000));
      }

      STATE.currentSession = {
        id: current.id,
        sessionId: current.sessionId,
        title: current.title,
        presenter: current.presenter,
        room: current.room || cfg.room,
        date: current.date,
        start: current.start,
        startedAt: Date.now(),
      };

      if (STATE.obsConnected) {
        try {
          await obsSwitchScene(cfg.pipSceneName);
          await obsUpdateLowerThird(current.title, current.presenter);
          await obsStartRecord();
        } catch (e) {
          log("AUTO-START ERROR", e.message);
          addError("Auto-start recording failed: " + e.message);
        }
      }
    } else if (!current && STATE.currentSession && STATE.recording) {
      // Session ended — stop recording
      log("SESSION ENDED — stopping recording");
      try { await obsStopRecord(); } catch (e) { log("STOP ERROR", e.message); }
      STATE.currentSession = null;
    }
  } catch (e) {
    if (cfg.verbose) log("POLL ERROR", e.message);
  }
}

async function sendHeartbeat() {
  const cfg = readConfig();
  try {
    await fetch(`${cfg.presenterHubBase}/api/agents/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        room: cfg.room || os.hostname(),
        type: "recordhub",
        pcname: os.hostname(),
        recording: STATE.recording,
        sessionId: STATE.currentSession ? STATE.currentSession.id : null,
      }),
      signal: AbortSignal.timeout(4000),
    });
    STATE.lastHeartbeatAt = Date.now();
  } catch {
    // Silent — server may be unreachable
  }
}

// ─── Recording History ───
async function getRecordingsList() {
  const cfg = readConfig();
  const recordings = [];

  async function scanDir(dir, relBase) {
    let items;
    try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        await scanDir(full, path.join(relBase, item.name));
      } else if (item.isFile() && /\.(mkv|mp4|mov|avi|ts|flv)$/i.test(item.name)) {
        const stat = await fsp.stat(full);
        recordings.push({
          name: item.name,
          path: path.join(relBase, item.name),
          size: stat.size,
          sizeHuman: formatBytes(stat.size),
          created: stat.birthtime || stat.mtime,
          duration: null, // Would need ffprobe
        });
      }
    }
  }

  await scanDir(cfg.recordingsRoot, "");
  recordings.sort((a, b) => new Date(b.created) - new Date(a.created));
  return recordings;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

// ─── Express Server ───
function startServer() {
  ensureDirs();
  const cfg = readConfig();
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.static(PUBLIC_DIR));

  // ── Dashboard ──
  app.get("/", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "dashboard.html")));
  app.get("/setup", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "setup.html")));

  // ── API: Status ──
  app.get("/api/status", async (_req, res) => {
    let obsRecStatus = { recording: false };
    try { obsRecStatus = await obsGetRecordStatus(); } catch {}
    res.json({
      ok: true,
      obsConnected: STATE.obsConnected,
      obsVersion: STATE.obsVersion,
      recording: STATE.recording,
      obsRecording: obsRecStatus,
      currentSession: STATE.currentSession,
      recordingStartedAt: STATE.recordingStartedAt,
      lastPollAt: STATE.lastPollAt,
      lastHeartbeatAt: STATE.lastHeartbeatAt,
      totalRecordings: STATE.totalRecordings,
      errors: STATE.errors.slice(0, 10),
      lastOutputPath: STATE.lastOutputPath,
      uptime: process.uptime(),
    });
  });

  // ── API: Config ──
  app.get("/api/config", (_req, res) => {
    const cfg = readConfig();
    // Mask password
    const safe = { ...cfg };
    if (safe.obsPassword) safe.obsPassword = "****";
    res.json({ ok: true, config: safe });
  });

  app.post("/api/config", (req, res) => {
    try {
      const current = readConfig();
      const updates = req.body || {};
      const merged = { ...current, ...updates };
      writeConfig(merged);
      log("CONFIG SAVED");
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── API: Manual Record Control ──
  app.post("/api/record/start", async (req, res) => {
    try {
      const { sessionId, title, presenter, room, date, start } = req.body || {};
      const cfg = readConfig();

      STATE.currentSession = {
        id: sessionId || "manual_" + Date.now(),
        title: title || "Manual Recording",
        presenter: presenter || "",
        room: room || cfg.room || "",
        date: date || new Date().toISOString().split("T")[0],
        start: start || new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
        startedAt: Date.now(),
      };

      if (STATE.obsConnected) {
        await obsSwitchScene(cfg.pipSceneName);
        await obsUpdateLowerThird(STATE.currentSession.title, STATE.currentSession.presenter);
      }
      await obsStartRecord();

      log("MANUAL START", STATE.currentSession.title);
      res.json({ ok: true, session: STATE.currentSession });
    } catch (e) {
      log("MANUAL START ERROR", e.message);
      addError("Manual start failed: " + e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/record/stop", async (req, res) => {
    try {
      const outputPath = await obsStopRecord();
      const session = STATE.currentSession;
      STATE.currentSession = null;
      log("MANUAL STOP");
      res.json({ ok: true, outputPath, session });
    } catch (e) {
      log("MANUAL STOP ERROR", e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── API: Recordings ──
  app.get("/api/recordings", async (_req, res) => {
    try {
      const list = await getRecordingsList();
      res.json({ ok: true, recordings: list, total: list.length });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── API: OBS Info ──
  app.get("/api/obs/scenes", async (_req, res) => {
    try {
      if (!obs || !STATE.obsConnected) return res.json({ ok: false, error: "OBS not connected" });
      const data = await obs.call("GetSceneList");
      res.json({ ok: true, scenes: data.scenes, currentScene: data.currentProgramSceneName });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  app.post("/api/obs/reconnect", async (_req, res) => {
    try {
      if (obs) { try { obs.disconnect(); } catch {} }
      await connectObs();
      res.json({ ok: true, connected: STATE.obsConnected });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ── Start ──
  app.listen(cfg.port, () => {
    log("SERVER RUNNING ON PORT", cfg.port);
    log("Dashboard: http://localhost:" + cfg.port);
    log("Setup:     http://localhost:" + cfg.port + "/setup");
  });

  // Connect to OBS
  connectObs();

  // Start polling RoomAgent
  pollTimer = setInterval(pollRoomAgent, cfg.pollMs);
  log("POLLING ROOMAGENT every", cfg.pollMs + "ms at", cfg.roomAgentBase);

  // Start heartbeat
  heartbeatTimer = setInterval(sendHeartbeat, cfg.heartbeatMs);
  setTimeout(sendHeartbeat, 2000); // Initial heartbeat

  // Initial poll
  setTimeout(pollRoomAgent, 3000);
}

startServer();
