"use strict";
/**
 * RecordHub v2.1
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
const { exec, spawn } = require("child_process");
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
  introImagePath: "",      // path to PNG/JPG intro card shown before recording
  introDurationSecs: 4,   // seconds to display the intro card
  orgName: "",             // event/organisation name shown in lower third badge
  verbose: true,
};

// Fixed source name — browser source replacing old color-BG + GDI-text pair
const LT_SOURCE = "Lower Third";


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
  // Register listener BEFORE calling StartRecord to avoid the race condition
  // where RecordStateChanged fires before we're listening.
  await new Promise((resolve, reject) => {
    let done = false;

    const timeout = setTimeout(() => {
      if (done) return;
      done = true;
      obs.off("RecordStateChanged", handler);
      reject(new Error("Recording start confirmation timed out (5 s) — check OBS"));
    }, 5000);

    function handler(data) {
      if (done) return;
      if (data.outputState === "OBS_WEBSOCKET_OUTPUT_STARTED") {
        done = true;
        clearTimeout(timeout);
        obs.off("RecordStateChanged", handler);
        resolve();
      }
    }

    obs.on("RecordStateChanged", handler);

    obs.call("StartRecord").catch(err => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      obs.off("RecordStateChanged", handler);
      reject(err);
    });
  });

  STATE.recording = true;
  STATE.recordingStartedAt = Date.now();
  log("RECORDING STARTED (confirmed via RecordStateChanged)");
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
// Auto-injects into the current OBS program scene on every recording start.
// No pre-setup required. Hides automatically after 10 seconds.

let ltFadeTimer = null;

// Upsert a source into a scene.
//   kinds  — array of input kind strings to try in order (first that works wins)
//   settings — input settings object
// Strategy:
//   1. Probe with SetInputSettings — if it succeeds the source already exists globally.
//   2. If source doesn't exist, try CreateInput with each kind until one succeeds.
//   3. Once the source exists globally, ensure it's in this scene via GetSceneItemId
//      or CreateSceneItem.
async function upsertSource(scene, name, kinds, settings) {
  // Step 1: Probe — does this source already exist globally?
  let existsGlobally = false;
  try {
    await obs.call("SetInputSettings", { inputName: name, inputSettings: settings });
    existsGlobally = true;
    log("LT upsert: exists — updated settings for", name);
  } catch {
    // Source doesn't exist yet — we'll create it below
  }

  if (!existsGlobally) {
    // Step 2: Create source, trying each kind in order until one works
    let created = false;
    for (const kind of kinds) {
      try {
        const r = await obs.call("CreateInput", {
          sceneName: scene, inputName: name, inputKind: kind,
          inputSettings: settings, sceneItemEnabled: false,
        });
        log("LT upsert: created", name, "kind=" + kind, "id=" + r.sceneItemId);
        return r.sceneItemId;   // CreateInput also adds it to the scene, so we're done
      } catch (e) {
        log("LT upsert: kind", kind, "failed —", e.message);
      }
    }
    if (!created) {
      throw new Error(`Cannot create "${name}" — tried kinds: ${kinds.join(", ")}`);
    }
  }

  // Step 3: Source exists globally. Get its scene item in this scene.
  try {
    const { sceneItemId } = await obs.call("GetSceneItemId", { sceneName: scene, sourceName: name });
    log("LT upsert: found in scene —", name, "id=" + sceneItemId);
    return sceneItemId;
  } catch {
    // Not in this scene yet — add it
    const { sceneItemId } = await obs.call("CreateSceneItem", {
      sceneName: scene, sourceName: name, sceneItemEnabled: false,
    });
    log("LT upsert: added to scene —", name, "id=" + sceneItemId);
    return sceneItemId;
  }
}

async function showLowerThird(title, presenter) {
  if (!obs || !STATE.obsConnected) { log("LT SKIP: OBS not connected"); return; }

  log("LT: injecting browser source —", presenter, "/", title);
  try {
    const cfg = readConfig();

    // 1. Canvas size
    let W = 1920, H = 1080;
    try {
      const vs = await obs.call("GetVideoSettings");
      W = vs.baseWidth || W; H = vs.baseHeight || H;
    } catch (e) { log("LT: GetVideoSettings failed —", e.message); }
    log("LT: canvas =", W + "×" + H);

    // 2. Current scene
    const { currentProgramSceneName: scene } = await obs.call("GetCurrentProgramScene");
    STATE.ltScene = scene;
    log("LT: scene =", scene);

    // 3. Upsert browser source — full canvas size, URL points to /lower-third page
    const ltId = await upsertSource(scene, LT_SOURCE, ["browser_source"], {
      url:      `http://localhost:${cfg.port}/lower-third`,
      width:    W,
      height:   H,
      fps:      30,
      css:      "",
      shutdown: false,
    });

    // 4. Position at 0,0 covering full canvas (source is already 1920×1080)
    await obs.call("SetSceneItemTransform", {
      sceneName: scene, sceneItemId: ltId,
      sceneItemTransform: { positionX: 0, positionY: 0, alignment: 5, boundsType: "OBS_BOUNDS_NONE" },
    });

    // 5. Enable — the HTML page self-manages the 10s display and slide animation via polling
    await obs.call("SetSceneItemEnabled", { sceneName: scene, sceneItemId: ltId, sceneItemEnabled: true });
    log("LT: browser source enabled — HTML manages display timing");
  } catch (e) {
    log("LT ERROR:", e.message);
    addError("Lower third error: " + e.message);
  }
}

async function hideLowerThird() {
  // The browser source page detects recording state via /api/lower-third polling and
  // hides itself. This function is a no-op kept for call-site compatibility.
  if (ltFadeTimer) { clearTimeout(ltFadeTimer); ltFadeTimer = null; }
  log("LT: hide (browser source self-manages via polling)");
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
    if (cfg.autoRemuxToMp4 && ext.toLowerCase() === ".mkv") {
      remuxToMp4(dest, finalPath => { if (cfg.introImagePath) makeWebReady(finalPath, s, cfg); });
    } else {
      if (cfg.introImagePath) makeWebReady(dest, s, cfg);
    }
  } catch (e) {
    log("RECORDING SAVE ERROR", e.message);
    addError("Recording save error: " + e.message);
  }
}

function remuxToMp4(mkvPath, onDone) {
  const mp4 = mkvPath.replace(/\.mkv$/i, ".mp4");
  exec(`ffmpeg -i "${mkvPath}" -codec copy "${mp4}" -y`, { windowsHide: true }, (err) => {
    if (!err) {
      log("REMUXED", path.basename(mp4));
      if (onDone) onDone(mp4);
    } else {
      log("REMUX SKIP (ffmpeg not found)");
      if (onDone) onDone(mkvPath); // fall back to original
    }
  });
}

// ─── Video dimensions (for intro card scaling) ────────────────────────────────
function getVideoDimensions(filePath) {
  return new Promise(resolve => {
    exec(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${filePath}"`,
      { windowsHide: true, timeout: 10000 },
      (_err, stdout) => {
        const parts = (stdout || "").trim().split("x");
        resolve({ w: parseInt(parts[0]) || 1920, h: parseInt(parts[1]) || 1080 });
      }
    );
  });
}

// ─── Web-ready export ─────────────────────────────────────────────────────────
// Prepends an intro card image (with crossfade) to the recording and saves a
// _web.mp4 file alongside the original. Uses spawn to avoid shell quoting
// issues with the filter_complex string.
async function makeWebReady(sourcePath, session, cfg) {
  const introPath = cfg.introImagePath;
  if (!introPath) return;
  if (!fs.existsSync(introPath)) {
    log("WEB READY SKIP: intro image not found —", introPath);
    addError("Web ready: intro image not found: " + introPath);
    return;
  }

  const dur       = Math.max(1, Number(cfg.introDurationSecs) || 4);
  const fadeStart = Math.max(0, dur - 1);
  const audioDelay = dur * 1000; // ms

  const ext     = path.extname(sourcePath);
  const webPath = sourcePath.slice(0, -ext.length) + "_web.mp4";

  const { w, h } = await getVideoDimensions(sourcePath);

  // Filter: scale+pad intro to match recording canvas, fade out → concat → fade in
  const filterStr = [
    `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,` +
      `fade=t=out:st=${fadeStart}:d=1[intro_v]`,
    `[1:v]fade=t=in:st=0:d=1[rec_v]`,
    `[intro_v][rec_v]concat=n=2:v=1:a=0[v]`,
    `[1:a]adelay=${audioDelay}|${audioDelay}[a]`,
  ].join(";");

  const args = [
    "-loop", "1", "-framerate", "30", "-t", String(dur),
    "-i", introPath,
    "-i", sourcePath,
    "-filter_complex", filterStr,
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "fast", "-crf", "22",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    "-y", webPath,
  ];

  log("WEB READY: encoding", path.basename(sourcePath), "→", path.basename(webPath));
  const proc = spawn("ffmpeg", args, { windowsHide: true });
  proc.stderr.on("data", () => {}); // consume stderr so process doesn't block
  proc.on("close", code => {
    if (code === 0) log("WEB READY: done →", path.basename(webPath));
    else { log("WEB READY FAILED exit=" + code); addError("Web ready failed: " + path.basename(sourcePath)); }
  });
  proc.on("error", e => {
    log("WEB READY ERROR:", e.message);
    addError("Web ready: " + e.message);
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

  // ── Lower third browser source page + data API ──
  app.get("/lower-third", (_, res) => res.sendFile(path.join(PUBLIC_DIR, "lower-third.html")));
  app.get("/api/lower-third", (_, res) => {
    const cfg = readConfig();
    const s   = STATE.currentSession;
    res.json({
      ok:        true,
      recording: STATE.recording,
      presenter: s?.presenter || "",
      title:     s?.title     || "",
      org:       cfg.orgName  || "",
    });
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
        await showLowerThird(STATE.currentSession.title, STATE.currentSession.presenter).catch(() => {});
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
          await showLowerThird(STATE.currentSession.title, STATE.currentSession.presenter).catch(() => {});
        }
        await obsStartRecord();
        scheduleAutoStop();
        log("TRIGGER START", STATE.currentSession.title, "— by", presenter || "unknown");
        res.json({ ok: true, recording: true, session: STATE.currentSession });

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

  // ── OBS: debug — shows exactly what's in OBS right now ──
  app.get("/api/obs/debug", async (_, res) => {
    if (!obs || !STATE.obsConnected) return res.json({ ok: false, error: "OBS not connected" });
    const out = { ok: true };
    try {
      const vs = await obs.call("GetVideoSettings");
      out.canvas = { w: vs.baseWidth, h: vs.baseHeight };
    } catch (e) { out.canvas = { error: e.message }; }
    try {
      const { currentProgramSceneName } = await obs.call("GetCurrentProgramScene");
      out.currentScene = currentProgramSceneName;
      const { sceneItems } = await obs.call("GetSceneItemList", { sceneName: currentProgramSceneName });
      out.sceneItems = sceneItems.map(i => ({
        name: i.sourceName, kind: i.inputKind, index: i.sceneItemIndex, enabled: i.sceneItemEnabled,
      }));
    } catch (e) { out.sceneError = e.message; }
    try {
      const { inputKinds } = await obs.call("GetInputKindList", { unversioned: false });
      out.relevantKinds = inputKinds.filter(k => /color|text|gdiplus|ft2/i.test(k));
    } catch (e) { out.kindsError = e.message; }
    res.json(out);
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
  // Returns step-by-step results so failures are visible in the UI.
  app.post("/api/obs/test-lower-third", async (_, res) => {
    if (!obs || !STATE.obsConnected) return res.json({ ok: false, error: "OBS not connected" });
    const steps = [];
    const step = (ok, msg) => { steps.push({ ok, msg }); log("LT TEST:", ok ? "OK" : "FAIL", msg); };

    try {
      // Canvas
      let W = 1920, H = 1080;
      try {
        const vs = await obs.call("GetVideoSettings");
        W = vs.baseWidth || W; H = vs.baseHeight || H;
        step(true, `Canvas: ${W}×${H}`);
      } catch (e) { step(false, `GetVideoSettings failed: ${e.message}`); }

      // Scene
      let scene;
      try {
        ({ currentProgramSceneName: scene } = await obs.call("GetCurrentProgramScene"));
        step(true, `Scene: "${scene}"`);
      } catch (e) { step(false, `GetCurrentProgramScene failed: ${e.message}`); return res.json({ ok: false, steps }); }

      // Kinds — confirm browser_source is available
      try {
        const { inputKinds } = await obs.call("GetInputKindList", { unversioned: false });
        const hasBrowser = inputKinds.includes("browser_source");
        step(hasBrowser, `browser_source available: ${hasBrowser}`);
      } catch (e) { step(false, `GetInputKindList failed: ${e.message}`); }

      // Inject
      try {
        await showLowerThird("Sample Session Title", "Presenter Name");
        step(true, "Lower third browser source injected — check OBS preview");
      } catch (e) { step(false, "showLowerThird threw: " + e.message); }

      // Verify source now in scene
      try {
        const { sceneItems } = await obs.call("GetSceneItemList", { sceneName: scene });
        const item = sceneItems.find(i => i.sourceName === LT_SOURCE);
        step(!!item, `"${LT_SOURCE}" in scene: ${!!item}`);
        if (item) step(item.sceneItemEnabled, `"${LT_SOURCE}" enabled: ${item.sceneItemEnabled}`);
      } catch (e) { step(false, "Scene item verification failed: " + e.message); }

      const allOk = steps.every(s => s.ok);
      res.json({ ok: allOk, steps });
    } catch (e) {
      step(false, "Unexpected error: " + e.message);
      res.json({ ok: false, steps });
    }
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
        ltOk = names.has(LT_SOURCE);
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
