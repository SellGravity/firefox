// InviFox detection test runner.
//
// Launches an InviFox (or stock Firefox, for a baseline) binary the same way
// the InviBrowser launcher does - fingerprint switches on the command line -
// drives it over WebDriver BiDi, visits detection sites and saves, per site:
// a full-page screenshot, the page text, and a JSON self-check of the values
// we spoof (so results can be diffed against a real Firefox 160 baseline).
//
// Usage:
//   npm install
//   node run.mjs --exe <path\to\invifox.exe> [--profile win-desktop]
//                [--sites fingerprint-playground,creepjs] [--out <dir>]
//                [--baseline]   (no fingerprint switches; for stock Firefox)

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const opts = parseArgs(process.argv);
if (!opts.exe) {
  console.error("--exe is required");
  process.exit(2);
}
const profileName = opts.profile || "win-desktop";
const profiles = JSON.parse(fs.readFileSync(path.join(here, "profiles.json")));
const allSites = JSON.parse(fs.readFileSync(path.join(here, "sites.json")));
const wanted = opts.sites ? String(opts.sites).split(",") : null;
const sites = wanted ? allSites.filter(s => wanted.includes(s.name)) : allSites;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const label = opts.baseline ? "baseline" : profileName;
const outDir = path.resolve(opts.out || path.join(here, "results", `${stamp}-${label}`));
fs.mkdirSync(outDir, { recursive: true });

const fpArgs = opts.baseline ? [] : profiles[profileName]?.args;
if (!fpArgs) {
  console.error(`unknown profile ${profileName}`);
  process.exit(2);
}

// Values a page can see; compared across runs/baseline.
async function selfCheck(page) {
  return page.evaluate(async () => {
    const r = {};
    const n = navigator;
    Object.assign(r, {
      userAgent: n.userAgent,
      appVersion: n.appVersion,
      platform: n.platform,
      oscpu: n.oscpu,
      vendor: n.vendor,
      languages: n.languages,
      hardwareConcurrency: n.hardwareConcurrency,
      deviceMemory: n.deviceMemory,
      maxTouchPoints: n.maxTouchPoints,
      webdriver: n.webdriver,
      pdfViewerEnabled: n.pdfViewerEnabled,
      plugins: n.plugins.length,
      userAgentData: "userAgentData" in n,
    });
    r.screen = {
      width: screen.width, height: screen.height,
      availWidth: screen.availWidth, availHeight: screen.availHeight,
      colorDepth: screen.colorDepth,
      orientation: screen.orientation && screen.orientation.type,
    };
    r.window = {
      innerWidth, innerHeight, outerWidth, outerHeight,
      screenX, screenY, devicePixelRatio,
    };
    r.media = {
      pointerCoarse: matchMedia("(pointer: coarse)").matches,
      hoverNone: matchMedia("(hover: none)").matches,
      touchEvent: "ontouchstart" in window,
    };
    r.intl = {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      offset: new Date().getTimezoneOffset(),
      dateString: new Date(0).toString(),
    };
    try {
      const gl = document.createElement("canvas").getContext("webgl");
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      r.webgl = {
        vendor: gl.getParameter(gl.VENDOR),
        renderer: gl.getParameter(gl.RENDERER),
        unmaskedVendor: ext && gl.getParameter(ext.UNMASKED_VENDOR_WEBGL),
        unmaskedRenderer: ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        extensions: gl.getSupportedExtensions().length,
      };
    } catch (e) {
      r.webgl = String(e);
    }
    const hash = async buf => {
      const d = await crypto.subtle.digest("SHA-256", buf);
      return [...new Uint8Array(d)].slice(0, 8).map(b => b.toString(16).padStart(2, "0")).join("");
    };
    try {
      const c = document.createElement("canvas");
      c.width = 240; c.height = 60;
      const x = c.getContext("2d");
      x.textBaseline = "top"; x.font = "16px Arial";
      x.fillStyle = "#f60"; x.fillRect(100, 1, 62, 20);
      x.fillStyle = "#069"; x.fillText("InviFox \u{1F600} canvas", 2, 15);
      x.fillStyle = "rgba(102,204,0,0.7)"; x.fillText("InviFox \u{1F600} canvas", 4, 17);
      const url1 = c.toDataURL(), url2 = c.toDataURL();
      const c2 = document.createElement("canvas");
      c2.width = 240; c2.height = 60;
      c2.getContext("2d").drawImage(c, 0, 0);
      r.canvas = {
        hash: await hash(new TextEncoder().encode(url1)),
        stableAcrossReads: url1 === url2,
        drawImageConsistent: url1 === c2.toDataURL(),
      };
    } catch (e) {
      r.canvas = String(e);
    }
    try {
      const ctx = new OfflineAudioContext(1, 44100, 44100);
      const osc = ctx.createOscillator();
      osc.type = "triangle"; osc.frequency.value = 10000;
      const comp = ctx.createDynamicsCompressor();
      osc.connect(comp); comp.connect(ctx.destination); osc.start(0);
      const buf = await ctx.startRendering();
      const d = buf.getChannelData(0);
      let sum = 0;
      for (let i = 4500; i < 5000; i++) sum += Math.abs(d[i]);
      const copy = new Float32Array(500);
      buf.copyFromChannel(copy, 0, 4500);
      let sum2 = 0;
      for (const v of copy) sum2 += Math.abs(v);
      r.audio = { sum, copyConsistent: sum === sum2 };
    } catch (e) {
      r.audio = String(e);
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      r.mediaDevices = devices.map(d => d.kind);
    } catch (e) {
      r.mediaDevices = String(e);
    }
    return r;
  });
}

async function waitForBidi(child, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("BiDi endpoint timeout")), timeoutMs);
    const onData = buf => {
      const m = /WebDriver BiDi listening on (ws:\/\/[^\s]+)/.exec(buf.toString());
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    child.stderr.on("data", onData);
    child.stdout.on("data", onData);
    child.on("exit", code => reject(new Error(`browser exited ${code}`)));
  });
}

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "invifox-test-"));
const port = 9300 + Math.floor(Math.random() * 500);
const args = [
  ...fpArgs,
  "-no-remote",
  "-profile", profileDir,
  `--remote-debugging-port=${port}`,
  "about:blank",
];
console.log(`[run] ${opts.exe}\n[run] profile=${label} out=${outDir}`);
fs.writeFileSync(path.join(outDir, "launch-args.json"), JSON.stringify(args, null, 2));

const child = spawn(opts.exe, args, { stdio: ["ignore", "pipe", "pipe"] });
const browserLog = fs.createWriteStream(path.join(outDir, "browser.log"));
child.stdout.pipe(browserLog);
child.stderr.pipe(browserLog);

let browser;
const summary = [];
try {
  const ws = await waitForBidi(child);
  browser = await puppeteer.connect({
    browserWSEndpoint: `${ws}/session`,
    protocol: "webDriverBiDi",
    defaultViewport: null,
  });

  const page = await browser.newPage();
  await page.goto("about:blank");
  const self = await selfCheck(page).catch(e => ({ error: String(e) }));
  fs.writeFileSync(path.join(outDir, "selfcheck.json"), JSON.stringify(self, null, 2));
  console.log("[selfcheck]", JSON.stringify(self, null, 2));

  for (const site of sites) {
    const entry = { site: site.name, url: site.url };
    try {
      await page.goto(site.url, { waitUntil: "load", timeout: 60000 });
      await new Promise(r => setTimeout(r, site.wait || 10000));
      // Self-check on a real https origin too (some APIs differ on about:).
      entry.selfcheck = await selfCheck(page).catch(e => String(e));
      await page.screenshot({ path: path.join(outDir, `${site.name}.png`), fullPage: true });
      const text = await page.evaluate(() => document.body.innerText);
      fs.writeFileSync(path.join(outDir, `${site.name}.txt`), text);
      entry.ok = true;
    } catch (e) {
      entry.ok = false;
      entry.error = String(e);
    }
    console.log(`[site] ${site.name}: ${entry.ok ? "ok" : entry.error}`);
    summary.push(entry);
  }
} catch (e) {
  console.error("[run] failed:", e);
  summary.push({ fatal: String(e) });
} finally {
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  try { await browser?.close(); } catch {}
  child.kill();
}
