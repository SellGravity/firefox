/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// SellGravity antidetect (InviFox): size/position the first browser window
// from the launcher switches (--window-size, --window-position, and for the
// mobile persona --device-size). Values arrive as locked sg.* prefs written by
// toolkit/components/resistfingerprinting/SGLaunchConfig.cpp.

let gApplied = false;

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

    const mobile = Services.prefs.getBoolPref("sg.fp.mobile", false);
    if (mobile) {
      // The CONTENT area must be exactly the device size in CSS px, so that
      // innerWidth/innerHeight and the meta-viewport layout match the device.
      const w = intPref("sg.fp.screen.width");
      const h = intPref("sg.fp.screen.height");
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
