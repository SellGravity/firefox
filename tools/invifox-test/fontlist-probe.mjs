// Records every font-family a detection page assigns (its font probe list).
//   node fontlist-probe.mjs --exe <exe> --args-file launcher-args.json --case android-default --url <url>
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
const opts = {};
for (let i = 2; i < process.argv.length; i += 2) opts[process.argv[i].slice(2)] = process.argv[i + 1];
const c = JSON.parse(fs.readFileSync(opts["args-file"])).find(x => x.name === opts.case);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "invifox-fl-"));
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
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    const seen = (window.__ff = new Set());
    const proto = (window.CSS2Properties || window.CSSStyleDeclaration).prototype;
    const d = Object.getOwnPropertyDescriptor(proto, "fontFamily");
    if (d && d.set) Object.defineProperty(proto, "fontFamily", { ...d, set(v) { seen.add(String(v)); return d.set.call(this, v); } });
    const d2 = Object.getOwnPropertyDescriptor(proto, "font");
    if (d2 && d2.set) Object.defineProperty(proto, "font", { ...d2, set(v) { seen.add("font:" + v); return d2.set.call(this, v); } });
    const fc = document.fonts && document.fonts.check && document.fonts.check.bind(document.fonts);
    if (fc) document.fonts.check = (f, t) => { seen.add("check:" + f); return fc(f, t); };
  });
  await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await new Promise(r => setTimeout(r, Number(opts.wait || 15000)));
  const list = await page.evaluate(() => [...window.__ff]);
  console.log(list.join("\n"));
} finally {
  try { await browser.close(); } catch {}
  child.kill();
}
process.exit(0);
