// Same-language echo detection. Azure's translation sessions re-speak input
// that is already in their target language (en->en, ja->ja) instead of
// staying silent, so a translated segment that is nearly contained in a
// recent original segment is an echo, not a translation. Character-bigram
// containment works for both spaced (English) and unspaced (Japanese) text.

export const ECHO_SIMILARITY = 0.66;
export const ECHO_MIN_CHARS = 12;

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
  const candidate = normalizeForEcho(translatedText);
  const reference = normalizeForEcho(originalText);
  if (candidate.length < ECHO_MIN_CHARS || reference.length < ECHO_MIN_CHARS) {
    return false;
  }
  return bigramContainment(candidate, reference) >= ECHO_SIMILARITY;
}
