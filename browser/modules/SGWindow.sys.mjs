/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// SellGravity antidetect (InviFox): size/position the first browser window
// from the launcher switches (--window-size, --window-position, and for the
// mobile persona --device-size). Values arrive as locked sg.* prefs written by
// toolkit/components/resistfingerprinting/SGLaunchConfig.cpp.

import {
  clearTimeout,
  setTimeout,
} from "resource://gre/modules/Timer.sys.mjs";

let gApplied = false;

// --webrtc-mode=forward|replace behind a proxy: WebRTC must report the proxy
// EXIT address as the public IP (see PeerConnectionImpl::
// SGStartSynthesizedGathering). The launcher may not know it (gateway
// hostnames, rotating pools), so ask an IP echo service through the profile
// proxy - the same route every page request takes. The proxy resolves names
// itself, so a dual-stack proxy reaches dual-stack sites (BrowserScan,
// Pixelscan...) over IPv6: ask dual-stack services first so the WebRTC
// address has the family those sites see ("IP addresses are different"
// otherwise), IPv4-only ones as a fallback.
const kIpEchoUrls = [
  "https://api64.ipify.org/",
  "https://icanhazip.com/",
  "https://api.ipify.org/",
  "https://checkip.amazonaws.com/",
];
const kIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const kIpv6 = /^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}$/i;

function setLockedString(name, value) {
  Services.prefs.unlockPref(name);
  Services.prefs.getDefaultBranch("").setStringPref(name, value);
  Services.prefs.lockPref(name);
}

async function discoverExitIp(attempt = 0) {
  for (const url of kIpEchoUrls) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(url, {
        cache: "no-store",
        credentials: "omit",
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const ip = (await res.text()).trim();
      if (res.ok && (kIpv4.test(ip) || kIpv6.test(ip))) {
        setLockedString("sg.fp.webrtc.public_ip", ip);
        return;
      }
    } catch (e) {
      // try the next service
    }
  }
  if (attempt < 3) {
    setTimeout(() => discoverExitIp(attempt + 1), 15000 * (attempt + 1));
  }
}

function intPref(name) {
  return Services.prefs.getIntPref(name, 0);
}

export const SGWindow = {
  /**
   * @param {Window} win  a browser.xhtml window
   */
  apply(win) {
    if (gApplied || !Services.prefs.getBoolPref("sg.fp.enabled", false)) {
      return;
    }
    gApplied = true;

    if (Services.prefs.getBoolPref("sg.fp.webrtc.discover_ip", false)) {
      discoverExitIp();
    }

    const mobile = Services.prefs.getBoolPref("sg.fp.mobile", false);
    if (mobile) {
      // The CONTENT area must be exactly the device size in CSS px, so that
      // innerWidth/innerHeight and the meta-viewport layout match the device.
      const w = intPref("sg.fp.screen.width");
      // Visible page height on a phone: screen minus status bar (24), the
      // Firefox toolbar (56) and the navigation bar (48). A content area as
      // tall as the screen reads as headless (CreepJS hasVvpScreenRes).
      const h = intPref("sg.fp.screen.height") - (24 + 56 + 48);
      if (w > 0 && h > 0) {
        // Windows will not make a browser window narrower than ~500px, so the
        // window alone cannot give a 360px content area. Like Responsive
        // Design Mode, pin every tab's <browser> to the device size (centred)
        // and only fit the window around it.
        const css =
          `.browserStack > browser {` +
          ` width: ${w}px !important; min-width: ${w}px !important;` +
          ` max-width: ${w}px !important; height: ${h}px !important;` +
          ` min-height: ${h}px !important; max-height: ${h}px !important;` +
          ` justify-self: center !important; align-self: start !important;` +
          ` flex: none !important; }`;
        try {
          win.windowUtils.loadSheetUsingURIString(
            "data:text/css," + encodeURIComponent(css),
            win.windowUtils.AUTHOR_SHEET
          );
        } catch (e) {
          console.error("SGWindow: cannot pin mobile viewport", e);
        }
        const fit = () => {
          const browser = win.gBrowser?.selectedBrowser;
          const stack = browser?.parentNode;
          if (!stack) {
            return;
          }
          // Grow the window until the stack holds the pinned browser; the
          // height is fitted exactly, the width may stay wider (min width).
          const dx = Math.max(0, w - stack.clientWidth);
          const dy = h - stack.clientHeight;
          if (dx || dy) {
            win.resizeBy(dx, dy);
          }
        };
        fit();
        // Toolbars may still be settling right after startup.
        win.setTimeout(fit, 300);
        win.setTimeout(fit, 1500);
      }
    } else {
      let w = intPref("sg.fp.window.width");
      let h = intPref("sg.fp.window.height");
      // Never larger than the fake screen (minus the Windows 11 taskbar), so
      // outerWidth/innerWidth stay consistent with screen.availWidth/Height.
      const sw = intPref("sg.fp.screen.width");
      const sh = intPref("sg.fp.screen.height");
      if (sw > 0 && sh > 0) {
        if (w <= 0 || h <= 0) {
          w = win.outerWidth;
          h = win.outerHeight;
        }
        w = Math.min(w, sw);
        h = Math.min(h, Math.max(1, sh - 48));
      }
      if (w > 0 && h > 0) {
        win.resizeTo(w, h);
      }
    }

    if (
      Services.prefs.prefHasDefaultValue("sg.fp.window.x") &&
      Services.prefs.prefIsLocked("sg.fp.window.x")
    ) {
      win.moveTo(intPref("sg.fp.window.x"), intPref("sg.fp.window.y"));
    }
  },
};
