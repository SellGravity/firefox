// Times each slow self-check step on one site under a launcher case.
//   node steptime.mjs --exe <exe> --args-file launcher-args.json --case win-default --url <url>
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
const opts = {};
for (let i = 2; i < process.argv.length; i += 2) opts[process.argv[i].slice(2)] = process.argv[i + 1];
const cases = JSON.parse(fs.readFileSync(opts["args-file"]));
const c = cases.find(x => x.name === opts.case);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "invifox-step-"));
const port = 9600 + Math.floor(Math.random() * 300);
const args = c.args.map(a => (a === "PROFILE_DIR" ? dir : a.startsWith("--remote-debugging-port=") ? `--remote-debugging-port=${port}` : a));
if (!args.includes("-wait-for-browser")) args.push("-wait-for-browser");
const child = spawn(opts.exe, args, { stdio: ["ignore", "pipe", "pipe"] });
const ws = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("no bidi")), 60000);
  const on = b => { const m = /WebDriver BiDi listening on (ws:\/\/\S+)/.exec(String(b)); if (m) { clearTimeout(t); res(m[1]); } };
  child.stderr.on("data", on); child.stdout.on("data", on);
});
const browser = await puppeteer.connect({ browserWSEndpoint: `${ws}/session`, protocol: "webDriverBiDi", defaultViewport: null });
const steps = {
  fonts: `(()=>{const p=document.createElement("span");p.style.cssText="position:absolute;left:-9999px;font-size:72px";p.textContent="mmmmmmmmmmlli1WQ@#";document.documentElement.appendChild(p);const w=f=>{p.style.fontFamily=f;return p.offsetWidth+"x"+p.offsetHeight};const b={serif:w("serif"),"sans-serif":w("sans-serif"),monospace:w("monospace")};const L=["Arial","Times New Roman","Courier New","Verdana","Tahoma","Georgia","Segoe UI","Calibri","Cambria","Consolas","Segoe UI Emoji","Microsoft YaHei","Roboto","Noto Serif","Droid Sans Mono","Helvetica","Twemoji Mozilla"];const r=L.filter(f=>Object.keys(b).some(g=>w('"'+f+'", '+g)!==b[g]));p.remove();return r.join(",")})()`,
  sysfont: `(()=>{const d=document.createElement("div");d.style.font="caption";document.body.appendChild(d);const f=getComputedStyle(d).fontFamily;d.remove();return f})()`,
  canvas: `(()=>{const c=document.createElement("canvas");c.width=240;c.height=60;const x=c.getContext("2d");x.font="16px Arial";x.fillText("InviFox 😀 canvas",2,15);const e=document.createElement("canvas").getContext("2d");e.font="28px sans-serif";e.fillText("😀👍🇻🇳",2,30);return c.toDataURL().length})()`,
  widevine: `navigator.requestMediaKeySystemAccess("com.widevine.alpha",[{initDataTypes:["cenc"],videoCapabilities:[{contentType:'video/mp4; codecs="avc1.42E01E"'}]}]).then(()=>true,e=>String(e))`,
  speech: `new Promise(r=>{const v=speechSynthesis.getVoices();if(v.length)return r(v.length);speechSynthesis.addEventListener("voiceschanged",()=>r(speechSynthesis.getVoices().length),{once:true});setTimeout(()=>r("t/o"),2000)})`,
  devices: `navigator.mediaDevices.enumerateDevices().then(d=>d.length)`,
  audio: `(()=>{const x=new OfflineAudioContext(1,44100,44100);const o=x.createOscillator();o.connect(x.destination);o.start(0);return x.startRendering().then(b=>b.length)})()`,
  webgl: `(()=>{const g=document.createElement("canvas").getContext("webgl");return g.getParameter(g.RENDERER)})()`,
  digest: `crypto.subtle.digest("SHA-256",new Uint8Array(8)).then(()=>1)`,
};
try {
  const page = await browser.newPage();
  for (const url of [opts.url, opts.url2].filter(Boolean)) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
    await new Promise(r => setTimeout(r, 12000));
    for (const [k, js] of Object.entries(steps)) {
      const t0 = Date.now();
      const v = await Promise.race([page.evaluate(js), new Promise(r => setTimeout(() => r("HANG>60s"), 60000))]).catch(e => "ERR " + e.message);
      console.log(url, k, Date.now() - t0, "ms", JSON.stringify(v));
    }
  }
} finally {
  try { await browser.close(); } catch {}
  child.kill();
}
process.exit(0);
