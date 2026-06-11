import { buildAudioMixState } from "/audio-mix.js";
import {
  buildDisplayMediaOptions,
  buildUserMediaOptions,
} from "/capture-options.js";
import { Pcm16Chunker, PCM16_200MS_CHUNK_BYTES, bytesToBase64 } from "/audio-chunks.js";
import {
  Pcm16Player,
  base64ToFloat32,
  framePeak,
  SILENT_FRAME_PEAK,
} from "/audio-playback.js";
import { buildTranscriptCsv, transcriptFileStamp } from "/transcript-export.js";
import { isEchoOf } from "/echo-detect.js";

// Translation event family (verified on Azure; docs/api-verification.md),
// plus the standard realtime family as a compatibility adapter.
const OUTPUT_TRANSCRIPT_EVENTS = new Set([
  "session.output_transcript.delta",
  "response.output_audio_transcript.delta",
]);
const INPUT_TRANSCRIPT_EVENTS = new Set([
  "session.input_transcript.delta",
  "conversation.item.input_audio_transcription.delta",
]);
const OUTPUT_AUDIO_EVENTS = new Set([
  "session.output_audio.delta",
  "response.output_audio.delta",
]);

// A pause this long between deltas starts a new subtitle segment.
const SEGMENT_GAP_MS = 2000;

const captureMode = document.querySelector("#captureMode");
const targetLanguage = document.querySelector("#targetLanguage");
const bidiToggle = document.querySelector("#bidiToggle");
const voiceMode = document.querySelector("#voiceMode");
const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const clearButton = document.querySelector("#clearButton");
const exportCsvButton = document.querySelector("#exportCsvButton");
const fullscreenButton = document.querySelector("#fullscreenButton");
const audioMix = document.querySelector("#audioMix");
const mixControl = document.querySelector("#mixControl");
const mixValue = document.querySelector("#mixValue");
const originalMixLabel = document.querySelector("#originalMixLabel");
const translatedMixLabel = document.querySelector("#translatedMixLabel");
const composeInput = document.querySelector("#composeInput");
const composeButton = document.querySelector("#composeButton");
const composeResult = document.querySelector("#composeResult");
const composeCopy = document.querySelector("#composeCopy");
const statusDot = document.querySelector("#statusDot");
const statusText = document.querySelector("#statusText");
const inputMeter = document.querySelector("#inputMeter");
const captureNote = document.querySelector("#captureNote");
const eventLog = document.querySelector("#eventLog");
const captureState = document.querySelector("#captureState");
const connectionState = document.querySelector("#connectionState");
const sessionState = document.querySelector("#sessionState");
const peakInputLevel = document.querySelector("#peakInputLevel");
const outputAudioDeltas = document.querySelector("#outputAudioDeltas");
const transcriptDeltas = document.querySelector("#transcriptDeltas");
const lastEventType = document.querySelector("#lastEventType");

const columns = {
  left: createTranscriptColumn({
    element: document.querySelector("#leftTranscript"),
    title: document.querySelector("#leftTitle"),
    badge: document.querySelector("#leftBadge"),
    muteButton: document.querySelector("#leftMute"),
    speakAllButton: document.querySelector("#leftSpeakAll"),
  }),
  right: createTranscriptColumn({
    element: document.querySelector("#rightTranscript"),
    title: document.querySelector("#rightTitle"),
    badge: document.querySelector("#rightBadge"),
    muteButton: document.querySelector("#rightMute"),
    speakAllButton: document.querySelector("#rightSpeakAll"),
  }),
};

/**
 * One Azure translation session behind the /api/ws proxy: a WebSocket plus a
 * PCM16 player for that session's translated audio. Bidirectional mode runs
 * two of these (target ja + target en) over the same capture.
 */
class TranslationSession {
  constructor(language, handlers) {
    this.language = language;
    this.handlers = handlers;
    this.socket = null;
    this.player = null;
    this.mutedFlag = false;
    this.baseVolume = 1;
  }

  async start() {
    this.player = new Pcm16Player({ context: ensurePlaybackContext() });
    await this.player.resume();
    await this.#connect();
  }

  #connect() {
    return new Promise((resolve, reject) => {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${location.host}/api/ws?target=${encodeURIComponent(this.language)}`;
      this.socket = new WebSocket(url);
      let settled = false;

      this.socket.addEventListener("open", () => {
        settled = true;
        this.handlers.onConnectionChange?.(this, "open");
        this.handlers.onLog?.(`ws.open[${this.language}]`, "connected");
        resolve();
      });

      this.socket.addEventListener("message", (message) => this.#handleEvent(message));

      this.socket.addEventListener("close", (event) => {
        this.handlers.onConnectionChange?.(this, "closed");
        if (!settled) {
          settled = true;
          reject(new Error(`Connection refused (${event.code}) ${event.reason}`));
          return;
        }
        this.handlers.onClosed?.(this, event);
      });

      this.socket.addEventListener("error", () => {
        this.handlers.onLog?.(`ws.error[${this.language}]`, "WebSocket error");
      });
    });
  }

  #handleEvent(message) {
    let event;
    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }

    this.handlers.onEventType?.(event.type);

    if (event.type === "error") {
      this.handlers.onLog?.(`error[${this.language}]`, JSON.stringify(event.error ?? event));
      return;
    }

    if (OUTPUT_AUDIO_EVENTS.has(event.type) && typeof event.delta === "string") {
      const floats = base64ToFloat32(event.delta);
      const voiced = framePeak(floats) >= SILENT_FRAME_PEAK;
      // The handler owns playback: it knows the voice mode and whether the
      // frame belongs to an echo segment that should stay silent.
      this.handlers.onAudioDelta?.(this, voiced, floats);
      return;
    }

    if (OUTPUT_TRANSCRIPT_EVENTS.has(event.type) && typeof event.delta === "string") {
      this.handlers.onOutputText?.(this, event.delta);
      return;
    }

    if (INPUT_TRANSCRIPT_EVENTS.has(event.type) && typeof event.delta === "string") {
      this.handlers.onInputText?.(this, event.delta, event);
      return;
    }

    if (event.type === "session.created" || event.type === "session.updated") {
      this.handlers.onSessionState?.(this, event.type.replace("session.", ""));
    }
  }

  sendAudio(base64) {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }
    this.socket.send(
      JSON.stringify({ type: "session.input_audio_buffer.append", audio: base64 }),
    );
  }

  setBaseVolume(volume) {
    this.baseVolume = volume;
    this.#applyVolume();
  }

  set muted(value) {
    this.mutedFlag = value;
    this.#applyVolume();
  }

  get muted() {
    return this.mutedFlag;
  }

  #applyVolume() {
    if (this.player) {
      this.player.volume = this.mutedFlag ? 0 : this.baseVolume;
    }
  }

  async close() {
    this.handlers.onClosed = null;
    this.socket?.close();
    this.socket = null;
    if (this.player) {
      await this.player.close();
    }
    this.player = null;
  }
}

let sessions = [];
let captureStream = null;
let captureContext = null;
let workletNode = null;
let chunker = null;
let sourceAudio = null;
let stopping = false;
let diagnostics = createEmptyDiagnostics();
// Shared output context for every Pcm16Player. Created synchronously inside a
// click handler so the browser's autoplay policy never leaves it suspended,
// and kept across Stop so buffered segment audio stays playable.
let playbackContext = null;

function ensurePlaybackContext() {
  if (!playbackContext || playbackContext.state === "closed") {
    playbackContext = new AudioContext();
    playbackContext.addEventListener("statechange", () => {
      logEvent("audio.context", playbackContext.state);
    });
  }
  if (playbackContext.state === "suspended") {
    void playbackContext.resume();
  }
  return playbackContext;
}

// ----- per-segment translation audio (manual Speak) -----

// `session.output_audio.delta` carries PCM16 mono at this rate (verified in
// docs/api-verification.md).
const TRANSLATED_SAMPLE_RATE = 24000;
// Voiced frames are kept per subtitle segment so the operator can replay a
// translation exactly when the room should hear it (mixed-language meetings
// rarely want every line spoken automatically). Only the newest segments
// keep audio: 20 segments is still only a few MB.
const SEGMENT_AUDIO_LIMIT = 20;
// Frames that arrive before their segment opens wait here; 50 frames = 10s.
const PENDING_AUDIO_FRAME_LIMIT = 50;
const segmentAudio = new Map();
const segmentAudioOrder = [];
let manualPlayback = null;

// ----- After-pause voice mode (consecutive interpretation) -----

// The queue fires once the room has been quiet for a beat AND the translation
// stream has finished arriving; either alone would cut an utterance in half.
const PAUSE_INPUT_QUIET_MS = 1200;
const PAUSE_AUDIO_QUIET_MS = 800;
// Worklet RMS above this counts as someone speaking (speech is ~0.05-0.3;
// the echo-cancelled mic floor sits well below).
const INPUT_SPEECH_RMS = 0.02;
let lastLoudInputAt = 0;
let lastVoicedFrameAt = 0;
let pauseEngineTimer = null;

function startPauseEngine() {
  stopPauseEngine();
  lastLoudInputAt = performance.now();
  lastVoicedFrameAt = performance.now();
  pauseEngineTimer = setInterval(() => {
    if (voiceMode.value !== "pause" || manualPlayback) {
      return;
    }
    const now = performance.now();
    if (
      now - lastLoudInputAt < PAUSE_INPUT_QUIET_MS ||
      now - lastVoicedFrameAt < PAUSE_AUDIO_QUIET_MS
    ) {
      return;
    }
    // One column per tick; the next tick picks up the other once it ends.
    for (const column of Object.values(columns)) {
      if (column.session?.muted) {
        continue;
      }
      if (column.speakQueue()) {
        break;
      }
    }
  }, 300);
}

function stopPauseEngine() {
  if (pauseEngineTimer) {
    clearInterval(pauseEngineTimer);
    pauseEngineTimer = null;
  }
}

function attachSegmentAudio(segmentEl, floats) {
  let frames = segmentAudio.get(segmentEl);
  if (!frames) {
    frames = [];
    segmentAudio.set(segmentEl, frames);
    segmentAudioOrder.push(segmentEl);
    segmentEl.append(createSpeakButton(segmentEl));
    while (segmentAudioOrder.length > SEGMENT_AUDIO_LIMIT) {
      const evicted = segmentAudioOrder.shift();
      segmentAudio.delete(evicted);
      evicted.querySelector(".speak-button")?.remove();
    }
  }
  frames.push(floats);
  updateAllSpeakButtons();
}

function createSpeakButton(segmentEl) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "speak-button";
  button.textContent = "🔊";
  // Native title here on purpose: a custom tooltip would be clipped by the
  // transcript's scroll container.
  button.title = "この段落の訳を読み上げ (もう一度押すと停止)";
  button.addEventListener("click", () => {
    if (manualPlayback?.button === button) {
      stopManualPlayback();
      return;
    }
    const frames = segmentAudio.get(segmentEl);
    if (!frames?.length) {
      return;
    }
    markSpoken(segmentEl);
    segmentEl.classList.add("speaking");
    playFrames(frames, button, "⏹", () => {
      segmentEl.classList.remove("speaking");
      button.textContent = "🔊";
      updateAllSpeakButtons();
    });
  });
  return button;
}

// Spoken segments are excluded from the column-level "▶ Speak" queue, so
// utterances split across paragraphs still play with a single click and
// already-heard text (manual, queued, or simultaneous) is never re-read.
function markSpoken(segmentEl) {
  segmentEl.dataset.spoken = "1";
  segmentEl.classList.add("spoken");
  segmentEl.querySelector(".speak-button")?.classList.add("spoken");
  updateAllSpeakButtons();
}

function updateAllSpeakButtons() {
  for (const column of Object.values(columns)) {
    column.updateSpeakAll();
  }
}

function playFrames(frames, button, playingLabel, restore) {
  if (frames.length === 0) {
    return;
  }
  stopManualPlayback();
  const context = ensurePlaybackContext();
  const length = frames.reduce((total, frame) => total + frame.length, 0);
  const floats = new Float32Array(length);
  let offset = 0;
  for (const frame of frames) {
    floats.set(frame, offset);
    offset += frame.length;
  }
  const buffer = context.createBuffer(1, length, TRANSLATED_SAMPLE_RATE);
  buffer.copyToChannel(floats, 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  // Straight to the destination: an explicit Speak click should be heard at
  // full volume regardless of the mix slider or column mutes.
  source.connect(context.destination);
  source.addEventListener("ended", () => {
    if (manualPlayback?.source === source) {
      stopManualPlayback();
    }
  });
  source.start();
  manualPlayback = { source, button, restore };
  button.textContent = playingLabel;
  button.classList.add("playing");
}

function stopManualPlayback() {
  if (!manualPlayback) {
    return;
  }
  const { source, button, restore } = manualPlayback;
  manualPlayback = null;
  try {
    source.stop();
  } catch {
    // Source already ended.
  }
  button.classList.remove("playing");
  restore();
}

// Segment text lives in the leading text node so appending text never wipes
// out the segment's Speak button.
function appendSegmentText(el, text) {
  const node =
    el.firstChild instanceof Text
      ? el.firstChild
      : el.insertBefore(document.createTextNode(""), el.firstChild);
  node.data += text;
}

function segmentText(el) {
  return el.firstChild instanceof Text ? el.firstChild.data : el.textContent;
}

function scrollColumnOf(el) {
  for (const column of Object.values(columns)) {
    if (column.element === el.parentElement) {
      if (column.pinnedToBottom) {
        column.element.scrollTop = column.element.scrollHeight;
      }
      return;
    }
  }
}

// Azure's translation sessions re-speak input that is already in their
// target language instead of staying silent (en->en, ja->ja). A translated
// segment that is nearly contained in a recent original is therefore an
// echo: dim it and keep it out of the Speak queue / auto-speak. Re-checked
// on every delta until it trips; marking is sticky.
const ECHO_WINDOW_MS = 45000;
const ECHO_ORIGINALS_CHECKED = 12;

function assessEcho(segmentEl) {
  if (segmentEl.dataset.echo) {
    return;
  }
  const ts = Number(segmentEl.dataset.ts ?? 0);
  const text = segmentText(segmentEl);
  for (const column of Object.values(columns)) {
    const originals = [
      ...column.element.querySelectorAll('.segment[data-kind="original"]'),
    ].slice(-ECHO_ORIGINALS_CHECKED);
    for (const original of originals) {
      if (Math.abs(Number(original.dataset.ts ?? 0) - ts) > ECHO_WINDOW_MS) {
        continue;
      }
      if (isEchoOf(text, segmentText(original))) {
        segmentEl.dataset.echo = "1";
        segmentEl.classList.add("echo");
        updateAllSpeakButtons();
        return;
      }
    }
  }
}

applyAudioMix();
configureColumns();
updateCaptureNote();
void loadConfig();

audioMix.addEventListener("input", () => {
  applyAudioMix();
});

voiceMode.addEventListener("change", () => {
  applyAudioMix();
  configureColumns();
});

targetLanguage.addEventListener("change", () => {
  configureColumns();
});

bidiToggle.addEventListener("change", () => {
  targetLanguage.disabled = bidiToggle.checked;
  configureColumns();
});

captureMode.addEventListener("change", () => {
  updateCaptureNote();
});

startButton.addEventListener("click", async () => {
  ensurePlaybackContext();
  prepareTranscriptsForStart();
  resetDiagnostics();
  stopping = false;
  setControls({ running: true });
  setStatus(
    captureMode.value === "mic" ? "Requesting microphone" : "Pick what to share",
    "idle",
  );

  try {
    captureStream = await captureAudio(captureMode.value);
    if (captureMode.value !== "mic") {
      // Mic input is never played back locally (feedback); shared tab/screen
      // audio is, because suppressLocalAudioPlayback mutes the original tab.
      startSourceAudio(captureStream);
    }

    setStatus("Connecting to translation session", "idle");
    await startSessions();
    applyAudioMix();
    startPauseEngine();

    await startAudioPipeline(captureStream);
    setStatus(
      bidiToggle.checked
        ? `Translating ja ⇄ en (${captureMode.value})`
        : `Translating to ${targetLanguage.value} (${captureMode.value})`,
      "live",
    );
  } catch (error) {
    logEvent("error", error instanceof Error ? error.message : String(error));
    await stop("Stopped after startup error", "error");
  }
});

stopButton.addEventListener("click", async () => {
  await stop("Stopped", "idle");
});

clearButton.addEventListener("click", () => {
  clearTranscripts();
});

exportCsvButton.addEventListener("click", () => {
  exportTranscript();
});

// ----- compose box (typed ja -> spoken-style en via /api/compose) -----

composeButton.addEventListener("click", () => {
  void composeTranslate();
});

composeInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    void composeTranslate();
  }
});

composeCopy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(composeResult.textContent);
    composeCopy.textContent = "Copied!";
    setTimeout(() => {
      composeCopy.textContent = "Copy";
    }, 1200);
  } catch (error) {
    logEvent("compose.copy", error.message);
  }
});

async function composeTranslate() {
  const text = composeInput.value.trim();
  if (!text || composeButton.disabled) {
    return;
  }
  composeButton.disabled = true;
  composeButton.textContent = "Translating…";
  composeResult.classList.remove("error");
  composeCopy.hidden = true;
  try {
    const response = await fetch("/api/compose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => null))?.detail;
      throw new Error(detail ?? `HTTP ${response.status}`);
    }
    // The server streams plain text chunks; render them as they arrive.
    composeResult.textContent = "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      composeResult.textContent += decoder.decode(value, { stream: true });
    }
    composeResult.textContent += decoder.decode();
    composeCopy.hidden = composeResult.textContent.length === 0;
  } catch (error) {
    composeResult.textContent = error.message;
    composeResult.classList.add("error");
    composeCopy.hidden = true;
    logEvent("compose", error.message);
  } finally {
    composeButton.disabled = false;
    composeButton.textContent = "→ English";
  }
}

fullscreenButton.addEventListener("click", async () => {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
    return;
  }
  try {
    await document.documentElement.requestFullscreen();
  } catch (error) {
    logEvent("fullscreen", error.message);
  }
});

document.addEventListener("fullscreenchange", () => {
  document.body.classList.toggle("subtitle-mode", Boolean(document.fullscreenElement));
  for (const column of Object.values(columns)) {
    column.scrollToBottom();
  }
});

async function startSessions() {
  const sharedHandlers = {
    onLog: logEvent,
    onEventType: (type) => {
      diagnostics.lastEventType = type;
      lastEventType.textContent = type;
    },
    onConnectionChange: () => {
      diagnostics.connectionState = sessions.length
        ? sessions
            .map((s) => (s.socket?.readyState === WebSocket.OPEN ? "open" : "closed"))
            .join("/")
        : "new";
      updateDiagnostics();
    },
    onSessionState: (session, state) => {
      diagnostics.sessionState = `${state} (${session.language})`;
      updateDiagnostics();
    },
    onClosed: () => {
      if (!stopping) {
        logEvent("ws.close", "session closed unexpectedly");
        void stop("Connection closed", "error");
      }
    },
  };

  // Diagnostics plus per-segment buffering for the Speak buttons; each
  // session's translated audio belongs to one column stream. In Simultaneous
  // mode the frame also plays live - unless it belongs to a detected echo
  // segment - and its segment counts as spoken so the ▶ Speak queue never
  // offers it again.
  const makeAudioDeltaHandler = (column, kind) => (session, voiced, floats) => {
    diagnostics.outputAudioDeltas += 1;
    if (voiced) {
      diagnostics.voicedAudioDeltas += 1;
      lastVoicedFrameAt = performance.now();
      const simul = voiceMode.value === "simul";
      const segment = column.bufferAudio(kind, floats, simul);
      if (simul && !segment?.dataset.echo) {
        session.player?.enqueueFloats(floats);
      }
    }
    updateDiagnostics();
  };

  if (bidiToggle.checked) {
    // Each column carries everything in its language: source speech routed by
    // script detection, plus the other language's translation (accented style).
    // Deltas arrive roughly per word, and Japanese speech routinely contains
    // Latin tokens ("AI", product names), so classification is per utterance:
    // kana/kanji anywhere makes it Japanese and relocates the whole segment;
    // Latin only sets English tentatively at the start of an utterance.
    // Utterance boundaries use the delta's audio-timeline position
    // (elapsed_ms): deltas arrive in bursts after the speech, so wall-clock
    // arrival gaps do not reflect actual pauses between speakers.
    const UTTERANCE_GAP_MS = 700;
    let utterance = null;
    let lastLanguage = "en";
    const routeInput = (text, event) => {
      const now = performance.now();
      const elapsed = typeof event?.elapsed_ms === "number" ? event.elapsed_ms : null;
      const speechGap =
        utterance &&
        elapsed !== null &&
        utterance.lastElapsedMs !== null &&
        elapsed - utterance.lastElapsedMs > UTTERANCE_GAP_MS;
      const wallGap = utterance && now - utterance.lastDeltaAt > SEGMENT_GAP_MS;
      if (!utterance || speechGap || wallGap) {
        if (utterance?.language) {
          lastLanguage = utterance.language;
        }
        const el = document.createElement("p");
        el.className = "segment";
        el.dataset.ts = String(Date.now());
        el.dataset.kind = "original";
        utterance = { el, language: null, lastDeltaAt: now, lastElapsedMs: elapsed };
        (lastLanguage === "ja" ? columns.right : columns.left).adopt(el);
      }
      utterance.lastDeltaAt = now;
      utterance.lastElapsedMs = elapsed ?? utterance.lastElapsedMs;
      appendSegmentText(utterance.el, text);
      if (/[぀-ヿ一-鿿]/.test(text)) {
        if (utterance.language !== "ja") {
          utterance.language = "ja";
          columns.right.adopt(utterance.el);
        }
      } else if (utterance.language === null && /[A-Za-z]/.test(text)) {
        utterance.language = "en";
        columns.left.adopt(utterance.el);
      }
      // adopt() only scrolls on relocation; growing text needs the same
      // bottom-following, or long utterances stall the auto-scroll.
      scrollColumnOf(utterance.el);
      diagnostics.transcriptDeltas += 1;
      updateDiagnostics();
    };

    const left = new TranslationSession("en", {
      ...sharedHandlers,
      onAudioDelta: makeAudioDeltaHandler(columns.left, "translated"),
      onOutputText: (_s, text) => appendTranscript(columns.left, text, "translated"),
      onInputText: () => {},
    });
    const right = new TranslationSession("ja", {
      ...sharedHandlers,
      onAudioDelta: makeAudioDeltaHandler(columns.right, "translated"),
      onOutputText: (_s, text) => appendTranscript(columns.right, text, "translated"),
      // Both sessions transcribe the same audio; one copy is enough.
      onInputText: (_s, text, event) => routeInput(text, event),
    });
    sessions = [left, right];
    columns.left.session = left;
    columns.right.session = right;
  } else {
    const only = new TranslationSession(targetLanguage.value, {
      ...sharedHandlers,
      onAudioDelta: makeAudioDeltaHandler(columns.right, ""),
      onOutputText: (_s, text) => appendTranscript(columns.right, text),
      onInputText: (_s, text) => appendTranscript(columns.left, text),
    });
    sessions = [only];
    columns.left.session = null;
    columns.right.session = only;
  }

  // Fresh sessions start unmuted. (A default mute of the Japanese voice was
  // tried and reverted: when the room speaks English, the Japanese voice is
  // the only audio there is, and muting it made Simultaneous/After-pause
  // silently do nothing. In-person operators use Manual or mute by hand.)
  for (const column of Object.values(columns)) {
    column.setMuted(false);
  }

  await Promise.all(sessions.map((session) => session.start()));
}

function appendTranscript(column, text, kind = "") {
  diagnostics.transcriptDeltas += 1;
  column.append(text, kind);
  updateDiagnostics();
}

// Subtitles survive Stop -> Start: restarting is the standard recovery move
// when a session degrades, and losing the meeting history made it costly.
// A thin divider marks where the new run begins.
function prepareTranscriptsForStart() {
  const stamp = new Date().toTimeString().slice(0, 5);
  for (const column of Object.values(columns)) {
    column.closeSegments();
    if (column.element.childElementCount > 0) {
      const divider = document.createElement("p");
      divider.className = "segment divider";
      divider.textContent = `─── ${stamp} 再開 ───`;
      column.adopt(divider);
    }
    // A new run always starts following the bottom, even if the operator had
    // scrolled up to read history before restarting.
    column.scrollToBottom();
  }
}

function configureColumns() {
  const bidi = bidiToggle.checked;
  // Per-column mutes pick which language speaks automatically (Simultaneous
  // stream, After-pause queue); in Manual mode nothing plays on its own and
  // the ▶ Speak button ignores mutes, so the buttons would only confuse.
  const muteVisible = bidi && voiceMode.value !== "manual";
  if (bidi) {
    columns.left.setHeader("English", "en", muteVisible);
    columns.right.setHeader("Japanese", "ja", muteVisible);
    // In bidi mode untyped segments are routed originals; translations always
    // carry the "translated" kind explicitly.
    columns.right.defaultKind = "original";
  } else {
    columns.left.setHeader("Source", "auto-detect", false);
    columns.right.setHeader("Translated", targetLanguage.value, false);
    columns.right.defaultKind = "translated";
  }
}

async function loadConfig() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) {
      return;
    }
    const config = await response.json();
    if (config.defaultTargetLanguage && !bidiToggle.checked) {
      targetLanguage.value = config.defaultTargetLanguage;
      configureColumns();
    }
  } catch {
    // Backend not reachable yet; the Start button will surface the error.
  }
}

function updateCaptureNote() {
  // Only genuine caveats get the warning banner; normal mode behavior is
  // documented in the quick guide instead.
  if (captureMode.value === "screen") {
    captureNote.textContent =
      "Pick \"Entire screen\" and enable system-audio sharing in the picker. If the picker offers no audio option (older macOS/Chrome), use Browser tab or Microphone capture instead.";
    captureNote.hidden = false;
  } else {
    captureNote.hidden = true;
  }
}

async function captureAudio(mode) {
  if (mode === "mic") {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not support microphone capture.");
    }
    const stream = await navigator.mediaDevices.getUserMedia(buildUserMediaOptions());
    watchFirstTrack(stream);
    captureState.textContent = `mic=${stream.getAudioTracks()[0]?.readyState ?? "?"}`;
    logEvent("capture.started", "microphone");
    return stream;
  }

  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("This browser does not support tab/screen audio capture.");
  }

  const supportedConstraints =
    navigator.mediaDevices.getSupportedConstraints?.() ?? {};
  const stream = await navigator.mediaDevices.getDisplayMedia(
    buildDisplayMediaOptions(supportedConstraints, mode),
  );

  const audioTracks = stream.getAudioTracks();
  const videoTracks = stream.getVideoTracks();

  if (audioTracks.length === 0) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error(
      mode === "screen"
        ? "No system audio was shared. On macOS, share a Chrome tab with audio instead."
        : "No tab audio was shared. Pick a Chrome tab and enable tab audio.",
    );
  }

  watchFirstTrack(stream);

  const audioSettings = audioTracks[0].getSettings?.() ?? {};
  const suppressed =
    typeof audioSettings.suppressLocalAudioPlayback === "boolean"
      ? String(audioSettings.suppressLocalAudioPlayback)
      : "unknown";
  captureState.textContent = `audio=${audioTracks[0].readyState}, video=${videoTracks.length}, suppressed=${suppressed}`;
  logEvent(
    "capture.started",
    `mode=${mode}, audio tracks=${audioTracks.length}, video tracks=${videoTracks.length}, suppressed=${suppressed}`,
  );

  return stream;
}

function watchFirstTrack(stream) {
  stream.getAudioTracks()[0]?.addEventListener(
    "ended",
    () => {
      void stop("Audio capture ended", "idle");
    },
    { once: true },
  );
}

async function startAudioPipeline(stream) {
  captureContext = new AudioContext();
  await captureContext.resume();
  await captureContext.audioWorklet.addModule("/pcm16-capture.worklet.js");

  const source = captureContext.createMediaStreamSource(stream);
  workletNode = new AudioWorkletNode(captureContext, "pcm16-capture", {
    processorOptions: { targetSampleRate: 24000 },
  });
  chunker = new Pcm16Chunker(PCM16_200MS_CHUNK_BYTES);

  workletNode.port.onmessage = ({ data }) => {
    if (data?.type !== "pcm16") {
      return;
    }
    updateInputMeter(data.rms ?? 0);
    for (const chunk of chunker.push(new Uint8Array(data.buffer))) {
      const base64 = bytesToBase64(chunk);
      for (const session of sessions) {
        session.sendAudio(base64);
      }
      diagnostics.chunksSent += 1;
    }
  };

  source.connect(workletNode);
  // The worklet only posts messages; nothing connects to the destination, so
  // captured audio is not echoed through this context.
}

function updateInputMeter(rms) {
  inputMeter.value = Math.min(1, rms * 12);
  if (rms >= INPUT_SPEECH_RMS) {
    lastLoudInputAt = performance.now();
  }
  diagnostics.peakInputLevel = Math.max(diagnostics.peakInputLevel, rms);
  peakInputLevel.textContent = diagnostics.peakInputLevel.toFixed(3);
}

function startSourceAudio(stream) {
  sourceAudio = new Audio();
  sourceAudio.autoplay = true;
  sourceAudio.playsInline = true;
  sourceAudio.srcObject = stream;
  applyAudioMix();

  void sourceAudio.play().catch((error) => {
    logEvent("source.audio.play", error.message);
  });
}

function applyAudioMix() {
  const mix = buildAudioMixState(audioMix.value);
  // Only Simultaneous mode plays the live per-session stream; Manual and
  // After-pause play buffered segments at full volume instead, so the mix
  // slider has nothing to balance there.
  const liveVoice = voiceMode.value === "simul";

  mixControl.hidden = !liveVoice;
  audioMix.value = String(mix.translatedPercent);
  mixValue.textContent = mix.valueLabel;
  originalMixLabel.textContent = mix.originalLabel;
  translatedMixLabel.textContent = mix.translatedLabel;

  if (sourceAudio) {
    sourceAudio.volume = liveVoice ? mix.originalVolume : 1;
  }
  for (const session of sessions) {
    session.setBaseVolume(liveVoice ? mix.translatedVolume : 0);
  }
}

async function stop(message, state = "idle") {
  stopping = true;
  stopPauseEngine();
  // Stop is the panic button: silence the ongoing readout too. The buffered
  // segments stay playable afterwards.
  stopManualPlayback();

  workletNode?.port.close();
  workletNode?.disconnect();
  workletNode = null;
  chunker = null;

  if (captureContext && captureContext.state !== "closed") {
    await captureContext.close();
  }
  captureContext = null;

  const closing = sessions;
  sessions = [];
  await Promise.all(closing.map((session) => session.close()));

  if (sourceAudio) {
    sourceAudio.pause();
    sourceAudio.srcObject = null;
  }
  sourceAudio = null;

  captureStream?.getTracks().forEach((track) => track.stop());
  captureStream = null;

  inputMeter.value = 0;
  setControls({ running: false });
  setStatus(message, state);
}

function setControls({ running }) {
  startButton.disabled = running;
  stopButton.disabled = !running;
  clearButton.disabled = running;
  targetLanguage.disabled = running || bidiToggle.checked;
  captureMode.disabled = running;
  bidiToggle.disabled = running;
}

function setStatus(message, state) {
  statusText.textContent = message;
  statusDot.className = `status-dot ${state === "live" ? "live" : ""} ${
    state === "error" ? "error" : ""
  }`;
}

function createTranscriptColumn({ element, title, badge, muteButton, speakAllButton }) {
  const column = {
    element,
    session: null,
    // Role recorded on untyped segments for export (set by configureColumns).
    defaultKind: "original",
    // One open segment per kind, so concurrent original/translated streams
    // interleave as whole paragraphs instead of shredding each other.
    streams: new Map(),
    pinnedToBottom: true,
    badgeLabel() {
      return badge.textContent.toLowerCase();
    },
    getStream(kind) {
      let stream = column.streams.get(kind);
      if (!stream) {
        stream = { segment: null, lastDeltaAt: 0, pendingAudio: [] };
        column.streams.set(kind, stream);
      }
      return stream;
    },
    append(text, kind = "") {
      const now = performance.now();
      const stream = column.getStream(kind);
      if (!stream.segment || now - stream.lastDeltaAt > SEGMENT_GAP_MS) {
        stream.segment = document.createElement("p");
        stream.segment.className = kind ? `segment ${kind}` : "segment";
        stream.segment.dataset.ts = String(Date.now());
        stream.segment.dataset.kind = kind || column.defaultKind;
        element.append(stream.segment);
        for (const frames of stream.pendingAudio.splice(0)) {
          attachSegmentAudio(stream.segment, frames);
        }
      }
      appendSegmentText(stream.segment, text);
      if (stream.segment.dataset.kind === "translated") {
        assessEcho(stream.segment);
      }
      stream.lastDeltaAt = now;
      if (column.pinnedToBottom) {
        element.scrollTop = element.scrollHeight;
      }
    },
    // Audio deltas have no response id linking them to a transcript, but they
    // arrive nearly in step with the matching text deltas, so "the open
    // segment of this column's stream" is the right home; early frames wait
    // in pendingAudio until the segment opens.
    // Returns the segment the frame was attached to, or null while the frame
    // is waiting for its segment to open.
    bufferAudio(kind, floats, autoSpoken = false) {
      const now = performance.now();
      const stream = column.getStream(kind);
      if (stream.segment && now - stream.lastDeltaAt <= SEGMENT_GAP_MS) {
        for (const frames of stream.pendingAudio.splice(0)) {
          attachSegmentAudio(stream.segment, frames);
        }
        attachSegmentAudio(stream.segment, floats);
        if (autoSpoken) {
          markSpoken(stream.segment);
        }
        return stream.segment;
      }
      stream.pendingAudio.push(floats);
      if (stream.pendingAudio.length > PENDING_AUDIO_FRAME_LIMIT) {
        stream.pendingAudio.shift();
      }
      return null;
    },
    clear() {
      element.textContent = "";
      column.streams.clear();
      column.pinnedToBottom = true;
    },
    // Force the next delta into a fresh segment (used across Stop -> Start so
    // new speech never extends a paragraph from the previous run).
    closeSegments() {
      for (const stream of column.streams.values()) {
        stream.segment = null;
        stream.pendingAudio.length = 0;
      }
    },
    scrollToBottom() {
      column.pinnedToBottom = true;
      element.scrollTop = element.scrollHeight;
    },
    // Attach (or relocate) an externally managed segment element.
    adopt(el) {
      element.append(el);
      if (column.pinnedToBottom) {
        element.scrollTop = element.scrollHeight;
      }
    },
    setHeader(titleText, badgeText, muteVisible) {
      title.textContent = titleText;
      badge.textContent = badgeText;
      muteButton.hidden = !muteVisible;
    },
    setMuted(value) {
      if (column.session) {
        column.session.muted = value;
      }
      muteButton.textContent = value ? "🔇" : "🔊";
      muteButton.classList.toggle("muted", value);
    },
    unspokenSegments() {
      return [...element.querySelectorAll(".segment")].filter(
        (el) => segmentAudio.has(el) && !el.dataset.spoken && !el.dataset.echo,
      );
    },
    updateSpeakAll() {
      // While this column's queue is playing, the button is a stop control.
      if (manualPlayback?.button === speakAllButton) {
        return;
      }
      const count = column.unspokenSegments().length;
      speakAllButton.hidden = count === 0;
      speakAllButton.textContent = count > 1 ? `▶ Speak ${count}` : "▶ Speak";
    },
    // Play every not-yet-spoken segment in order as one take, highlighting
    // each segment while its slice is being read.
    speakQueue() {
      const segments = column.unspokenSegments();
      if (segments.length === 0) {
        return false;
      }
      const frameSets = segments.map((el) => segmentAudio.get(el));
      for (const el of segments) {
        markSpoken(el);
      }
      const highlightTimers = [];
      let offsetSeconds = 0;
      segments.forEach((el, i) => {
        const duration =
          frameSets[i].reduce((total, f) => total + f.length, 0) /
          TRANSLATED_SAMPLE_RATE;
        highlightTimers.push(
          setTimeout(() => {
            for (const other of segments) {
              other.classList.remove("speaking");
            }
            el.classList.add("speaking");
          }, offsetSeconds * 1000),
        );
        offsetSeconds += duration;
      });
      playFrames(frameSets.flat(), speakAllButton, "⏹ Stop", () => {
        for (const timer of highlightTimers) {
          clearTimeout(timer);
        }
        for (const el of segments) {
          el.classList.remove("speaking");
        }
        updateAllSpeakButtons();
      });
      return true;
    },
  };

  element.addEventListener("scroll", () => {
    column.pinnedToBottom =
      element.scrollTop + element.clientHeight >= element.scrollHeight - 24;
  });

  muteButton.addEventListener("click", () => {
    if (!column.session) {
      return;
    }
    column.setMuted(!column.session.muted);
  });

  speakAllButton.addEventListener("click", () => {
    if (manualPlayback?.button === speakAllButton) {
      stopManualPlayback();
      return;
    }
    column.speakQueue();
  });

  return column;
}

function clearTranscripts() {
  stopManualPlayback();
  segmentAudio.clear();
  segmentAudioOrder.length = 0;
  for (const column of Object.values(columns)) {
    column.clear();
  }
  updateAllSpeakButtons();
}

// ----- transcript export -----

function collectTranscriptRows() {
  const rows = [];
  for (const column of Object.values(columns)) {
    const label = column.badgeLabel();
    for (const el of column.element.querySelectorAll(".segment")) {
      if (el.classList.contains("divider")) {
        continue;
      }
      const text = (
        el.firstChild instanceof Text ? el.firstChild.data : el.textContent
      ).trim();
      if (!text) {
        continue;
      }
      const ts = Number(el.dataset.ts ?? 0);
      rows.push({
        ts,
        time: ts ? new Date(ts).toTimeString().slice(0, 8) : "",
        column: label,
        kind: el.dataset.echo ? "echo" : (el.dataset.kind ?? "original"),
        text,
      });
    }
  }
  // Chronological across both columns; the DOM only orders within a column.
  rows.sort((a, b) => a.ts - b.ts);
  return rows;
}

function exportTranscript() {
  const rows = collectTranscriptRows();
  if (rows.length === 0) {
    logEvent("export", "transcript is empty");
    return;
  }
  const stamp = transcriptFileStamp(new Date());
  downloadFile(
    `transcript-${stamp}.csv`,
    buildTranscriptCsv(rows),
    "text/csv;charset=utf-8",
  );
  logEvent("export", `${rows.length} segments -> transcript-${stamp}.csv`);
}

function downloadFile(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function createEmptyDiagnostics() {
  return {
    connectionState: "new",
    sessionState: "none",
    lastEventType: "none",
    peakInputLevel: 0,
    chunksSent: 0,
    outputAudioDeltas: 0,
    voicedAudioDeltas: 0,
    transcriptDeltas: 0,
  };
}

function resetDiagnostics() {
  diagnostics = createEmptyDiagnostics();
  captureState.textContent = "Starting";
  eventLog.textContent = "";
  updateDiagnostics();
}

function updateDiagnostics() {
  connectionState.textContent = diagnostics.connectionState;
  sessionState.textContent = diagnostics.sessionState;
  peakInputLevel.textContent = diagnostics.peakInputLevel.toFixed(3);
  outputAudioDeltas.textContent = `${diagnostics.voicedAudioDeltas} voiced / ${diagnostics.outputAudioDeltas}`;
  transcriptDeltas.textContent = String(diagnostics.transcriptDeltas);
  lastEventType.textContent = diagnostics.lastEventType;
}

function logEvent(type, detail) {
  const entry = document.createElement("div");
  entry.className = "log-entry";
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${type}: ${detail}`;
  eventLog.append(entry);
  eventLog.scrollTop = eventLog.scrollHeight;
}

// Debug handle for scripted verification (chrome-devtools MCP); the audio
// path cannot be asserted through the DOM alone.
window.__rt = { sessions: () => sessions, columns: () => columns };
