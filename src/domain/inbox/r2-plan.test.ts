import { describe, expect, test } from "vitest";
import { invalidAllowlistEntries, parseAllowlist, senderAllowed } from "./allowlist";
import { INBOX_POLL, isInboxObjectKey, planPoll, pollHealth } from "./r2-plan";

const NOW = Date.UTC(2026, 9, 19, 10, 0, 0);
const obj = (key: string, minutesAgo: number) => ({ key, lastModified: NOW - minutesAgo * 60_000, size: 100 });

describe("INB-049 poll planning", () => {
  test("INB-049 T06-155 a run with 120 objects processes the 50 oldest first", () => {
    const objects = Array.from({ length: 120 }, (_, i) => obj(`inbox/${NOW - i}-u${i}.eml`, i));
    const plan = planPoll(objects, NOW);
    expect(plan.batch).toHaveLength(INBOX_POLL.batch);
    expect(plan.batch[0]?.key).toBe(`inbox/${NOW - 119}-u119.eml`);
    expect(plan.batch.map((o) => o.lastModified)).toEqual(
      [...plan.batch.map((o) => o.lastModified)].sort((a, b) => a - b),
    );
    expect(plan.batch.at(-1)?.key).toBe(`inbox/${NOW - 70}-u70.eml`);
  });

  test("INB-052 EC-INB-32 T06-159 objects outside inbox/ or without .eml are ignored, never in the batch", () => {
    const plan = planPoll(
      [obj("other/readme.txt", 5), obj("inbox/notes.txt", 5), obj("inbox/.eml", 5), obj("inbox/1-a.eml", 1)],
      NOW,
    );
    expect(plan.batch.map((o) => o.key)).toEqual(["inbox/1-a.eml"]);
    expect(plan.ignored).toEqual(["other/readme.txt", "inbox/notes.txt", "inbox/.eml"]);
    expect(isInboxObjectKey("inbox/1729-uuid.EML")).toBe(true);
  });

  test("INB-052 EC-INB-28 objects still present 60 min after LastModified are stale", () => {
    const plan = planPoll([obj("inbox/a.eml", 61), obj("inbox/b.eml", 90), obj("inbox/c.eml", 59)], NOW);
    expect(plan.staleCount).toBe(2);
    expect(plan.oldestStaleAt).toBe(NOW - 90 * 60_000);
    expect(planPoll([obj("inbox/c.eml", 10)], NOW)).not.toHaveProperty("oldestStaleAt");
  });

  test("INB-052 EC-INB-28/29 health: 401/403 pauses; the third consecutive failure alerts once; success resets", () => {
    expect(pollHealth({ consecutiveFailures: 0 }, "unauthorized")).toEqual({
      consecutiveFailures: 1,
      pause: true,
      alert: "unauthorized",
    });
    let h = { consecutiveFailures: 0 };
    const alerts: (string | null)[] = [];
    for (let i = 0; i < 4; i++) {
      const next = pollHealth(h, "failed");
      alerts.push(next.alert);
      expect(next.pause).toBe(false);
      h = next;
    }
    expect(alerts).toEqual([null, null, "failed_runs", null]);
    expect(pollHealth(h, "ok")).toEqual({ consecutiveFailures: 0, pause: false, alert: null });
  });
});

describe("INB-051 sender allowlist", () => {
  test("INB-051 EC-INB-06 T06-009 addresses and @domain entries; empty list allows everyone", () => {
    const list = parseAllowlist("Rechnung@Telekom.de\n@aws.amazon.com, kaputt@, rechnung@telekom.de; @x");
    expect(list).toEqual(["rechnung@telekom.de", "@aws.amazon.com"]);
    expect(invalidAllowlistEntries("ok@a.de, kaputt@\n@x")).toEqual(["kaputt@", "@x"]);
    expect(senderAllowed("rechnung@telekom.de", list)).toBe(true);
    expect(senderAllowed("billing@aws.amazon.com", list)).toBe(true);
    expect(senderAllowed("billing@evil-aws.amazon.com.example", list)).toBe(false);
    expect(senderAllowed("someone@telekom.de", list)).toBe(false);
    expect(senderAllowed(undefined, list)).toBe(false);
    expect(senderAllowed("anyone@anywhere.de", [])).toBe(true);
  });
});
