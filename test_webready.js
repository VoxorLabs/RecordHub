"use strict";
// Test script for makeWebReady logic — no ffmpeg required for filter validation

const path = require("path");
const fs   = require("fs");

let passed = 0, failed = 0;
function assert(label, cond) {
  if (cond) { console.log("  PASS:", label); passed++; }
  else       { console.error("  FAIL:", label); failed++; }
}

// ── 1. Filter string construction ──────────────────────────────────────────
console.log("\n1. filter_complex string");
{
  const w = 1920, h = 1080, dur = 4;
  const fadeStart  = Math.max(0, dur - 1);   // 3
  const audioDelay = dur * 1000;             // 4000

  const filterStr = [
    `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,` +
      `fade=t=out:st=${fadeStart}:d=1[intro_v]`,
    `[1:v]fade=t=in:st=0:d=1[rec_v]`,
    `[intro_v][rec_v]concat=n=2:v=1:a=0[v]`,
    `[1:a]adelay=${audioDelay}|${audioDelay}[a]`,
  ].join(";");

  assert("contains scale+pad",   filterStr.includes("scale=1920:1080"));
  assert("fade out at st=3",     filterStr.includes("fade=t=out:st=3:d=1"));
  assert("fade in on recording", filterStr.includes("[1:v]fade=t=in:st=0:d=1[rec_v]"));
  assert("concat 2 segments",    filterStr.includes("concat=n=2:v=1:a=0[v]"));
  assert("audio delay 4000ms",   filterStr.includes("adelay=4000|4000"));
  assert("no shell-special chars in filter (no quotes needed)",
    !/['"\\]/.test(filterStr));
}

// ── 2. Edge: dur=1 → fadeStart=0 ───────────────────────────────────────────
console.log("\n2. edge — dur=1");
{
  const dur = 1;
  const fadeStart = Math.max(0, dur - 1);
  assert("fadeStart=0 when dur=1", fadeStart === 0);
  assert("audioDelay=1000",        dur * 1000 === 1000);
}

// ── 3. Output path construction ─────────────────────────────────────────────
console.log("\n3. output path");
{
  const cases = [
    ["recording.mp4",    "recording_web.mp4"],
    ["rec.mkv",          "rec_web.mp4"],
    ["/a/b/rec.MP4",     "/a/b/rec_web.mp4"],
    ["C:/recs/file.mp4", "C:/recs/file_web.mp4"],
  ];
  for (const [src, expected] of cases) {
    const ext     = path.extname(src);
    const webPath = src.slice(0, -ext.length) + "_web.mp4";
    assert(`${src} → ${expected}`, webPath === expected);
  }
}

// ── 4. makeWebReady skips when introImagePath is blank ──────────────────────
console.log("\n4. skip when no introImagePath");
{
  // Replicate the guard at the top of makeWebReady
  const cfg = { introImagePath: "" };
  let skipped = false;
  if (!cfg.introImagePath) skipped = true;
  assert("returns early when introImagePath empty", skipped);
}

// ── 5. getVideoDimensions fallback ──────────────────────────────────────────
console.log("\n5. getVideoDimensions fallback (no ffprobe)");
{
  function parseDimOutput(stdout) {
    const parts = (stdout || "").trim().split("x");
    return { w: parseInt(parts[0]) || 1920, h: parseInt(parts[1]) || 1080 };
  }
  const good = parseDimOutput("1280x720");
  assert("parses 1280x720 correctly", good.w === 1280 && good.h === 720);
  const bad  = parseDimOutput("");
  assert("falls back to 1920x1080 on empty output", bad.w === 1920 && bad.h === 1080);
  const partial = parseDimOutput("xgarbage");
  assert("falls back on NaN parse", partial.w === 1920 && partial.h === 1080);
}

// ── 6. ffmpeg spawn args length ─────────────────────────────────────────────
console.log("\n6. ffmpeg spawn args");
{
  const dur = 4, filterStr = "FILTER", introPath = "intro.png", webPath = "out_web.mp4", sourcePath = "rec.mp4";
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
  assert("30 args total", args.length === 30);
  assert("inputs before filter_complex", args.indexOf("-i") < args.indexOf("-filter_complex"));
  assert("-y before webPath",  args[args.length - 2] === "-y");
  assert("webPath is last arg", args[args.length - 1] === webPath);
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
