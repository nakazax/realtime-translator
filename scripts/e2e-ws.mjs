#!/usr/bin/env node
/**
 * End-to-end check against a RUNNING local server: connects to the
 * /api/ws proxy exactly like the browser does, streams the English fixture
 * WAV as PCM16 chunks, and asserts that Japanese transcript deltas and
 * translated audio come back through the proxy.
 *
 * Usage: node scripts/e2e-ws.mjs [--url ws://127.0.0.1:8000/api/ws?target=ja]
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const urlIdx = args.indexOf("--url");
const URL_ = urlIdx >= 0 ? args[urlIdx + 1] : "ws://127.0.0.1:8000/api/ws?target=ja";

const WAV_PATH = path.join(SCRIPT_DIR, "fixtures", "source-speech-24k.wav");
if (!existsSync(WAV_PATH)) {
  console.error(`fixture missing: ${WAV_PATH}`);
  process.exit(1);
}
const audio = extractWavData(readFileSync(WAV_PATH));

const state = {
  events: {},
  inputTranscript: "",
  outputTranscript: "",
  outputAudioDeltas: 0,
  errors: [],
};

const ws = new WebSocket(URL_);
const CHUNK = 9600;

ws.addEventListener("open", async () => {
  console.log(`connected: ${URL_}`);
  const silence = Buffer.alloc(CHUNK).toString("base64");
  const send = (b64) =>
    ws.send(JSON.stringify({ type: "session.input_audio_buffer.append", audio: b64 }));
  for (let i = 0; i < 5; i += 1) {
    send(silence);
    await delay(100);
  }
  for (let off = 0; off < audio.length; off += CHUNK) {
    send(audio.subarray(off, off + CHUNK).toString("base64"));
    await delay(100);
  }
  for (let i = 0; i < 12; i += 1) {
    send(silence);
    await delay(100);
  }
  console.log("audio sent; collecting events for 20s...");
  setTimeout(finish, 20000);
});

ws.addEventListener("message", (message) => {
  let event;
  try {
    event = JSON.parse(message.data);
  } catch {
    return;
  }
  state.events[event.type] = (state.events[event.type] ?? 0) + 1;
  if (event.type === "error") {
    state.errors.push(JSON.stringify(event.error ?? event));
  }
  if (event.type === "session.input_transcript.delta") {
    state.inputTranscript += event.delta ?? "";
  }
  if (event.type === "session.output_transcript.delta") {
    state.outputTranscript += event.delta ?? "";
  }
  if (event.type === "session.output_audio.delta") {
    state.outputAudioDeltas += 1;
  }
});

ws.addEventListener("close", (event) => {
  console.log(`closed: ${event.code} ${event.reason}`);
});
ws.addEventListener("error", () => {
  console.error("websocket error (is the server running on the target port?)");
  process.exit(1);
});

function finish() {
  ws.close();
  const ja = /[぀-ヿ一-鿿]/.test(state.outputTranscript);
  console.log(JSON.stringify({ ...state, outputIsJapanese: ja }, null, 2));
  if (!ja) {
    console.error("FAIL: no Japanese transcript came back through the proxy");
    process.exit(1);
  }
  if (state.outputAudioDeltas === 0) {
    console.error("FAIL: no translated audio deltas");
    process.exit(1);
  }
  console.log("PASS: proxy relayed translation (text + audio) end to end");
  process.exit(0);
}

function extractWavData(wav) {
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString("ascii", offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (chunkId === "data") {
      return wav.subarray(dataStart, dataStart + chunkSize);
    }
    offset = dataStart + chunkSize + (chunkSize % 2);
  }
  throw new Error("WAV did not contain a data chunk.");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
