// Proxy + WebRTC acceptance: launcher-exact args with an AUTHENTICATED local
// proxy (HTTP Basic and SOCKS5 user/pass, credentials with URL-escaped
// characters), for every --webrtc-mode the launcher sends.
//   node webrtc-proxy.mjs --exe <invifox.exe> [--args-file launcher-args.json] [--cases win-default,android-default]
// Checks: the page loads through the proxy without an auth prompt; forward /
// replace show the proxy exit IP as the only public address, with Firefox's
// event shape (gathering -> host mDNS -> srflx -> end-of-candidates ->
// complete) and no socket-backed leak; disable completes with no candidate.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const opts = { "args-file": "launcher-args.json", cases: "win-default,android-default" };
for (let i = 2; i < process.argv.length; i += 2) opts[process.argv[i].slice(2)] = process.argv[i + 1];
if (!opts.exe) throw new Error("--exe is required");

const USER = "u@ser", PASS = "p:ss w0rd";
const stats = { http407: 0, httpOk: 0, socksOk: 0, socksBad: 0 };

// --- local authenticated proxies -------------------------------------------
const okAuth = h => {
  const m = /^Basic (.+)$/.exec(h || "");
  return !!m && Buffer.from(m[1], "base64").toString() === `${USER}:${PASS}`;
};
const hp = http.createServer((req, res) => {
  if (!okAuth(req.headers["proxy-authorization"])) { stats.http407++; res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="t"' }).end(); return; }
  stats.httpOk++;
  const u = new URL(req.url);
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !k.startsWith("proxy-")));
  const up = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: req.method, headers }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on("error", () => res.destroy());
  req.pipe(up);
});
hp.on("connect", (req, sock, head) => {
  if (!okAuth(req.headers["proxy-authorization"])) { stats.http407++; sock.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="t"\r\nContent-Length: 0\r\n\r\n'); return; }
  stats.httpOk++;
  const [h, p] = req.url.split(":");
  const up = net.connect(+p, h, () => { sock.write("HTTP/1.1 200 Connection Established\r\n\r\n"); up.write(head); up.pipe(sock); sock.pipe(up); });
  up.on("error", () => sock.destroy()); sock.on("error", () => up.destroy());
});
// SOCKS5 with RFC 1929 user/pass; buffers partial/coalesced packets, ATYP 1/3/4.
function socksServer(onOk, onBad) {
  return net.createServer(sock => {
    sock.on("error", () => {});
    let buf = Buffer.alloc(0), stage = 0;
    const onData = chunk => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (stage === 0) {
          if (buf.length < 2 || buf.length < 2 + buf[1]) return;
          const methods = [...buf.subarray(2, 2 + buf[1])];
          buf = buf.subarray(2 + buf[1]);
          if (!methods.includes(2)) { onBad(); sock.end(Buffer.from([5, 0xff])); return; }
          sock.write(Buffer.from([5, 2])); stage = 1;
        } else if (stage === 1) {
          if (buf.length < 2) return;
          const ul = buf[1];
          if (buf.length < 3 + ul) return;
          const pl = buf[2 + ul];
          if (buf.length < 3 + ul + pl) return;
          const user = buf.subarray(2, 2 + ul).toString(), pass = buf.subarray(3 + ul, 3 + ul + pl).toString();
          buf = buf.subarray(3 + ul + pl);
          if (user !== USER || pass !== PASS) { onBad(); sock.end(Buffer.from([1, 1])); return; }
          sock.write(Buffer.from([1, 0])); stage = 2;
        } else if (stage === 2) {
          if (buf.length < 5) return;
          const at = buf[3];
          const alen = at === 1 ? 4 : at === 4 ? 16 : at === 3 ? 1 + buf[4] : -1;
          if (alen < 0) { sock.destroy(); return; }
          if (buf.length < 4 + alen + 2) return;
          let host;
          if (at === 1) host = [...buf.subarray(4, 8)].join(".");
          else if (at === 3) host = buf.subarray(5, 5 + buf[4]).toString();
          else host = buf.subarray(4, 20).toString("hex").match(/.{4}/g).join(":");
          const port = buf.readUInt16BE(4 + alen);
          const cmd = buf[1];
          const rest = buf.subarray(4 + alen + 2);
          sock.off("data", onData); stage = 3;
          if (cmd !== 1) { sock.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
          onOk(host, port);
          const up = net.connect(port, host, () => {
            sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            if (rest.length) up.write(rest);
            up.pipe(sock); sock.pipe(up);
          });
          up.on("error", () => sock.destroy()); sock.on("close", () => up.destroy());
          return;
        } else return;
      }
    };
    sock.on("data", onData);
  });
}

const sp = socksServer(() => stats.socksOk++, () => stats.socksBad++);
await new Promise(r => hp.listen(0, "127.0.0.1", r));
await new Promise(r => sp.listen(0, "127.0.0.1", r));
const cred = `${encodeURIComponent(USER)}:${encodeURIComponent(PASS)}`;
const PROXIES = {
  http: `http://${cred}@127.0.0.1:${hp.address().port}`,
  socks: `socks5://${cred}@127.0.0.1:${sp.address().port}`,
};

// --- page probe ------------------------------------------------------------
const PROBE = `(async () => {
  const out = {};
  // Exit address as an IPv4-only site and as a dual-stack site sees it.
  try { out.ip = (await (await fetch("https://api.ipify.org?format=json")).json()).ip; } catch (e) { out.ip = "ERR " + e; }
  try { out.ip64 = (await (await fetch("https://api64.ipify.org?format=json")).json()).ip; } catch (e) { out.ip64 = ""; }
  async function gather(withAudio) {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    const list = [], states = [pc.iceGatheringState];
    pc.createDataChannel("x");
    if (withAudio) pc.addTransceiver("audio");
    pc.onicecandidate = e => list.push(e.candidate ? e.candidate.candidate : null);
    pc.onicegatheringstatechange = () => states.push(pc.iceGatheringState);
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise(r => { const t = setTimeout(r, 8000); const iv = setInterval(() => { if (pc.iceGatheringState === "complete") { clearTimeout(t); clearInterval(iv); r(); } }, 50); });
    const sdp = pc.localDescription.sdp;
    pc.close();
    return { list, states, sdp };
  }
  out.dc = await gather(false);
  out.av = await gather(true);
  return out;
})()`;

async function runCase(name, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "invifox-rtc-"));
  const port = 9600 + Math.floor(Math.random() * 300);
  const finalArgs = args.map(a => (a === "PROFILE_DIR" ? dir : a.startsWith("--remote-debugging-port=") ? `--remote-debugging-port=${port}` : a));
  const child = spawn(opts.exe, finalArgs, { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const ws = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("no BiDi line")), 60000);
      const on = b => { const m = /WebDriver BiDi listening on (ws:\/\/\S+)/.exec(String(b)); if (m) { clearTimeout(t); res(m[1]); } };
      child.stderr.on("data", on); child.stdout.on("data", on);
    });
    const browser = await puppeteer.connect({ browserWSEndpoint: `${ws}/session`, protocol: "webDriverBiDi", defaultViewport: null });
    try {
      const page = await browser.newPage();
      await page.goto("https://example.com/", { waitUntil: "load", timeout: 90000 });
      // Let the exit-IP lookup through the proxy land (it runs at startup).
      await new Promise(r => setTimeout(r, 1500));
      return await page.evaluate(PROBE);
    } finally {
      try { await browser.close(); } catch {}
    }
  } finally {
    child.kill();
  }
}

const isPublicV4 = a => /^\d+\.\d+\.\d+\.\d+$/.test(a) && !/^(10|127|0)\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(a);

const exitsOf = r => [r.ip, r.ip64].filter((v, i, a) => v && a.indexOf(v) === i).join(" / ");

function verdict(mode, r) {
  const errs = [];
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(r.ip || "")) errs.push(`page could not load through the proxy (${r.ip})`);
  const exits = [r.ip, r.ip64].filter(Boolean);
  for (const [k, g] of Object.entries({ dc: r.dc, av: r.av })) {
    const cands = g.list.filter(c => c);
    const parsed = cands.map(c => c.split(" "));
    if (g.states.at(-1) !== "complete") errs.push(`${k}: gathering ended in "${g.states.at(-1)}"`);
    if (g.list.at(-1) !== null) errs.push(`${k}: no null end candidate`);
    if (mode === "disable") {
      if (parsed.length) errs.push(`${k}: disable mode surfaced ${parsed.length} candidate(s)`);
      continue;
    }
    if (mode === "forward" || mode === "replace") {
      if (!g.states.includes("gathering")) errs.push(`${k}: never reported "gathering"`);
      if (!g.list.includes("")) errs.push(`${k}: no end-of-candidates event`);
      if (!/a=end-of-candidates/.test(g.sdp)) errs.push(`${k}: no a=end-of-candidates in SDP`);
      const srflx = parsed.filter(p => p[7] === "srflx");
      if (!srflx.length) errs.push(`${k}: no srflx candidate`);
      for (const p of srflx) if (!exits.includes(p[4])) errs.push(`${k}: srflx ${p[4]} is not an exit IP (${exits.join(", ")})`);
      for (const p of parsed) if (p[7] === "host" && !p[4].endsWith(".local")) errs.push(`${k}: host candidate exposes ${p[4]}`);
      for (const m of g.sdp.matchAll(/^c=IN IP[46] (\S+)/gm)) if (!exits.includes(m[1])) errs.push(`${k}: SDP c= ${m[1]}`);
    }
    for (const p of parsed) if ((isPublicV4(p[4]) || p[4].includes(":")) && !exits.includes(p[4])) errs.push(`${k}: foreign public IP ${p[4]}`);
  }
  return errs;
}

const base = JSON.parse(fs.readFileSync(opts["args-file"], "utf8"));
let failed = 0, total = 0;
for (const caseName of opts.cases.split(",")) {
  const b = base.find(c => c.name === caseName);
  if (!b) throw new Error(`no case ${caseName}`);
  const clean = b.args.filter(a => !/^--(proxy-server|webrtc-mode|webrtc-proxy-ip)=/.test(a));
  for (const [pn, proxy] of Object.entries(PROXIES)) {
    for (const mode of ["forward", "replace", "disable"]) {
      total++;
      const label = `${caseName} ${pn} ${mode}`;
      try {
        const r = await runCase(label, [...clean, `--proxy-server=${proxy}`, `--webrtc-mode=${mode}`]);
        const errs = verdict(mode, r);
        const srflx = r.dc.list.filter(c => c && c.includes(" srflx ")).map(c => c.split(" ")[4]);
        if (errs.length) { failed++; console.log(`FAIL  ${label}: ${errs.join("; ")}`); }
        else console.log(`ok    ${label}: exit ${exitsOf(r)}, srflx [${srflx.join(",")}], states ${r.dc.states.join(">")}`);
      } catch (e) {
        failed++;
        console.log(`FAIL  ${label}: ${e.message}`);
      }
    }
  }
}
console.log(`proxy: HTTP 407 challenges ${stats.http407}, authorised ${stats.httpOk}; SOCKS5 authorised ${stats.socksOk}, rejected ${stats.socksBad}`);
if (stats.socksBad) { failed++; console.log("FAIL  SOCKS5 credentials were rejected"); }
console.log(`${total - failed}/${total} passed`);
hp.close(); sp.close();
process.exit(failed ? 1 : 0);
