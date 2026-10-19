import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { createValues, orgForm, PARIS } from "./catalog.fixtures";
import { invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import { recordCheck } from "./model/vatChecks";
import { makeT } from "./test.setup";

const NOW = new Date("2026-10-12T10:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("INV-28 VAT-ID check override and follow-up", { timeout: 30_000 }, () => {
  test("INV-28 EC-044 T-EC-029 a K invoice finalised with an override opens a follow-up that a qualified check closes", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const fr = await owner.mutation(api.contacts.create, {
      values: createValues(orgForm("Société Exemple SARL", { vatId: "FR40303265045" }), {
        address: { ...PARIS },
        email: "factures@exemple.fr",
      }),
    });
    const contactId = fr.id as Id<"contacts">;
    const base = invoiceValues(fr.id);
    const { id } = await owner.mutation(api.invoices.createDraft, {
      values: {
        ...base,
        lines: base.lines.map((l) => (l.kind === "item" ? { ...l, productType: "good" as const, unitCode: "H87" } : l)),
        taxCaseOverride: { taxCase: "intra_community_supply" as const, reason: "Lieferung nach Frankreich" },
        deliveryAddress: { name: "Société Exemple SARL", ...PARIS },
      },
    });
    // Without a reason the unverified VAT ID blocks.
    const blocked = await owner.action(api.invoices.finalize, { id, version: 1 }).catch((x: unknown) => x);
    const codes = (
      ((blocked as { data?: { findings?: { code: string }[] } }).data?.findings ?? []) as {
        code: string;
      }[]
    ).map((f) => f.code);
    expect(codes).toContain("buyer_vat_id_not_verified");

    const r = await owner.action(api.invoices.finalize, {
      id,
      version: 1,
      overrides: { vatCheck: { reason: "BZSt-Schnittstelle nicht erreichbar, Prüfung wird nachgeholt" } },
    });
    await settle(t);
    const todos = await owner.query(api.invoices.todos, {});
    const followUp = todos.find((n) => n.kind === "vat_check_followup");
    expect(followUp?.title).toBe(`USt-IdNr. FR40303265045 nachträglich prüfen (${r.number})`);
    expect(followUp?.link).toBe(`/kontakte/${contactId}`);
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(
      audit.some((a) => a.action === "document.finalize" && a.reason?.includes("BZSt-Schnittstelle nicht erreichbar")),
    ).toBe(true);

    const actor = { actor: owner.actor, role: "owner", channel: "ui" } as const;
    const check = (qualified: boolean) =>
      t.model(actor, (ctx) =>
        recordCheck(ctx, contactId, "FR40303265045", {
          provider: qualified ? "bzst_evatr" : "eu_vies",
          request: {},
          response: {},
          status: "valid",
          ...(qualified ? { qualified: { name: "A", street: "A", postalCode: "A", city: "A" } } : {}),
          message: "gültig",
          fingerprint: qualified ? "q" : "s",
        }),
      );
    // A simple (VIES) confirmation is not enough for an intra-Community supply …
    await check(false);
    expect((await owner.query(api.invoices.todos, {})).some((n) => n.kind === "vat_check_followup")).toBe(true);
    // … the qualified eVatR confirmation closes the follow-up.
    await check(true);
    expect((await owner.query(api.invoices.todos, {})).some((n) => n.kind === "vat_check_followup")).toBe(false);
  });
});
