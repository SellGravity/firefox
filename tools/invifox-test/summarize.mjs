// One line per site verdict for each case of a round directory.
//   node summarize.mjs results/full8 [cases...]
import fs from "node:fs";
import path from "node:path";
const [, , root, ...cs] = process.argv;
const cases = cs.length ? cs : fs.readdirSync(root).filter(d => fs.existsSync(path.join(root, d, "summary.json")));
const t = (c, f) => { try { return fs.readFileSync(path.join(root, c, f + ".txt"), "utf8"); } catch { return ""; } };
const pick = (s, re) => (re.exec(s) || [])[1] || "?";
for (const c of cases) {
  const bs = t(c, "browserscan"), sb = t(c, "scanbrowser"), cj = t(c, "creepjs"), px = t(c, "pixelscan"), ip = t(c, "iphey"), fp = t(c, "fingerprint-playground"), so = t(c, "sannysoft"), bot = t(c, "browserscan-bot");
  console.log(`== ${c}`);
  console.log(`  browserscan     ${pick(bs, /authenticity:\s*(\d+%)/)}`);
  console.log(`  browserscan-bot ${pick(bot, /Test Results:\s*\n\s*(\w+)/)}`);
  console.log(`  scanbrowser     ${pick(sb, /Trình duyệt của bạn\s*\n\s*([^\n]+)/)}; anomalies: ${[...sb.matchAll(/([^\n]+)\n\s*Phát hiện bất thường/g)].map(m => m[1]).join(",") || "none"}`);
  console.log(`  creepjs         ${pick(cj, /(\d+%) like headless/)} like-headless, ${pick(cj, /(\d+%) headless:/)} headless, ${pick(cj, /(\d+%) stealth/)} stealth`);
  console.log(`  pixelscan       ${(px.match(/(No masking detected|Masking detected|consistent|inconsistent|Your browser fingerprint[^\n]*)/gi) || []).slice(0, 3).join(" / ") || "?"}`);
  console.log(`  iphey           ${pick(ip, /(Trustworthy|Suspicious|Unreliable)/)}`);
  console.log(`  fingerprint     ${fp.replace(/\s+/g, " ").slice(0, 160)}`);
  console.log(`  sannysoft fails ${(so.match(/failed/gi) || []).length}`);
}
