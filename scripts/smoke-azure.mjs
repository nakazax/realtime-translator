#!/usr/bin/env node
/**
 * Azure Realtime Translation API verification matrix.
 *
 * Empirically determines which API surface Azure exposes for
 * gpt-realtime-translate / gpt-realtime-whisper deployments:
 *   P0  v1 surface sanity (GET /models)
 *   P1  client-secret mint variants (translations path / standard path / session shapes)
 *   P2  WebSocket handshake probes (paths x auth modes)
 *   P3  full WebSocket loop: stream English speech, collect transcript events
 *   P4  WebRTC SDP calls endpoint existence
 *   P5  CORS preflight (informational; app uses a backend SDP proxy by default)
 *
 * Zero dependencies. Usage:
 *   node scripts/smoke-azure.mjs [--wav path/to/24k-mono-pcm16.wav] [--skip-ws-loop]
 *
 * Test audio resolution order: --wav flag, scripts/fixtures/source-speech-24k.wav,
 * /tmp/source-speech-24k.wav. Generate with:
 *   say -v Samantha "The quick brown fox jumps over the lazy dog. Artificial intelligence is transforming real time translation." -o /tmp/rt-src.aiff
 *   afconvert -f WAVE -d LEI16@24000 -c 1 /tmp/rt-src.aiff scripts/fixtures/source-speech-24k.wav
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import tls from "node:tls";
import crypto from "node:crypto";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

// The spoken text of the default fixture WAV (for input-transcript overlap check).
const KNOWN_PHRASE =
  "The quick brown fox jumps over the lazy dog. Artificial intelligence is transforming real time translation.";

loadEnvFile(path.join(REPO_ROOT, ".env"));

const ENDPOINT = (process.env.AZURE_OPENAI_ENDPOINT ?? "").replace(/\/+$/, "");
const API_KEY = process.env.AZURE_OPENAI_API_KEY ?? "";
const TD = process.env.AZURE_OPENAI_TRANSLATE_DEPLOYMENT ?? "gpt-realtime-translate";
const WD = process.env.AZURE_OPENAI_WHISPER_DEPLOYMENT ?? "gpt-realtime-whisper";

if (!ENDPOINT || !API_KEY) {
  console.error("AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY missing (.env)");
  process.exit(1);
}

const BASE = `${ENDPOINT}/openai/v1`;
const WSS_BASE = BASE.replace(/^https:/, "wss:");
const args = process.argv.slice(2);
const wavFlagIdx = args.indexOf("--wav");
const WAV_PATH = firstExisting([
  wavFlagIdx >= 0 ? args[wavFlagIdx + 1] : null,
  path.join(SCRIPT_DIR, "fixtures", "source-speech-24k.wav"),
  "/tmp/source-speech-24k.wav",
]);
const SKIP_WS_LOOP = args.includes("--skip-ws-loop");

const TBODY = {
  session: {
    model: TD,
    audio: {
      input: { transcription: { model: WD }, noise_reduction: null },
      output: { language: "ja" },
    },
  },
};

// Representative Chrome offer: BUNDLEd audio (sendrecv) + data channel, trickle ICE.
// Only needs to pass server-side SDP validation; media is never established.
const REAL_OFFER = [
  "v=0",
  "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0 1",
  "a=extmap-allow-mixed",
  "a=msid-semantic: WMS",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126",
  "c=IN IP4 0.0.0.0",
  "a=rtcp:9 IN IP4 0.0.0.0",
  "a=ice-ufrag:4ZcD",
  "a=ice-pwd:2v1muCWoOi3uLifh0NuRHlGH",
  "a=ice-options:trickle",
  "a=fingerprint:sha-256 7B:8B:F0:65:5F:78:E2:51:3B:AC:6F:F3:3F:46:1B:35:DC:B8:5F:64:1A:24:C2:43:F0:A1:58:D0:A1:2C:19:08",
  "a=setup:actpass",
  "a=mid:0",
  "a=sendrecv",
  "a=msid:- smoke-audio",
  "a=rtcp-mux",
  "a=rtpmap:111 opus/48000/2",
  "a=rtcp-fb:111 transport-cc",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "a=ssrc:1001 cname:smoke",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 0.0.0.0",
  "a=ice-ufrag:4ZcD",
  "a=ice-pwd:2v1muCWoOi3uLifh0NuRHlGH",
  "a=ice-options:trickle",
  "a=fingerprint:sha-256 7B:8B:F0:65:5F:78:E2:51:3B:AC:6F:F3:3F:46:1B:35:DC:B8:5F:64:1A:24:C2:43:F0:A1:58:D0:A1:2C:19:08",
  "a=setup:actpass",
  "a=mid:1",
  "a=sctp-port:5000",
  "a=max-message-size:262144",
  "",
].join("\r\n");

const results = [];
const verdict = {
  mintPath: null,
  mintBodyShape: null,
  mintPreviewRequired: false,
  wsPath: null,
  wsAuth: null,
  eventFamily: null,
  inputTranscriptSeen: false,
  outputTranscriptJa: false,
  callsPath: null,
  callsAuth: null,
  cors: {},
  arch: "unresolved",
};

function log(probe, msg) {
  console.log(`[${new Date().toISOString()}] [${probe}] ${msg}`);
}

function record(probe, detail) {
  results.push({ probe, ...detail });
}

function redact(text) {
  return String(text).replaceAll(API_KEY, "<api-key>");
}

async function probeHttp(probe, method, url, { headers = {}, body, label } = {}) {
  let status = -1;
  let text = "";
  let resHeaders = {};
  try {
    const res = await fetch(url, { method, headers, body });
    status = res.status;
    resHeaders = Object.fromEntries(res.headers.entries());
    text = await res.text();
  } catch (error) {
    text = `FETCH_ERROR: ${error.message}`;
  }
  log(probe, `${method} ${url} -> ${status} ${label ?? ""}`);
  if (text) log(probe, `  body: ${redact(text).slice(0, 400).replaceAll("\n", " ")}`);
  record(probe, { method, url, label, status, body: redact(text).slice(0, 2000), headers: resHeaders });
  return { status, text, headers: resHeaders };
}

/** Try url, and on 404 retry with ?api-version=preview. */
async function probeWithPreview(probe, method, url, opts) {
  const first = await probeHttp(probe, method, url, opts);
  if (first.status !== 404) return { ...first, preview: false };
  const sep = url.includes("?") ? "&" : "?";
  const second = await probeHttp(`${probe}+pv`, method, `${url}${sep}api-version=preview`, opts);
  return { ...second, preview: true };
}

// ---------------------------------------------------------------------------
// P0: sanity
// ---------------------------------------------------------------------------
async function p0() {
  const { status } = await probeHttp("P0", "GET", `${BASE}/models`, {
    headers: { "api-key": API_KEY },
    label: "v1 surface sanity",
  });
  if (status === 401) throw new Error("API key rejected. Fix .env.");
  if (status === 404) throw new Error("v1 surface not enabled on this resource.");
}

// ---------------------------------------------------------------------------
// P1: mint matrix
// ---------------------------------------------------------------------------
async function p1() {
  const jsonHeaders = { "api-key": API_KEY, "Content-Type": "application/json" };
  const variants = [
    {
      id: "P1a",
      path: "realtime/translations/client_secrets",
      body: TBODY,
      shape: "translation (no type)",
    },
    {
      id: "P1b",
      path: "realtime/client_secrets",
      body: TBODY,
      shape: "translation (no type)",
    },
    {
      id: "P1c",
      path: "realtime/client_secrets",
      body: { session: { type: "translation", ...TBODY.session } },
      shape: "translation (type:translation)",
    },
    {
      id: "P1d",
      path: "realtime/client_secrets",
      body: {
        session: {
          type: "realtime",
          model: TD,
          audio: { input: { transcription: { model: WD } } },
          instructions:
            "You are a simultaneous interpreter. Translate everything you hear into Japanese. Output only the translation.",
        },
      },
      shape: "realtime+instructions",
    },
  ];

  for (const v of variants) {
    const { status, text, preview } = await probeWithPreview(v.id, "POST", `${BASE}/${v.path}`, {
      headers: jsonHeaders,
      body: JSON.stringify(v.body),
      label: v.shape,
    });
    if (status >= 200 && status < 300) {
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = {};
      }
      if (typeof data.value === "string") {
        verdict.mintPath = v.path;
        verdict.mintBodyShape = v.shape;
        verdict.mintPreviewRequired = preview;
        verdict.mintVariantId = v.id;
        log(v.id, `MINT WINNER: ${v.path} (${v.shape})${preview ? " [preview]" : ""}`);
        return { variant: v, sessionEcho: data.session ?? null };
      }
      log(v.id, `2xx but no .value field: ${redact(text).slice(0, 200)}`);
    }
  }
  log("P1", "No mint variant produced an ephemeral key.");
  return null;
}

async function mintFresh(mintWinner) {
  if (!mintWinner) return null;
  const sep = verdict.mintPreviewRequired ? "?api-version=preview" : "";
  const res = await fetch(`${BASE}/${mintWinner.variant.path}${sep}`, {
    method: "POST",
    headers: { "api-key": API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(mintWinner.variant.body),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return typeof data.value === "string" ? data : null;
}

// ---------------------------------------------------------------------------
// P2: WS handshake probes (raw HTTP upgrade; reports the exact status code)
// ---------------------------------------------------------------------------
function wsHandshake(url, { headers = {}, protocols } = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString("base64");
    const reqHeaders = {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": key,
      ...headers,
    };
    if (protocols?.length) reqHeaders["Sec-WebSocket-Protocol"] = protocols.join(", ");

    const req = https.request({
      host: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      headers: reqHeaders,
      timeout: 15000,
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve({ status: 101, headers: res.headers, body: "" });
    });
    req.on("response", (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: -1, body: "TIMEOUT" });
    });
    req.on("error", (error) => resolve({ status: -1, body: `ERROR: ${error.message}` }));
    req.end();
  });
}

async function p2(eph) {
  const paths = [
    { id: "translations", url: `${WSS_BASE}/realtime/translations?model=${encodeURIComponent(TD)}` },
    { id: "standard", url: `${WSS_BASE}/realtime?model=${encodeURIComponent(TD)}` },
  ];
  const auths = [
    eph && {
      id: "eph-subprotocol",
      protocols: [`openai-insecure-api-key.${eph.value}`, "realtime"],
      browserCompatible: true,
    },
    { id: "apikey-header", headers: { "api-key": API_KEY }, protocols: ["realtime"], browserCompatible: false },
    {
      id: "apikey-subprotocol",
      protocols: [`openai-insecure-api-key.${API_KEY}`, "realtime"],
      browserCompatible: true,
    },
  ].filter(Boolean);

  const wins = [];
  for (const p of paths) {
    for (const a of auths) {
      let url = p.url;
      let res = await wsHandshake(url, { headers: a.headers, protocols: a.protocols });
      let suffix = "";
      if (res.status === 404) {
        url = `${p.url}&api-version=preview`;
        res = await wsHandshake(url, { headers: a.headers, protocols: a.protocols });
        suffix = " [preview]";
      }
      const label = `path=${p.id} auth=${a.id}${suffix}`;
      log("P2", `WS ${label} -> ${res.status} ${redact(res.body ?? "").slice(0, 200).replaceAll("\n", " ")}`);
      record("P2", { url, label, status: res.status, body: redact(res.body ?? "").slice(0, 500) });
      if (res.status === 101) {
        wins.push({ path: p, auth: a, url });
        break; // first winning auth per path is enough
      }
    }
  }
  return wins;
}

// ---------------------------------------------------------------------------
// Minimal WebSocket client over node:tls (header auth support; text frames only)
// ---------------------------------------------------------------------------
class MiniWs {
  constructor(url, { headers = {}, protocols } = {}) {
    this.url = new URL(url);
    this.headers = headers;
    this.protocols = protocols;
    this.handlers = { open: [], message: [], close: [], error: [] };
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.closed = false;
  }

  on(event, fn) {
    this.handlers[event].push(fn);
  }

  emit(event, ...args) {
    for (const fn of this.handlers[event]) fn(...args);
  }

  connect() {
    const key = crypto.randomBytes(16).toString("base64");
    const lines = [
      `GET ${this.url.pathname + this.url.search} HTTP/1.1`,
      `Host: ${this.url.hostname}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      `Sec-WebSocket-Key: ${key}`,
    ];
    if (this.protocols?.length) lines.push(`Sec-WebSocket-Protocol: ${this.protocols.join(", ")}`);
    for (const [k, v] of Object.entries(this.headers)) lines.push(`${k}: ${v}`);
    const request = lines.join("\r\n") + "\r\n\r\n";

    this.socket = tls.connect({ host: this.url.hostname, port: 443, servername: this.url.hostname }, () => {
      this.socket.write(request);
    });
    this.socket.on("error", (error) => this.emit("error", error));
    this.socket.on("close", () => {
      if (!this.closed) {
        this.closed = true;
        this.emit("close", 1006, "socket closed");
      }
    });

    let upgraded = false;
    let headerBuf = Buffer.alloc(0);
    this.socket.on("data", (data) => {
      if (upgraded) {
        this.buffer = Buffer.concat([this.buffer, data]);
        this.parseFrames();
        return;
      }
      headerBuf = Buffer.concat([headerBuf, data]);
      const idx = headerBuf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      const head = headerBuf.subarray(0, idx).toString();
      const statusLine = head.split("\r\n")[0];
      if (!/ 101 /.test(statusLine)) {
        this.emit("error", new Error(`Handshake failed: ${statusLine}\n${head}`));
        this.socket.destroy();
        return;
      }
      upgraded = true;
      this.buffer = headerBuf.subarray(idx + 4);
      this.emit("open");
      this.parseFrames();
    });
  }

  parseFrames() {
    while (true) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      let maskKey = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        maskKey = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + len) return;
      let payload = this.buffer.subarray(offset, offset + len);
      this.buffer = this.buffer.subarray(offset + len);
      if (maskKey) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
      }

      if (opcode === 0x9) {
        this.sendFrame(0xa, payload); // pong
        continue;
      }
      if (opcode === 0xa) continue; // pong
      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString() : "";
        this.closed = true;
        this.emit("close", code, reason);
        this.socket.destroy();
        return;
      }
      // text/binary/continuation
      this.fragments.push(payload);
      if (fin) {
        const message = Buffer.concat(this.fragments).toString("utf8");
        this.fragments = [];
        this.emit("message", message);
      }
    }
  }

  sendFrame(opcode, payload) {
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  send(text) {
    this.sendFrame(0x1, Buffer.from(text, "utf8"));
  }

  close() {
    try {
      this.sendFrame(0x8, Buffer.from([0x03, 0xe8]));
      this.socket.end();
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// P3: full WS loop
// ---------------------------------------------------------------------------
const INPUT_DELTA_EVENTS = new Set([
  "session.input_transcript.delta",
  "conversation.item.input_audio_transcription.delta",
]);
const OUTPUT_TEXT_DELTA_EVENTS = new Set([
  "session.output_transcript.delta",
  "response.output_audio_transcript.delta",
  "response.audio_transcript.delta",
  "response.output_text.delta",
]);
const OUTPUT_AUDIO_DELTA_EVENTS = new Set([
  "session.output_audio.delta",
  "response.output_audio.delta",
  "response.audio.delta",
]);

function buildSessionUpdate(shape) {
  if (shape === "realtime+instructions") {
    return {
      type: "session.update",
      session: {
        type: "realtime",
        audio: { input: { transcription: { model: WD } } },
        instructions:
          "You are a simultaneous interpreter. Translate everything you hear into Japanese. Output only the translation.",
      },
    };
  }
  return {
    type: "session.update",
    session: {
      audio: {
        input: { transcription: { model: WD }, noise_reduction: null },
        output: { language: "ja" },
      },
    },
  };
}

async function p3(wsWin, audio, sessionShape) {
  const state = {
    eventCounts: {},
    firstOfType: {},
    inputTranscript: "",
    outputTranscript: "",
    outputAudioDeltas: 0,
    errors: [],
    closeInfo: null,
    audioEventFamily: wsWin.path.id === "translations" ? "session-prefixed" : "standard",
    familySwitched: false,
  };

  const ws = new MiniWs(wsWin.url, {
    headers: wsWin.auth.headers ?? {},
    protocols: wsWin.auth.protocols,
  });

  const appendType = () =>
    state.audioEventFamily === "session-prefixed"
      ? "session.input_audio_buffer.append"
      : "input_audio_buffer.append";

  let sendStarted = false;
  const sendAudio = async () => {
    if (sendStarted) return;
    sendStarted = true;
    const chunkBytes = 9600; // 200ms of PCM16 @ 24kHz mono
    const silence = Buffer.alloc(chunkBytes).toString("base64");
    log("P3", `streaming audio: family=${state.audioEventFamily} type=${appendType()}`);
    for (let i = 0; i < 5; i += 1) {
      ws.send(JSON.stringify({ type: appendType(), audio: silence }));
      await delay(100);
    }
    for (let off = 0; off < audio.length; off += chunkBytes) {
      ws.send(JSON.stringify({ type: appendType(), audio: audio.subarray(off, off + chunkBytes).toString("base64") }));
      await delay(100);
    }
    for (let i = 0; i < 12; i += 1) {
      ws.send(JSON.stringify({ type: appendType(), audio: silence }));
      await delay(100);
    }
    log("P3", "audio fully sent; collecting events...");
  };

  await new Promise((resolve) => {
    const deadline = setTimeout(() => {
      log("P3", "deadline reached");
      ws.close();
      resolve();
    }, 60000);

    ws.on("error", (error) => {
      state.errors.push(`ws: ${redact(error.message)}`);
      log("P3", `WS error: ${redact(error.message).slice(0, 300)}`);
      clearTimeout(deadline);
      resolve();
    });
    ws.on("close", (code, reason) => {
      state.closeInfo = { code, reason: redact(reason) };
      log("P3", `WS closed: ${code} ${redact(reason)}`);
      clearTimeout(deadline);
      resolve();
    });
    ws.on("open", () => {
      log("P3", "WS open; sending session.update");
      ws.send(JSON.stringify(buildSessionUpdate(sessionShape)));
      // Some surfaces don't echo session.updated before accepting audio; start sending
      // after a short grace period regardless.
      setTimeout(() => void sendAudio(), 1500);
    });
    ws.on("message", (text) => {
      let event;
      try {
        event = JSON.parse(text);
      } catch {
        return;
      }
      const type = event.type ?? "unknown";
      state.eventCounts[type] = (state.eventCounts[type] ?? 0) + 1;
      if (!state.firstOfType[type]) {
        state.firstOfType[type] = redact(text).slice(0, 300);
        log("P3", `event: ${type} ${state.firstOfType[type].replaceAll("\n", " ").slice(0, 220)}`);
      }

      if (type === "error") {
        const msg = JSON.stringify(event.error ?? event);
        state.errors.push(redact(msg));
        // If the event family was wrong, switch once and resend.
        if (/unknown|invalid|not.*support/i.test(msg) && /input_audio_buffer/.test(msg) && !state.familySwitched) {
          state.familySwitched = true;
          state.audioEventFamily =
            state.audioEventFamily === "session-prefixed" ? "standard" : "session-prefixed";
          sendStarted = false;
          log("P3", `switching audio event family to ${state.audioEventFamily} and resending`);
          void sendAudio();
        }
        return;
      }
      if (type === "session.created" || type === "session.updated") {
        void sendAudio();
      }
      if (INPUT_DELTA_EVENTS.has(type) && typeof event.delta === "string") {
        state.inputTranscript += event.delta;
      }
      if (OUTPUT_TEXT_DELTA_EVENTS.has(type) && typeof event.delta === "string") {
        state.outputTranscript += event.delta;
        verdict.eventFamily = type.startsWith("session.") ? "translation" : "standard";
      }
      if (OUTPUT_AUDIO_DELTA_EVENTS.has(type)) {
        state.outputAudioDeltas += 1;
      }
      // Finish early once we have solid evidence and audio is fully sent.
      if (
        sendStarted &&
        state.outputTranscript.length > 30 &&
        (state.inputTranscript.length > 30 || state.eventCounts[appendType()])
      ) {
        // keep collecting a bit; the deadline handles termination
      }
    });
    ws.connect();
  });

  record("P3", {
    url: wsWin.url,
    label: `auth=${wsWin.auth.id}`,
    eventCounts: state.eventCounts,
    inputTranscript: state.inputTranscript.slice(0, 500),
    outputTranscript: state.outputTranscript.slice(0, 500),
    outputAudioDeltas: state.outputAudioDeltas,
    errors: state.errors.slice(0, 10),
    closeInfo: state.closeInfo,
  });

  const ja = /[぀-ヿ一-鿿]/.test(state.outputTranscript);
  const overlap = wordOverlap(KNOWN_PHRASE, state.inputTranscript);
  verdict.inputTranscriptSeen = state.inputTranscript.length > 0;
  verdict.outputTranscriptJa = ja;
  log("P3", `RESULT outputTranscript(ja=${ja}): ${state.outputTranscript.slice(0, 300)}`);
  log("P3", `RESULT inputTranscript(overlap=${overlap.toFixed(2)}): ${state.inputTranscript.slice(0, 300)}`);
  log("P3", `RESULT outputAudioDeltas=${state.outputAudioDeltas} events=${JSON.stringify(state.eventCounts)}`);
  return state;
}

// ---------------------------------------------------------------------------
// P4: SDP calls endpoints
// ---------------------------------------------------------------------------
async function p4(mintWinner) {
  const paths = ["realtime/calls", "realtime/translations/calls"];
  for (const p of paths) {
    const eph = await mintFresh(mintWinner);
    const auth = eph
      ? { Authorization: `Bearer ${eph.value}` }
      : { "api-key": API_KEY };
    const authLabel = eph ? "eph-bearer" : "api-key";

    // Dummy probe: distinguishes route-absent (404) from SDP-rejected (400/415/422).
    const dummy = await probeWithPreview(`P4-${p}-dummy`, "POST", `${BASE}/${p}`, {
      headers: { ...auth, "Content-Type": "application/sdp" },
      body: "v=0\r\n",
      label: `dummy SDP, auth=${authLabel}`,
    });
    if (dummy.status === 404) continue;

    // Real offer against a path that exists.
    const eph2 = await mintFresh(mintWinner);
    const auth2 = eph2 ? { Authorization: `Bearer ${eph2.value}` } : { "api-key": API_KEY };
    const real = await probeWithPreview(`P4-${p}-real`, "POST", `${BASE}/${p}`, {
      headers: { ...auth2, "Content-Type": "application/sdp" },
      body: REAL_OFFER,
      label: `real SDP offer, auth=${eph2 ? "eph-bearer" : "api-key"}`,
    });
    if ((real.status === 200 || real.status === 201) && /^v=0/m.test(real.text)) {
      verdict.callsPath = p;
      verdict.callsAuth = eph2 ? "eph-bearer" : "api-key";
      verdict.callsLocation = real.headers["location"] ?? null;
      log("P4", `CALLS WINNER: ${p} (Location: ${verdict.callsLocation})`);
      return;
    }
    // Path exists but offer rejected: still record as existing.
    if (!verdict.callsPath && dummy.status !== 404) {
      verdict.callsPath = `${p} (exists, offer rejected ${real.status})`;
    }
  }
}

// ---------------------------------------------------------------------------
// P5: CORS preflight (informational)
// ---------------------------------------------------------------------------
async function p5() {
  const target = `${BASE}/${(verdict.callsPath ?? "realtime/calls").split(" ")[0]}`;
  for (const origin of ["http://127.0.0.1:8000", "https://smoke-test.databricksapps.com"]) {
    const { status, headers } = await probeHttp("P5", "OPTIONS", target, {
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type",
      },
      label: `preflight origin=${origin}`,
    });
    const allow = headers["access-control-allow-origin"];
    verdict.cors[origin] = { status, allowOrigin: allow ?? null, allowHeaders: headers["access-control-allow-headers"] ?? null };
    log("P5", `origin=${origin} -> allow-origin=${allow ?? "(none)"}`);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function decideArch() {
  const mintMirror = verdict.mintPath === "realtime/translations/client_secrets";
  const mintStandardTranslation =
    verdict.mintPath === "realtime/client_secrets" && verdict.mintBodyShape?.startsWith("translation");
  const mintRealtime = verdict.mintBodyShape === "realtime+instructions";
  if (mintMirror && verdict.wsPath === "translations") verdict.arch = "i (full mirror)";
  else if (mintMirror) verdict.arch = "i' (mirror mint + standard transport)";
  else if (mintStandardTranslation) verdict.arch = verdict.eventFamily === "standard" ? "ii+iii-events" : "ii (standard paths, translation shape)";
  else if (mintRealtime) verdict.arch = "iii (realtime session on translate deployment)";
  else verdict.arch = "iv (translate deployment unusable; needs fallback)";
}

async function main() {
  log("init", `BASE=${BASE} TD=${TD} WD=${WD} wav=${WAV_PATH ?? "(none)"}`);
  await p0();

  const mintWinner = await p1();

  const eph = await mintFresh(mintWinner);
  const wsWins = await p2(eph);
  if (wsWins.length > 0) {
    verdict.wsPath = wsWins[0].path.id;
    verdict.wsAuth = wsWins[0].auth.id;
  }

  if (!SKIP_WS_LOOP && wsWins.length > 0 && WAV_PATH) {
    const audio = extractWavPcm(WAV_PATH);
    log("P3", `WAV ok: ${audio.length} bytes (${(audio.length / 48000).toFixed(1)}s)`);
    // For the loop, prefer an ephemeral-auth win (closest to production); else header auth.
    const loopWin = wsWins.find((w) => w.auth.id === "eph-subprotocol") ?? wsWins[0];
    const shape = verdict.mintBodyShape === "realtime+instructions" ? "realtime+instructions" : "translation";
    // Fresh ephemeral for the loop if that auth mode is used.
    if (loopWin.auth.id === "eph-subprotocol") {
      const fresh = await mintFresh(mintWinner);
      if (fresh) loopWin.auth.protocols = [`openai-insecure-api-key.${fresh.value}`, "realtime"];
    }
    await p3(loopWin, audio, shape);
  } else if (!WAV_PATH) {
    log("P3", "SKIPPED: no test WAV found (see header comment for generation commands)");
  } else if (wsWins.length === 0) {
    log("P3", "SKIPPED: no WS handshake succeeded");
  }

  await p4(mintWinner);
  await p5();
  decideArch();

  console.log("\n========== VERDICT ==========");
  console.log(JSON.stringify(verdict, null, 2));
  console.log("\n========== RAW RESULTS ==========");
  console.log(JSON.stringify(results, null, 2));
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

function firstExisting(paths) {
  for (const p of paths) if (p && existsSync(p)) return p;
  return null;
}

/** Parse a WAV file: verify PCM16 mono 24kHz, return the data chunk. */
function extractWavPcm(file) {
  const wav = readFileSync(file);
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${file} is not a RIFF/WAVE file`);
  }
  let fmt = null;
  let data = null;
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt ") {
      fmt = {
        format: wav.readUInt16LE(start),
        channels: wav.readUInt16LE(start + 2),
        rate: wav.readUInt32LE(start + 4),
        bits: wav.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      data = wav.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`${file}: missing fmt/data chunk`);
  if (fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== 24000 || fmt.bits !== 16) {
    throw new Error(
      `${file}: need PCM16 mono 24kHz, got format=${fmt.format} ch=${fmt.channels} rate=${fmt.rate} bits=${fmt.bits}`,
    );
  }
  return data;
}

function wordOverlap(reference, candidate) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter(Boolean);
  const ref = new Set(norm(reference));
  if (ref.size === 0) return 0;
  const cand = new Set(norm(candidate));
  let hit = 0;
  for (const w of ref) if (cand.has(w)) hit += 1;
  return hit / ref.size;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(`FATAL: ${redact(error.stack ?? error.message)}`);
  process.exit(1);
});
