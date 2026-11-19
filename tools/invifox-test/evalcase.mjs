// Evaluates one JS expression on a URL under a launcher case.
//   node evalcase.mjs --exe <exe> --args-file launcher-args.json --case android-default --url <url> --js "<expr>"
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
const opts = {};
for (let i = 2; i < process.argv.length; i += 2) opts[process.argv[i].slice(2)] = process.argv[i + 1];
const c = JSON.parse(fs.readFileSync(opts["args-file"])).find(x => x.name === opts.case);
// --profile-dir: reuse a prepared profile (e.g. with launcher extension pointer files).
const dir = opts["profile-dir"] || fs.mkdtempSync(path.join(os.tmpdir(), "invifox-ev-"));
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
  await page.goto(opts.url || "https://example.com/", { waitUntil: "load", timeout: 90000 });
  const v = await page.evaluate(`(async()=>{${fs.existsSync(opts.js) ? fs.readFileSync(opts.js, "utf8") : "return " + opts.js}})()`);
  console.log(typeof v === "string" ? v : JSON.stringify(v, null, 1));
  if (opts.out) await page.screenshot({ path: opts.out });
} finally {
  try { await browser.close(); } catch {}
  child.kill();
}
process.exit(0);
