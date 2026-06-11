import assert from "node:assert/strict";
import test from "node:test";

import {
  base64ToFloat32,
  framePeak,
  SILENT_FRAME_PEAK,
} from "../audio-playback.js";

function pcm16Base64(values) {
  const bytes = new Uint8Array(values.length * 2);
  new DataView(bytes.buffer).setInt16(0, 0, true);
  values.forEach((value, i) => {
    new DataView(bytes.buffer).setInt16(i * 2, value, true);
  });
  return Buffer.from(bytes).toString("base64");
}

test("base64ToFloat32 decodes little-endian PCM16 into [-1, 1) floats", () => {
  const floats = base64ToFloat32(pcm16Base64([0, 0x4000, -0x8000, 0x7fff]));
  assert.equal(floats.length, 4);
  assert.equal(floats[0], 0);
  assert.equal(floats[1], 0.5);
  assert.equal(floats[2], -1);
  assert.ok(Math.abs(floats[3] - 0.99997) < 1e-4);
});

test("Azure's synthesized-silence frames fall under the gate, speech stays above", () => {
  // Observed dubbed-track amplitudes: silence frames peak at <= 63 int16,
  // speech frames at >= 1024 (docs in audio-playback.js).
  const silent = base64ToFloat32(pcm16Base64([0, 12, -35, 63]));
  const speech = base64ToFloat32(pcm16Base64([0, 30, -1024, 19200]));
  assert.ok(framePeak(silent) < SILENT_FRAME_PEAK);
  assert.ok(framePeak(speech) >= SILENT_FRAME_PEAK);
});

test("framePeak of an empty frame is zero", () => {
  assert.equal(framePeak(new Float32Array(0)), 0);
});
