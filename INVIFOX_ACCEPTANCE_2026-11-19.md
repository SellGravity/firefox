# InviFox — báo cáo nghiệm thu (19/11/2026)

Bản build: `obj-sg-release/dist/bin/invifox.exe` (Firefox 160.0.1, nhánh
`develop`, commit `da29475bce`). Mọi thay đổi đã push lên
`SellGravity/firefox` `develop`.

## 1. Kết quả cuối (lượt 8, chạy đúng tham số launcher)

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
7. **Nhánh launcher** `feat/invifox-engine` (worktree `gravbrowser-invifox`,
   commit `fa11fdc6`) mới commit local, chưa push và chưa tạo PR. Chờ
   duyệt.

## 5. Commit trong phiên này (develop)

- `d7ad1a4b55` fix(invifox): Android font set without tofu (name gate + Noto aliases, bundled Noto Serif / Droid Sans Mono)
- `da29475bce` test(invifox): per-step timings, zombie-safe site deadline, font/CJK rules, probe tools
- Trước đó: `9091d5e6e2` (system font + viewport Android), `bc6daccf03` (IPv4-only DNS), `6cb7da2bdb`, `956563ad51`, `08fb7765df`, `af60ccac66`, `3bbc82ace7`, `f7d1b5d1de`.
