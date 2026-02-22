"use strict";

/**
 * RecordHub — Automated Session Recording Sidecar
 *
 * Controls OBS Studio via WebSocket to automatically record event sessions.
 * Triggered by RoomAgent kiosk session lifecycle, time-based polling, or
 * direct HTTP trigger from a room PC.
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
  slidesUrl: "",          // browser source URL, e.g. http://10.0.0.X:3199/kiosk
  slidesMonitor: 0,       // fallback if slidesUrl is blank
  cameraDevice: "",
  canvasWidth: 1920,
  canvasHeight: 1080,
  sessionDurationMins: 90, // auto-stop recording after this many minutes
  verbose: true,
};

// ─── State ───
const STATE = {
  obsConnected: false,
  obsVersion: null,
  recording: false,
  currentSession: null,        // { id, title, presenter, room, date, start, startedAt }
  lastStoppedSessionId: null,  // prevents poll from restarting a session that was manually stopped
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
    const OBSWebSocket = require("obs-websocket-js").default || require("obs-websocket-js");
    obs = new OBSWebSocket();

    await obs.connect(cfg.obsWebSocketUrl, cfg.obsPassword || undefined);
    STATE.obsConnected = true;

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
      setTimeout(connectObs, 5000);
    });

    obs.on("ConnectionError", (err) => {
      log("OBS CONNECTION ERROR", err.message);
      STATE.obsConnected = false;
      addError("OBS connection error: " + err.message);
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
    const result = await obs.call("StopRecord");
    STATE.recording = false;
    log("RECORDING STOPPED", result.outputPath || "");
    return result.outputPath || null;
  } catch (e) {
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

async function obsSwitchScene(sceneName) {
  if (!obs || !STATE.obsConnected) return;
  try {
    await obs.call("SetCurrentProgramScene", { sceneName });
    log("SCENE SWITCHED", sceneName);
  } catch (e) {
    log("SCENE SWITCH SKIP", e.message);
  }
}

// ─── Lower Third (show on session start, fade out after 10 s) ───
let lowerThirdFadeTimer = null;

async function obsShowLowerThird(title, presenter, startTime, durationMs = 10_000) {
  if (!obs || !STATE.obsConnected) { log("LOWER THIRD SKIP: OBS not connected"); return; }
  const cfg = readConfig();

  if (lowerThirdFadeTimer) {
    clearTimeout(lowerThirdFadeTimer);
    lowerThirdFadeTimer = null;
  }

  const parts = [presenter, title, startTime].filter(Boolean);
  const text = parts.join("  ·  ");

  const SCENE = cfg.pipSceneName;
  log("LOWER THIRD: scene=", SCENE, "source=", cfg.titleSourceName, "text=", text);

  try {
    // Update text content.
    // If the source doesn't exist yet, auto-build the scene then retry once.
    try {
      await obs.call("SetInputSettings", {
        inputName: cfg.titleSourceName,
        inputSettings: { text },
      });
      log("LOWER THIRD: text set OK");
    } catch (e) {
      if (/not found|no source/i.test(e.message || "")) {
        log("LOWER THIRD: source missing — running scene auto-setup");
        try { await obsSetupScenes(); } catch (se) { log("LOWER THIRD: auto-setup error —", se.message); }
        // Retry after setup
        await obs.call("SetInputSettings", {
          inputName: cfg.titleSourceName,
          inputSettings: { text },
        });
        log("LOWER THIRD: text set OK (after auto-setup)");
      } else {
        throw e;
      }
    }

    // Reveal: remove any blocking opacity filter then enable scene items.
    // We don't rely on filter opacity — it varies by OBS version (0-1 vs 0-100)
    // and silently fails, leaving sources invisible. SetSceneItemEnabled is reliable.
    for (const srcName of [cfg.titleSourceName, "Lower Third BG"]) {
      try { await obs.call("RemoveSourceFilter", { sourceName: srcName, filterName: "Fade" }); } catch {}
      try {
        const { sceneItemId } = await obs.call("GetSceneItemId", { sceneName: SCENE, sourceName: srcName });
        await obs.call("SetSceneItemEnabled", { sceneName: SCENE, sceneItemId, sceneItemEnabled: true });
        log("LOWER THIRD: enabled", srcName, "sceneItemId=" + sceneItemId);
      } catch (e) {
        log("LOWER THIRD: FAILED to enable", srcName, "—", e.message);
      }
    }

    log("LOWER THIRD SHOWN for", durationMs / 1000 + "s —", text);

    // Schedule fade-out
    lowerThirdFadeTimer = setTimeout(() => fadeOutLowerThird(cfg), durationMs);
  } catch (e) {
    log("LOWER THIRD SHOW SKIP", e.message);
  }
}

async function fadeOutLowerThird(cfg) {
  if (!obs || !STATE.obsConnected) return;
  lowerThirdFadeTimer = null;

  const SCENE = cfg.pipSceneName;

  for (const srcName of [cfg.titleSourceName, "Lower Third BG"]) {
    try {
      const { sceneItemId } = await obs.call("GetSceneItemId", { sceneName: SCENE, sourceName: srcName });
      await obs.call("SetSceneItemEnabled", { sceneName: SCENE, sceneItemId, sceneItemEnabled: false });
    } catch {}
  }

  log("LOWER THIRD HIDDEN");
}

// ─── OBS Scene Setup ───
async function obsSetupScenes() {
  if (!obs || !STATE.obsConnected) throw new Error("OBS not connected");
  const cfg = readConfig();

  const SCENE   = cfg.pipSceneName;
  const W       = cfg.canvasWidth  || 1920;
  const H       = cfg.canvasHeight || 1080;
  const SLIDES  = "Slides";
  const CAM     = "Presenter Cam";
  const LT_BG   = "Lower Third BG";
  const LT_TEXT = cfg.titleSourceName;

  const PIP_W = 320, PIP_H = 180, PIP_PAD = 24;
  const PIP_X = W - PIP_W - PIP_PAD;
  const PIP_Y = H - PIP_H - PIP_PAD;
  const LT_H  = 90;
  const LT_Y  = H - LT_H - 10;

  // ── Detect what OBS actually has installed ──
  let kinds = new Set();
  try {
    const { inputKinds } = await obs.call("GetInputKindList", { unversioned: false });
    kinds = new Set(inputKinds);
    log("OBS SETUP: available kinds →", [...kinds].join(", "));
  } catch (e) {
    log("OBS SETUP: could not get input kinds —", e.message);
  }

  const pick = (...candidates) => candidates.find(k => kinds.has(k)) || candidates[0];

  const colorKind  = pick("color_source_v3", "color_source_v2", "color_source");
  const textKind   = pick("text_gdiplus", "text_ft2_source", "text_gdiplus_v2");
  const camKind    = pick("dshow_input", "av_capture_input_v2", "av_capture_input", "v4l2_input");
  const hasBrowser = kinds.size === 0 || kinds.has("browser_source"); // assume available if list empty

  // Detect available filter kinds
  let filterKinds = new Set();
  try {
    const fk = await obs.call("GetSourceFilterKindList");
    filterKinds = new Set(fk.sourceFilterKinds || []);
  } catch {}
  const fadeFilterKind = (filterKinds.size === 0 || filterKinds.has("color_filter_v2"))
    ? "color_filter_v2" : "color_filter";

  log("OBS SETUP: using →", { colorKind, textKind, camKind, hasBrowser, fadeFilterKind });

  // ── helpers ──

  // Upsert: create the input if it doesn't exist, otherwise update its settings.
  // Returns the sceneItemId so transforms can be applied immediately.
  // This avoids "source already exists" errors when rebuilding the scene.
  async function upsertInput(inName, inKind, inSettings, enabled) {
    try {
      // Happy path: source doesn't exist yet
      const r = await obs.call("CreateInput", {
        sceneName: SCENE, inputName: inName, inputKind: inKind,
        inputSettings: inSettings, sceneItemEnabled: enabled,
      });
      return r.sceneItemId;
    } catch {
      // Source already exists — update its settings instead
      try { await obs.call("SetInputSettings", { inputName: inName, inputSettings: inSettings }); } catch {}
      // Get or add its scene item in this scene
      try {
        const { sceneItemId } = await obs.call("GetSceneItemId", { sceneName: SCENE, sourceName: inName });
        try { await obs.call("SetSceneItemEnabled", { sceneName: SCENE, sceneItemId, sceneItemEnabled: enabled !== false }); } catch {}
        return sceneItemId;
      } catch {
        // Not in this scene yet — add it
        const { sceneItemId } = await obs.call("CreateSceneItem", {
          sceneName: SCENE, sourceName: inName, sceneItemEnabled: enabled,
        });
        return sceneItemId;
      }
    }
  }

  async function addFadeFilter(srcName) {
    try { await obs.call("RemoveSourceFilter", { sourceName: srcName, filterName: "Fade" }); } catch {}
    await obs.call("CreateSourceFilter", {
      sourceName: srcName,
      filterName: "Fade",
      filterKind: fadeFilterKind,
      filterSettings: { opacity: 0.0 },
    });
  }

  // ── 1. Create scene if it doesn't exist (idempotent) ──
  try {
    await obs.call("CreateScene", { sceneName: SCENE });
    log("OBS SETUP: scene created —", SCENE);
  } catch {
    log("OBS SETUP: scene already exists — updating sources in place");
  }

  const warnings = [];

  // ── 2. Slides ──
  // Only create the software Slides source if a slidesUrl is configured.
  // Users feeding slides via a hardware capture card (HDMI from RoomPC) manage
  // that source themselves — Build Scene should not touch or recreate it.
  let slidesKind = null;
  if (cfg.slidesUrl) {
    let slidesSettings;
    if (hasBrowser) {
      slidesKind = "browser_source";
      slidesSettings = {
        url: cfg.slidesUrl,
        width: W, height: H, fps: 30,
        css: "body{margin:0;overflow:hidden;background:transparent}",
        reroute_audio: false, shutdown: false, restart_when_active: false,
      };
    } else {
      warnings.push("browser_source not found in OBS — using monitor capture. Install obs-browser to use the kiosk URL.");
      slidesKind = "monitor_capture";
      slidesSettings = { monitor: cfg.slidesMonitor ?? 0 };
    }
    const slidesId = await upsertInput(SLIDES, slidesKind, slidesSettings, true);
    await obs.call("SetSceneItemTransform", {
      sceneName: SCENE, sceneItemId: slidesId,
      sceneItemTransform: { positionX: 0, positionY: 0, alignment: 5,
        boundsType: "OBS_BOUNDS_SCALE_INNER", boundsWidth: W, boundsHeight: H },
    });
    log("OBS SETUP: slides →", slidesKind, cfg.slidesUrl);
  } else {
    log("OBS SETUP: skipping Slides source — no slidesUrl configured (capture card in use)");
  }

  // ── 3. Presenter Cam PiP ──
  try {
    const camSettings = {};
    if (cfg.cameraDevice) camSettings.video_device_id = cfg.cameraDevice;
    const camId = await upsertInput(CAM, camKind, camSettings, true);
    await obs.call("SetSceneItemTransform", {
      sceneName: SCENE, sceneItemId: camId,
      sceneItemTransform: { positionX: PIP_X, positionY: PIP_Y, alignment: 5,
        boundsType: "OBS_BOUNDS_SCALE_INNER", boundsWidth: PIP_W, boundsHeight: PIP_H },
    });
    log("OBS SETUP: camera PiP →", camKind, `${PIP_W}×${PIP_H} at (${PIP_X},${PIP_Y})`);
  } catch (e) {
    warnings.push("Camera source skipped: " + e.message + " — connect camera and re-run setup.");
    log("OBS SETUP: camera skip —", e.message);
  }

  // ── 4. Lower Third BG ──
  const ltBgId = await upsertInput(LT_BG, colorKind, { color: 3422552064 }, false);
  await obs.call("SetSceneItemTransform", {
    sceneName: SCENE, sceneItemId: ltBgId,
    sceneItemTransform: { positionX: 0, positionY: LT_Y, alignment: 5,
      boundsType: "OBS_BOUNDS_STRETCH", boundsWidth: W, boundsHeight: LT_H },
  });
  // Remove any old opacity-blocking "Fade" filter left from previous setups
  try { await obs.call("RemoveSourceFilter", { sourceName: LT_BG,   filterName: "Fade" }); } catch {}

  // ── 5. Lower Third text — 40 px to fit presenter · title · time ──
  // color + color1: white for both text_gdiplus (v1 uses "color") and text_gdiplus_v2 (uses "color1").
  const ltTextId = await upsertInput(LT_TEXT, textKind, {
    text: "",
    font: { face: "Arial", size: 40, style: "Bold", flags: 0 },
    color: 4294967295, color1: 4294967295, outline: true,
    outline_color: 4278190080, outline_size: 3,
    extents: true, extents_cx: W - 60, extents_cy: LT_H - 16, extents_wrap: false,
  }, false);
  await obs.call("SetSceneItemTransform", {
    sceneName: SCENE, sceneItemId: ltTextId,
    sceneItemTransform: { positionX: 30, positionY: LT_Y + 12, alignment: 5,
      boundsType: "OBS_BOUNDS_NONE" },
  });
  try { await obs.call("RemoveSourceFilter", { sourceName: LT_TEXT, filterName: "Fade" }); } catch {}

  // ── 6. Ensure text renders ABOVE the BG ──
  // If setup was run before and sources already existed, upsertInput doesn't change their
  // z-order in the scene. The BG may end up on top, covering the text (blue box, no text).
  // Explicitly move LT_TEXT above LT_BG after both are created/retrieved.
  try {
    const { sceneItems } = await obs.call("GetSceneItemList", { sceneName: SCENE });
    const bgItem   = sceneItems.find(i => i.sourceName === LT_BG);
    const textItem = sceneItems.find(i => i.sourceName === LT_TEXT);
    if (bgItem && textItem && textItem.sceneItemIndex <= bgItem.sceneItemIndex) {
      await obs.call("SetSceneItemIndex", {
        sceneName: SCENE,
        sceneItemId: ltTextId,
        sceneItemIndex: bgItem.sceneItemIndex + 1,
      });
      log("OBS SETUP: reordered — text now above BG");
    }
  } catch (e) {
    log("OBS SETUP: z-order check failed —", e.message);
  }

  log("OBS SETUP: complete —", SCENE, "ready");
  if (warnings.length) warnings.forEach(w => log("OBS SETUP WARNING:", w));
  return { scene: SCENE, slidesKind, camKind, colorKind, textKind, fadeFilterKind, warnings };
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
    const date = (s.date || "").replace(/-/g, "");
    const time = (s.start || "").replace(/[: ]/g, "").replace(/AM|PM/gi, "");
    const presenter = sanitizeFilename(s.presenter || "Unknown");
    const title = sanitizeFilename(s.title || "Session");
    const ext = path.extname(outputPath);
    const newName = `${date}_${time}_${presenter}_${title}${ext}`;

    const roomDir = path.join(cfg.recordingsRoot, sanitizeFilename(s.room || cfg.room || "Room"));
    const dateDir = path.join(roomDir, s.date || "undated");
    await fsp.mkdir(dateDir, { recursive: true });

    const destPath = path.join(dateDir, newName);

    try {
      await fsp.rename(outputPath, destPath);
      log("RECORDING MOVED", destPath);
    } catch {
      await fsp.copyFile(outputPath, destPath);
      await fsp.unlink(outputPath);
      log("RECORDING COPIED", destPath);
    }

    STATE.totalRecordings++;
    STATE.lastOutputPath = destPath;

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
  const cmd = `ffmpeg -i "${mkvPath}" -codec copy "${mp4Path}" -y`;
  exec(cmd, { windowsHide: true }, (err) => {
    if (err) {
      log("REMUX SKIP (ffmpeg not available)", path.basename(mkvPath));
    } else {
      log("REMUXED TO MP4", path.basename(mp4Path));
    }
  });
}

// ─── Auto-stop timer ───
let autoStopTimer = null;

function scheduleAutoStop(mins) {
  if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; }
  if (!mins || mins <= 0) return;
  autoStopTimer = setTimeout(async () => {
    if (!STATE.recording) return;
    log("AUTO-STOP: max duration reached (" + mins + " min)");
    try { await obsStopRecord(); } catch (e) { log("AUTO-STOP ERROR", e.message); }
    STATE.currentSession = null;
  }, mins * 60 * 1000);
  log("AUTO-STOP scheduled in", mins, "min");
}

function cancelAutoStop() {
  if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; }
}

// ─── Session Detection ───
let pollTimer = null;
let heartbeatTimer = null;

function parseTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const t = timeStr.trim();
  const m12 = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (m12) {
    let h = parseInt(m12[1], 10);
    const min = parseInt(m12[2], 10);
    if (m12[3].toUpperCase() === "PM" && h !== 12) h += 12;
    if (m12[3].toUpperCase() === "AM" && h === 12) h = 0;
    return new Date(`${dateStr}T${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:00`);
  }
  const m24 = t.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) {
    return new Date(`${dateStr}T${t}:00`);
  }
  return null;
}

// Returns { session, nextStart } — nextStart is the Date the next session begins,
// or null if this is the last session of the day.
function findCurrentSession(sessions) {
  if (!sessions || !sessions.length) return { session: null, nextStart: null };
  const now = new Date();
  // Use LOCAL date, not UTC. toISOString() gives UTC which in US timezones flips
  // to "tomorrow" in the afternoon, causing all sessions to be filtered out.
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  const today = sessions
    .filter(s => (s.date || "") === todayStr)
    .map(s => ({ ...s, _startDt: parseTime(s.date, s.start) }))
    .filter(s => s._startDt)
    .sort((a, b) => a._startDt - b._startDt);

  if (!today.length) return { session: null, nextStart: null };

  for (let i = 0; i < today.length; i++) {
    const s = today[i];
    const nextStart = today[i + 1] ? today[i + 1]._startDt : null;
    if (now >= s._startDt) {
      if (!nextStart || now < nextStart) {
        return { session: s, nextStart };
      }
    }
  }
  return { session: null, nextStart: null };
}

async function pollRoomAgent() {
  const cfg = readConfig();

  // Skip polling if roomAgentBase is the install placeholder
  if (!cfg.roomAgentBase || /10\.0\.0\.X/i.test(cfg.roomAgentBase)) {
    if (cfg.verbose) log("POLL SKIP: roomAgentBase not configured — set it in /setup");
    return;
  }

  try {
    const res = await fetch(`${cfg.roomAgentBase}/api/kiosk-data`, {
      signal: AbortSignal.timeout(4000),
    });
    const data = await res.json();
    STATE.lastPollAt = Date.now();

    if (!data.ok || !data.sessions) return;

    const { session: current, nextStart } = findCurrentSession(data.sessions);

    // When session time passes, reset the manual-stop guard so the next session can auto-start.
    if (!current) STATE.lastStoppedSessionId = null;

    if (current && (!STATE.currentSession || STATE.currentSession.id !== current.id)
        && current.id !== STATE.lastStoppedSessionId) {
      if (STATE.recording) {
        log("SESSION CHANGED — stopping previous recording");
        cancelAutoStop();
        try { await obsStopRecord(); } catch (e) { log("STOP ERROR", e.message); }
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
          await obsShowLowerThird(current.title, current.presenter, current.start);
          await obsStartRecord();

          // Stop precisely when next session begins; fall back to fixed duration
          if (nextStart) {
            const msUntil = nextStart - Date.now();
            if (msUntil > 0) {
              cancelAutoStop();
              autoStopTimer = setTimeout(async () => {
                if (!STATE.recording) return;
                log("AUTO-STOP: next session starting at", nextStart.toLocaleTimeString());
                try { await obsStopRecord(); } catch (e) { log("AUTO-STOP ERROR", e.message); }
                STATE.currentSession = null;
              }, msUntil);
              log("AUTO-STOP scheduled at", nextStart.toLocaleTimeString(), `(${Math.round(msUntil / 60000)} min)`);
            }
          } else {
            // Last session of the day — use configured max duration
            scheduleAutoStop(cfg.sessionDurationMins);
          }
        } catch (e) {
          log("AUTO-START ERROR", e.message);
          addError("Auto-start recording failed: " + e.message);
        }
      }
    } else if (!current && STATE.currentSession && STATE.recording) {
      log("SESSION ENDED — stopping recording");
      cancelAutoStop();
      try { await obsStopRecord(); } catch (e) { log("STOP ERROR", e.message); }
      STATE.currentSession = null;
    }
  } catch (e) {
    if (cfg.verbose) log("POLL ERROR", cfg.roomAgentBase, "—", e.message);
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
        sessionTitle: STATE.currentSession ? STATE.currentSession.title : null,
        sessionPresenter: STATE.currentSession ? STATE.currentSession.presenter : null,
        obsConnected: STATE.obsConnected,
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
          duration: null,
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

  // ── Pages ──
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
        await obsShowLowerThird(STATE.currentSession.title, STATE.currentSession.presenter, STATE.currentSession.start);
      }
      await obsStartRecord();
      scheduleAutoStop(cfg.sessionDurationMins);

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
      cancelAutoStop();
      const outputPath = await obsStopRecord();
      const session = STATE.currentSession;
      STATE.lastStoppedSessionId = session?.id || null;
      STATE.currentSession = null;
      log("MANUAL STOP");
      res.json({ ok: true, outputPath, session });
    } catch (e) {
      log("MANUAL STOP ERROR", e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── API: Remote Trigger (called by room PC / RoomAgent) ──
  //
  //   POST /api/trigger  { "action": "start", "title": "...", "presenter": "...", "room": "..." }
  //   POST /api/trigger  { "action": "stop" }
  //
  app.post("/api/trigger", async (req, res) => {
    try {
      const { action, sessionId, title, presenter, room, date, start } = req.body || {};
      const cfg = readConfig();

      if (action === "start") {
        if (STATE.recording) {
          log("TRIGGER: stopping previous recording before new session");
          try { await obsStopRecord(); } catch {}
          await new Promise(r => setTimeout(r, 1500));
        }

        STATE.currentSession = {
          id: sessionId || "trigger_" + Date.now(),
          title: title || "Session",
          presenter: presenter || "",
          room: room || cfg.room || "",
          date: date || new Date().toISOString().split("T")[0],
          start: start || new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
          startedAt: Date.now(),
        };

        if (STATE.obsConnected) {
          await obsSwitchScene(cfg.pipSceneName);
          await obsShowLowerThird(STATE.currentSession.title, STATE.currentSession.presenter, STATE.currentSession.start);
        }
        await obsStartRecord();
        scheduleAutoStop(cfg.sessionDurationMins);

        log("TRIGGER START", STATE.currentSession.title, "— by", presenter || "unknown");
        res.json({ ok: true, session: STATE.currentSession });

      } else if (action === "stop") {
        cancelAutoStop();
        const outputPath = await obsStopRecord();
        const session = STATE.currentSession;
        STATE.lastStoppedSessionId = session?.id || null;
        STATE.currentSession = null;
        log("TRIGGER STOP");
        res.json({ ok: true, outputPath, session });

      } else {
        res.status(400).json({ ok: false, error: 'action must be "start" or "stop"' });
      }
    } catch (e) {
      log("TRIGGER ERROR", e.message);
      addError("Trigger error: " + e.message);
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

  // ── API: Detect monitors and cameras from OBS ──
  app.get("/api/obs/sources", async (_req, res) => {
    if (!obs || !STATE.obsConnected)
      return res.json({ ok: false, error: "OBS not connected" });

    const result = { cameras: [], monitors: [] };

    // Monitors — GetMonitorList added in OBS 29+
    try {
      const { monitors } = await obs.call("GetMonitorList");
      result.monitors = monitors.map(m => ({
        id: m.monitorIndex,
        name: m.monitorName || `Monitor ${m.monitorIndex + 1}`,
        width: m.monitorWidth,
        height: m.monitorHeight,
      }));
    } catch {
      // OBS < 29 fallback — provide numbered options
      result.monitors = [
        { id: 0, name: "Monitor 1 (Primary)" },
        { id: 1, name: "Monitor 2" },
        { id: 2, name: "Monitor 3" },
      ];
    }

    // Cameras — enumerate DirectShow devices via a temporary dshow_input probe
    const PROBE = "__rh_cam_probe__";
    let probeCreated = false;
    let queryName = null;

    try {
      // Prefer an already-existing dshow_input so we don't create temp sources
      const { inputs } = await obs.call("GetInputList", { inputKind: "dshow_input" });
      const existing = (inputs || []).find(i => i.inputName !== PROBE);
      if (existing) queryName = existing.inputName;
    } catch {}

    if (!queryName) {
      try {
        const { currentProgramSceneName } = await obs.call("GetCurrentProgramScene");
        await obs.call("CreateInput", {
          sceneName: currentProgramSceneName,
          inputName: PROBE,
          inputKind: "dshow_input",
          inputSettings: {},
          sceneItemEnabled: false,
        });
        queryName = PROBE;
        probeCreated = true;
        // Give DirectShow a moment to enumerate devices
        await new Promise(r => setTimeout(r, 600));
      } catch {}
    }

    if (queryName) {
      try {
        const { propertyItems } = await obs.call("GetInputPropertiesListPropertyItems", {
          inputName: queryName,
          propertyName: "video_device_id",
        });
        result.cameras = (propertyItems || []).map(p => ({
          id: p.itemValue,
          name: p.itemName,
        }));
      } catch {}
      if (probeCreated) {
        try { await obs.call("RemoveInput", { inputName: PROBE }); } catch {}
      }
    }

    res.json({ ok: true, ...result });
  });

  // ── API: Build OBS scenes ──
  app.post("/api/obs/setup-scenes", async (_req, res) => {
    try {
      const result = await obsSetupScenes();
      res.json({ ok: true, ...result });
    } catch (e) {
      log("SETUP SCENES ERROR", e.message);
      addError("Scene setup failed: " + e.message);
      res.status(500).json({ ok: false, error: e.message });
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

  // ── API: Network Info (LAN IP self-announcement) ──
  app.get("/api/network-info", (_req, res) => {
    const cfg = readConfig();
    const ifaces = os.networkInterfaces();
    const ips = [];
    for (const list of Object.values(ifaces)) {
      for (const addr of list) {
        if (addr.family === "IPv4" && !addr.internal) ips.push(addr.address);
      }
    }
    const recommended =
      ips.find(ip => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) ||
      ips[0] || "localhost";
    const port = cfg.port || 3299;
    res.json({ ok: true, ips, recommended, port, url: `http://${recommended}:${port}` });
  });

  // ── API: Health Check ──
  app.get("/api/health", async (_req, res) => {
    const cfg = readConfig();
    const checks = [];

    // OBS connection
    checks.push({
      key: "obs", label: "OBS Studio", ok: STATE.obsConnected,
      detail: STATE.obsConnected
        ? `Connected — OBS ${STATE.obsVersion || ""}`
        : "Not connected — check WebSocket URL and password",
      action: STATE.obsConnected ? null : "test-obs",
    });

    // Scene + sources
    let sceneNames = [];
    if (STATE.obsConnected) {
      try {
        const { sceneItems } = await obs.call("GetSceneItemList", { sceneName: cfg.pipSceneName });
        sceneNames = sceneItems.map(i => i.sourceName);
      } catch {}
    }
    const sceneOk = sceneNames.length > 0;

    checks.push({
      key: "scene", label: "Recording Scene", ok: sceneOk,
      detail: sceneOk
        ? `"${cfg.pipSceneName}" — ${sceneNames.length} sources`
        : `Scene "${cfg.pipSceneName}" not found — click Build OBS Scenes`,
      action: sceneOk ? null : "build-scene",
    });

    const slidesOk = sceneNames.includes("Slides");
    checks.push({
      key: "slides", label: "Slides Source", ok: slidesOk,
      detail: slidesOk
        ? (cfg.slidesUrl ? `Browser: ${cfg.slidesUrl}` : `Monitor ${cfg.slidesMonitor ?? 0}`)
        : "Not in scene — rebuild",
      action: slidesOk ? null : "build-scene",
    });

    const camOk = sceneNames.includes("Presenter Cam");
    checks.push({
      key: "camera", label: "Presenter Cam", ok: camOk,
      detail: camOk ? (cfg.cameraDevice || "Camera detected") : "Not in scene — rebuild",
      action: camOk ? null : "build-scene",
    });

    const ltOk = sceneNames.includes(cfg.titleSourceName);
    checks.push({
      key: "lower-third", label: "Lower Third", ok: ltOk,
      detail: ltOk ? "Ready — hidden until session starts" : "Not in scene — rebuild",
      action: ltOk ? null : "build-scene",
    });

    // RoomAgent
    let raOk = false;
    let raDetail = cfg.roomAgentBase ? "Checking…" : "Not configured";
    if (cfg.roomAgentBase) {
      try {
        const r = await fetch(cfg.roomAgentBase + "/api/kiosk-data",
          { signal: AbortSignal.timeout(3000) });
        if (r.ok) {
          const d = await r.json();
          raOk = true;
          raDetail = `Connected — ${d.sessions?.length ?? 0} sessions`;
        } else {
          raDetail = `HTTP ${r.status}`;
        }
      } catch (e) {
        raDetail = `Unreachable (${e.message.split(":")[0]})`;
      }
    }
    checks.push({ key: "roomagent", label: "RoomAgent", ok: raOk, detail: raDetail });

    res.json({ ok: true, checks, obsConnected: STATE.obsConnected, sceneBuilt: sceneOk });
  });

  // ── API: Test Lower Third ──
  app.post("/api/obs/test-lower-third", async (_req, res) => {
    try {
      if (!obs || !STATE.obsConnected) return res.json({ ok: false, error: "OBS not connected" });
      const timeStr = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      await obsShowLowerThird("Sample Session Title", "Presenter Name", timeStr, 30_000);
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ── Start ──
  app.listen(cfg.port, () => {
    log("SERVER RUNNING ON PORT", cfg.port);
    log("Dashboard: http://localhost:" + cfg.port);
    log("Setup:     http://localhost:" + cfg.port + "/setup");
    log("Trigger:   POST http://localhost:" + cfg.port + "/api/trigger");
  });

  connectObs();

  pollTimer = setInterval(pollRoomAgent, cfg.pollMs);
  log("POLLING ROOMAGENT every", cfg.pollMs + "ms at", cfg.roomAgentBase);

  heartbeatTimer = setInterval(sendHeartbeat, cfg.heartbeatMs);
  setTimeout(sendHeartbeat, 2000);
  setTimeout(pollRoomAgent, 3000);
}

startServer();
