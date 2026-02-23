# RecordHub — Claude Context

## What this project is
RecordHub is a Node.js/Express server (port 3299) that automates conference session recording via OBS Studio. It is one component in a 3-part system:

- **RecordHub** (this repo) — runs on the recording PC, controls OBS via WebSocket
- **RoomAgent** — runs on the room kiosk laptop, manages the session schedule, sends triggers to RecordHub
- **PresenterHub** — central hub (optional heartbeat target)

## Architecture — critical to understand

### Start/stop is trigger-driven, NOT poll-driven
`POST /api/trigger { action: "start" | "stop" }` is how RoomAgent starts and stops recordings.
The poll (`pollRoomAgent`) is **info-only** for session metadata — with one exception:

**Poll auto-stop**: if `!currentSession && STATE.recording`, the poll stops the recording.
This is how *scheduled session end* stops the recording — RoomAgent does NOT send a stop trigger
at session end; it relies on RecordHub's poll detecting the session is gone.

### Escape key
Escape on the room PC kiosk sends `POST /api/trigger { action: "stop" }` from RoomAgent —
it is NOT handled in RecordHub's dashboard. The dashboard also has an Escape handler
(added v2.2) but that's a secondary convenience for the operator sitting at the recording PC.

### Lower third (v2.2+)
A single OBS `browser_source` named `"Lower Third"` points to `http://localhost:3299/lower-third`.
The HTML page polls `/api/lower-third` every 3s and self-manages slide-in/slide-out based on
`recording: true/false`. RecordHub's `showLowerThird()` just upserts the browser source and
enables it — the page handles timing. `hideLowerThird()` is a no-op.

## Key files
| File | Purpose |
|------|---------|
| `recordhub.js` | Main server — all logic in one file |
| `public/dashboard.html` | Operator dashboard |
| `public/setup.html` | Config UI |
| `public/lower-third.html` | OBS browser source overlay |
| `data/config.json` | Runtime config (gitignored values: obsPassword) |
| `test_webready.js` | Unit tests for web-ready export filter logic |

## Config fields
```json
{
  "port": 3299,
  "obsWebSocketUrl": "ws://localhost:4455",
  "obsPassword": "",
  "roomAgentBase": "http://<roompc>:3199",
  "presenterHubBase": "http://<hub>:8088",
  "room": "BallroomA",
  "recordingsRoot": "C:\\path\\to\\recordings",
  "autoRemuxToMp4": true,
  "orgName": "TechConf 2026",
  "introImagePath": "C:\\path\\to\\logo.png",
  "introDurationSecs": 4,
  "verbose": true
}
```

## Recording file flow
1. OBS saves raw file (date-based name) to its output folder
2. `RecordStateChanged` STOPPED fires → `handleRecordingStopped(outputPath)`
3. File is renamed to `{date}_{time}_{presenter}_{title}.{ext}` and moved to
   `{recordingsRoot}/{room}/{date}/`
4. If `.mkv` and `autoRemuxToMp4`: remux to `.mp4` via ffmpeg
5. If `introImagePath` set: create `_web.mp4` with intro card + crossfade

## Known race conditions fixed
- **Session for file rename**: `STATE.currentSession` is cleared before `RecordStateChanged` fires.
  Fix: `STATE.pendingSession` holds the session across the gap. `handleRecordingStopped` uses
  `currentSession || pendingSession`. All stop paths set `pendingSession` before clearing `currentSession`.
- **Recording start confirmation**: `obsStartRecord()` awaits `RecordStateChanged` STARTED (5s timeout)
  before returning, so the trigger response only fires after OBS confirms it started.

## Web-ready export
After each recording, if `introImagePath` is set, `makeWebReady()` creates `filename_web.mp4`:
- Scales/pads intro image to match recording canvas
- Crossfades intro → recording (fade out last 1s, fade in first 1s)
- Delays audio by intro duration
- Uses `spawn` (not `exec`) to avoid shell quoting issues with `filter_complex`

## Version history (recent)
- **v2.2.0** — browser source lower third, web-ready export, orgName config
- **v2.1.0** — production hardened, RecordStateChanged confirmation on start
- **v2.0.0** — complete rewrite, zero-config lower thirds (GDI text approach)
- **v1.x** — original with scene builder, slides browser source

## Running
```
node recordhub.js
```
Dashboard: `http://localhost:3299`
Setup: `http://localhost:3299/setup`
