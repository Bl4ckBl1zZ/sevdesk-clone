import type { ReactElement } from "react";
import { describe, expect, test, vi } from "vitest";
import Page from "./page";

vi.mock("@/components/auth/role-gate", () => ({ RoleGate: () => null }));
vi.mock("@/components/catalog/catalog-page", () => ({ catalogMetadata: () => ({}) }));
vi.mock("@/components/invoices/invoice-detail", () => ({ InvoiceDetail: () => null }));

const asked = async (searchParams: Record<string, string | string[]>) => {
  const page = (await Page({
    params: Promise.resolve({ id: "d1" }),
    searchParams: Promise.resolve(searchParams),
  })) as ReactElement<{ children: ReactElement<{ id: string; askFinalize: boolean }> }>;
  return page.props.children.props;
};

describe("DOC-61 /rechnungen/[id]?fertigstellen=1", () => {
  test("DOC-61 only the exact parameter asks for the finalise dialog", async () => {
    expect(await asked({ fertigstellen: "1" })).toEqual({ id: "d1", askFinalize: true });
    expect((await asked({})).askFinalize).toBe(false);
    expect((await asked({ fertigstellen: "ja" })).askFinalize).toBe(false);
    expect((await asked({ fertigstellen: ["1", "1"] })).askFinalize).toBe(false);
  });
});
