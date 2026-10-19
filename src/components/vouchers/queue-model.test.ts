import { describe, expect, test } from "vitest";
import {
  complete,
  createQueue,
  currentId,
  doneCount,
  isFinished,
  next,
  parseQueueIds,
  prev,
  progressLabel,
  queueHref,
  queueKeyAction,
  skip,
} from "./queue-model";

describe("VOU-100 batch queue (F06 §3.9)", () => {
  test("VOU-100 progress „3 von 17“, j/k navigation and „Buchen und weiter“", () => {
    const ids = Array.from({ length: 17 }, (_, i) => `v${i + 1}`);
    let q = createQueue([...ids, "v1"]);
    expect(q.ids).toHaveLength(17);
    expect(progressLabel(q)).toBe("1 von 17");
    q = next(next(q));
    expect(currentId(q)).toBe("v3");
    expect(progressLabel(q)).toBe("3 von 17");
    q = prev(q);
    expect(currentId(q)).toBe("v2");
    q = complete(q, "v2");
    expect(currentId(q)).toBe("v3");
    expect(doneCount(q)).toBe(1);
    // A completed voucher is never shown again, also not when navigating back.
    q = prev(q);
    expect(currentId(q)).toBe("v1");
    q = prev(q);
    expect(currentId(q)).toBe("v17");
  });

  test("VOU-100 skipped vouchers come back after the others; the queue finishes when all are done", () => {
    let q = createQueue(["a", "b", "c"]);
    q = skip(q);
    expect(currentId(q)).toBe("b");
    expect(q.skipped).toEqual(["a"]);
    q = complete(q, "b");
    q = complete(q, "c");
    expect(currentId(q)).toBe("a");
    expect(isFinished(q)).toBe(false);
    q = complete(q, "a");
    expect(isFinished(q)).toBe(true);
    expect(q.skipped).toEqual([]);
    expect(complete(q, "a")).toBe(q);
  });

  test("VOU-100 keyboard: ⌘/Strg+Enter always, letters only outside fields", () => {
    expect(queueKeyAction({ key: "Enter", metaKey: true, inField: true })).toBe("book_next");
    expect(queueKeyAction({ key: "Enter", ctrlKey: true })).toBe("book_next");
    expect(queueKeyAction({ key: "Enter" })).toBeNull();
    expect(queueKeyAction({ key: "s" })).toBe("skip");
    expect(queueKeyAction({ key: "j" })).toBe("next");
    expect(queueKeyAction({ key: "k" })).toBe("prev");
    expect(queueKeyAction({ key: "d" })).toBe("duplicate");
    expect(queueKeyAction({ key: "r" })).toBe("reject");
    expect(queueKeyAction({ key: "s", inField: true })).toBeNull();
    expect(queueKeyAction({ key: "s", metaKey: true })).toBeNull();
  });

  test("VOU-100 the selection travels in the URL", () => {
    const href = queueHref(["k57abc", "k57def"]);
    expect(href).toBe("/belege/warteschlange?ids=k57abc,k57def");
    expect(parseQueueIds("k57abc,k57def, bad-id ,")).toEqual(["k57abc", "k57def"]);
    expect(parseQueueIds(null)).toEqual([]);
    expect(progressLabel(createQueue([]))).toBe("0 von 0");
  });
});
