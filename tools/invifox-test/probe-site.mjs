// Opens one site under a launcher case, optionally clicks an element whose
// text matches --click, and dumps the page text (for drilling into a verdict).
//   node probe-site.mjs --exe <invifox.exe> --args-file launcher-args.json
//        --case win-noise --url https://scanbrowser.net/ --click "Phần cứng"
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const opts = {};
for (let i = 2; i < process.argv.length; i += 2) opts[process.argv[i].slice(2)] = process.argv[i + 1];
const cases = JSON.parse(fs.readFileSync(opts["args-file"]));
const c = cases.find(x => x.name === opts.case);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "invifox-probe-"));
const port = 9600 + Math.floor(Math.random() * 300);
const args = c.args.map(a => (a === "PROFILE_DIR" ? dir : a.startsWith("--remote-debugging-port=") ? `--remote-debugging-port=${port}` : a));
// --drop a,b: remove launcher switches by name prefix (one-flag experiments).
const drops = opts.drop ? String(opts.drop).split(",") : [];
const finalArgs = args.filter(a => !drops.some(d => a.startsWith("--" + d)));
const child = spawn(opts.exe, finalArgs, { stdio: ["ignore", "pipe", "pipe"] });
const ws = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("no bidi")), 60000);
  const on = b => { const m = /WebDriver BiDi listening on (ws:\/\/\S+)/.exec(String(b)); if (m) { clearTimeout(t); res(m[1]); } };
  child.stderr.on("data", on); child.stdout.on("data", on);
});
const browser = await puppeteer.connect({ browserWSEndpoint: `${ws}/session`, protocol: "webDriverBiDi", defaultViewport: null });
try {
  const page = await browser.newPage();
  // Optional experiment: a script to run before the page (e.g. add FontFaces).
  if (opts.preload) await page.evaluateOnNewDocument(fs.readFileSync(opts.preload, "utf8"));
  await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await new Promise(r => setTimeout(r, Number(opts.wait || 15000)));
  if (opts.click) {
    await page.evaluate(label => {
      const els = [...document.querySelectorAll("button, a, div, span, h3, p")];
      const el = els.find(e => e.children.length < 4 && e.textContent.trim().startsWith(label));
      (el?.closest("button,a,[role=button],div") || el)?.click();
    }, opts.click);
    await new Promise(r => setTimeout(r, Number(opts.after || 3000)));
  }
  const text = await page.evaluate(() => document.body.innerText);
  console.log(text);
  if (opts.out) await page.screenshot({ path: opts.out });
} finally {
  try { await browser.close(); } catch {}
  child.kill();
}
process.exit(0);
