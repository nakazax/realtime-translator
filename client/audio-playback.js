// Scheduling headroom when playback has caught up with arrival. Azure delivers
// 200ms frames at real-time rate, so a fresh burst needs enough lead that the
// next frame lands before the previous one finishes despite network jitter.
export const PLAYBACK_LEAD_SECONDS = 0.35;

// Azure streams translated audio as a continuous dubbed track over the input
// timeline: mostly synthesized silence (observed peaks <= 63 int16) with
// speech bursts >= 1024. Frames below this peak are dropped before
// scheduling; otherwise every network stall permanently grows the playback
// delay by the stall length (the player never skips the backlog of silence).
export const SILENT_FRAME_PEAK = 64 / 0x8000;

export function base64ToFloat32(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const samples = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
  const floats = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    floats[i] = samples[i] / 0x8000;
  }
  return floats;
}

export function framePeak(floats) {
  let peak = 0;
  for (let i = 0; i < floats.length; i += 1) {
    const value = Math.abs(floats[i]);
    if (value > peak) {
      peak = value;
    }
  }
  return peak;
}

/**
 * Gapless-ish player for PCM16 mono frames (24kHz by default), as delivered
 * by `session.output_audio.delta`. Frames are scheduled back to back on a
 * running clock; a GainNode exposes the translated-audio volume for the mix
 * slider. Pass a shared AudioContext so every player created from a single
 * user gesture is allowed to play; the player then leaves closing it to the
 * owner.
 */
export class Pcm16Player {
  constructor({ sampleRate = 24000, context = null } = {}) {
    this.sampleRate = sampleRate;
    this.ownsContext = !context;
    this.context = context ?? new AudioContext();
    this.gain = this.context.createGain();
    this.gain.connect(this.context.destination);
    this.nextStartTime = 0;
  }

  set volume(value) {
    this.gain.gain.value = Math.min(1, Math.max(0, value));
  }

  get volume() {
    return this.gain.gain.value;
  }

  async resume() {
    if (this.context.state === "suspended") {
      await this.context.resume();
    }
  }

  enqueueFloats(floats) {
    if (floats.length === 0) {
      return;
    }
    const buffer = this.context.createBuffer(1, floats.length, this.sampleRate);
    buffer.copyToChannel(floats, 0);

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);

    const now = this.context.currentTime;
    if (this.nextStartTime < now + PLAYBACK_LEAD_SECONDS) {
      this.nextStartTime = now + PLAYBACK_LEAD_SECONDS;
    }
    source.start(this.nextStartTime);
    this.nextStartTime += buffer.duration;
  }

  enqueueBase64(base64) {
    this.enqueueFloats(base64ToFloat32(base64));
  }

  async close() {
    this.gain.disconnect();
    if (this.ownsContext && this.context.state !== "closed") {
      await this.context.close();
    }
  }
}
