// Automatic consistency verdicts for one run.mjs result directory.
//   node check.mjs <results/...dir> [--baseline <results/...baseline-dir>]
// Reads launch-args.json + selfcheck.json (and per-site selfchecks from
// summary.json) and prints PASS/FAIL per rule. Exit code 1 if any FAIL.

import fs from "node:fs";
import path from "node:path";

const [, , dir, flag, baseDir] = process.argv;
if (!dir) {
  console.error("usage: node check.mjs <result-dir> [--baseline <dir>]");
  process.exit(2);
}
const read = (d, f) => JSON.parse(fs.readFileSync(path.join(d, f), "utf8"));
const args = read(dir, "launch-args.json");
const self = read(dir, "selfcheck.json");
const summary = fs.existsSync(path.join(dir, "summary.json")) ? read(dir, "summary.json") : [];
const base = flag === "--baseline" && baseDir ? read(baseDir, "selfcheck.json") : null;

const arg = name => {
  const a = args.find(x => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
};
const has = name => args.includes(`--${name}`) || args.some(x => x.startsWith(`--${name}=`));
const ua = arg("user-agent") || "";
const mobile = arg("device-mode") === "phone" || /Android|iPhone|iPad/.test(ua);

const results = [];
const rule = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });

// --- identity -------------------------------------------------------------
rule("navigator.webdriver is false", self.webdriver === false, String(self.webdriver));
rule("UA is Firefox 160 of this engine", /rv:160\.0\) Gecko\/(20100101|160\.0) Firefox\/160\.0$/.test(self.userAgent), self.userAgent);
rule("no userAgentData (Firefox has none)", self.userAgentData === false);
rule("vendor is empty (Firefox)", self.vendor === "", self.vendor);
if (mobile) {
  rule("Android UA", /Android \d+; Mobile/.test(self.userAgent), self.userAgent);
  rule("platform Linux armv81", self.platform === "Linux armv81", self.platform);
} else {
  rule("Windows UA/platform", /Windows NT 10\.0; Win64; x64/.test(self.userAgent) && self.platform === "Win32", `${self.platform}`);
}
const hc = arg("hardware-concurrency");
if (hc) rule("hardwareConcurrency = switch", self.hardwareConcurrency === Number(hc), `${self.hardwareConcurrency} vs ${hc}`);
rule("no navigator.deviceMemory (Firefox)", self.deviceMemory === undefined, String(self.deviceMemory));

// --- locale / time --------------------------------------------------------
const tz = arg("timezone");
if (tz) rule("Intl time zone = switch", self.intl.timeZone === tz, `${self.intl.timeZone} vs ${tz}`);
const lang = arg("lang");
if (lang) {
  rule("navigator.languages[0] = --lang", self.languages?.[0] === lang, JSON.stringify(self.languages));
  rule("Intl locale = --lang", self.intl.locale === lang, self.intl.locale);
}

// --- screen / window ------------------------------------------------------
const ss = arg("device-size") || arg("screen-size");
if (ss && !mobile) {
  const [w, h] = ss.split(",").map(Number);
  rule("screen = --screen-size", self.screen.width === w && self.screen.height === h, `${self.screen.width}x${self.screen.height} vs ${ss}`);
}
for (const [k, v] of Object.entries(self.consistency || {})) rule(`window/screen: ${k}`, v);
rule("CSS device-width = screen.width", self.media.deviceWidthMatchesScreen);
rule("CSS device-height = screen.height", self.media.deviceHeightMatchesScreen);
rule("CSS resolution = devicePixelRatio", self.media.resolutionMatchesDpr);

// --- mobile persona -------------------------------------------------------
if (mobile) {
  rule("touch: maxTouchPoints 5", self.maxTouchPoints === 5, String(self.maxTouchPoints));
  rule("pointer: coarse", self.media.pointerCoarse);
  rule("hover: none", self.media.hoverNone);
  rule("ontouchstart in window", self.media.touchEvent);
  rule("window.orientation + onorientationchange", self.media.orientationApi && self.media.onorientationchange);
  rule("outer == inner (no chrome)", self.window.outerWidth === self.window.innerWidth, `${self.window.outerWidth}/${self.window.innerWidth}`);
  rule("screen portrait", self.screen.height > self.screen.width);
  rule("DPR >= 2", self.window.devicePixelRatio >= 2, String(self.window.devicePixelRatio));
  const winFonts = (self.fonts || []).filter(f => !["Roboto", "Noto Serif", "Droid Sans Mono", "Twemoji Mozilla"].includes(f));
  rule("no desktop fonts visible", winFonts.length === 0, winFonts.join(", "));
  rule("Roboto visible", (self.fonts || []).includes("Roboto"));
  const r = self.webgl?.unmaskedRenderer || "";
  rule("WebGL renderer is a phone GPU", /Adreno|Mali|PowerVR|Xclipse/.test(r), r);
  rule("WebGL renderer has no Direct3D", !/Direct3D|D3D11|ANGLE/.test(r), r);
} else {
  rule("not touch-capable", self.maxTouchPoints === 0 || self.maxTouchPoints === 1 || self.maxTouchPoints === 5, String(self.maxTouchPoints));
  rule("pointer fine", !self.media.pointerCoarse);
  rule("no window.orientation on desktop", !self.media.orientationApi);
  rule("Roboto hidden on desktop", !(self.fonts || []).includes("Roboto"));
  const r = self.webgl?.unmaskedRenderer || "";
  rule("WebGL renderer Windows ANGLE D3D11", /ANGLE \(.*Direct3D11/.test(r), r);
  rule("WebGL renderer not Mesa/LLVM/OpenGL", !/Mesa|LLVM|OpenGL|llvmpipe|SwiftShader/.test(r), r);
}

// --- noise ----------------------------------------------------------------
if (typeof self.canvas === "object") {
  rule("canvas stable across reads", self.canvas.stableAcrossReads);
  rule("canvas drawImage consistent", self.canvas.drawImageConsistent);
}
if (typeof self.audio === "object") rule("audio getChannelData == copyFromChannel", self.audio.copyConsistent);
if (base && typeof base.canvas === "object" && typeof self.canvas === "object") {
  if (has("canvas-noise")) rule("canvas differs from baseline (noise on)", self.canvas.hash !== base.canvas.hash, `${self.canvas.hash} vs ${base.canvas.hash}`);
}
if (base && typeof base.audio === "object" && typeof self.audio === "object") {
  if (has("audio-noise")) rule("audio differs from baseline (noise on)", self.audio.sum !== base.audio.sum, `${self.audio.sum} vs ${base.audio.sum}`);
}

// --- media / DRM ------------------------------------------------------------
rule("Widevine available", self.widevine === true, String(self.widevine));
if (Array.isArray(self.mediaDevices)) rule("enumerateDevices not empty", self.mediaDevices.length > 0, self.mediaDevices.join(","));

// --- per-site selfchecks agree with about:blank ----------------------------
for (const s of summary) {
  if (s.selfcheck && typeof s.selfcheck === "object") {
    const sc = s.selfcheck;
    rule(`[${s.site}] UA/tz/screen same as about:blank`,
      sc.userAgent === self.userAgent && sc.intl?.timeZone === self.intl.timeZone &&
      sc.screen?.width === self.screen.width && sc.webdriver === false);
  }
}

let fail = 0;
for (const r of results) {
  if (!r.ok) fail++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
}
console.log(`\n${results.length - fail}/${results.length} passed`);
process.exit(fail ? 1 : 0);
