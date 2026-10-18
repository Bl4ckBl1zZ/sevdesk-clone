import { seedRange } from "../../src/domain/numbering/format";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { defaultInvoiceAccount, saveDefaultInvoiceAccount } from "./bankAccounts";
import { getCompanyProfile, patchCompanyProfile } from "./companyProfile";
import { seedPaymentMethods, seedUnits } from "./lookups";
import { listDefaultRanges, saveRanges } from "./numberRanges";
import { seedCategories } from "./products";
import { seedTextTemplates } from "./textTemplates";
import type { ModelCtx } from "./types";

/**
 * Seeded settings data (F01 SET-086, SET-090, SET-092; F03 PRD-060 product categories) inserted when the setup is completed. Each seed is idempotent
 * and only fills gaps, so it can run again („Standardwerte wiederherstellen“) without touching owner changes.
 */
export async function seedSettingsDefaults(ctx: ModelCtx): Promise<void> {
  await seedTextTemplates(ctx);
  await seedUnits(ctx);
  await seedPaymentMethods(ctx);
  await seedCategories(ctx);
}

const TEST_RANGES = [
  { key: "contact", name: "Kontakte", format: "{#####}", resetPolicy: "never", next: 10000 },
  { key: "invoice", name: "Rechnungen", format: "RE-{YYYY}-{####}", resetPolicy: "yearly", next: 1 },
  { key: "correction", name: "Rechnungskorrekturen", format: "RK-{YYYY}-{####}", resetPolicy: "yearly", next: 1 },
] as const;

/**
 * Test deployments only (IS_TEST; `testFixtures.ensureInvoicingSetup` with the admin key): fills what an integration
 * test needs to issue invoices and Rechnungskorrekturen through the normal API — the seeded lookups, a completed
 * company profile (the golden GmbH seller of test/factories/snapshot.ts), the contact, invoice and correction number
 * ranges and a default EUR invoice account. Only gaps are filled; an existing setup (e.g. from the E2E journey) is
 * kept as it is. Returns what was added.
 */
export async function ensureInvoicingSetupForTest(ctx: ModelCtx): Promise<string[]> {
  const added: string[] = [];
  const today = berlinCalendarDate(ctx.now());
  await seedSettingsDefaults(ctx);
  if ((await getCompanyProfile(ctx))?.setupCompletedAt === undefined) {
    await patchCompanyProfile(
      ctx,
      {
        legalForm: "gmbh",
        name: "Muster Design GmbH",
        address: {
          name: "Muster Design GmbH",
          street: "Hauptstraße 1",
          postalCode: "10115",
          city: "Berlin",
          countryCode: "DE",
        },
        seat: "Berlin",
        contact: {
          name: "Erika Musterfrau",
          phone: "+49 30 1234567",
          email: "rechnung@muster-design.de",
          website: "www.muster-design.de",
        },
        register: { court: "Amtsgericht Charlottenburg", type: "HRB", number: "123456 B" },
        representatives: [{ name: "Max Mustermann" }, { name: "Erika Musterfrau" }],
        shareCapital: { amountCents: 2_500_000 },
        taxNumber: "1121081508150",
        taxNumberState: "BE",
        vatId: "DE123456788",
        electronicAddress: { scheme: "EM", value: "rechnung@muster-design.de" },
        kleinunternehmer: [{ validFrom: "2020-01-01", isKU: false }],
        taxationMethod: [{ validFrom: "2020-01-01", method: "soll" }],
        ustvaPeriod: [{ year: Number(today.slice(0, 4)), period: "monthly", dauerfrist: false }],
        chartOfAccounts: [{ validFromFiscalYear: 2020, chart: "SKR03" }],
        priorYearTotalTurnoverCents: [{ year: Number(today.slice(0, 4)) - 1, amountCents: 12_000_000 }],
        setupCompletedAt: ctx.now(),
      },
      { action: "settings.company.update" },
    );
    added.push("companyProfile");
  }
  const existing = await listDefaultRanges(ctx);
  const missing = TEST_RANGES.filter((r) => !existing.some((x) => x.docTypes[0] === seedRange(r.key)?.key));
  if (missing.length > 0) {
    await saveRanges(
      ctx,
      { ranges: missing.map((r) => ({ ...r })) },
      { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) },
    );
    added.push(...missing.map((r) => `range:${r.key}`));
  }
  if (!(await defaultInvoiceAccount(ctx))) {
    await saveDefaultInvoiceAccount(
      ctx,
      { iban: "DE89370400440532013000", bic: "COBADEFFXXX", accountHolder: "Muster Design GmbH", currency: "EUR" },
      "SKR03",
    );
    added.push("bankAccount");
  }
  return added;
}
