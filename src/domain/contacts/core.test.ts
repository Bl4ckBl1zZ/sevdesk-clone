import { describe, expect, test } from "vitest";
import {
  buildSearchText,
  checkKindChange,
  checkParent,
  displayName,
  foldSearch,
  normalizeContactNumber,
  normalizeSearchQuery,
  phoneTokens,
  statusAfterFinalisation,
  validateCoreFields,
} from "./core";

const base = {
  kind: "organization" as const,
  organizationName: "Müller GmbH",
  roles: ["customer"],
  currency: "EUR",
  isConsumer: false,
  isPublicAuthority: false,
};

const codes = (v: { errors: { code: string }[] }) => v.errors.map((e) => e.code);

describe("CON-001 CON-002 kind, names and display name", () => {
  test("CON-001 organisations need organizationName, persons need lastName", () => {
    expect(codes(validateCoreFields({ ...base, organizationName: " " }))).toEqual(["REQUIRED"]);
    expect(validateCoreFields({ ...base, organizationName: "" }).errors[0]?.message).toBe(
      "Bitte den Firmennamen angeben.",
    );
    const person = validateCoreFields({ ...base, kind: "person", firstName: "Anna" });
    expect(person.errors[0]).toMatchObject({
      code: "REQUIRED",
      field: "lastName",
      message: "Bitte den Nachnamen angeben.",
    });
    expect(codes(validateCoreFields({ ...base, kind: "person", lastName: "Müller" }))).toEqual([]);
  });

  test("CON-001 an organisation cannot have a parent; a person's parent must be an active organisation", () => {
    expect(codes(validateCoreFields({ ...base, parentId: "x" }))).toEqual(["PARENT_NOT_ALLOWED"]);
    const org = { id: "o1", kind: "organization" as const, status: "active" as const };
    expect(checkParent("p1", org)).toBeNull();
    expect(checkParent("p1", { ...org, kind: "person" })?.code).toBe("PARENT_INVALID");
    expect(checkParent("p1", { ...org, status: "archived" })?.code).toBe("PARENT_INVALID");
    expect(checkParent("p1", { ...org, mergedIntoId: "o2" })?.code).toBe("PARENT_INVALID");
    expect(checkParent("o1", org)?.code).toBe("PARENT_INVALID");
    expect(checkParent("p1", null)?.message).toBe("Ein Ansprechpartner kann nur einer Organisation zugeordnet werden.");
  });

  test("CON-002 display name: organisation name; person [title] first last", () => {
    expect(displayName({ kind: "organization", organizationName: " Müller GmbH " })).toBe("Müller GmbH");
    expect(displayName({ kind: "person", academicTitle: "Dr.", firstName: "Anna", lastName: "Müller" })).toBe(
      "Dr. Anna Müller",
    );
    expect(displayName({ kind: "person", lastName: "Müller" })).toBe("Müller");
  });

  test("CON-005 §5.1 length limits for first name, title and position", () => {
    const long = (n: number) => "x".repeat(n);
    const v = validateCoreFields({
      ...base,
      kind: "person",
      lastName: "M",
      firstName: long(81),
      academicTitle: long(31),
      position: long(81),
    });
    expect(codes(v)).toEqual(["TOO_LONG", "TOO_LONG", "TOO_LONG"]);
    expect(v.errors[0]?.message).toBe("Der Text ist zu lang (max. 80 Zeichen).");
  });

  test("§5.1 kind change organisation → person with children is refused", () => {
    expect(checkKindChange("organization", "person", 2)?.code).toBe("KIND_CHANGE_HAS_CHILDREN");
    expect(checkKindChange("organization", "person", 0)).toBeNull();
    expect(checkKindChange("person", "organization", 3)).toBeNull();
  });
});

describe("CON-003 CON-004 CON-006 number, roles, status, currency", () => {
  test("CON-003 numbers: 1–36 chars of the DATEV charset, compared case-insensitively", () => {
    expect(codes(validateCoreFields({ ...base, number: "K-10042" }))).toEqual([]);
    expect(codes(validateCoreFields({ ...base, number: "K 1" }))).toEqual(["CONTACT_NUMBER_INVALID"]);
    expect(codes(validateCoreFields({ ...base, number: "x".repeat(37) }))).toEqual(["CONTACT_NUMBER_INVALID"]);
    expect(normalizeContactNumber(" k-1 ")).toBe("K-1");
  });

  test("CON-004 at least one role; a lead becomes active at the first finalisation", () => {
    expect(validateCoreFields({ ...base, roles: [] }).errors[0]?.message).toBe(
      "Bitte mindestens eine Rolle wählen (Kunde, Lieferant, Partner, Interessent).",
    );
    expect(statusAfterFinalisation("lead")).toBe("active");
    expect(statusAfterFinalisation("archived")).toBe("archived");
  });

  test("CON-006 currency must be supported; CON-005 birthday not in the future", () => {
    expect(codes(validateCoreFields({ ...base, currency: "XXX" }))).toEqual(["CURRENCY_INVALID"]);
    const p = { ...base, kind: "person" as const, lastName: "M" };
    expect(codes(validateCoreFields({ ...p, birthday: "2030-01-01" }, "2026-10-12"))).toEqual(["DATE_INVALID"]);
    expect(codes(validateCoreFields({ ...p, birthday: "1980-02-30" }))).toEqual(["DATE_INVALID"]);
    expect(codes(validateCoreFields({ ...p, birthday: "1980-02-28" }, "2026-10-12"))).toEqual([]);
  });

  test("T-CON-045 CON-042 isConsumer and isPublicAuthority are mutually exclusive", () => {
    const v = validateCoreFields({ ...base, isConsumer: true, isPublicAuthority: true });
    expect(v.errors[0]).toMatchObject({
      code: "CONTACT_TYPE_CONFLICT",
      message: "Ein Kontakt kann nicht gleichzeitig Privatkunde und öffentlicher Auftraggeber sein.",
    });
  });
});

describe("CON-172 §5.11 search text", () => {
  test("T-CON-057 'mueller' and 'muller' find 'Müller GmbH'; phone digits; e-mails; VAT ID", () => {
    const text = buildSearchText({
      displayName: "Müller GmbH",
      number: "10042",
      emails: ["Buchhaltung@Mueller.de"],
      phones: ["+49 30 1234567"],
      vatId: "DE123456788",
      city: "Köln",
      tags: ["Stammkunde"],
    });
    const tokens = text.split(" ");
    expect(tokens).toEqual(expect.arrayContaining(["muller", "mueller", "gmbh", "koln", "koeln", "10042"]));
    expect(tokens).toEqual(expect.arrayContaining(["buchhaltung@mueller.de", "de123456788", "stammkunde"]));
    expect(tokens).toEqual(expect.arrayContaining(["49301234567", "0301234567"]));
    expect(normalizeSearchQuery("Müller")).toBe("muller");
    expect(normalizeSearchQuery("030 1234")).toBe("0301234");
    expect(normalizeSearchQuery("ART-12")).toBe("art-12");
  });

  test("CON-172 folding removes diacritics and ß", () => {
    expect(foldSearch("Straße Ñandú")).toBe("strasse nandu");
    expect(phoneTokens("0049 89 12345")).toEqual(["004989" + "12345", "08912345"]);
    expect(phoneTokens("abc")).toEqual([]);
  });
});
