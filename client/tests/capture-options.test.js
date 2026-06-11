import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDisplayMediaOptions,
  buildUserMediaOptions,
} from "../capture-options.js";

test("buildDisplayMediaOptions requests local playback suppression when supported", () => {
  const options = buildDisplayMediaOptions({ suppressLocalAudioPlayback: true });

  assert.equal(options.audio.suppressLocalAudioPlayback, true);
  assert.equal(options.audio.echoCancellation, false);
  assert.equal(options.video.displaySurface, "browser");
});

test("buildDisplayMediaOptions omits local playback suppression when unsupported", () => {
  const options = buildDisplayMediaOptions({});

  assert.equal(Object.hasOwn(options.audio, "suppressLocalAudioPlayback"), false);
});

test("buildDisplayMediaOptions targets the monitor surface in screen mode", () => {
  assert.equal(
    buildDisplayMediaOptions({}, "screen").video.displaySurface,
    "monitor",
  );
  assert.equal(buildDisplayMediaOptions({}, "tab").video.displaySurface, "browser");
});

test("buildUserMediaOptions enables echo cancellation for the microphone", () => {
  const options = buildUserMediaOptions();

  assert.equal(options.audio.echoCancellation, true);
  assert.equal(options.audio.noiseSuppression, false);
  assert.equal(options.audio.autoGainControl, false);
});
