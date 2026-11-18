# SellGravity Firefox Antidetect — kế hoạch

Base: **Firefox 160.0.1** (tag `FIREFOX_160_0_1_RELEASE`), nhánh `antidetect/160`.
Bản tham chiếu: fork Chromium `SellGravity/chromium` (base 143), xem `ANTIDETECT_AUDIT_2026-11-18.md` bên repo đó.

## 0. Nguyên tắc rút ra từ bản Chromium

1. **Luôn bám bản stable thật.** Bên Chromium bị lộ vì UA 148, engine 143, Chrome thật 157 (A6). Bên này mỗi bản Firefox release (4 tuần một lần) phải rebase patch set lên tag `FIREFOX_<N>_0_RELEASE` mới.
2. **Chỉ giả Firefox.** Gecko không có UA-CH (`navigator.userAgentData`) và có nhiều khác biệt engine (CSS, JS, `-moz-*`). Profile luôn phải là UA Firefox đúng version engine. Chỉ đổi OS và phần cứng.
3. **Không tự gây lộ ở launcher.** Không mở cổng remote debugging (A1). Không dùng chuỗi GPU sai OS (A2). Không để GPU giả khác hãng với GPU thật (A3).
4. **Nhất quán hơn ngẫu nhiên.** Noise phải xác định theo seed của profile. Tắt noise ở chỗ CreepJS/BrowserScan có kiểm tra chéo; bên Chromium đã rút kinh nghiệm về WebGL readback và rects.

## 1. Cách nạp profile — tương đương `SessionNoiseCache`

Chromium dùng switch dòng lệnh và chép từng switch sang renderer. Gecko có cơ chế gọn hơn: **prefs được tự đồng bộ từ parent sang mọi content process** qua shared-memory pref map.

- Launcher ghi `<profile>/user.js` (hoặc truyền `--sg-fp-config <file.json>`) với các pref `sg.fp.*`.
- Mọi pref khai báo trong `modules/libpref/init/StaticPrefList.yaml` với `mirror: always`. Code C++ ở content process đọc bằng `StaticPrefs::sg_fp_*()`, không cần IPC.
- Seed: parent process tính `hash(profileDir + salt)` cho từng loại: canvas, audio, fonts, rects. Nếu launcher không đưa seed thì ghi lại vào pref `sg.fp.seed.*` lúc khởi động.
- Đặt pref ở dạng **locked** để trang/extension không đổi được, và ẩn `sg.fp.*` khỏi `about:config`.
- Singleton `SGFingerprint` đặt trong `toolkit/components/resistfingerprinting/` (cạnh `nsRFPService`) là nơi tập trung mọi getter.

Đề xuất bộ pref (tương ứng switch Chromium):

| Pref | Chromium | Ghi chú |
|---|---|---|
| `general.useragent.override` (có sẵn) | `--user-agent` | Áp cho cả HTTP và JS |
| `sg.fp.platform`, `sg.fp.oscpu` | (suy từ UA) | `Win32`, `Windows NT 10.0; Win64; x64` |
| `sg.fp.hardware_concurrency` | `--hardware-concurrency` | |
| `intl.accept_languages` (có sẵn) | `--accept-lang` | Thêm `sg.fp.languages` nếu cần tách |
| `sg.fp.timezone` | `--timezone` | IANA |
| `sg.fp.screen.*` (w, h, availW, availH, colorDepth, dpr) | `--window-size`, `--dpr-override` | |
| `webgl.override-unmasked-vendor` / `-renderer` (có sẵn) | `--webgl-vendor/-renderer` | Cần thêm params và lọc extensions |
| `sg.fp.webgl.params` (JSON) | `webgl_parameters` | Port `webgl_gpu_profiles.h` |
| `sg.fp.seed.canvas/audio/fonts/rects` | `--canvas-seed`… | |
| `sg.fp.fonts.allow` / `.block` | `--font-exclusion-list` | |
| `sg.fp.media_devices` | `--media-device-count` | |
| `sg.fp.webrtc.mode`, `sg.fp.webrtc.public_ip` | `--webrtc-mode`, `--webrtc-proxy-ip` | |
| `sg.fp.geo.mode`, `sg.fp.geo.lat/lng/acc` | `--location-mode` | |

## 2. Bản đồ các bề mặt spoof: Chromium → Gecko

| Bề mặt | Chromium (đã làm) | Điểm hook trong Gecko 160 | Cách làm |
|---|---|---|---|
| UA (HTTP + JS) | `user_agent_utils.cc` | `netwerk/protocol/http/nsHttpHandler.cpp`, pref `general.useragent.override` | Có sẵn. Kiểm tra cả worker và `navigator.appVersion` |
| navigator.platform / oscpu | `navigator_base.cc` | `dom/base/Navigator.cpp`: `GetPlatform` (l.427, 2063), `GetOscpu` (l.452) | Đọc `sg.fp.platform/oscpu`. Sửa cả bản static dùng cho worker |
| hardwareConcurrency | `navigator_concurrent_hardware.cc` | `Navigator::HardwareConcurrency` (l.691) và `WorkerNavigator` | Pref |
| deviceMemory | có | — | Firefox không có API này. Không thêm |
| webdriver | luôn false | `Navigator::Webdriver` (l.2378) | Trả false. Build với `--disable-webdriver` hoặc chỉ cho Marionette chạy qua pipe |
| languages | stock flag | `Navigator::GetLanguages` (l.407), `intl.accept_languages` | Có sẵn. Đồng bộ thêm `Intl` locale qua `intl.locale.requested` |
| screen.* | `render_widget_host_view_base.cc` | `dom/base/nsScreen.cpp`: `GetRect` (l.70), `GetAvailRect` (l.102), `colorDepth` | Override theo pref |
| inner/outer, DPR | `local_dom_window.cc` | `dom/base/nsGlobalWindowInner.cpp`: `GetInnerWidth` (l.3728), `GetOuterWidth` (l.3754), `GetDevicePixelRatio` (l.3811); media queries trong `layout/style/nsMediaFeatures.cpp` | Override, và chỉnh luôn kích thước cửa sổ thật cho khớp (`layout.css.devPixelsPerPx`) |
| Timezone | ICU `ucal_setDefaultTimeZone` | `js/src/vm/DateTime.cpp` (`ResetTimeZoneInternal`), `nsRFPService::GetSpoofedJSTimeZone` (l.1063) | Dùng lại đường RFP đang spoof UTC, đổi thành `sg.fp.timezone`. Phải gọi cho mọi process |
| WebGL vendor/renderer | `webgl_debug_renderer_info.cc` | `dom/canvas/ClientWebGLContext.cpp` l.2510; pref `webgl.override-unmasked-*` có sẵn | Có sẵn một phần. Thêm `GetParameter` override và lọc `GetSupportedExtensions` (l.6426) theo GPU profile |
| WebGPU adapter info | `gpu_adapter_info.cc` | `dom/webgpu/Adapter.cpp` | Override `GPUAdapterInfo` |
| Canvas 2D noise | `html_canvas_element.cc`, `base_rendering_context_2d.cc` | `nsRFPService::RandomizePixels` (đã có), gọi từ `CanvasRenderingContext2D.cpp` l.2321/6901 và `CanvasUtils.cpp` | Mozilla đã có canvas randomization (RFPTarget `CanvasRandomization`). Thay key ngẫu nhiên theo session bằng `sg.fp.seed.canvas` và bật target cố định |
| Audio noise | `audio_noise_generator.h` | `dom/media/webaudio/` (`AnalyserNode`, `DynamicsCompressorNode`, `AudioBuffer`, `OfflineAudioContext`) | Port thuật toán, seed `sg.fp.seed.audio` |
| Fonts | `font_cache.cc` | `FontVisibilityProvider` + `gfx/thebes/gfxPlatformFontList.cpp` (`font.system.whitelist`) | Danh sách allow/block theo profile. Glyph-metric noise trong `gfx/thebes/gfxFont.cpp` |
| Client rects | `dom_rect_read_only.cc` (mặc định tắt) | `dom/base/DOMRect.cpp`, `Element::GetBoundingClientRect` | Để tắt mặc định như bên Chromium |
| WebRTC IP | `rtc_peer_connection_handler.cc` + SOCKS5 UDP | `dom/media/webrtc/jsapi/PeerConnectionImpl.cpp`, `dom/media/webrtc/transport/` (nICEr); prefs `media.peerconnection.ice.proxy_only*`, `no_host`, `default_address_only` | Bước 1: dùng prefs có sẵn (`proxy_only` + `no_host`). Bước 2: rewrite srflx bằng `sg.fp.webrtc.public_ip`, như mode `replace` |
| Media devices | `media_devices.cc` | `dom/media/MediaManager.cpp`, `MediaDevices.cpp`; `media.navigator.streams.fake` | Nhãn và số lượng giả |
| Geolocation | `geolocation_provider_impl.cc` | `dom/geolocation/Geolocation.cpp`; `geo.provider.network.url`, `geo.provider.testing` | Pref mock lat/lng. Mode `ip` tra qua proxy (bên Chromium đang đi tắt proxy, không nên làm vậy) |
| Plugins / pdfViewerEnabled | `dom_plugin_array.cc` | `dom/base/nsPluginArray.cpp` | Firefox thật luôn có 5 PDF plugin. Giữ nguyên |
| Mobile | `in_process_emulation_client.cc` | — | Không làm. Firefox desktop không giả được Android tin cậy, dùng GeckoView nếu cần |

## 3. Chống lộ riêng của Firefox

- Branding: không dùng branding official của Mozilla (vướng trademark). Dùng `browser/branding/unofficial` hoặc branding riêng. Website không đọc được branding, chỉ đọc UA.
- Kiểm tra `about:` pages và `resource://` (một số site dò extension qua `moz-extension://`).
- Tắt telemetry, Normandy/Nimbus, remote settings `fingerprinting-protection-overrides`, vì chúng có thể đè cấu hình (`privacy.fingerprintingProtection.remoteOverrides.enabled=false`).
- Automation: không bật `marionette.enabled`/`remote.active-protocols` khi chạy thật. Nếu launcher cần điều khiển, dùng pipe hoặc cổng ngẫu nhiên bind localhost, và chặn trang web truy cập loopback.

## 4. Build trên Windows

1. Cài **MozillaBuild** (https://ftp.mozilla.org/pub/mozilla/libraries/win32/MozillaBuildSetup-Latest.exe) vào `C:\mozilla-build`.
2. Mở `C:\mozilla-build\start-shell.bat`, `cd /c/Users/AnhDuong/Downloads/FireFox`.
3. `./mach bootstrap` chọn "Firefox for Desktop". Bước này tự tải clang-cl, Rust, Windows SDK và Node.
4. `./mach build` dùng `mozconfig` ở root. Lần đầu mất khoảng 1–2 giờ, objdir khoảng 40 GB.
5. `./mach run` để chạy thử. `./mach package` tạo bản phân phối trong `obj-sg-release/dist/`.

## 5. Lộ trình

- [x] Fork `SellGravity/firefox`, nhánh `antidetect/160` từ 160.0.1
- [ ] Build vanilla thành công (mốc chuẩn để so sánh)
- [ ] P1: hạ tầng `sg.fp.*` + `SGFingerprint` + seed theo profile
- [ ] P2: navigator, screen, window, timezone, UA (bộ cơ bản)
- [ ] P3: WebGL params/extensions + WebGPU + GPU profiles (port từ Chromium)
- [ ] P4: canvas/audio/fonts noise theo seed
- [ ] P5: WebRTC, media devices, geolocation
- [ ] P6: launcher InviBrowser hỗ trợ engine Firefox (sinh `user.js`)
- [ ] P7: kiểm thử BrowserScan, CreepJS, fingerprint.com, pixelscan; so sánh với Firefox 160 thật trên cùng máy
- [ ] Quy trình rebase mỗi bản release (script `git rebase --onto FIREFOX_<N+1>_0_RELEASE`)

## 6. Trạng thái P1 (đã code, CHƯA build/test được vì máy chưa có toolchain)

**Hợp đồng với launcher:** Firefox nhận **đúng các switch** mà `gravbrowser/electron/modules/chromium/chromium-flags.builder.ts` đang sinh ra. Gecko vốn hỗ trợ cú pháp `--flag=value` (`toolkit/xre/CmdLineAndEnvUtils.h`).

Luồng xử lý:

1. `toolkit/xre/nsAppRunner.cpp`: hàm `CollectLaunchArgs()` chạy sau khi lưu `gRestartArgv`.
   - Gỡ các switch ra khỏi argv. Bước này bắt buộc: nếu để lại, `--foo=bar` sẽ bị tách đôi và `bar` bị mở như một URL.
   - Đặt biến môi trường `MOZ_SG_TIMEZONE` trước khi JS chạy. Mọi child process sẽ kế thừa biến này.
2. `ApplyLaunchConfig()` chạy ngay sau `DoStartup()`, tức là lúc prefs của profile đã nạp và chưa có cửa sổ hay content process nào.
   - Ghi các pref vào default branch rồi **lock**. Nhờ vậy prefs.js không giữ lại gì và trang web, add-on hay about:config đều không sửa được.
3. Content process đọc giá trị qua `StaticPrefs::sg_fp_*()`.

| Switch | Gecko | Trạng thái |
|---|---|---|
| `--user-agent` | Ép về UA Firefox đúng version engine (giữ OS), sau đó đặt `general.useragent/platform/oscpu/appversion.override` | xong |
| `--timezone` | `MOZ_SG_TIMEZONE` → `js/src/vm/DateTime.cpp` gọi `intl::TimeZone::SetDefaultTimeZone` | xong |
| `--lang` / `--accept-lang` | `intl.accept_languages` | xong (chưa có locale của `Intl`) |
| `--hardware-concurrency` | `RuntimeService::ClampedHardwareConcurrency` (áp cho cả window và worker) | xong |
| `--screen-size` (mới) / `--window-size` | `nsScreen::GetRect/GetAvailRect` (avail trừ thanh taskbar) | xong |
| `--webgl-vendor/-renderer` | `webgl.override-unmasked-*` (sẵn có), chuỗi vẫn đi qua `SanitizeRenderer` như Firefox thật | xong; params/extensions để P3 |
| `--canvas/audio/fonts/rects/webgl-noise`, seed | `sg.fp.*_noise`, `sg.fp.seed.*`. Thiếu seed thì lấy hash(profile dir + salt), giống Chromium | mới có pref; thuật toán để P4 |
| `--proxy-server` | `network.proxy.*`, `socks_remote_dns`, `failover_direct=false`. User/pass chỉ giữ trong parent | xong (phần auth để P5) |
| `--webrtc-mode` | `media.peerconnection.ice.*` | cơ bản; rewrite srflx để P5 |
| `--location-mode` | `permissions.default.geo` + `geo.provider.network.url` (data: JSON); tắt quét Wi-Fi | xong (mode `ip` để P5) |
| `--media-device-count`, `--webgpu-*`, `--font-exclusion-list` | mới có pref | P3–P5 |
| `navigator.webdriver` | luôn `false` khi `sg.fp.enabled` (remote agent sẽ bật nó lên nếu không chặn) | xong |
| `--device-memory` | bỏ qua: Firefox không có API này | đúng hành vi |
| `--headless=new` | chuyển thành `MOZ_HEADLESS=1` | xong |
| các switch chỉ Chromium có (`--disable-features`…) | nuốt bỏ | xong |

## 7. Việc phía launcher (gravbrowser) để chạy engine Firefox

- [ ] Thêm loại engine `firefox` vào profile và runtime, tải bản build từ R2 giống `browser-runtimes`.
- [ ] Khi spawn Firefox: dùng `-profile <dir>` thay cho `--user-data-dir`, thêm `-no-remote`; bỏ `--remote-debugging-port` nếu không cần tự động hoá.
- [ ] **Tự động hoá:** Firefox **không còn CDP** (đã gỡ khỏi Gecko). `cdp.service.ts` phải có thêm nhánh WebDriver BiDi, hoặc dùng Playwright/Puppeteer qua BiDi. Đây là phần việc lớn nhất phía launcher.
- [ ] Sinh UA Firefox (`shared/utils/user-agent.ts`). Phía engine cũng tự ép về đúng version.
- [ ] Truyền `--screen-size=W,H` lấy từ `fp.screen` để màn hình giả không bị lấy theo kích thước ô xếp cửa sổ.
- [ ] Mode vị trí `ip`: launcher tự đổi IP proxy ra toạ độ rồi truyền `--location-mode=<perm>,lat,lng`.
- [ ] Đặt kích thước/vị trí cửa sổ thật (P2: đọc `sg.fp.window.*` lúc mở cửa sổ đầu tiên, trong `browser/`).

## 8. InviFox: branding và mobile

**Branding:** thư mục `browser/branding/invifox`. File chạy là `invifox.exe`, tên hiển thị InviFox, vendor SellGravity. Icon tạm thời vẫn lấy của bản unofficial; cần thay bằng logo InviBrowser (`gravbrowser/electron/assets/icon.png`).

### Persona mobile (`--device-mode=phone` hoặc UA Android)

Dùng chính các field của BrowsingContext mà DevTools RDM và WebDriver BiDi đang dùng. Các field này được gán ngay khi tạo top-level context, trong `BrowsingContext::ComputeInitialFields`:

- `TouchEventsOverride=Enabled`: có `TouchEvent` và `ontouchstart`; media query trả `pointer: coarse` và `hover: none`.
- `maxTouchPoints`: mặc định 5 (`--max-touch-points`).
- `OverrideDPPX`: dùng `--force-device-scale-factor`/`--dpr-override`; nếu không truyền thì suy theo chiều rộng (360→3, 393→2.75, 412→2.625).
- Hướng màn hình `portrait-primary` / 0°. Bật `dom.meta-viewport.enabled` và overlay scrollbar (độ rộng thanh cuộn = 0).
- `screen` = `--device-size` (luôn để dọc), `availHeight` = `height`; `outerWidth/Height` = `inner`; `screenX/Y` = 0.
- Cửa sổ thật được co sao cho **vùng nội dung** đúng bằng kích thước thiết bị theo CSS px (`browser/modules/SGWindow.sys.mjs`).
- UA là Firefox for Android, đúng version engine: `Mozilla/5.0 (Android N; Mobile; rv:160.0) Gecko/160.0 Firefox/160.0`; platform/oscpu `Linux armv81`.

Việc còn lại để Android đạt mức tối đa:

- [ ] `window.orientation` và `onorientationchange` hiện chỉ biên dịch trong bản Android (`#if MOZ_WIDGET_ANDROID` trong `Window.webidl`). Cần chuyển sang bật lúc chạy theo `sg.fp.mobile`.
- [ ] Danh sách font Android (Roboto, Noto…) để thay font Windows trong mobile mode.
- [ ] WebGL renderer của GPU mobile (Adreno/Mali) do launcher truyền, kèm params và extensions của GPU đó (P3).
- [ ] Các API desktop-only và Android-only, ví dụ `navigator.share`, Battery, giọng `speechSynthesis`: so sánh với Firefox Android 160 thật rồi bật/tắt theo.
- [ ] Bàn phím ảo / `visualViewport` khi focus vào input (mức nâng cao).

### iOS: giới hạn cứng, không vượt qua được

Trên iOS, mọi trình duyệt (kể cả Firefox iOS) đều phải chạy **WebKit + JavaScriptCore**. Gecko (cũng như Blink bên Chromium) có JS engine, CSS, định dạng lỗi/stack và tập API khác hẳn. Các trang như CreepJS hay fingerprint.com nhận ra ngay bằng feature detection, dù UA và các con số có đúng đến đâu.

Vì vậy InviFox không giả làm iOS: UA iPhone/iPad sẽ được chuyển sang persona Firefox Android và ghi log. Muốn persona iOS thật thì phải có engine WebKit, ví dụ một bản WebKit/Playwright-WebKit build riêng, hoặc thiết bị iOS thật hay cloud phone.
