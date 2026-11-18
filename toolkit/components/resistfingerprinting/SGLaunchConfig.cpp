/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "SGLaunchConfig.h"

#include <stdlib.h>
#include <string.h>

#include <utility>

#include "mozilla/CmdLineAndEnvUtils.h"
#include "mozilla/HashFunctions.h"
#include "mozilla/Logging.h"
#include "mozilla/Preferences.h"
#include "mozilla/StaticPtr.h"
#include "gfxPlatform.h"
#include "mozilla/Span.h"
#include "nsCharSeparatedTokenizer.h"
#include "nsEscape.h"
#include "nsIFile.h"
#include "nsReadableUtils.h"
#include "nsTArray.h"
#include "prenv.h"

namespace mozilla::sgfp {

static LazyLogModule gSGLog("SGFingerprint");
#define SG_LOG(...) MOZ_LOG(gSGLog, LogLevel::Info, (__VA_ARGS__))

namespace {

enum class Kind : uint8_t {
  Bool,   // --flag            (a stray "=value" is consumed and ignored)
  Value,  // --flag=value      (also accepts "--flag value")
};

struct SwitchDef {
  const char* mName;  // lowercase, without leading dashes
  Kind mKind;
};

// Every switch InviBrowser's chromium-flags.builder.ts emits. Switches that
// have no Gecko meaning are still listed so they are swallowed instead of
// confusing nsCommandLine.
const SwitchDef kSwitches[] = {
    // Fingerprint
    {"user-agent", Kind::Value},
    {"timezone", Kind::Value},
    {"lang", Kind::Value},
    {"accept-lang", Kind::Value},
    {"webgl-vendor", Kind::Value},
    {"webgl-renderer", Kind::Value},
    {"webgpu-vendor", Kind::Value},
    {"webgpu-renderer", Kind::Value},
    {"canvas-noise", Kind::Bool},
    {"audio-noise", Kind::Bool},
    {"fonts-noise", Kind::Bool},
    {"rects-noise", Kind::Bool},
    {"webgl-noise", Kind::Bool},
    {"canvas-seed", Kind::Value},
    {"audio-noise-seed", Kind::Value},
    {"unicode-glyphs-seed", Kind::Value},
    {"rects-noise-seed", Kind::Value},
    {"hardware-concurrency", Kind::Value},
    {"device-memory", Kind::Value},
    {"media-device-count", Kind::Value},
    {"font-exclusion-list", Kind::Value},
    // Window / screen
    {"screen-size", Kind::Value},  // Firefox-only: real screen, not tile
    {"window-size", Kind::Value},
    {"window-position", Kind::Value},
    {"window-scale", Kind::Value},
    {"device-mode", Kind::Value},
    {"device-size", Kind::Value},
    {"force-device-scale-factor", Kind::Value},
    {"dpr-override", Kind::Value},
    {"max-touch-points", Kind::Value},
    // Network
    {"proxy-server", Kind::Value},
    {"proxy-auth-user", Kind::Value},
    {"proxy-auth-pass", Kind::Value},
    {"webrtc-mode", Kind::Value},
    {"webrtc-proxy-ip", Kind::Value},
    {"location-mode", Kind::Value},
    // Launcher / UI plumbing
    {"taskbar-title", Kind::Value},
    {"gra-taskbar", Kind::Value},
    {"profile-name", Kind::Value},
    {"gra-token", Kind::Value},
    {"gra-session-id", Kind::Value},
    // Chromium-only switches: swallowed
    {"no-first-run", Kind::Bool},
    {"no-default-browser-check", Kind::Bool},
    {"disable-blink-features", Kind::Value},
    {"disable-features", Kind::Value},
    {"enable-features", Kind::Value},
    {"disable-sync", Kind::Bool},
    {"disable-translate", Kind::Bool},
    {"disable-infobars", Kind::Bool},
    {"disable-background-networking", Kind::Bool},
    {"disable-component-update", Kind::Bool},
    {"disable-default-apps", Kind::Bool},
    {"ignore-gpu-blocklist", Kind::Bool},
    {"enable-unsafe-webgpu", Kind::Bool},
};

struct CollectedArg {
  nsCString mName;
  nsCString mValue;
};

StaticAutoPtr<nsTArray<CollectedArg>> sArgs;
StaticAutoPtr<nsCString> sProxyUser;
StaticAutoPtr<nsCString> sProxyPass;

const nsCString* FindArg(const char* aName) {
  if (!sArgs) {
    return nullptr;
  }
  for (const auto& arg : *sArgs) {
    if (arg.mName.Equals(aName)) {
      return &arg.mValue;
    }
  }
  return nullptr;
}

bool HasArg(const char* aName) { return FindArg(aName) != nullptr; }

void StoreArg(const char* aName, const char* aValue) {
  for (auto& arg : *sArgs) {
    if (arg.mName.Equals(aName)) {
      arg.mValue.Assign(aValue ? aValue : "");  // last occurrence wins
      return;
    }
  }
  CollectedArg* arg = sArgs->AppendElement();
  arg->mName.Assign(aName);
  arg->mValue.Assign(aValue ? aValue : "");
}

// PR_SetEnv keeps the pointer, so the string must live forever.
void SetEnvForever(const nsACString& aName, const nsACString& aValue) {
  nsAutoCString kv(aName);
  kv.Append('=');
  kv.Append(aValue);
  char* leaked = strdup(kv.get());
  if (leaked) {
    PR_SetEnv(leaked);
  }
}

bool IsSafeTimeZoneId(const nsACString& aTz) {
  if (aTz.IsEmpty() || aTz.Length() > 64) {
    return false;
  }
  for (char c : Span(aTz.BeginReading(), aTz.Length())) {
    if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
          (c >= '0' && c <= '9') || c == '/' || c == '_' || c == '-' ||
          c == '+')) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Pref helpers. Values go to the DEFAULT branch and are locked: a locked pref
// always reports its default value, so nothing is persisted into prefs.js and
// neither pages, add-ons nor about:config edits can change it for the session.

void LockCString(const char* aPref, const nsACString& aValue) {
  Preferences::Unlock(aPref);
  Preferences::SetCString(aPref, aValue, PrefValueKind::Default);
  Preferences::Lock(aPref);
}

void LockBool(const char* aPref, bool aValue) {
  Preferences::Unlock(aPref);
  Preferences::SetBool(aPref, aValue, PrefValueKind::Default);
  Preferences::Lock(aPref);
}

void LockInt(const char* aPref, int32_t aValue) {
  Preferences::Unlock(aPref);
  Preferences::SetInt(aPref, aValue, PrefValueKind::Default);
  Preferences::Lock(aPref);
}

void LockUint(const char* aPref, uint32_t aValue) {
  Preferences::Unlock(aPref);
  Preferences::SetUint(aPref, aValue, PrefValueKind::Default);
  Preferences::Lock(aPref);
}

void LockFloat(const char* aPref, float aValue) {
  Preferences::Unlock(aPref);
  Preferences::SetFloat(aPref, aValue, PrefValueKind::Default);
  Preferences::Lock(aPref);
}

bool ParseUint(const nsACString& aStr, uint64_t& aOut) {
  if (aStr.IsEmpty()) {
    return false;
  }
  uint64_t v = 0;
  for (char c : Span(aStr.BeginReading(), aStr.Length())) {
    if (c < '0' || c > '9') {
      return false;
    }
    v = v * 10 + uint64_t(c - '0');
  }
  aOut = v;
  return true;
}

bool ParsePair(const nsACString& aStr, int32_t& aA, int32_t& aB) {
  int32_t comma = aStr.FindChar(',');
  if (comma <= 0) {
    return false;
  }
  nsresult rv1, rv2;
  aA = nsCString(Substring(aStr, 0, comma)).ToInteger(&rv1);
  aB = nsCString(Substring(aStr, comma + 1)).ToInteger(&rv2);
  return NS_SUCCEEDED(rv1) && NS_SUCCEEDED(rv2);
}

// ---------------------------------------------------------------------------
// User agent. Gecko must only ever claim to be Firefox of its OWN engine
// version: a Chrome UA, or a Firefox UA of another version, is trivially
// detected through engine features (lesson A6 from the Chromium audit).
// We keep only the OS part of whatever UA the launcher sends.

enum class UAOs { Windows, Mac, Linux, Android, IOS, Unknown };

struct UAParts {
  nsCString mUserAgent;   // navigator.userAgent / HTTP
  nsCString mPlatform;    // navigator.platform
  nsCString mOscpu;       // navigator.oscpu
  nsCString mAppVersion;  // navigator.appVersion
};

UAOs DetectOs(const nsACString& aUA) {
  // Mobile first: Android UAs also contain "Linux", iOS UAs "Mac OS X".
  if (FindInReadable("Android"_ns, aUA)) return UAOs::Android;
  if (FindInReadable("iPhone"_ns, aUA) || FindInReadable("iPad"_ns, aUA)) {
    return UAOs::IOS;
  }
  if (FindInReadable("Windows"_ns, aUA)) return UAOs::Windows;
  if (FindInReadable("Macintosh"_ns, aUA) ||
      FindInReadable("Mac OS X"_ns, aUA)) {
    return UAOs::Mac;
  }
  if (FindInReadable("Linux"_ns, aUA) || FindInReadable("X11"_ns, aUA)) {
    return UAOs::Linux;
  }
  return UAOs::Unknown;
}

UAParts BuildFirefoxUA(const nsACString& aRequestedUA) {
  UAParts out;
  constexpr auto kVer = MOZILLA_UAVERSION ""_ns;  // e.g. "160.0"
  switch (DetectOs(aRequestedUA)) {
    case UAOs::IOS:
      // Gecko cannot pass as WebKit (JS engine, CSS, APIs differ), so an iOS
      // persona would be detected. Use the closest honest persona: Firefox
      // for Android, same engine as us.
      SG_LOG("iOS user-agent requested; using Firefox for Android persona");
      [[fallthrough]];
    case UAOs::Android: {
      nsAutoCString androidVer("15");
      int32_t pos = aRequestedUA.Find("Android "_ns);
      if (pos != kNotFound) {
        uint32_t start = uint32_t(pos) + 8, end = start;
        while (end < aRequestedUA.Length() && aRequestedUA[end] >= '0' &&
               aRequestedUA[end] <= '9') {
          ++end;
        }
        if (end > start) androidVer = Substring(aRequestedUA, start, end - start);
      }
      out.mPlatform.AssignLiteral("Linux armv81");
      out.mOscpu.AssignLiteral("Linux armv81");
      out.mAppVersion = "5.0 (Android "_ns + androidVer + ")"_ns;
      // Firefox for Android: "Gecko/<ver>" instead of "Gecko/20100101".
      out.mUserAgent = "Mozilla/5.0 (Android "_ns + androidVer +
                       "; Mobile; rv:"_ns + kVer + ") Gecko/"_ns + kVer +
                       " Firefox/"_ns + kVer;
      return out;
    }
    case UAOs::Mac:
      out.mOscpu.AssignLiteral("Intel Mac OS X 10.15");
      out.mPlatform.AssignLiteral("MacIntel");
      out.mAppVersion.AssignLiteral("5.0 (Macintosh)");
      out.mUserAgent = "Mozilla/5.0 (Macintosh; "_ns + out.mOscpu;
      break;
    case UAOs::Linux:
      out.mOscpu.AssignLiteral("Linux x86_64");
      out.mPlatform.AssignLiteral("Linux x86_64");
      out.mAppVersion.AssignLiteral("5.0 (X11)");
      out.mUserAgent = "Mozilla/5.0 (X11; "_ns + out.mOscpu;
      break;
    case UAOs::Windows:
    case UAOs::Unknown:
    default:
      out.mOscpu.AssignLiteral("Windows NT 10.0; Win64; x64");
      out.mPlatform.AssignLiteral("Win32");
      out.mAppVersion.AssignLiteral("5.0 (Windows)");
      out.mUserAgent = "Mozilla/5.0 ("_ns + out.mOscpu;
      break;
  }
  out.mUserAgent += "; rv:"_ns + kVer + ") Gecko/20100101 Firefox/"_ns + kVer;
  return out;
}

// ---------------------------------------------------------------------------

nsCString AcceptLanguagesFor(const nsACString& aLang) {
  // Firefox style list; Gecko computes the q-values itself.
  nsAutoCString lang(aLang);
  lang.StripWhitespace();
  if (lang.IsEmpty()) {
    return "en-US, en"_ns;
  }
  if (lang.FindChar(',') != kNotFound) {
    return nsCString(aLang);  // already a list
  }
  nsAutoCString out(lang);
  int32_t dash = lang.FindChar('-');
  nsAutoCString base(lang);
  if (dash > 0) {
    base.Truncate(dash);
  }
  if (!base.Equals(lang)) {
    out += ", "_ns + base;
  }
  if (!base.EqualsLiteral("en")) {
    out += ", en-US, en"_ns;
  }
  return std::move(out);
}

uint32_t DeriveSeed(const nsAString& aProfilePath, const char* aSalt) {
  NS_ConvertUTF16toUTF8 path(aProfilePath);
  HashNumber h = HashString(path.get(), path.Length());
  h = AddToHash(h, HashString(aSalt, strlen(aSalt)));
  return h ? h : 1;  // 0 means "off" for consumers
}

void ApplySeed(const char* aPref, const char* aSwitch,
               const nsAString& aProfilePath, const char* aSalt) {
  uint64_t seed = 0;
  const nsCString* s = FindArg(aSwitch);
  if (s && ParseUint(*s, seed) && seed) {
    LockUint(aPref, uint32_t(seed ^ (seed >> 32)) | 1);
  } else {
    LockUint(aPref, DeriveSeed(aProfilePath, aSalt));
  }
}

void ApplyProxy(const nsACString& aProxy) {
  // [scheme://][user:pass@]host:port
  nsAutoCString rest(aProxy);
  nsAutoCString scheme("http");
  int32_t sep = rest.Find("://"_ns);
  if (sep > 0) {
    scheme = Substring(rest, 0, sep);
    ToLowerCase(scheme);
    nsAutoCString tail(Substring(rest, sep + 3));
    rest = tail;
  }
  int32_t at = rest.RFindChar('@');
  if (at > 0) {
    nsAutoCString creds(Substring(rest, 0, at));
    nsAutoCString hostPort(Substring(rest, at + 1));
    rest = hostPort;
    int32_t colon = creds.FindChar(':');
    nsAutoCString user, pass;
    nsAutoCString rawUser(creds);
    if (colon >= 0) {
      rawUser.Truncate(colon);
    }
    NS_UnescapeURL(rawUser, esc_AlwaysCopy, user);
    if (colon >= 0) {
      NS_UnescapeURL(Substring(creds, colon + 1), esc_AlwaysCopy, pass);
    }
    *sProxyUser = user;
    *sProxyPass = pass;
  }
  int32_t colon = rest.RFindChar(':');
  if (colon <= 0) {
    SG_LOG("proxy-server ignored, no port: %s", rest.get());
    return;
  }
  nsAutoCString host(Substring(rest, 0, colon));
  nsresult rv;
  int32_t port = nsCString(Substring(rest, colon + 1)).ToInteger(&rv);
  if (NS_FAILED(rv) || port <= 0 || port > 65535) {
    return;
  }

  LockInt("network.proxy.type", 1);  // manual
  LockCString("network.proxy.no_proxies_on", ""_ns);
  // Never fall back to a direct connection: that would leak the real IP.
  LockBool("network.proxy.failover_direct", false);
  LockBool("network.proxy.allow_bypass", false);

  if (scheme.EqualsLiteral("socks5") || scheme.EqualsLiteral("socks5h") ||
      scheme.EqualsLiteral("socks4") || scheme.EqualsLiteral("socks")) {
    LockCString("network.proxy.socks", host);
    LockInt("network.proxy.socks_port", port);
    LockInt("network.proxy.socks_version", scheme.EqualsLiteral("socks4") ? 4 : 5);
    LockBool("network.proxy.socks_remote_dns", true);  // no local DNS leak
    LockBool("network.proxy.socks5_remote_dns", true);
    LockCString("network.proxy.http", ""_ns);
    LockCString("network.proxy.ssl", ""_ns);
  } else {
    LockCString("network.proxy.http", host);
    LockInt("network.proxy.http_port", port);
    LockCString("network.proxy.ssl", host);
    LockInt("network.proxy.ssl_port", port);
    LockBool("network.proxy.share_proxy_settings", true);
    LockCString("network.proxy.socks", ""_ns);
  }
  // TODO(P5): SOCKS5 user/pass and HTTP 407 auto-answer from
  // GetProxyCredentials() (nsHttpChannelAuthProvider / nsSOCKSIOLayer).
}

void ApplyWebRtc(const nsACString& aMode) {
  // InviBrowser: disable | forward | replace ("real" sends no switch).
  if (aMode.EqualsLiteral("disable") || aMode.EqualsLiteral("disabled")) {
    LockBool("media.peerconnection.ice.no_host", true);
    LockBool("media.peerconnection.ice.default_address_only", true);
    LockBool("media.peerconnection.ice.proxy_only", true);
  } else if (aMode.EqualsLiteral("forward")) {
    LockBool("media.peerconnection.ice.no_host", true);
    LockBool("media.peerconnection.ice.proxy_only_if_behind_proxy", true);
  } else if (aMode.EqualsLiteral("replace")) {
    LockBool("media.peerconnection.ice.no_host", true);
    LockBool("media.peerconnection.ice.default_address_only", true);
    // TODO(P5): rewrite srflx candidates with sg.fp.webrtc.public_ip.
  }
  LockCString("sg.fp.webrtc.mode", aMode);
}

void ApplyLocation(const nsACString& aMode) {
  // block | ask,ip | allow,ip | <perm>,<lat>,<lng>[,<acc>]
  nsTArray<nsCString> parts;
  for (const auto& token : aMode.Split(',')) {
    parts.AppendElement(token);
  }
  if (parts.IsEmpty()) {
    return;
  }
  // Never send Wi-Fi scans to a location service: real location leak.
  LockBool("geo.provider.network.scan", false);
  LockBool("geo.provider.ms-windows-location", false);
  LockBool("geo.provider.use_corelocation", false);
  LockBool("geo.provider.use_geoclue", false);
  LockBool("geo.provider.use_gpsd", false);

  const nsCString& perm = parts[0];
  if (perm.EqualsLiteral("block")) {
    LockInt("permissions.default.geo", 2);
  } else if (perm.EqualsLiteral("allow")) {
    LockInt("permissions.default.geo", 1);
  } else {
    LockInt("permissions.default.geo", 0);  // ask
  }

  if (parts.Length() >= 3) {
    nsresult rv1, rv2;
    double lat = parts[1].ToDouble(&rv1);
    double lng = parts[2].ToDouble(&rv2);
    if (NS_SUCCEEDED(rv1) && NS_SUCCEEDED(rv2)) {
      double acc = 20.0;
      if (parts.Length() >= 4) {
        nsresult rv3;
        double a = parts[3].ToDouble(&rv3);
        if (NS_SUCCEEDED(rv3) && a > 0) acc = a;
      }
      nsAutoCString url;
      url.AppendPrintf(
          "data:application/json,{\"location\":{\"lat\":%.6f,\"lng\":%.6f},"
          "\"accuracy\":%.1f}",
          lat, lng, acc);
      LockCString("geo.provider.network.url", url);
    }
  } else {
    // "ip" mode (or no coordinates): our builds carry no Google location key,
    // so use an MLS-compatible service. With Wi-Fi scanning off it locates by
    // request IP - and the request goes through the profile proxy, so the
    // answer is the proxy location.
    LockCString("geo.provider.network.url",
                "https://api.beacondb.net/v1/geolocate"_ns);
  }
  LockCString("sg.fp.geo.mode", aMode);
}

// Typical CSS-px width -> device pixel ratio of popular Android phones.
float DefaultMobileDppx(int32_t aCssWidth) {
  if (aCssWidth <= 360) return 3.0f;    // Galaxy S class
  if (aCssWidth <= 393) return 2.75f;   // Pixel 7/8/9
  if (aCssWidth <= 412) return 2.625f;  // Pixel 4a-6, many mid-range
  return 2.0f;                          // tablets
}

void ApplyMobile() {
  const nsCString* mode = FindArg("device-mode");
  bool mobile = mode && mode->EqualsLiteral("phone");
  if (const nsCString* ua = FindArg("user-agent")) {
    UAOs os = DetectOs(*ua);
    mobile = mobile || os == UAOs::Android || os == UAOs::IOS;
  }
  if (!mobile) {
    return;
  }

  LockBool("sg.fp.mobile", true);
  // Like Firefox for Android: honour <meta name=viewport>, expose touch
  // events, overlay scrollbars (scrollbar width 0).
  LockBool("dom.meta-viewport.enabled", true);
  LockInt("dom.w3c_touch_events.enabled", 1);
  LockInt("ui.useOverlayScrollbars", 1);

  // Font list like Android. On a real phone "Arial", "Times New Roman",
  // "Courier New"... are only aliases of the generic families, so a width
  // probe never sees them as installed. Expose only the Android families
  // (Roboto ships in <app>/fonts; Noto Serif / Droid Sans Mono are used when
  // bundled too) and the bundled COLR emoji font: every Windows family,
  // including Segoe UI Emoji, disappears.
  LockCString("font.system.whitelist",
              "Roboto, Noto Serif, Droid Sans Mono, Twemoji Mozilla"_ns);
  // Firefox for Android defaults to sans-serif (Roboto).
  for (const char* lang : {"x-western", "x-unicode", "x-cyrillic", "el"}) {
    auto lockFont = [lang](const char* aPrefix, const nsACString& aValue) {
      nsAutoCString name(aPrefix);
      name.Append(lang);
      LockCString(name.get(), aValue);
    };
    lockFont("font.default.", "sans-serif"_ns);
    lockFont("font.name.sans-serif.", "Roboto"_ns);
    lockFont("font.name.serif.", "Noto Serif"_ns);
    lockFont("font.name-list.serif.", "Noto Serif, Roboto"_ns);
    lockFont("font.name.monospace.", "Droid Sans Mono"_ns);
    lockFont("font.name-list.monospace.", "Droid Sans Mono, Roboto"_ns);
  }
  LockCString("font.name-list.emoji", "Twemoji Mozilla"_ns);
  // Windows SAPI voices would reveal the host OS.
  LockBool("media.webspeech.synth.enabled", false);

  int32_t w = 0, h = 0;
  const nsCString* ds = FindArg("device-size");
  if (ds && ParsePair(*ds, w, h) && w > 0 && h > 0) {
    // Portrait: width < height.
    if (w > h) std::swap(w, h);
    // The persona is always Firefox for Android, but the launcher data set
    // also holds iPhone viewports (375x812, 390x844...), which no Android
    // phone reports. Map them to the closest common Android viewport.
    static const struct {
      int32_t iw, ih, aw, ah;
    } kIphoneToAndroid[] = {
        {320, 568, 360, 640}, {375, 667, 360, 640}, {375, 812, 360, 800},
        {390, 844, 393, 873}, {393, 852, 393, 873}, {402, 874, 412, 915},
        {414, 736, 412, 846}, {414, 896, 412, 915}, {428, 926, 412, 915},
        {430, 932, 412, 915}, {440, 956, 412, 915},
    };
    for (const auto& m : kIphoneToAndroid) {
      if (w == m.iw && h == m.ih) {
        SG_LOG("iPhone viewport %dx%d mapped to Android %dx%d", w, h, m.aw,
               m.ah);
        w = m.aw;
        h = m.ah;
        break;
      }
    }
    LockInt("sg.fp.screen.width", w);
    LockInt("sg.fp.screen.height", h);
  } else {
    w = Preferences::GetInt("sg.fp.screen.width", 412);
  }

  float dppx = 0.0f;
  const nsCString* df = FindArg("force-device-scale-factor");
  if (!df) df = FindArg("dpr-override");
  if (df) {
    nsresult rv;
    dppx = float(nsCString(*df).ToDouble(&rv));
    if (NS_FAILED(rv) || dppx < 1.0f || dppx > 5.0f) dppx = 0.0f;
  }
  LockFloat("sg.fp.dppx", dppx > 0.0f ? dppx : DefaultMobileDppx(w));

  uint64_t tp = 5;
  if (const nsCString* t = FindArg("max-touch-points")) {
    if (!ParseUint(*t, tp) || tp == 0 || tp > 10) tp = 5;
  }
  LockUint("sg.fp.max_touch_points", uint32_t(tp));
}

void ApplyHardening() {
  // Things a launcher-driven profile must never do on its own.
  LockBool("browser.shell.checkDefaultBrowser", false);
  LockBool("browser.aboutwelcome.enabled", false);
  LockCString("browser.startup.homepage_override.mstone", "ignore"_ns);
  LockCString("startup.homepage_welcome_url", ""_ns);
  LockCString("startup.homepage_welcome_url.additional", ""_ns);
  LockBool("datareporting.policy.dataSubmissionEnabled", false);
  LockBool("datareporting.healthreport.uploadEnabled", false);
  LockBool("toolkit.telemetry.enabled", false);
  LockBool("toolkit.telemetry.unified", false);
  LockBool("app.normandy.enabled", false);
  LockBool("app.shield.optoutstudies.enabled", false);
  LockBool("messaging-system.rsexperimentloader.enabled", false);
  // Remote settings must not override our fingerprint values.
  LockBool("privacy.fingerprintingProtection.remoteOverrides.enabled", false);
  LockBool("privacy.resistFingerprinting", false);
  LockBool("privacy.fingerprintingProtection", false);
  LockBool("privacy.resistFingerprinting.pbmode", false);
  LockBool("privacy.fingerprintingProtection.pbmode", false);
  // The remote agent (launcher automation) would otherwise apply its
  // "recommended" automation prefs, some of them web-visible (popup
  // blocker off, ...).
  LockBool("remote.prefs.recommended", false);
}

}  // namespace

void CollectLaunchArgs(int& aArgc, char** aArgv) {
  sArgs = new nsTArray<CollectedArg>();
  sProxyUser = new nsCString();
  sProxyPass = new nsCString();

  for (const SwitchDef& def : kSwitches) {
    for (;;) {
      const char* param = nullptr;
      ArgResult ar;
      if (def.mKind == Kind::Bool) {
        ar = CheckArg(aArgc, aArgv, def.mName, nullptr,
                      CheckArgFlag::RemoveArg);
        if (ar == ARG_BAD) {
          // "--flag=value" on a boolean switch: consume it anyway.
          ar = CheckArg(aArgc, aArgv, def.mName, &param,
                        CheckArgFlag::RemoveArg);
        }
      } else {
        ar = CheckArg(aArgc, aArgv, def.mName, &param,
                      CheckArgFlag::RemoveArg);
      }
      if (ar == ARG_NONE) {
        break;
      }
      // ARG_BAD = flag present but without a usable value; it was removed.
      StoreArg(def.mName, ar == ARG_FOUND ? param : nullptr);
    }
  }

  // "--headless=new" (Chromium syntax). Plain "--headless" is left for Gecko.
  {
    const char* param = nullptr;
    if (CheckArg(aArgc, aArgv, "headless", nullptr, CheckArgFlag::None) ==
            ARG_BAD &&
        CheckArg(aArgc, aArgv, "headless", &param, CheckArgFlag::RemoveArg) ==
            ARG_FOUND) {
      PR_SetEnv("MOZ_HEADLESS=1");
    }
  }

  // Timezone must be in the environment before any JS runs, and child
  // processes inherit it (like Chromium's per-process ucal_setDefaultTimeZone).
  if (const nsCString* tz = FindArg("timezone")) {
    if (IsSafeTimeZoneId(*tz)) {
      SetEnvForever(nsLiteralCString(SG_TIMEZONE_ENV), *tz);
    }
  }

  if (const nsCString* u = FindArg("proxy-auth-user")) *sProxyUser = *u;
  if (const nsCString* p = FindArg("proxy-auth-pass")) *sProxyPass = *p;
}

bool IsLaunchConfigPresent() {
  return sArgs && (HasArg("user-agent") || HasArg("timezone") ||
                   HasArg("webgl-renderer") || HasArg("canvas-noise") ||
                   HasArg("proxy-server") || HasArg("hardware-concurrency"));
}

bool GetProxyCredentials(nsACString& aUser, nsACString& aPass) {
  if (!sProxyUser || sProxyUser->IsEmpty()) {
    return false;
  }
  aUser = *sProxyUser;
  if (sProxyPass) {
    aPass = *sProxyPass;
  } else {
    aPass.Truncate();
  }
  return true;
}

void ApplyLaunchConfig(nsIFile* aProfileDir) {
  if (!sArgs || sArgs->IsEmpty()) {
    return;
  }

  nsAutoString profilePath;
  if (aProfileDir) {
    aProfileDir->GetPath(profilePath);
  }

  if (IsLaunchConfigPresent()) {
    LockBool("sg.fp.enabled", true);
    ApplyHardening();
  }

  // --- navigator / HTTP identity -------------------------------------------
  if (const nsCString* ua = FindArg("user-agent")) {
    UAParts parts = BuildFirefoxUA(*ua);
    if (!parts.mUserAgent.Equals(*ua)) {
      SG_LOG("user-agent rewritten to engine-consistent Firefox UA: %s",
             parts.mUserAgent.get());
    }
    LockCString("general.useragent.override", parts.mUserAgent);
    LockCString("general.platform.override", parts.mPlatform);
    LockCString("general.oscpu.override", parts.mOscpu);
    LockCString("general.appversion.override", parts.mAppVersion);
  }

  const nsCString* acceptLang = FindArg("accept-lang");
  const nsCString* lang = FindArg("lang");
  if (acceptLang || lang) {
    LockCString("intl.accept_languages",
                AcceptLanguagesFor(acceptLang ? *acceptLang : *lang));
    // JS default locale: first entry of the language list.
    nsAutoCString first(lang ? *lang : *acceptLang);
    int32_t c = first.FindChar(',');
    if (c > 0) first.Truncate(c);
    first.StripWhitespace();
    if (int32_t semi = first.FindChar(';'); semi > 0) first.Truncate(semi);
    if (!first.IsEmpty()) {
      LockCString("sg.fp.locale", first);
    }
  }

  if (const nsCString* tz = FindArg("timezone")) {
    LockCString("sg.fp.timezone", *tz);
  }

  uint64_t num = 0;
  if (const nsCString* hc = FindArg("hardware-concurrency")) {
    if (ParseUint(*hc, num) && num > 0 && num <= 256) {
      LockUint("sg.fp.hardware_concurrency", uint32_t(num));
    }
  }
  // --device-memory: Firefox has no navigator.deviceMemory. Ignored on purpose.

  // --- screen / window -------------------------------------------------------
  int32_t a = 0, b = 0;
  // Prefer --screen-size; fall back to --window-size like the Chromium fork.
  const nsCString* ss = FindArg("screen-size");
  if (const nsCString* ws = ss ? ss : FindArg("window-size")) {
    if (ParsePair(*ws, a, b) && a > 0 && b > 0) {
      LockInt("sg.fp.screen.width", a);
      LockInt("sg.fp.screen.height", b);
    }
  }
  if (const nsCString* ws = FindArg("window-size")) {
    if (ParsePair(*ws, a, b) && a > 0 && b > 0) {
      LockInt("sg.fp.window.width", a);
      LockInt("sg.fp.window.height", b);
    }
  }
  if (const nsCString* wp = FindArg("window-position")) {
    if (ParsePair(*wp, a, b)) {
      LockInt("sg.fp.window.x", a);
      LockInt("sg.fp.window.y", b);
    }
  }

  // --- mobile persona (--device-mode=phone) -------------------------------
  ApplyMobile();

  // --- WebGL -----------------------------------------------------------------
  if (const nsCString* v = FindArg("webgl-vendor")) {
    LockCString("webgl.override-unmasked-vendor", *v);
  }
  if (const nsCString* r = FindArg("webgl-renderer")) {
    LockCString("webgl.override-unmasked-renderer", *r);
    LockCString("sg.fp.webgl.renderer", *r);  // GPU profile lookup (P3)
  }
  if (const nsCString* v = FindArg("webgpu-vendor")) {
    LockCString("sg.fp.webgpu.vendor", *v);
  }
  if (const nsCString* r = FindArg("webgpu-renderer")) {
    LockCString("sg.fp.webgpu.renderer", *r);
  }

  // --- noise -----------------------------------------------------------------
  LockBool("sg.fp.canvas_noise", HasArg("canvas-noise"));
  LockBool("sg.fp.audio_noise", HasArg("audio-noise"));
  LockBool("sg.fp.fonts_noise", HasArg("fonts-noise"));
  LockBool("sg.fp.rects_noise", HasArg("rects-noise"));
  LockBool("sg.fp.webgl_noise", HasArg("webgl-noise"));
  ApplySeed("sg.fp.seed.canvas", "canvas-seed", profilePath, "canvas");
  ApplySeed("sg.fp.seed.audio", "audio-noise-seed", profilePath, "audio");
  ApplySeed("sg.fp.seed.fonts", "unicode-glyphs-seed", profilePath, "glyphs");
  ApplySeed("sg.fp.seed.rects", "rects-noise-seed", profilePath, "rects");
  if (const nsCString* f = FindArg("font-exclusion-list")) {
    LockCString("sg.fp.fonts.exclude", *f);
  }

  // "0,0,0" is what the launcher sends when the profile never set device
  // counts: keep real Firefox behaviour then (pre-permission it only shows
  // one blank entry per available kind) instead of claiming no devices.
  if (const nsCString* m = FindArg("media-device-count")) {
    bool allZero = true;
    for (char ch : Span(m->BeginReading(), m->Length())) {
      if (ch >= '1' && ch <= '9') {
        allZero = false;
      }
    }
    if (!allZero) {
      LockCString("sg.fp.media_device_count", *m);
    }
  }

  // --- network ---------------------------------------------------------------
  if (const nsCString* p = FindArg("proxy-server")) {
    ApplyProxy(*p);
  }
  if (const nsCString* ip = FindArg("webrtc-proxy-ip")) {
    LockCString("sg.fp.webrtc.public_ip", *ip);
  }
  if (const nsCString* w = FindArg("webrtc-mode")) {
    ApplyWebRtc(*w);
  }
  if (const nsCString* l = FindArg("location-mode")) {
    ApplyLocation(*l);
  }

  // --- launcher UI -----------------------------------------------------------
  if (const nsCString* t = FindArg("taskbar-title")) {
    LockCString("sg.ui.taskbar_title", *t);
  }
  if (const nsCString* n = FindArg("profile-name")) {
    LockCString("sg.ui.profile_name", *n);
  }

  // If graphics (and so the system font list) came up before us, rebuild
  // the list so font hiding / the mobile allowlist take effect.
  if (gfxPlatform::Initialized()) {
    gfxPlatform::GetPlatform()->UpdateFontList(true);
  }

  SG_LOG("launch config applied (%zu switches)", size_t(sArgs->Length()));
}

}  // namespace mozilla::sgfp
