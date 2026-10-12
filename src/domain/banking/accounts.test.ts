import { describe, expect, test } from "vitest";
import { checkArchiveAccount, LAST_INVOICE_ACCOUNT_MESSAGE } from "./accounts";

const acc = (
  over: Partial<{
    id: string;
    currency: string;
    showOnInvoices: boolean;
    isDefaultForInvoices: boolean;
    archivedAt: number;
  }>,
) => ({
  id: "a1",
  currency: "EUR",
  showOnInvoices: true,
  isDefaultForInvoices: false,
  ...over,
});

describe("SET-054 archiving invoice accounts", () => {
  test("SET-054 the default invoice account cannot be archived while it is the only showOnInvoices account", () => {
    const only = acc({ isDefaultForInvoices: true });
    expect(checkArchiveAccount(only, [only])).toEqual({
      code: "last_invoice_account",
      message: LAST_INVOICE_ACCOUNT_MESSAGE,
    });
    expect(LAST_INVOICE_ACCOUNT_MESSAGE).toBe(
      "Mindestens ein Konto muss auf Rechnungen angezeigt werden. Bitte zuerst ein anderes Konto als Standard festlegen.",
    );
  });

  test("SET-054 the default can be archived once another account is shown; a non-default account always", () => {
    const def = acc({ isDefaultForInvoices: true });
    const other = acc({ id: "a2" });
    expect(checkArchiveAccount(def, [def, other])).toMatchObject({ code: "default_account" });
    expect(checkArchiveAccount(other, [def, other])).toBeNull();
    // Archived or hidden accounts do not count as "shown".
    expect(
      checkArchiveAccount(def, [def, acc({ id: "a3", archivedAt: 1 }), acc({ id: "a4", showOnInvoices: false })]),
    ).toMatchObject({
      code: "last_invoice_account",
    });
  });

  test("SET-054 an already archived account is a no-op error", () => {
    const a = acc({ archivedAt: 5 });
    expect(checkArchiveAccount(a, [a])).toMatchObject({ code: "already_archived" });
  });
});
