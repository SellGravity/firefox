// Installs an unpacked extension folder as a temporary add-on over BiDi and
// reports the result (manifest errors come back verbatim).
//   node bidi-ext-install.mjs --exe <exe> --args-file launcher-args.json --case win-default --ext <dir>
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
const opts = {};
for (let i = 2; i < process.argv.length; i += 2) opts[process.argv[i].slice(2)] = process.argv[i + 1];
const c = JSON.parse(fs.readFileSync(opts["args-file"])).find(x => x.name === opts.case);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "invifox-bx-"));
const port = 9600 + Math.floor(Math.random() * 300);
const args = c.args.map(a => (a === "PROFILE_DIR" ? dir : a.startsWith("--remote-debugging-port=") ? `--remote-debugging-port=${port}` : a));
const child = spawn(opts.exe, args, { stdio: ["ignore", "pipe", "pipe"] });
const ws = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("no bidi")), 60000);
  const on = b => { const m = /WebDriver BiDi listening on (ws:\/\/\S+)/.exec(String(b)); if (m) { clearTimeout(t); res(m[1]); } };
  child.stderr.on("data", on); child.stdout.on("data", on);
});
const browser = await puppeteer.connect({ browserWSEndpoint: `${ws}/session`, protocol: "webDriverBiDi", defaultViewport: null });
try {
  const id = await browser.installExtension(path.resolve(opts.ext));
  console.log("installed", id);
  const page = await browser.newPage();
  await page.goto("https://example.com/", { waitUntil: "load" });
  await new Promise(r => setTimeout(r, 3000));
  console.log(await page.evaluate(() => ({ ext: document.documentElement.getAttribute("data-invi-ext"), bg: document.documentElement.getAttribute("data-invi-bg") })));
} catch (e) {
  console.log("ERROR", e.message);
} finally {
  try { await browser.close(); } catch {}
  child.kill();
  setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }, 1500);
}
setTimeout(() => process.exit(0), 2000);
