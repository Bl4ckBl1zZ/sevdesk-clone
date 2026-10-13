import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildSnapshot } from "@/domain/documents/build-snapshot";
import { cancellationSnapshotInput } from "@/domain/documents/corrections";
import { canonicalSnapshotJson } from "@/domain/documents/snapshot";
import { makeSnapshot } from "../factories/snapshot";

/**
 * The Storno flow builds its snapshot from the original's snapshot (F04 INV-10); this pins it to the golden G-17
 * (storno-full) so the Convex flow and the golden suite cannot drift apart.
 */
describe("Storno mirror vs golden storno-full", () => {
  test("UST-30 RI-06 T-INV-009 the mirror of T-GLD-01 equals golden storno-full (decision per ER-03 rule R1)", () => {
    const original = makeSnapshot();
    const input = cancellationSnapshotInput(original, {
      number: "RE-2026-0047",
      documentDate: "2026-10-20",
      layoutVersionId: "layout-v1",
    });
    const r = buildSnapshot(input);
    if (!r.ok) throw new Error(r.error.message);
    const golden = JSON.parse(
      readFileSync(join(import.meta.dirname, "cases/storno-full/expected.snapshot.json"), "utf8"),
    );
    // EC-DOC-88: a Storno of an E-Rechnung is MUST_E (R1); the golden input predates the R1 wiring.
    expect(r.value.einvoice).toEqual({ format: "zugferd_en16931", decision: "MUST_E" });
    expect({ ...JSON.parse(canonicalSnapshotJson(r.value)), einvoice: golden.einvoice }).toEqual(golden);
    for (const [i, grp] of original.totals.byGroup.entries()) {
      expect(r.value.totals.byGroup[i]?.baseCents).toBe(-grp.baseCents);
      expect(r.value.totals.byGroup[i]?.vatCents).toBe(-grp.vatCents);
    }
  });
});
