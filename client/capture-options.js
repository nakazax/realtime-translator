export const CAPTURE_MODES = ["tab", "screen", "mic"];

export function buildDisplayMediaOptions(supportedConstraints = {}, mode = "tab") {
  const audio = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };

  if (supportedConstraints.suppressLocalAudioPlayback) {
    audio.suppressLocalAudioPlayback = true;
  }

  return {
    preferCurrentTab: false,
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
    systemAudio: "include",
    video: {
      displaySurface: mode === "screen" ? "monitor" : "browser",
    },
    audio,
  };
}

export function buildUserMediaOptions() {
  return {
    audio: {
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: false,
    },
  };
}
