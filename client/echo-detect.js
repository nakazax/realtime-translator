// Same-language echo detection. Azure's translation sessions re-speak input
// that is already in their target language (en->en, ja->ja) instead of
// staying silent, so a translated segment that is nearly contained in a
// recent original segment is an echo, not a translation. Character-bigram
// containment works for both spaced (English) and unspaced (Japanese) text.
// An echo is always in the script of its original, so a Japanese translation
// that keeps English product names ("Databricks の Unity Catalog") is never
// one, however many letters it shares with the English original.

export const ECHO_SIMILARITY = 0.66;
export const ECHO_MIN_CHARS = 12;

// Kana and CJK ideographs: the same split the bidirectional router uses.
const JAPANESE_CHARS = /[\u3040-\u30ff\u4e00-\u9fff]/u;

export function sameScript(a, b) {
  return JAPANESE_CHARS.test(a) === JAPANESE_CHARS.test(b);
}

// Strip whitespace and punctuation only; keep every letter including the
// katakana long-vowel mark, which carries meaning.
export function normalizeForEcho(text) {
  return String(text)
    .toLowerCase()
    .replaceAll(/[\s。、．，,.!?！？:：;；"'“”‘’()（）[\]【】…・「」『』]/gu, "");
}

function bigrams(text) {
  const set = new Set();
  for (let i = 0; i < text.length - 1; i += 1) {
    set.add(text.slice(i, i + 2));
  }
  return set;
}

// How much of `candidate` is contained in `reference`, in [0, 1].
export function bigramContainment(candidate, reference) {
  const candidateGrams = bigrams(candidate);
  if (candidateGrams.size === 0) {
    return 0;
  }
  const referenceGrams = bigrams(reference);
  let hits = 0;
  for (const gram of candidateGrams) {
    if (referenceGrams.has(gram)) {
      hits += 1;
    }
  }
  return hits / candidateGrams.size;
}

export function isEchoOf(translatedText, originalText) {
  if (!sameScript(translatedText, originalText)) {
    return false;
  }
  const candidate = normalizeForEcho(translatedText);
  const reference = normalizeForEcho(originalText);
  if (candidate.length < ECHO_MIN_CHARS || reference.length < ECHO_MIN_CHARS) {
    return false;
  }
  return bigramContainment(candidate, reference) >= ECHO_SIMILARITY;
}

// Re-check for a segment already marked as an echo while it keeps growing.
// It can trip on its first words and then turn into a real translation, so
// it stays hidden only while its whole text is contained in the same-script
// originals spoken around it. Comparing against all of them together keeps a
// true echo hidden even when it spans several original segments.
export function isStillEchoOf(translatedText, originalTexts) {
  const reference = originalTexts.filter((text) => sameScript(translatedText, text)).join(" ");
  return isEchoOf(translatedText, reference);
}
