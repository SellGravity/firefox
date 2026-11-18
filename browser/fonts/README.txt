Twemoji Mozilla
================

The upstream repository of Twemoji Mozilla can be found at

  https://github.com/mozilla/twemoji-colr

Please refer commit history for the current version of the font.
This file purposely omit the version, so there is no need to update it here.

Roboto (InviFox)
================

Roboto-Regular.ttf is the Roboto 3.002 variable font (Copyright 2011 Google
Inc., Apache License 2.0), the system UI font of Android 12+. InviFox exposes
it only to the Android persona (--device-mode=phone / Android UA); desktop
personas hide it (see SGIsFontHidden in gfx/thebes/gfxPlatformFontList.cpp).

NotoSerif-Regular.ttf is Noto Serif Regular 1.02 (Copyright 2012 Google Inc.,
SIL Open Font License 1.1), Android's "serif" family.

DroidSansMono.ttf is Droid Sans Mono 1.00 build 112 (Copyright 2006 Google
Corporation, Apache License 2.0), Android's "monospace" family, subset to
Basic Latin + Latin-1 (211 code points; other characters fall back to Roboto).

Both are exposed only to the Android persona, like Roboto, so that the serif
and monospace generics resolve to real Android faces (font-width probes then
see Roboto as an installed family, and the font list is not empty).
