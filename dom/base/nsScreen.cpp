/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsScreen.h"

#include "mozilla/GeckoBindings.h"
#include "mozilla/dom/BrowsingContextBinding.h"
#include "mozilla/dom/Document.h"
#include "mozilla/dom/DocumentInlines.h"
#include "mozilla/Preferences.h"
#include "mozilla/StaticPrefs_sg.h"
#include "mozilla/widget/ScreenManager.h"
#include "nsCOMPtr.h"
#include "nsDeviceContext.h"
#include "nsGlobalWindowInner.h"
#include "nsGlobalWindowOuter.h"
#include "nsIDocShell.h"
#include "nsIDocShellTreeItem.h"
#include "nsLayoutUtils.h"
#include "nsPIDOMWindowInlines.h"
#include "nsPresContext.h"

using namespace mozilla;
using namespace mozilla::dom;

nsScreen::nsScreen(nsPIDOMWindowInner* aWindow)
    : DOMEventTargetHelper(aWindow) {}

/* static */ already_AddRefed<nsScreen> nsScreen::Create(
    nsPIDOMWindowInner* aWindow) {
  RefPtr screen = new nsScreen(aWindow);
  screen->mScreenOrientation = dom::ScreenOrientation::Create(aWindow, screen);
  return screen.forget();
}

nsScreen::~nsScreen() = default;

// QueryInterface implementation for nsScreen
NS_INTERFACE_MAP_BEGIN_CYCLE_COLLECTION(nsScreen)
NS_INTERFACE_MAP_END_INHERITING(DOMEventTargetHelper)

NS_IMPL_ADDREF_INHERITED(nsScreen, DOMEventTargetHelper)
NS_IMPL_RELEASE_INHERITED(nsScreen, DOMEventTargetHelper)

NS_IMPL_CYCLE_COLLECTION_INHERITED(nsScreen, DOMEventTargetHelper,
                                   mScreenOrientation)

int32_t nsScreen::PixelDepth() {
  // Return 24 to prevent fingerprinting.
  if (ShouldResistFingerprinting(RFPTarget::ScreenPixelDepth)) {
    return 24;
  }
  nsDeviceContext* context = GetDeviceContext();
  if (NS_WARN_IF(!context)) {
    return 24;
  }
  return context->GetDepth();
}

nsPIDOMWindowOuter* nsScreen::GetOuter() const {
  if (nsPIDOMWindowInner* inner = GetOwnerWindow()) {
    return inner->GetOuterWindow();
  }
  return nullptr;
}

nsDeviceContext* nsScreen::GetDeviceContext() const {
  return nsLayoutUtils::GetDeviceContextForScreenInfo(GetOuter());
}

CSSIntRect nsScreen::GetRect() {
  // Return window inner rect to prevent fingerprinting.
  if (ShouldResistFingerprinting(RFPTarget::ScreenRect)) {
    return GetTopWindowInnerRectForRFP();
  }

  // Here we manipulate the value of aRect to represent the screen size,
  // if there is an override set with WebDriver BiDi or in RDM.
  if (nsPIDOMWindowInner* owner = GetOwnerWindow()) {
    if (Document* doc = owner->GetExtantDoc()) {
      Maybe<CSSIntSize> deviceSize =
          nsGlobalWindowOuter::GetRDMDeviceSize(*doc);
      if (deviceSize.isSome()) {
        const CSSIntSize& size = deviceSize.value();
        return {0, 0, size.width, size.height};
      }
    }

    if (BrowsingContext* bc = owner->GetBrowsingContext()) {
      if (auto size = bc->GetScreenAreaOverride()) {
        return {{}, *size};
      }
    }
  }

  // SellGravity antidetect: launcher screen size.
  if (Maybe<CSSIntRect> sg = SGSpoofedScreenRect(/* aAvail = */ false)) {
    return *sg;
  }

  nsDeviceContext* context = GetDeviceContext();
  if (NS_WARN_IF(!context)) {
    return {};
  }
  return CSSIntRect::FromAppUnitsRounded(context->GetRect());
}

/* static */
Maybe<CSSIntRect> nsScreen::SGSpoofedScreenRect(bool aAvail) {
  const int32_t w = StaticPrefs::sg_fp_screen_width();
  const int32_t h = StaticPrefs::sg_fp_screen_height();
  if (w <= 0 || h <= 0) {
    return Nothing();
  }
  if (!aAvail) {
    return Some(CSSIntRect(0, 0, w, h));
  }
  // availHeight excludes the OS taskbar / menu bar, like a real desktop.
  nsAutoCString platform;
  Preferences::GetCString("general.platform.override", platform);
  int32_t reserved = 48;  // Windows 11 taskbar at 100% scale (measured)
  if (platform.EqualsLiteral("MacIntel")) {
    reserved = 25;  // macOS menu bar (Dock auto-hidden)
  } else if (StringBeginsWith(platform, "Linux"_ns)) {
    reserved = 0;
  }
  return Some(CSSIntRect(0, 0, w, std::max(1, h - reserved)));
}

CSSIntRect nsScreen::GetAvailRect() {
  // Return window inner rect to prevent fingerprinting.
  if (ShouldResistFingerprinting(RFPTarget::ScreenAvailRect)) {
    return GetTopWindowInnerRectForRFP();
  }

  // Check for overrides set by WebDriver BiDi or RDM before applying
  // fingerprinting protection. This allows developer tools to simulate
  // specific device dimensions for testing purposes.
  if (nsPIDOMWindowInner* owner = GetOwnerWindow()) {
    if (Document* doc = owner->GetExtantDoc()) {
      Maybe<CSSIntSize> deviceSize =
          nsGlobalWindowOuter::GetRDMDeviceSize(*doc);
      if (deviceSize.isSome()) {
        const CSSIntSize& size = deviceSize.value();
        return {0, 0, size.width, size.height};
      }
    }

    if (BrowsingContext* bc = owner->GetBrowsingContext()) {
      if (auto size = bc->GetScreenAreaOverride()) {
        return {{}, *size};
      }
    }
  }

  // SellGravity antidetect: launcher screen size. Real Firefox 160 reports
  // avail = screen minus taskbar (measured 1080 -> 1032): its remote FPP
  // overrides switch ScreenAvailToResolution off, and we disable remote
  // overrides, so never follow that target here. avail == screen is a
  // headless / spoofing tell (Scanbrowser "Phan cung", CreepJS).
  if (Maybe<CSSIntRect> sg = SGSpoofedScreenRect(/* aAvail = */ true)) {
    return *sg;
  }

  if (ShouldResistFingerprinting(RFPTarget::ScreenAvailToResolution)) {
    nsDeviceContext* context = GetDeviceContext();
    if (NS_WARN_IF(!context)) {
      return {};
    }

    if (nsPIDOMWindowInner* owner = GetOwnerWindow()) {
      if (Document* doc = owner->GetExtantDoc()) {
        AutoTArray<nsString, 1> params;
        params.AppendElement(
            u"https://support.mozilla.org/kb/firefox-protection-against-fingerprinting"_ns);
        doc->WarnOnceAbout(Document::eScreenFingerprintingProtection, false,
                           params);
      }
    }

    return nsRFPService::GetSpoofedScreenAvailSize(
        context->GetRect(), context->GetFullZoom(), IsFullscreen());
  }

  nsDeviceContext* context = GetDeviceContext();
  if (NS_WARN_IF(!context)) {
    return {};
  }
  return CSSIntRect::FromAppUnitsRounded(context->GetClientRect());
}

bool nsScreen::IsFullscreen() const {
  if (nsPIDOMWindowInner* owner = GetOwnerWindow()) {
    if (Document* doc = owner->GetExtantDoc()) {
      return StyleDisplayMode::Fullscreen ==
             Gecko_MediaFeatures_GetDisplayMode(doc);
    }
  }
  return false;
}

uint16_t nsScreen::GetOrientationAngle() const {
  nsDeviceContext* context = GetDeviceContext();
  if (context) {
    return context->GetScreenOrientationAngle();
  }
  RefPtr<widget::Screen> s =
      widget::ScreenManager::GetSingleton().GetPrimaryScreen();
  return s->GetOrientationAngle();
}

hal::ScreenOrientation nsScreen::GetOrientationType() const {
  nsDeviceContext* context = GetDeviceContext();
  if (context) {
    return context->GetScreenOrientationType();
  }
  RefPtr<widget::Screen> s =
      widget::ScreenManager::GetSingleton().GetPrimaryScreen();
  return s->GetOrientationType();
}

dom::ScreenOrientation* nsScreen::Orientation() const {
  return mScreenOrientation;
}

void nsScreen::GetMozOrientation(nsString& aOrientation,
                                 CallerType aCallerType) const {
  switch (mScreenOrientation->DeviceType(aCallerType)) {
    case OrientationType::Portrait_primary:
      aOrientation.AssignLiteral("portrait-primary");
      break;
    case OrientationType::Portrait_secondary:
      aOrientation.AssignLiteral("portrait-secondary");
      break;
    case OrientationType::Landscape_primary:
      aOrientation.AssignLiteral("landscape-primary");
      break;
    case OrientationType::Landscape_secondary:
      aOrientation.AssignLiteral("landscape-secondary");
      break;
    default:
      MOZ_CRASH("Unacceptable screen orientation type.");
  }
}

/* virtual */
JSObject* nsScreen::WrapObject(JSContext* aCx,
                               JS::Handle<JSObject*> aGivenProto) {
  return Screen_Binding::Wrap(aCx, this, aGivenProto);
}

CSSIntRect nsScreen::GetTopWindowInnerRectForRFP() {
  if (nsPIDOMWindowInner* inner = GetOwnerWindow()) {
    if (BrowsingContext* bc = inner->GetBrowsingContext()) {
      CSSIntSize size = bc->TopInnerSizeSpoofedForRFP();
      return {0, 0, size.width, size.height};
    }
  }
  return {};
}

bool nsScreen::ShouldResistFingerprinting(RFPTarget aTarget) const {
  nsGlobalWindowInner* owner = GetOwnerWindow();
  return owner && owner->ShouldResistFingerprinting(aTarget);
}
