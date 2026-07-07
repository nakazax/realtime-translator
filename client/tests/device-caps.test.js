import assert from "node:assert/strict";
import test from "node:test";

import { captureModeAvailability, resolveCaptureMode } from "../device-caps.js";

test("captureModeAvailability enables everything on a full desktop browser", () => {
  const availability = captureModeAvailability({
    hasGetUserMedia: true,
    hasGetDisplayMedia: true,
  });

  assert.equal(availability.mic, true);
  assert.equal(availability.tab, true);
  assert.equal(availability.screen, true);
  assert.equal(availability.displayCaptureNote, null);
});

test("captureModeAvailability gates tab/screen without getDisplayMedia", () => {
  const availability = captureModeAvailability({
    hasGetUserMedia: true,
    hasGetDisplayMedia: false,
  });

  assert.equal(availability.mic, true);
  assert.equal(availability.tab, false);
  assert.equal(availability.screen, false);
  assert.match(availability.displayCaptureNote, /マイクのみ/);
  assert.match(availability.displayCaptureNote, /microphone/i);
});

test("captureModeAvailability reports a mic-less browser", () => {
  const availability = captureModeAvailability({
    hasGetUserMedia: false,
    hasGetDisplayMedia: false,
  });

  assert.equal(availability.mic, false);
  assert.equal(availability.tab, false);
  assert.equal(availability.screen, false);
});

test("resolveCaptureMode keeps an available selection", () => {
  const availability = captureModeAvailability({
    hasGetUserMedia: true,
    hasGetDisplayMedia: true,
  });

  assert.equal(resolveCaptureMode("tab", availability), "tab");
  assert.equal(resolveCaptureMode("screen", availability), "screen");
  assert.equal(resolveCaptureMode("mic", availability), "mic");
});

test("resolveCaptureMode falls back to mic when display capture is missing", () => {
  const availability = captureModeAvailability({
    hasGetUserMedia: true,
    hasGetDisplayMedia: false,
  });

  assert.equal(resolveCaptureMode("tab", availability), "mic");
  assert.equal(resolveCaptureMode("screen", availability), "mic");
  assert.equal(resolveCaptureMode("mic", availability), "mic");
});
