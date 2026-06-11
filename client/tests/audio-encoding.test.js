import assert from "node:assert/strict";
import test from "node:test";

import { bytesToBase64 } from "../audio-chunks.js";

test("bytesToBase64 round-trips arbitrary bytes", () => {
  const bytes = new Uint8Array(70000);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = i % 256;
  }
  const encoded = bytesToBase64(bytes);
  const decoded = Buffer.from(encoded, "base64");
  assert.equal(decoded.length, bytes.length);
  assert.deepEqual(new Uint8Array(decoded), bytes);
});

test("bytesToBase64 handles empty input", () => {
  assert.equal(bytesToBase64(new Uint8Array(0)), "");
});

test("bytesToBase64 matches Node's encoder on a PCM-sized chunk", () => {
  const chunk = new Uint8Array(9600);
  for (let i = 0; i < chunk.length; i += 1) {
    chunk[i] = (i * 31) % 256;
  }
  assert.equal(bytesToBase64(chunk), Buffer.from(chunk).toString("base64"));
});
