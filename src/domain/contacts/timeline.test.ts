import { describe, expect, test } from "vitest";
import { filterTimeline, type TimelineEntryLike } from "./timeline";

const at = (iso: string) => Date.parse(iso);
const entries: TimelineEntryLike[] = [
  { key: "n1", at: at("2026-10-01T08:00:00Z"), kind: "note", text: "Rückruf wegen Rahmenvertrag vereinbart" },
  { key: "c1", at: at("2026-09-15T12:00:00Z"), kind: "call", text: "Telefonat: Preisliste 2027" },
  { key: "t1", at: at("2026-10-10T09:00:00Z"), kind: "task", text: "Angebot nachfassen" },
  { key: "d1", at: at("2026-10-05T10:00:00Z"), kind: "derived", text: "Rechnung RE-2026-0001 fertiggestellt" },
  // 23:30 UTC on 31.10. is already 01.11. in Berlin (CET)
  { key: "n2", at: at("2026-10-31T23:30:00Z"), kind: "note", text: "Notiz zum RAHMENVERTRAG" },
];

describe("CON-124 timeline filter", () => {
  test("CON-124 filters by kind (manual kinds or automatic events)", () => {
    expect(filterTimeline(entries, { kind: "note" }).map((e) => e.key)).toEqual(["n1", "n2"]);
    expect(filterTimeline(entries, { kind: "derived" }).map((e) => e.key)).toEqual(["d1"]);
    expect(filterTimeline(entries, { kind: "all" })).toHaveLength(5);
  });

  test("CON-124 filters by period (inclusive Berlin calendar days)", () => {
    expect(filterTimeline(entries, { from: "2026-10-01", to: "2026-10-10" }).map((e) => e.key)).toEqual([
      "n1",
      "t1",
      "d1",
    ]);
    expect(filterTimeline(entries, { from: "2026-11-01" }).map((e) => e.key)).toEqual(["n2"]);
    expect(filterTimeline(entries, { to: "2026-09-30" }).map((e) => e.key)).toEqual(["c1"]);
  });

  test("CON-124 searches within the notes, case-insensitive, combined with the other filters", () => {
    expect(filterTimeline(entries, { query: "rahmenvertrag" }).map((e) => e.key)).toEqual(["n1", "n2"]);
    expect(filterTimeline(entries, { query: "  rahmenvertrag ", to: "2026-10-31" }).map((e) => e.key)).toEqual(["n1"]);
    expect(filterTimeline(entries, { query: "preisliste", kind: "note" })).toEqual([]);
    expect(filterTimeline(entries, { query: "" })).toHaveLength(5);
  });
});
