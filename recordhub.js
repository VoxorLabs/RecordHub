"use strict";
/**
 * RecordHub v2.0
 *
 * Recording is triggered exclusively by POST /api/trigger from RoomAgent.
 * Lower thirds auto-inject into OBS's current scene on each recording start
 * — no manual scene setup or "Build Scene" step required.
 *
 * Port: 3299
 */

const fs   = require("fs");
const fsp  = fs.promises;
const path = require("path");
const os   = require("os");
const { exec } = require("child_process");
const express  = require("express");
const cors     = require("cors");

// ─── Paths ───────────────────────────────────────────────────────────────────
const ROOT          = __dirname;
const DATA_DIR      = path.join(ROOT, "data");
const PUBLIC_DIR    = path.join(ROOT, "public");
const RECORDINGS_DIR = path.join(ROOT, "recordings");

// ─── Config defaults (minimal by design) ─────────────────────────────────────
const DEFAULTS = {
  port: 3299,
  obsWebSocketUrl: "ws://localhost:4455",
  obsPassword: "",
  roomAgentBase: "",      // RoomAgent URL for session info (lower third text)
  presenterHubBase: "",   // Optional — PresenterHub heartbeat
  room: "",               // Used for recordings folder organisation
  recordingsRoot: RECORDINGS_DIR,
  autoRemuxToMp4: true,
  verbose: true,
};

// Fixed source names — not configurable to avoid misconfiguration
const LT_BG   = "Lower Third BG";
const LT_TEXT = "Lower Third";

// ─── State ───────────────────────────────────────────────────────────────────
const STATE = {
  obsConnected: false,
  obsVersion: null,
  recording: false,
  currentSession: null,   // { id, title, presenter, room, date, start, startedAt }
  polledSession: null,    // latest from RoomAgent poll — info only, never starts recording
  lastPollAt: null,
  lastHeartbeatAt: null,
  totalRecordings: 0,
  errors: [],
  recordingStartedAt: null,
  lastOutputPath: null,
  ltScene: null,          // scene where lower third was last injected
};

// ─── Dirs / config ───────────────────────────────────────────────────────────
function ensureDirs() {
  [DATA_DIR, RECORDINGS_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

function readConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(DATA_DIR, "config.json"), "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeConfig(cfg) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (cfg[k] !== undefined) out[k] = cfg[k];
  }
  fs.writeFileSync(path.join(DATA_DIR, "config.json"), JSON.stringify(out, null, 2));
}

function log(...args) {
  console.log(new Date().toISOString(), "- RECORDHUB", ...args);
}

function addError(msg) {
  STATE.errors.unshift({ ts: new Date().toISOString(), msg });
  if (STATE.errors.length > 50) STATE.errors.length = 50;
}

// ─── OBS WebSocket ────────────────────────────────────────────────────────────
let obs = null;

async function connectObs() {
  const cfg = readConfig();
  try {
    const OBSWebSocket = require("obs-websocket-js").default || require("obs-websocket-js");
    obs = new OBSWebSocket();
    await obs.connect(cfg.obsWebSocketUrl, cfg.obsPassword || undefined);
    STATE.obsConnected = true;

    try {
      const v = await obs.call("GetVersion");
      STATE.obsVersion = v.obsVersion || "connected";
    } catch { STATE.obsVersion = "connected"; }

    log("OBS CONNECTED version=" + STATE.obsVersion);

    obs.on("ConnectionClosed", () => {
      log("OBS DISCONNECTED");
      STATE.obsConnected = false;
      STATE.obsVersion = null;
      setTimeout(connectObs, 5000);
    });
    obs.on("ConnectionError", (e) => {
      STATE.obsConnected = false;
      addError("OBS error: " + e.message);
    });
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
    const r = await obs.call("StopRecord");
    STATE.recording = false;
    log("RECORDING STOPPED", r.outputPath || "");
    return r.outputPath || null;
  } catch (e) {
    if (/not active/i.test(e.message || "")) { STATE.recording = false; return null; }
    throw e;
  }
}

// ─── Lower Third ─────────────────────────────────────────────────────────────
// Auto-injects into the current OBS program scene. No pre-setup required.
// Called automatically on every trigger-start; hidden 10 seconds later.

let ltFadeTimer = null;

// Upsert a source into a scene: creates it if new, updates settings if existing.
// Returns the sceneItemId.
async function upsertSource(scene, name, kind, settings) {
  // Try create fresh
  try {
    const r = await obs.call("CreateInput", {
      sceneName: scene, inputName: name, inputKind: kind,
      inputSettings: settings, sceneItemEnabled: false,
    });
    return r.sceneItemId;
  } catch {
    // Already exists — update settings
    try { await obs.call("SetInputSettings", { inputName: name, inputSettings: settings }); } catch {}
    // Get scene item ID in this scene
    try {
      const { sceneItemId } = await obs.call("GetSceneItemId", { sceneName: scene, sourceName: name });
      return sceneItemId;
    } catch {
      // Source exists globally but not in this scene — add it
      const { sceneItemId } = await obs.call("CreateSceneItem", {
        sceneName: scene, sourceName: name, sceneItemEnabled: false,
      });
      return sceneItemId;
    }
  }
}

async function showLowerThird(title, presenter, startTime) {
  if (!obs || !STATE.obsConnected) { log("LT SKIP: OBS not connected"); return; }
  if (ltFadeTimer) { clearTimeout(ltFadeTimer); ltFadeTimer = null; }

  const text = [presenter, title, startTime].filter(Boolean).join("  ·  ");
  log("LT: showing —", text);

  try {
    // 1. Read actual OBS canvas — never guess or use config
    let W = 1920, H = 1080;
    try {
      const vs = await obs.call("GetVideoSettings");
      W = vs.baseWidth  || W;
      H = vs.baseHeight || H;
    } catch {}

    // 2. Current program scene — lower third goes wherever OBS is pointing
    const { currentProgramSceneName: scene } = await obs.call("GetCurrentProgramScene");
    STATE.ltScene = scene;

    // 3. Detect available source kinds
    let kinds = new Set();
    try {
      const { inputKinds } = await obs.call("GetInputKindList", { unversioned: false });
      kinds = new Set(inputKinds);
    } catch {}
    const pick  = (...cs) => cs.find(k => kinds.has(k)) || cs[0];
    const colorKind = pick("color_source_v3", "color_source_v2", "color_source");
    const textKind  = pick("text_gdiplus_v2", "text_gdiplus", "text_ft2_source");
    log("LT: canvas=" + W + "×" + H, "scene=" + scene, "text=" + textKind);

    const LT_H = 90;
    const LT_Y = H - LT_H - 10;

    // 4. Lower Third BG — solid opaque dark blue strip
    const bgId = await upsertSource(scene, LT_BG, colorKind, { color: 0xFF1A237E });
    await obs.call("SetSceneItemTransform", {
      sceneName: scene, sceneItemId: bgId,
      sceneItemTransform: {
        positionX: 0, positionY: LT_Y, alignment: 5,
        boundsType: "OBS_BOUNDS_STRETCH", boundsWidth: W, boundsHeight: LT_H,
      },
    });
    try { await obs.call("RemoveSourceFilter", { sourceName: LT_BG, filterName: "Fade" }); } catch {}

    // 5. Lower Third text — white bold Arial, set text content on every call
    const textId = await upsertSource(scene, LT_TEXT, textKind, {
      text,
      font: { face: "Arial", size: 40, style: "Bold", flags: 0 },
      color:  4294967295,   // 0xFFFFFFFF white (text_gdiplus v1)
      color1: 4294967295,   // 0xFFFFFFFF white (text_gdiplus_v2)
      outline: true, outline_color: 4278190080, outline_size: 3,
      extents: true, extents_cx: W - 60, extents_cy: LT_H - 16, extents_wrap: false,
    });
    await obs.call("SetSceneItemTransform", {
      sceneName: scene, sceneItemId: textId,
      sceneItemTransform: { positionX: 30, positionY: LT_Y + 12, alignment: 5, boundsType: "OBS_BOUNDS_NONE" },
    });
    try { await obs.call("RemoveSourceFilter", { sourceName: LT_TEXT, filterName: "Fade" }); } catch {}

    // 6. Ensure text is ABOVE the BG in z-order (higher index = rendered on top)
    try {
      const { sceneItems } = await obs.call("GetSceneItemList", { sceneName: scene });
      const bg = sceneItems.find(i => i.sourceName === LT_BG);
      const tx = sceneItems.find(i => i.sourceName === LT_TEXT);
      if (bg && tx && tx.sceneItemIndex <= bg.sceneItemIndex) {
        await obs.call("SetSceneItemIndex", {
          sceneName: scene, sceneItemId: textId, sceneItemIndex: bg.sceneItemIndex + 1,
        });
        log("LT: text moved above BG");
      }
    } catch {}

    // 7. Enable both sources
    await obs.call("SetSceneItemEnabled", { sceneName: scene, sceneItemId: bgId,   sceneItemEnabled: true });
    await obs.call("SetSceneItemEnabled", { sceneName: scene, sceneItemId: textId, sceneItemEnabled: true });

    log("LT: shown — hiding in 10s");
    ltFadeTimer = setTimeout(() => hideLowerThird(), 10_000);
  } catch (e) {
    log("LT ERROR:", e.message);
    addError("Lower third error: " + e.message);
  }
}

async function hideLowerThird() {
  if (!obs || !STATE.obsConnected) return;
  if (ltFadeTimer) { clearTimeout(ltFadeTimer); ltFadeTimer = null; }

  let scene = STATE.ltScene;
  if (!scene) {
    try { ({ currentProgramSceneName: scene } = await obs.call("GetCurrentProgramScene")); } catch { return; }
  }

  for (const src of [LT_BG, LT_TEXT]) {
    try {
      const { sceneItemId } = await obs.call("GetSceneItemId", { sceneName: scene, sourceName: src });
      await obs.call("SetSceneItemEnabled", { sceneName: scene, sceneItemId, sceneItemEnabled: false });
    } catch {}
  }
  STATE.ltScene = null;
  log("LT: hidden");
}

// ─── Recording file management ────────────────────────────────────────────────
function sanitize(s) {
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
    const date = (s.date  || "").replace(/-/g, "");
    const time = (s.start || "").replace(/[: ]/g, "").replace(/AM|PM/gi, "");
    const ext  = path.extname(outputPath);
    const name = `${date}_${time}_${sanitize(s.presenter || "Unknown")}_${sanitize(s.title || "Session")}${ext}`;
    const dir  = path.join(cfg.recordingsRoot, sanitize(s.room || cfg.room || "Room"), s.date || "undated");
    await fsp.mkdir(dir, { recursive: true });
    const dest = path.join(dir, name);
    try { await fsp.rename(outputPath, dest); }
    catch { await fsp.copyFile(outputPath, dest); await fsp.unlink(outputPath); }
    STATE.totalRecordings++;
    STATE.lastOutputPath = dest;
    log("RECORDING SAVED", dest);
    if (cfg.autoRemuxToMp4 && ext.toLowerCase() === ".mkv") remuxToMp4(dest);
  } catch (e) {
    log("RECORDING SAVE ERROR", e.message);
    addError("Recording save error: " + e.message);
  }
}

function remuxToMp4(mkvPath) {
  const mp4 = mkvPath.replace(/\.mkv$/i, ".mp4");
  exec(`ffmpeg -i "${mkvPath}" -codec copy "${mp4}" -y`, { windowsHide: true }, (err) => {
    if (!err) log("REMUXED", path.basename(mp4));
    else log("REMUX SKIP (ffmpeg not found)");
  });
}

// ─── Auto-stop safety net ────────────────────────────────────────────────────
// Hard 4-hour limit — prevents runaway recordings if stop trigger is missed.
let autoStopTimer = null;

function scheduleAutoStop() {
  cancelAutoStop();
  autoStopTimer = setTimeout(async () => {
    if (!STATE.recording) return;
    log("AUTO-STOP: 4-hour safety limit reached");
    try { await obsStopRecord(); } catch (e) { log("AUTO-STOP ERROR", e.message); }
    STATE.currentSession = null;
  }, 4 * 60 * 60 * 1000);
}

function cancelAutoStop() {
  if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; }
}

// ─── Poll RoomAgent ───────────────────────────────────────────────────────────
// INFO ONLY — reads session data for lower third text and dashboard display.
// Poll NEVER starts or stops recordings. Only POST /api/trigger does that.

function parseTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const t = timeStr.trim();
  const m12 = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (m12) {
    let h = parseInt(m12[1]);
    const min = parseInt(m12[2]);
    if (m12[3].toUpperCase() === "PM" && h !== 12) h += 12;
    if (m12[3].toUpperCase() === "AM" && h === 12) h = 0;
    return new Date(`${dateStr}T${String(h).padStart(2,"0")}:${String(min).padStart(2,"0")}:00`);
  }
  const m24 = t.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) return new Date(`${dateStr}T${t}:00`);
  return null;
}

function findCurrentSession(sessions) {
  if (!sessions?.length) return null;
  const now = new Date();
  // Local date — not UTC (UTC flips to "tomorrow" in US afternoon)
  const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
  const todays = sessions
    .filter(s => s.date === today)
    .map(s => ({ ...s, _dt: parseTime(s.date, s.start) }))
    .filter(s => s._dt)
    .sort((a, b) => a._dt - b._dt);
  for (let i = 0; i < todays.length; i++) {
    const s = todays[i];
    const next = todays[i + 1]?._dt;
    if (now >= s._dt && (!next || now < next)) return s;
  }
  return null;
}

async function pollRoomAgent() {
  const cfg = readConfig();
  if (!cfg.roomAgentBase) return;
  try {
    const r = await fetch(`${cfg.roomAgentBase}/api/kiosk-data`, { signal: AbortSignal.timeout(4000) });
    const d = await r.json();
    STATE.lastPollAt = Date.now();
    if (!d.ok || !d.sessions) return;
    const s = findCurrentSession(d.sessions);
    STATE.polledSession = s
      ? { id: s.id, title: s.title, presenter: s.presenter, room: s.room, date: s.date, start: s.start }
      : null;
  } catch (e) {
    if (cfg.verbose) log("POLL ERROR", e.message);
  }
}

// ─── Heartbeat to PresenterHub (optional) ────────────────────────────────────
async function sendHeartbeat() {
  const cfg = readConfig();
  if (!cfg.presenterHubBase) return;
  try {
    await fetch(`${cfg.presenterHubBase}/api/agents/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        room: cfg.room || os.hostname(), type: "recordhub", pcname: os.hostname(),
        recording: STATE.recording, obsConnected: STATE.obsConnected,
        sessionId: STATE.currentSession?.id, sessionTitle: STATE.currentSession?.title,
      }),
      signal: AbortSignal.timeout(4000),
    });
    STATE.lastHeartbeatAt = Date.now();
  } catch {}
}

// ─── Recordings list ──────────────────────────────────────────────────────────
async function getRecordingsList() {
  const cfg = readConfig();
  const out = [];
  async function scan(dir) {
    let items;
    try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) { await scan(full); continue; }
      if (/\.(mkv|mp4|mov|avi|ts|flv)$/i.test(item.name)) {
        const st = await fsp.stat(full).catch(() => null);
        if (st) out.push({ name: item.name, size: st.size, sizeHuman: fmtBytes(st.size), created: st.birthtime || st.mtime });
      }
    }
  }
  await scan(cfg.recordingsRoot);
  return out.sort((a, b) => new Date(b.created) - new Date(a.created));
}

function fmtBytes(b) {
  if (b < 1024)       return b + " B";
  if (b < 1048576)    return (b / 1024).toFixed(1) + " KB";
  if (b < 1073741824) return (b / 1048576).toFixed(1) + " MB";
  return (b / 1073741824).toFixed(2) + " GB";
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────
function startServer() {
  ensureDirs();
  const cfg = readConfig();
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.static(PUBLIC_DIR));

  app.get("/",      (_, res) => res.sendFile(path.join(PUBLIC_DIR, "dashboard.html")));
  app.get("/setup", (_, res) => res.sendFile(path.join(PUBLIC_DIR, "setup.html")));

  // ── Status ──
  app.get("/api/status", async (_, res) => {
    let obsRec = { recording: false, duration: 0 };
    try {
      if (obs && STATE.obsConnected) {
        const r = await obs.call("GetRecordStatus");
        obsRec = { recording: r.outputActive, duration: r.outputDuration };
      }
    } catch {}
    res.json({
      ok: true,
      obsConnected: STATE.obsConnected, obsVersion: STATE.obsVersion,
      recording: STATE.recording, obsRecording: obsRec,
      currentSession: STATE.currentSession, polledSession: STATE.polledSession,
      recordingStartedAt: STATE.recordingStartedAt,
      lastPollAt: STATE.lastPollAt, lastHeartbeatAt: STATE.lastHeartbeatAt,
      totalRecordings: STATE.totalRecordings,
      errors: STATE.errors.slice(0, 10), lastOutputPath: STATE.lastOutputPath,
      uptime: process.uptime(),
    });
  });

  // ── Config ──
  app.get("/api/config", (_, res) => {
    const c = readConfig();
    if (c.obsPassword) c.obsPassword = "****";
    res.json({ ok: true, config: c });
  });
  app.post("/api/config", (req, res) => {
    try {
      writeConfig({ ...readConfig(), ...req.body });
      log("CONFIG SAVED");
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ── Manual recording (dashboard buttons / testing) ──
  app.post("/api/record/start", async (req, res) => {
    try {
      const { sessionId, title, presenter, room, date, start } = req.body || {};
      const c = readConfig();
      STATE.currentSession = {
        id: sessionId || "manual_" + Date.now(),
        title: title || "Manual Recording",
        presenter: presenter || "",
        room: room || c.room || "",
        date: date || new Date().toISOString().split("T")[0],
        start: start || new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
        startedAt: Date.now(),
      };
      if (STATE.obsConnected) {
        await showLowerThird(STATE.currentSession.title, STATE.currentSession.presenter, STATE.currentSession.start).catch(() => {});
      }
      await obsStartRecord();
      scheduleAutoStop();
      log("MANUAL START", STATE.currentSession.title);
      res.json({ ok: true, session: STATE.currentSession });
    } catch (e) {
      addError("Manual start: " + e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/record/stop", async (req, res) => {
    try {
      cancelAutoStop();
      hideLowerThird().catch(() => {});
      const outputPath = await obsStopRecord();
      const session = STATE.currentSession;
      STATE.currentSession = null;
      log("MANUAL STOP");
      res.json({ ok: true, outputPath, session });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Trigger endpoint — called by RoomAgent kiosk ──
  //
  //   POST /api/trigger  { "action": "start", "title": "...", "presenter": "...", "room": "...", "sessionId": "..." }
  //   POST /api/trigger  { "action": "stop" }
  //
  app.post("/api/trigger", async (req, res) => {
    try {
      const { action, sessionId, title, presenter, room, date, start } = req.body || {};
      const c = readConfig();

      if (action === "start") {
        // Stop any in-progress recording before starting a new one
        if (STATE.recording) {
          log("TRIGGER: stopping previous recording first");
          try { await obsStopRecord(); } catch {}
          await new Promise(r => setTimeout(r, 1500));
        }
        STATE.currentSession = {
          id: sessionId || "trigger_" + Date.now(),
          title: title || "Session",
          presenter: presenter || "",
          room: room || c.room || "",
          date: date || (() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,"0")}-${String(n.getDate()).padStart(2,"0")}`; })(),
          start: start || new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
          startedAt: Date.now(),
        };
        if (STATE.obsConnected) {
          await showLowerThird(STATE.currentSession.title, STATE.currentSession.presenter, STATE.currentSession.start).catch(() => {});
        }
        await obsStartRecord();
        scheduleAutoStop();
        log("TRIGGER START", STATE.currentSession.title, "— by", presenter || "unknown");
        res.json({ ok: true, session: STATE.currentSession });

      } else if (action === "stop") {
        cancelAutoStop();
        hideLowerThird().catch(() => {});
        const outputPath = await obsStopRecord();
        const session = STATE.currentSession;
        STATE.currentSession = null;
        log("TRIGGER STOP");
        res.json({ ok: true, outputPath, session });

      } else {
        res.status(400).json({ ok: false, error: 'action must be "start" or "stop"' });
      }
    } catch (e) {
      log("TRIGGER ERROR", e.message);
      addError("Trigger: " + e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Recordings ──
  app.get("/api/recordings", async (_, res) => {
    try {
      const recordings = await getRecordingsList();
      res.json({ ok: true, recordings, total: recordings.length });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ── OBS: reconnect ──
  app.post("/api/obs/reconnect", async (req, res) => {
    try {
      if (obs) { try { obs.disconnect(); } catch {} }
      await connectObs();
      res.json({ ok: true, connected: STATE.obsConnected, version: STATE.obsVersion });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── OBS: test lower third ──
  app.post("/api/obs/test-lower-third", async (_, res) => {
    if (!obs || !STATE.obsConnected) return res.json({ ok: false, error: "OBS not connected" });
    try {
      const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      await showLowerThird("Sample Session Title", "Presenter Name", t);
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Network info ──
  app.get("/api/network-info", (_, res) => {
    const c = readConfig();
    const ips = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list) {
        if (a.family === "IPv4" && !a.internal) ips.push(a.address);
      }
    }
    const recommended = ips.find(ip => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) || ips[0] || "localhost";
    res.json({ ok: true, ips, recommended, port: c.port, url: `http://${recommended}:${c.port}` });
  });

  // ── Health check ──
  app.get("/api/health", async (_, res) => {
    const c = readConfig();
    const checks = [];

    // OBS
    checks.push({
      key: "obs", label: "OBS Studio", ok: STATE.obsConnected,
      detail: STATE.obsConnected
        ? `Connected — OBS ${STATE.obsVersion}`
        : "Not connected — check Tools → WebSocket Server Settings in OBS",
    });

    // RoomAgent
    let raOk = false;
    let raDetail = c.roomAgentBase ? "Checking…" : "Not configured — set RoomAgent URL in Setup";
    if (c.roomAgentBase) {
      try {
        const r = await fetch(c.roomAgentBase + "/api/kiosk-data", { signal: AbortSignal.timeout(3000) });
        if (r.ok) {
          const d = await r.json();
          raOk = true;
          raDetail = `Connected — ${d.sessions?.length ?? 0} sessions loaded`;
        } else { raDetail = `HTTP ${r.status}`; }
      } catch (e) { raDetail = `Unreachable — ${e.message.split(":")[0]}`; }
    }
    checks.push({ key: "roomagent", label: "RoomAgent", ok: raOk, detail: raDetail });

    // Lower third (informational — auto-created on first recording start)
    let ltOk = false;
    let ltDetail = STATE.obsConnected ? "Will auto-create when recording starts" : "Waiting for OBS connection";
    if (STATE.obsConnected) {
      try {
        const { currentProgramSceneName: scene } = await obs.call("GetCurrentProgramScene");
        const { sceneItems } = await obs.call("GetSceneItemList", { sceneName: scene });
        const names = new Set(sceneItems.map(i => i.sourceName));
        ltOk = names.has(LT_BG) && names.has(LT_TEXT);
        ltDetail = ltOk
          ? `Ready in "${scene}" — click Test Lower Third to verify`
          : `Not in "${scene}" yet — auto-created when recording starts`;
      } catch {}
    }
    checks.push({ key: "lower-third", label: "Lower Third", ok: ltOk, detail: ltDetail });

    res.json({ ok: true, checks });
  });

  // ── Start ──
  app.listen(cfg.port, () => {
    log("RUNNING ON PORT", cfg.port);
    log("Dashboard:", `http://localhost:${cfg.port}`);
    log("Setup:    ", `http://localhost:${cfg.port}/setup`);
    log("Trigger:  ", `POST http://localhost:${cfg.port}/api/trigger`);
  });

  connectObs();
  setInterval(pollRoomAgent, 5000);
  setTimeout(pollRoomAgent, 3000);
  setInterval(sendHeartbeat, 30000);
  setTimeout(sendHeartbeat, 5000);
}

startServer();
