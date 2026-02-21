# RecordHub

Automated session recording sidecar for PresenterHub events.
Controls OBS Studio via WebSocket — starts and stops recording automatically when sessions begin and end, produces PiP video (presenter camera over slides), and burns a presenter lower-third that fades after 10 seconds.

---

## Requirements

| Software | Version | Notes |
|---|---|---|
| [Node.js](https://nodejs.org) | 18 LTS or newer | Download the LTS installer |
| [OBS Studio](https://obsproject.com) | 28 or newer | Includes built-in WebSocket server |

---

## Installation

1. **Download** the latest release zip from GitHub and extract it, **or** clone:
   ```
   git clone https://github.com/VoxorLabs/RecordHub.git
   cd RecordHub
   npm install
   ```

2. **Enable OBS WebSocket** — in OBS go to
   `Tools → WebSocket Server Settings → Enable WebSocket server`
   Note the port (default 4455) and password (optional).

3. **Double-click `START-RECORDHUB.CMD`**
   On first run it installs dependencies automatically, then opens the dashboard in your browser.

---

## First-time Setup

Open **http://localhost:3299/setup** (the launcher opens this automatically).

### Step 1 — OBS Connection
- Enter your OBS WebSocket URL (default `ws://localhost:4455`) and password if set.
- Click **Test OBS Connection** to confirm.

### Step 2 — Build the OBS Scene
- Connect your presenter camera via USB/capture card before this step.
- Click **Detect Sources** — RecordHub reads your monitors and cameras from OBS and populates the dropdowns.
- Select the monitor showing the **PowerPoint/slides** and the **camera device** for the presenter.
- Click **Build OBS Scenes**.

RecordHub creates the full scene in OBS automatically:

```
Scene: "Session Recording"
├── Lower Third      — presenter name, white Arial Bold, fades out after 10 s
├── Lower Third BG   — full-width dark strip, fades with the text
├── Presenter Cam    — 320×180 PiP, lower-right corner
└── Slides           — monitor capture, fills the canvas
```

### Step 3 — PresenterHub & Room
- Set the PresenterHub server URL and your room name (used for file organisation and heartbeats).

### Step 4 — Save
- Click **Save Configuration**.

---

## Triggering Recording from a Room PC

Send a plain HTTP POST to start or stop recording from any device on the network:

**Start**
```http
POST http://<recordhub-ip>:3299/api/trigger
Content-Type: application/json

{
  "action": "start",
  "title": "Keynote: The Future of AI",
  "presenter": "Jane Smith",
  "room": "BallroomA"
}
```

**Stop**
```http
POST http://<recordhub-ip>:3299/api/trigger
Content-Type: application/json

{ "action": "stop" }
```

Response: `{ "ok": true, "session": { … } }`

RecordHub also polls RoomAgent automatically as a fallback — push trigger takes priority.

---

## File Output

Recordings are saved to `recordings/` (or the path set in Setup) and organised automatically:

```
recordings/
└── BallroomA/
    └── 2026-02-21/
        └── 20260221_0900_JaneSmith_Keynote_The_Future_of_AI.mp4
```

MKV files are remuxed to MP4 automatically if `ffmpeg` is in your PATH.

---

## Dashboard

Open **http://localhost:3299** to monitor recording status, view recent files, and manually start/stop if needed.

---

## Ports

| Port | Service |
|---|---|
| 3299 | RecordHub HTTP API + dashboard |
| 4455 | OBS WebSocket (on the same PC) |
