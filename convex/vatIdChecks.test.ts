import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { BERLIN, createValues, orgForm, PARIS, setupCatalog } from "./catalog.fixtures";
import { errorCode } from "./lib/errors";
import { EVATR_DEFAULT_BASE, VIES_DEFAULT_BASE } from "./lib/vatProviders";
import { patchCompanyProfile } from "./model/companyProfile";
import { makeT, type TestT } from "./test.setup";

/**
 * VAT-ID checks against mocked providers (F02 T-CON-034…038). MSW intercepts the action's outbound fetch; each
 * test records the request bodies to assert what was sent.
 */
const requests: { provider: "evatr" | "vies"; body: Record<string, unknown> }[] = [];
let evatrReply: () => Response = () => HttpResponse.json(EVATR_QUALIFIED);
let viesReply: () => Response = () => HttpResponse.json(VIES_VALID);

const EVATR_QUALIFIED = {
  id: "evatr-req-1",
  anfrageZeitpunkt: "2026-10-12T10:00:00Z",
  status: "evatr-0000",
  ergFirmenname: "A",
  ergStrasse: "A",
  ergPlz: "A",
  ergOrt: "A",
};
const VIES_VALID = { valid: true, requestIdentifier: "WAPIAAAAZ1", name: "ACME", address: "" };

const server = setupServer(
  http.post(`${EVATR_DEFAULT_BASE}/app/v1/abfrage`, async ({ request }) => {
    requests.push({ provider: "evatr", body: (await request.json()) as Record<string, unknown> });
    return evatrReply();
  }),
  http.post(`${VIES_DEFAULT_BASE}/check-vat-number`, async ({ request }) => {
    requests.push({ provider: "vies", body: (await request.json()) as Record<string, unknown> });
    return viesReply();
  }),
);

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
  server.resetHandlers();
  requests.length = 0;
  evatrReply = () => HttpResponse.json(EVATR_QUALIFIED);
  viesReply = () => HttpResponse.json(VIES_VALID);
});
afterAll(() => server.close());

const reasonOf = (e: unknown) => (e as { data?: { reason?: string } }).data?.reason;

async function setup(t: TestT, ownVatId: string | null = "DE123456788") {
  const owner = await setupCatalog(t);
  if (ownVatId) {
    await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) =>
      patchCompanyProfile(ctx, { vatId: ownVatId }, { action: "settings.company.update" }),
    );
  }
  return owner;
}

async function french(owner: Awaited<ReturnType<typeof setup>>) {
  return owner.mutation(api.contacts.create, {
    values: createValues(orgForm("Dupont SA", { vatId: "FR40303265045" }), { address: PARIS }),
  });
}

describe("CON-051…058 VAT-ID check", () => {
  test("T-CON-034 CON-051 CON-054 eVatR gets our ID, the foreign ID and the billing address; A/A/A/A → qualified", async () => {
    const t = makeT();
    const owner = await setup(t);
    const c = await french(owner);
    const r = await owner.action(api.vatIdChecks.check, { contactId: c.id });
    expect(r).toMatchObject({ status: "valid", reused: false, warning: null });
    expect(requests).toEqual([
      {
        provider: "evatr",
        body: {
          anfragendeUstid: "DE123456788",
          angefragteUstid: "FR40303265045",
          firmenname: "Dupont SA",
          ort: "Paris",
          plz: "75001",
          strasse: "1 Rue de Rivoli",
        },
      },
    ]);
    const detail = await owner.query(api.contacts.get, { id: c.id });
    expect(detail?.contact.vatIdStatus).toMatchObject({ status: "valid", qualified: true, lastCheckId: r.checkId });
    expect(detail?.vatBadge.kind).toBe("qualified");
  });

  test("T-CON-036 CON-053 the evidence row is immutable and kept until the end of the year + 10", async () => {
    const t = makeT();
    const owner = await setup(t);
    const c = await french(owner);
    const r = await owner.action(api.vatIdChecks.check, { contactId: c.id });
    const [row] = await owner.query(api.vatIdChecks.list, { contactId: c.id });
    expect(row?.retentionUntil).toMatch(/^20\d\d-12-31$/);
    expect(Number(row?.retentionUntil.slice(0, 4))).toBe(new Date(row?.checkedAt ?? 0).getUTCFullYear() + 10);
    expect(row?.providerRequestId).toBe("evatr-req-1");
    expect(row?.request).toMatchObject({ angefragteUstid: "FR40303265045" });
    const patch = await t
      .model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) =>
        ctx.db.patch("vatIdChecks", r.checkId as Id<"vatIdChecks">, { status: "invalid" }),
      )
      .catch((e: unknown) => errorCode(e));
    expect(patch).toBe("immutable_record");
    const del = await t
      .model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) => ctx.db.delete("vatIdChecks", r.checkId))
      .catch((e: unknown) => errorCode(e));
    expect(del).toBe("immutable_record");
  });

  test("T-CON-035 CON-052 a German ID is checked via VIES with requester fields; requestIdentifier is stored", async () => {
    const t = makeT();
    const owner = await setup(t);
    const c = await owner.mutation(api.contacts.create, {
      values: createValues(orgForm("Muster AG", { vatId: "DE136695976" }), { address: BERLIN }),
    });
    const r = await owner.action(api.vatIdChecks.check, { contactId: c.id });
    expect(requests.map((x) => x.provider)).toEqual(["vies"]);
    expect(requests[0]?.body).toMatchObject({
      countryCode: "DE",
      vatNumber: "136695976",
      requesterMemberStateCode: "DE",
      requesterNumber: "123456788",
      traderName: "Muster AG",
    });
    const [row] = await owner.query(api.vatIdChecks.list, { contactId: c.id });
    expect(row?.providerRequestId).toBe("WAPIAAAAZ1");
    expect(r.status).toBe("valid");
    // A simple check is never qualified (CON-054).
    expect((await owner.query(api.contacts.get, { id: c.id }))?.contact.vatIdStatus?.qualified).toBe(false);
  });

  test("T-CON-037 CON-058 an identical check within 24 h makes no external call; force does", async () => {
    const t = makeT();
    const owner = await setup(t);
    const c = await french(owner);
    const first = await owner.action(api.vatIdChecks.check, { contactId: c.id });
    const second = await owner.action(api.vatIdChecks.check, { contactId: c.id });
    expect(second).toMatchObject({ reused: true, checkId: first.checkId });
    expect(requests).toHaveLength(1);
    const forced = await owner.action(api.vatIdChecks.check, { contactId: c.id, force: true });
    expect(forced.reused).toBe(false);
    expect(requests).toHaveLength(2);
  });

  test("T-CON-038 CON-051 without an own USt-IdNr a foreign ID is checked via VIES with the warning", async () => {
    const t = makeT();
    const owner = await setup(t, null);
    const c = await french(owner);
    const r = await owner.action(api.vatIdChecks.check, { contactId: c.id });
    expect(requests.map((x) => x.provider)).toEqual(["vies"]);
    expect(r.warning).toBe(
      "Eine qualifizierte Bestätigung beim BZSt ist nur mit eigener USt-IdNr möglich; es wurde einfach über VIES geprüft.",
    );
  });

  test("CON-E07 eVatR unavailable → retried once via VIES; both attempts are stored as evidence", async () => {
    const t = makeT();
    const owner = await setup(t);
    const c = await french(owner);
    evatrReply = () => HttpResponse.json({ status: "evatr-0011" }, { status: 503 });
    viesReply = () => HttpResponse.json({ errorWrappers: [{ error: "MS_UNAVAILABLE" }] }, { status: 200 });
    const r = await owner.action(api.vatIdChecks.check, { contactId: c.id });
    expect(r.status).toBe("unavailable");
    expect(requests.map((x) => x.provider)).toEqual(["evatr", "vies"]);
    const rows = await owner.query(api.vatIdChecks.list, { contactId: c.id });
    expect(rows.map((x) => x.provider).sort()).toEqual(["bzst_evatr", "eu_vies"]);
    expect((await owner.query(api.contacts.get, { id: c.id }))?.vatBadge.kind).toBe("unavailable");
  });

  test("CON-060 changing the VAT ID resets the status; the old check stays as evidence", async () => {
    const t = makeT();
    const owner = await setup(t);
    const c = await french(owner);
    await owner.action(api.vatIdChecks.check, { contactId: c.id });
    const before = await owner.query(api.contacts.get, { id: c.id });
    const r = await owner.mutation(api.contacts.update, {
      id: c.id,
      version: before?.contact.version ?? 0,
      values: orgForm("Dupont SA", { vatId: "FR83404833048" }),
    });
    expect(r.vatIdChanged).toBe(true);
    const after = await owner.query(api.contacts.get, { id: c.id });
    expect(after?.contact.vatIdStatus).toBeUndefined();
    expect(after?.vatBadge.kind).toBe("unchecked");
    expect(after?.checks).toHaveLength(1);
  });

  test("CON-050 §4.2 step 1: a contact without VAT ID is refused without any external call", async () => {
    const t = makeT();
    const owner = await setup(t);
    const c = await owner.mutation(api.contacts.create, { values: createValues(orgForm("Ohne GmbH")) });
    expect(await owner.action(api.vatIdChecks.check, { contactId: c.id }).catch(reasonOf)).toBe("VAT_ID_MISSING");
    expect(requests).toHaveLength(0);
  });
});
