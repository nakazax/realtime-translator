// Capture-mode availability from feature detection (no UA sniffing).
// iOS Safari has no getDisplayMedia, so tab/screen capture is desktop-only.

export function captureModeAvailability({ hasGetUserMedia, hasGetDisplayMedia }) {
  const availability = {
    mic: Boolean(hasGetUserMedia),
    tab: Boolean(hasGetDisplayMedia),
    screen: Boolean(hasGetDisplayMedia),
    displayCaptureNote: null,
  };
  if (!availability.tab) {
    availability.displayCaptureNote =
      "この端末ではマイクのみ利用可能です (タブ/画面の音声キャプチャ非対応のブラウザ)。" +
      "Web会議の音声はスピーカーから出してマイクで拾ってください。 / " +
      "Only microphone capture is available on this device.";
  }
  return availability;
}

// Falls back to mic when the selected mode is unavailable, so a stored or
// default selection never points at a capture path the browser cannot run.
export function resolveCaptureMode(currentMode, availability) {
  if (availability[currentMode]) {
    return currentMode;
  }
  return "mic";
}
