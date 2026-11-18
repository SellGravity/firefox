/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// SellGravity antidetect (InviFox): profile-seeded Web Audio noise
// (--audio-noise). Deterministic: the same input always yields the same
// output within a profile, so repeated reads and getChannelData() vs
// copyFromChannel() stay consistent, while different profiles hash
// differently - like the float rounding differences between real devices.

#ifndef mozilla_dom_SGAudioNoise_h
#define mozilla_dom_SGAudioNoise_h

#include <stdint.h>

#include "mozilla/HashFunctions.h"
#include "mozilla/StaticPrefs_sg.h"

namespace mozilla::dom::sgaudio {

inline uint32_t Seed() {
  return StaticPrefs::sg_fp_audio_noise() ? StaticPrefs::sg_fp_seed_audio()
                                          : 0;
}

// Signed value in [-1, 1) derived from (seed, a, b).
inline float Unit(uint32_t aSeed, uint32_t aA, uint32_t aB) {
  HashNumber h = AddToHash(HashGeneric(aSeed, aA), aB);
  // Final avalanche so neighbouring indices are uncorrelated.
  h ^= h >> 16;
  h *= 0x7feb352dU;
  h ^= h >> 15;
  return float(int32_t(h)) / 2147483648.0f;
}

// Rendered sample perturbation: about +-1 ulp on a subset of samples.
// Exact zeros (silence) are kept exact - detectors check for that.
inline void PerturbSamples(uint32_t aSeed, uint32_t aChannel, float* aData,
                           uint32_t aLength) {
  if (!aSeed || !aData) {
    return;
  }
  for (uint32_t i = 0; i < aLength; ++i) {
    const float v = aData[i];
    if (v != 0.0f) {
      aData[i] = v * (1.0f + Unit(aSeed, aChannel, i) * 2.0e-7f);
    }
  }
}

// AnalyserNode frequency data, in dB: +-1e-4 dB per bin (Chromium parity).
inline float PerturbDecibels(uint32_t aSeed, uint32_t aBin, float aDb) {
  if (!aSeed || !(aDb > -1.0e30f)) {  // keep -Infinity / NaN untouched
    return aDb;
  }
  return aDb + Unit(aSeed, 0xA0A0u, aBin) * 1.0e-4f;
}

}  // namespace mozilla::dom::sgaudio

#endif  // mozilla_dom_SGAudioNoise_h
