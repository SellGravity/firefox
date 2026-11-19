/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// SellGravity antidetect: launch-time fingerprint profile.
//
// The InviBrowser launcher passes the fingerprint profile as command-line
// switches, using the SAME switch names as the SellGravity Chromium fork
// (--user-agent, --timezone, --webgl-renderer, --canvas-noise, ...).
//
// Flow (parent process only):
//   1. CollectLaunchArgs()  - XREMain::XRE_mainInit, right after the restart
//      argv has been saved. Removes our switches from argv so that the
//      regular nsCommandLine never sees them (otherwise "--foo=bar" would be
//      split and "bar" opened as a URL). Sets process environment that must
//      exist before JS starts (timezone) so child processes inherit it.
//   2. ApplyLaunchConfig()  - XREMain::XRE_mainRun, right after the profile
//      prefs are loaded. Writes the profile into *default-branch, locked*
//      prefs. Gecko syncs prefs to every content process automatically, so no
//      per-switch IPC plumbing is needed (unlike Chromium's kSwitchNames).
//
// Content-process code reads the values through StaticPrefs::sg_fp_*().

#ifndef mozilla_SGLaunchConfig_h
#define mozilla_SGLaunchConfig_h

#include <stdint.h>

#include "nsString.h"

class nsIFile;

namespace mozilla::sgfp {

// Environment variable read by SpiderMonkey (js/src/vm/DateTime.cpp) to set
// the ICU default time zone in every process. Inherited by child processes.
#define SG_TIMEZONE_ENV "MOZ_SG_TIMEZONE"

void CollectLaunchArgs(int& aArgc, char** aArgv);

// Before profile-after-change (XRE_mainRun, just before DoStartup): locked
// default-branch prefs that components starting on profile-after-change read
// at once - the add-on manager for launcher extensions.
void ApplyEarlyLaunchConfig();

void ApplyLaunchConfig(nsIFile* aProfileDir);

// True when the launcher passed at least one fingerprint switch.
bool IsLaunchConfigPresent();

// Proxy credentials are kept in the parent process only (never in prefs, so
// they are not synced to content processes or shown in about:config).
bool GetProxyCredentials(nsACString& aUser, nsACString& aPass);

}  // namespace mozilla::sgfp

#endif  // mozilla_SGLaunchConfig_h
