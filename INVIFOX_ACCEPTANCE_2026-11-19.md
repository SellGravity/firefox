# InviFox — báo cáo nghiệm thu (19/11/2026)

Bản build: `obj-sg-release/dist/bin/invifox.exe` (Firefox 160.0.1, nhánh
`develop`, commit `10d9ffdce9`). Mọi thay đổi đã push lên
`SellGravity/firefox` `develop`.

## 0. Cập nhật sáng 19/11: tích hợp launcher và proxy

Đợt này rà toàn bộ đường đi launcher → InviFox, vì đây là lần đầu launcher
chạy Firefox. Đã kiểm thử với proxy thật có mật khẩu. Lượt 8 trước đó chạy
không proxy nên chưa phát hiện được các lỗi dưới đây.

**Lỗi đã sửa trong InviFox (commit `b2d150b8d6`):**

1. **WebRTC lộ IP thật khi đi qua proxy.**
   - Chế độ `replace` gửi STUN thẳng qua UDP. Site nào tự đặt STUN server sẽ
     thấy IP thật, dù chữ trong candidate có bị sửa.
   - Chế độ `forward` (launcher bật mặc định khi profile có proxy) và
     `disable` kẹt ở trạng thái "new", không có end-of-candidates. Không
     trình duyệt thật nào như vậy.
   - Cách sửa: không socket ICE nào được ra mạng. InviFox tự phát đúng chuỗi
     sự kiện của Firefox sau NAT:
     - trạng thái gathering;
     - candidate host mDNS (UDP và TCP);
     - candidate srflx mang IP đầu ra của proxy;
     - end-of-candidates;
     - trạng thái complete.
   - Priority, foundation, raddr/rport và SDP (`c=`, port của `m=`,
     `a=rtcp`, `a=end-of-candidates`) đều theo nICEr.
   - `disable` vẫn hoàn tất gathering, chỉ là không có candidate, giống bản
     Chrome.
2. **IP đầu ra của proxy** được lấy theo thứ tự:
   - `--webrtc-proxy-ip` nếu có;
   - nếu không, host proxy khi đó là IP public;
   - sau đó InviFox tự hỏi một dịch vụ dò IP dual-stack, đi qua chính proxy
     đó. Cách này đúng cả với proxy dạng hostname hoặc pool xoay vòng, và
     cho ra cùng họ IPv4/IPv6 với IP mà site thấy.
3. Xác thực proxy (HTTP 407, SOCKS5 user/pass, mật khẩu chứa ký tự đặc biệt)
   đã kiểm chứng chạy đúng và không hiện hộp thoại nào.

**Lỗi đã sửa trong launcher (nhánh `feat/invifox-engine`, commit `c3bb99c9`):**

- **Cookie của profile Firefox trước đây bị bỏ qua hoặc báo lỗi.** Gồm khôi
  phục cookie seed khi mở profile, import JSON/Netscape và export. Giờ chạy
  qua WebDriver BiDi (`storage.setCookie` / `storage.getCookies`). Đã thử
  trên InviFox thật với cookie domain, host-only, phiên, httpOnly và sameSite.
- **Sắp xếp cửa sổ đang chạy và spotlight** giờ chạy được với profile
  Firefox (BiDi `browser.setClientWindowState` / `browsingContext.activate`).

**Kiểm thử:**

- `node tools/invifox-test/webrtc-proxy.mjs --exe <invifox.exe>`: 12/12
  tổ hợp (2 persona × proxy HTTP/SOCKS5 × forward/replace/disable).
- Các site thật qua proxy có mật khẩu (chế độ forward):

  | Site | Windows (proxy HTTP) | Android (proxy SOCKS5) |
  |---|---|---|
  | BrowserScan | 100% (trước khi sửa: 90%, "IP addresses are different") | 100% |
  | Pixelscan | consistent, no masking | consistent, no masking |
  | Scanbrowser | Đáng tin cậy, 4/4 | — |
  | iphey | Trustworthy | — |
  | CreepJS | 6% | 13% |
  | browserleaks WebRTC | Local IP "-", Public IP = IP proxy | như Windows |

  Ô "WebRTC" của BrowserScan hiện "disabled". Ô đó là IP mà TURN server của
  ThreatMetrix thực sự nhận được gói UDP; qua proxy HTTP thì không có UDP nào
  đi ra, nên đó là kết quả đúng, không rò. Ô này không bị trừ điểm.
- Các case không proxy, chạy lại trên bản build cuối: win-noise đủ 14 site
  ok; win-default và android-default (BrowserScan 100%, Pixelscan sạch,
  CreepJS 6% / 13%) giữ nguyên như lượt 8.
- Launcher: typecheck sạch. Unit test cookie mới đạt. 34 test cũ của module
  profile báo `ERR_DLOPEN_FAILED` cả trước lẫn sau thay đổi: module native
  được build cho Electron chứ không phải cho Node, lỗi có sẵn từ trước.

**Luồng tạo/sửa profile Firefox trong Invi (launcher commit `5289b14d`, InviFox `10d9ffdce9`):**

Một helper dùng chung (`shared/utils/fingerprint-engine.ts`, có bản sao trong
`invi-server`) giữ fingerprint khớp với engine ở mọi đường tạo/sửa:

- **Đường áp dụng:**
  - IPC tạo/sửa, đường lưu qua HTTP;
  - `profileService` create, update (sau merge, cả chế độ cloud), clone, bulk;
  - server POST/PATCH `/profiles` và bulk generator;
  - external API: thêm trường `engine`, chế độ `auto` biết engine và OS.
- **Profile Firefox nhận:**
  - UA InviFox Firefox 160 đúng OS; iOS chuyển thành Android;
  - phiên bản Android thật: phiên bản người dùng chọn, hoặc phiên bản đã lưu, hoặc chọn theo tỉ lệ thị phần. Không còn cảnh mọi profile cùng "Android 10";
  - `browser_version` 160.0.
- **Profile Chromium:** không bao giờ giữ UA Firefox.

Lỗi đã sửa:

- **Clone:** profile Firefox hoặc Android clone ra bị biến thành Chromium
  Windows với UA Chrome mặc định. Giờ giữ nguyên engine, OS, UA, vị trí và
  thiết bị media.
- **Seed noise canvas/audio/glyph/rects:** trước đây tính từ đường dẫn tuyệt
  đối, nên sang máy khác sau khi sync cloud là hash đổi. Giờ launcher truyền
  seed tính từ ID profile; khi không có seed, InviFox dùng phần `<id>/firefox`
  của đường dẫn. Đã kiểm chứng: cùng ID ở hai "máy" ra cùng hash, khác ID thì
  khác hash.
- **Chromium runtime:** không còn tải cho profile Firefox, và không lưu
  `engine_version` của Chromium vào profile Firefox.
- **Cloud backup:** không còn đóng gói cache, dữ liệu crash/telemetry và
  `parent.lock` của Firefox.

Giao diện:

- **Màn tạo và màn sửa, khi chọn Firefox:**
  - ô trình duyệt hiện "InviFox · Firefox 160" thay cho bộ chọn phiên bản Chrome;
  - UA Firefox cập nhật trực tiếp, ở chế độ chỉ đọc, kèm ghi chú;
  - ẩn iOS; preview hiện đúng tên trình duyệt;
  - "New fingerprint" tôn trọng engine;
  - màn sửa hỏi xác nhận khi đổi engine, vì mỗi engine có thư mục dữ liệu riêng.
- **Bulk create:** thêm chọn engine; danh sách OS cho Firefox là Windows 10/11
  và Android 13–15, không có iOS.
- **Danh sách profile:** badge "Firefox" cạnh tên.
- **Thông báo lỗi:** `ENGINE_NOT_SUPPORTED` và `INVIFOX_BINARY_NOT_FOUND`
  hiện bằng câu dễ hiểu (tiếng Việt và tiếng Anh).

Kiểm thử:

- Helper chuẩn hoá: test mới đạt. Flags builder 25/25 (seed và UA). Bulk
  phía server 22/22.
- Bộ test launcher không thêm lỗi nào so với HEAD; các lỗi module native
  có sẵn vẫn như cũ.
- Site thật với args mới có seed: win-noise và android-noise đều BrowserScan
  100%, CreepJS 6% / 13%, Pixelscan consistent; check.mjs 34/34 và 41/41.

**Còn thiếu ở phía launcher:**

- **Automation, selector builder và action sync** vẫn báo `ENGINE_NOT_SUPPORTED`
  với profile Firefox.
  - Lý do: automation gọi CDP thô ở khoảng 250 chỗ, mà Firefox 160 đã bỏ CDP.
  - Muốn chạy được phải viết một lớp chuyển CDP sang WebDriver BiDi. Đây là
    một dự án riêng, cần ước lượng và thiết kế, không làm vội được.
  - Giao diện đã báo lỗi rõ ràng, không treo.
- Extension Chrome không chạy trên Firefox. Profile có giới hạn URL bị chặn
  mở bằng Firefox (fail closed).

## 1. Kết quả lượt 8 (không proxy, chạy đúng tham số launcher)

Tham số lấy nguyên từ launcher (`tools/invifox-test/launcher-args.json`, sinh
bằng test local trong worktree launcher). Mỗi case mở 14 site; check.mjs chấm
tự động so với baseline (InviFox không switch = Firefox 160 gốc).

| Site | win-default | win-noise | android-default | android-noise |
|---|---|---|---|---|
| check.mjs (rule nội bộ) | 44/44 | 45/45 | 52/52 | 53/53 |
| BrowserScan authenticity | 100% | 100% | 100% | 100% |
| BrowserScan bot | Normal | Normal | Normal | Normal |
| Scanbrowser | Đáng tin cậy, 4/4 bình thường | Đáng tin cậy | Phần mềm: bất thường (*) | Phần mềm: bất thường (*) |
| CreepJS like-headless / headless / stealth | 6% / 0% / 0% (= Firefox gốc) | 6/0/0 | 13% / 0% / 0% (**) | 13/0/0 |
| Pixelscan | consistent, no masking | consistent, no masking | consistent, no masking | consistent, no masking (***) |
| iphey | Trustworthy | Trustworthy | Trustworthy | Trustworthy |
| fingerprint.com | bot not_detected, tampering false, anti_detect false, VM false | như trên | như trên | như trên |
| Sannysoft | chỉ "Chrome (New) missing" (đúng với Firefox) | như trên | như trên | như trên |

(*) Xem mục 4.1. (**) Thêm 1 tiêu chí so với Windows: `noTaskbar`
(availHeight = height). Điện thoại thật cũng vậy, GeckoView và Chrome Android
đều báo avail = toàn màn hình, nên đây là mức tự nhiên của máy Android.
(***) Lần chạy đầu bị "inconsistent / masking". Chạy lại 5 lần (kể cả
nguyên tham số) đều sạch. Pixelscan tự ghi chú rằng đổi tham số giữa các
phiên trên cùng IP gây "inconsistent", mà lượt test chạy liên tiếp 5 persona
trên một IP.

`fingerprint.com` vẫn báo "VPN (OS mismatch)" ở mọi case, kể cả Firefox gốc
không switch. Nguyên nhân là đường mạng IPv4/NAT của nhà mạng, không liên
quan tới trình duyệt.

## 2. Đã sửa trong đêm

1. **Font Android không còn ô vuông (tofu).** Trước đây persona Android lọc
   bỏ mọi font Windows (`font.system.whitelist`), nên mất luôn fallback theo
   ký tự: chữ Trung/Nhật/Hàn, Ả Rập, Thái hiện thành ô hex. Đây vừa là lỗi
   hiển thị vừa là dấu hiệu nhận diện. Giờ font Windows vẫn dùng được cho
   fallback, nhưng trang chỉ gọi được tên các font Android (CSS, canvas,
   `local()`).
   - Tên Android không có sẵn được ánh xạ sang font cùng loại:
     `Noto Color Emoji` → Twemoji; `Noto Sans/Serif CJK JP/KR/SC/TC/HK` → font
     CJK Windows tương ứng.
   - Đóng gói thêm Noto Serif (OFL) và Droid Sans Mono (Apache-2.0, chỉ có
     Latin), lấy từ file có sẵn trên máy, không tải gì. Nhờ vậy serif và
     monospace là font Android thật, và Roboto dò được bằng độ rộng chữ.
   - Persona desktop vẫn ẩn cả 3 font Android.
2. **Harness:** site quá hạn không còn ghi nhầm nội dung trang sau vào file
   của nó. Có đo thời gian từng site và từng bước selfCheck.
3. Rule mới trong check.mjs: CJK render được, tên Noto Android dò thấy, font
   Android bị ẩn trên desktop.

Các lượt full5 và full6 hỏng (mọi site quá hạn) là do môi trường, không phải
build. Chúng chỉ xảy ra khi harness chạy nền (detached). Chạy foreground thì
cùng build, cùng tham số đều ổn (8–25 s mỗi site). `round.sh` đã ghi chú
phải chạy foreground.

## 3. Cách nghiệm thu nhanh

```sh
cd tools/invifox-test
EXE=C:/Users/AnhDuong/Downloads/FireFox/obj-sg-release/dist/bin/invifox.exe
# một case (khoảng 5 phút), chạy ở terminal foreground:
node run.mjs --exe $EXE --args-file launcher-args.json --case android-default --out results/my-android
node check.mjs results/my-android --baseline results/full7/baseline
node summarize.mjs results my-android
# xem tận mắt một site:
node probe-site.mjs --exe $EXE --args-file launcher-args.json --case android-default \
  --url https://scanbrowser.net/ --click "Phần mềm" --out shot.png
```

Kết quả lượt 8 nằm ở `tools/invifox-test/results/full8/` (ảnh và text từng
site). Thư mục này không commit.

## 4. Hạn chế còn lại

1. **Scanbrowser, persona Android: "Phần mềm — bất thường".** Đã loại trừ
   bằng thí nghiệm bỏ từng cờ: font (rỗng, 4 font Noto, thêm cả
   DejaVu/Liberation), timezone, kích thước màn hình, WebGL đều không đổi
   kết quả. Với `navigator.platform = "Linux armv81"`, site dò danh sách
   font Linux desktop, trong đó không có font nào chỉ Android mới có. Vì vậy
   nhiều khả năng Firefox Android thật cũng bị đánh dấu. Muốn kết luận chắc
   phải đọc mã đã làm rối của site, việc này tôi không làm. Persona Windows
   sạch hoàn toàn.
2. **iOS:** không thể giả lập trên Gecko (UA, WebKit API, engine khác hẳn).
3. **Emoji Android** vẽ bằng Twemoji, máy thật dùng Noto Color Emoji. Hash
   canvas emoji vì thế khác máy thật. File Noto Color Emoji có trên máy (bản
   CBDT 9–10 MB), nhưng Firefox trên Windows có thể không vẽ được CBDT. Chưa
   làm.
4. **Glyph CJK trên Android** là font Windows (YaHei, Malgun…), không phải
   Noto CJK. Thấy được nếu đo hình dạng glyph chi tiết.
5. **Tham số WebGL trên Android** (extension, giới hạn) vẫn là của GPU máy
   thật. Chỉ chuỗi renderer/vendor là GPU điện thoại (Adreno/Mali).
6. **Dữ liệu từ generator của launcher:**
   - Renderer Mesa/OpenGL bị InviFox từ chối, dùng GPU thật.
   - Kích thước iPhone được map sang kích thước Android.
   - `--media-device-count=0,0,0` được giữ nguyên hành vi thật. Máy test
     không có mic/camera nên `enumerateDevices` rỗng, Firefox gốc cũng vậy.
7. **Nhánh launcher** `feat/invifox-runtime` (worktree `gravbrowser-invifox`,
   dựng trên `develop` 1.6.85; commit `414ec8c0` và `59f52c1b`). Thay cho
   nhánh cũ `feat/invifox-engine`, vẫn còn bản backup
   `backup/invifox-engine-pre-rebase`. Mới ở local: lệnh push bị hệ thống quyền
   chặn, chờ anh/chị push hoặc cho phép.
8. **Phân phối cho người dùng (đã làm phần code):**
   - InviFox phát hành giống Chromium runtime: release trên GitHub
     `SellGravity/firefox`, tag `v160.0.1.N`, file
     `invifox-<version>-win64.zip`.
   - Server có route `/runtime/*?engine=firefox`.
   - Launcher tự tải, cài vào `invifox-runtimes/<version>` và tự cập nhật
     bản mới nhất.
   - Bản đầu tiên `160.0.1.1` đã đóng gói và kiểm thử từ chính file zip:
     BrowserScan 100%, CreepJS 13%, proxy/WebRTC 6/6, giải nén bằng AdmZip
     của launcher OK. Tag đã push.
   - Còn lại:
     - tạo release trên web và tải zip lên;
     - deploy server;
     - merge và phát hành launcher;
     - ký số `invifox.exe` (chưa ký).

## 5. Commit trong phiên này (develop)

- `10d9ffdce9` fix(invifox): derive fallback noise seeds from the profile-relative path
- `b2d150b8d6` fix(invifox): WebRTC behind a proxy shows the exit IP and never the real one

- `d7ad1a4b55` fix(invifox): Android font set without tofu (name gate + Noto aliases, bundled Noto Serif / Droid Sans Mono)
- `da29475bce` test(invifox): per-step timings, zombie-safe site deadline, font/CJK rules, probe tools
- Trước đó: `9091d5e6e2` (system font + viewport Android), `bc6daccf03` (IPv4-only DNS), `6cb7da2bdb`, `956563ad51`, `08fb7765df`, `af60ccac66`, `3bbc82ace7`, `f7d1b5d1de`.
