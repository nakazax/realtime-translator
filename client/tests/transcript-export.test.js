import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTranscriptCsv,
  csvField,
  transcriptFileStamp,
} from "../transcript-export.js";

const rows = [
  { time: "09:00:01", column: "en", kind: "original", text: "Hello, \"world\"" },
  { time: "09:00:03", column: "ja", kind: "translated", text: "こんにちは、世界\n改行あり" },
];

test("CSV starts with a UTF-8 BOM and quotes every field", () => {
  const csv = buildTranscriptCsv(rows);
  assert.ok(csv.startsWith("\ufeff"));
  const lines = csv.slice(1).split("\r\n");
  assert.equal(lines[0], "time,column,kind,text");
  assert.equal(lines[1], '"09:00:01","en","original","Hello, ""world"""');
  assert.ok(lines[2].startsWith('"09:00:03","ja","translated","こんにちは、世界'));
});

test("csvField doubles embedded quotes", () => {
  assert.equal(csvField('a "b" c'), '"a ""b"" c"');
});

test("transcriptFileStamp formats as YYYYMMDD-HHMMSS", () => {
  const stamp = transcriptFileStamp(new Date(2026, 5, 11, 9, 5, 7));
  assert.equal(stamp, "20260611-090507");
});
