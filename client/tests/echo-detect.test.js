import assert from "node:assert/strict";
import test from "node:test";

import { isEchoOf, normalizeForEcho } from "../echo-detect.js";

test("verbatim English re-speak is an echo", () => {
  assert.ok(
    isEchoOf(
      "The quick brown fox jumps over the lazy dog.",
      " The quick brown fox jumps over the lazy dog. Artificial intelligence is transforming translation.",
    ),
  );
});

test("lightly paraphrased echo with casing/punctuation noise still matches", () => {
  assert.ok(
    isEchoOf(
      "the quick brown foxjumps over the lazy dog",
      "The quick brown fox jumps over the lazy dog.",
    ),
  );
});

test("Japanese ja->ja re-speak is an echo", () => {
  assert.ok(
    isEchoOf(
      "本社のデータ基盤について質問があります。",
      "本社のデータ基盤について質問があります。リアルタイム翻訳の精度はどのくらいですか?",
    ),
  );
});

test("a genuine translation of different content is not an echo", () => {
  assert.ok(
    !isEchoOf(
      "I have a question about your data platform.",
      "The quick brown fox jumps over the lazy dog and keeps on running.",
    ),
  );
  assert.ok(
    !isEchoOf(
      "御社のデータ基盤について質問があります。",
      "リアルタイム翻訳の精度は高いほど現場で使いやすくなりますよね。",
    ),
  );
});

test("short fragments never match (guards streaming prefixes)", () => {
  assert.ok(!isEchoOf("The quick", "The quick brown fox jumps over the lazy dog."));
});

test("normalize keeps the katakana long-vowel mark", () => {
  assert.equal(normalizeForEcho("データ、ベース!"), "データベース");
});
