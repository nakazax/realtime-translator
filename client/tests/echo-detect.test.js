import assert from "node:assert/strict";
import test from "node:test";

import { isEchoOf, isStillEchoOf, normalizeForEcho } from "../echo-detect.js";

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

const ENGLISH_PRODUCT_TALK =
  "Databricks Unity Catalog and Lakeflow Connect make governance simple for every team.";

test("a Japanese translation that starts with English product names is not an echo", () => {
  // Bigram overlap alone is 0.90 here; the script differs, so it is a translation.
  assert.ok(!isEchoOf("Databricks の Unity Catalog", ENGLISH_PRODUCT_TALK));
  assert.ok(
    !isEchoOf("Unity Catalog is the foundation", "Unity Catalogはガバナンスの基盤です。"),
  );
});

test("a segment that tripped on a Latin-only prefix is released once Japanese arrives", () => {
  // Before any kana arrives the prefix still looks like an English echo...
  assert.ok(isEchoOf("Databricks Unity Catalog", ENGLISH_PRODUCT_TALK));
  // ...and the re-check releases it as the translation grows.
  assert.ok(
    !isStillEchoOf("Databricks Unity Catalog と Lakeflow Connect によって", [
      ENGLISH_PRODUCT_TALK,
    ]),
  );
});

test("a true echo spanning several originals stays an echo", () => {
  assert.ok(
    isStillEchoOf("本社のデータ基盤について質問があります。リアルタイム翻訳の精度はどうですか", [
      "本社のデータ基盤について質問があります。",
      "リアルタイム翻訳の精度はどうですか?",
    ]),
  );
});

test("the re-check ignores originals in the other script", () => {
  // Bidirectional mode: an English echo must stay hidden even when Japanese
  // utterances sit in the same window.
  assert.ok(
    isStillEchoOf("The quick brown fox jumps over the lazy dog.", [
      "本社のデータ基盤について質問があります。",
      "The quick brown fox jumps over the lazy dog.",
    ]),
  );
});
