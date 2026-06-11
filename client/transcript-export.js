// Transcript export builders. Rows are plain objects:
//   { time: "HH:MM:SS", column: "en", kind: "original" | "translated", text }
// kept pure so they can be unit-tested in Node.

export function csvField(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

// UTF-8 BOM so Excel opens Japanese text correctly.
export function buildTranscriptCsv(rows) {
  const lines = ["time,column,kind,text"];
  for (const row of rows) {
    lines.push(
      [row.time, row.column, row.kind, row.text].map(csvField).join(","),
    );
  }
  return "\ufeff" + lines.join("\r\n") + "\r\n";
}

export function transcriptFileStamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}
