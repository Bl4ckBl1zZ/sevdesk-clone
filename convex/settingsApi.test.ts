import { describe, expect, test } from "vitest";
import { type CompanyValues, companyDefaults } from "../src/domain/schemas/settings";
import { api } from "./_generated/api";
import { errorCode } from "./lib/errors";
import { makeT } from "./test.setup";

const COMPANY: CompanyValues = {
  ...companyDefaults,
  legalForm: "gmbh",
  name: "Muster GmbH",
  street: "Hauptstraße 1",
  postalCode: "10115",
  city: "Berlin",
  seat: "Berlin",
  contactName: "Erika Musterfrau",
  phone: "+49 30 123456",
  email: "info@muster.de",
  registerCourt: "Amtsgericht Berlin-Charlottenburg",
  registerNumber: "12345 B",
  representatives: [{ name: "Max Mustermann" }],
};

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return errorCode(e);
  }
}

describe("settings reads via REST/MCP (05 §4.8, F01 §7.1)", () => {
  test("API-019 SET-021 a company:public key sees only the public subset; settings:read sees the profile", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    await owner.mutation(api.settings.saveCompanyProfile, { values: COMPANY });
    const website = await t.asApiKey(["company:public"]);
    const pub = await website.query(api.settingsApi.companyPublic, {});
    expect(pub).toMatchObject({ name: "Muster GmbH", representatives: ["Max Mustermann"] });
    expect(Object.keys(pub ?? {})).not.toContain("datev");
    expect(await codeOf(website.query(api.settingsApi.company, {}))).toBe("forbidden_scope");
    const reader = await t.asApiKey(["settings:read"]);
    const full = await reader.query(api.settingsApi.company, {});
    expect(full).toMatchObject({ name: "Muster GmbH", legalForm: "gmbh" });
    expect(Object.keys(full ?? {})).not.toContain("accessConcept");
    expect(Object.keys(full ?? {})).not.toContain("logoStorageId");
    expect((await reader.query(api.settingsApi.companyPublic, {}))?.name).toBe("Muster GmbH");
  });

  test("API-019 tax rates resolve on the given date from the rule tables", async () => {
    const t = makeT();
    const reader = await t.asApiKey(["settings:read"]);
    const rates = await reader.query(api.settingsApi.taxRates, { date: "2026-10-12" });
    expect(rates.find((r) => r.key === "standard")).toMatchObject({ rateBp: 1900, category: "S" });
    expect(rates.find((r) => r.key === "reduced")).toMatchObject({ rateBp: 700 });
    expect(await codeOf(reader.query(api.settingsApi.taxRates, { date: "12.10.2026" }))).toBe("invalid_input");
  });

  test("MCP-007 workspace_overview reports the company, tax status, counts and setup gaps for any read key", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    await owner.mutation(api.settings.saveCompanyProfile, { values: COMPANY });
    const key = await t.asMcp(["contacts:read"]);
    const o = await key.query(api.settingsApi.workspaceOverview, {});
    expect(o.company).toMatchObject({ name: "Muster GmbH", legalForm: "gmbh", kleinunternehmer: false });
    expect(o.counts).toEqual({ activeContacts: 0, activeProducts: 0 });
    expect(o.setup.blocking.length).toBeGreaterThan(0);
    const writer = await t.asMcp(["contacts:write"]);
    expect(await codeOf(writer.query(api.settingsApi.workspaceOverview, {}))).toBe("forbidden_scope");
  });
});
