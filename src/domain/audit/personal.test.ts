import { describe, expect, test } from "vitest";
import { isEncryptedValue, mapPersonalFields, personalContactId } from "./personal";

const fakeEncrypt = async (v: unknown) => ({ enc: { contactId: "c1", iv: "iv", ct: `enc(${JSON.stringify(v)})` } });

describe("personal fields in audit diffs (F02 §5.12)", () => {
  test("GOBD-06 natural-person fields are encrypted, business identifiers stay in clear text", async () => {
    const diff = {
      before: { firstName: "Max", number: "K-1001", vatId: "DE123", notes: null },
      after: { firstName: "Moritz", number: "K-1001", vatId: "DE123", birthday: "1980-01-01" },
    };
    const out = await mapPersonalFields("contacts", diff, fakeEncrypt);
    expect(out.before).toEqual({
      firstName: { enc: expect.any(Object) },
      number: "K-1001",
      vatId: "DE123",
      notes: null,
    });
    expect(isEncryptedValue(out.after?.firstName)).toBe(true);
    expect(isEncryptedValue(out.after?.birthday)).toBe(true);
    expect(out.after?.number).toBe("K-1001");
  });

  test("GOBD-06 tables without personal data are untouched", async () => {
    const diff = { after: { name: "x" } };
    expect(await mapPersonalFields("members", diff, fakeEncrypt)).toBe(diff);
  });

  test("GOBD-06 the owning contact is the entity or the referenced contactId", () => {
    expect(personalContactId("contacts", "c9", undefined)).toBe("c9");
    expect(personalContactId("contactChannels", "ch1", { after: { contactId: "c2" } })).toBe("c2");
    expect(personalContactId("contactChannels", "ch1", { before: { contactId: "c3" } })).toBe("c3");
    expect(personalContactId("contactChannels", "ch1", {})).toBeUndefined();
    expect(personalContactId("members", "m1", {})).toBeUndefined();
  });

  test("GOBD-06 isEncryptedValue recognises only the envelope", () => {
    expect(isEncryptedValue({ enc: { contactId: "c", iv: "a", ct: "b" } })).toBe(true);
    expect(isEncryptedValue({ enc: "x" })).toBe(false);
    expect(isEncryptedValue("x")).toBe(false);
    expect(isEncryptedValue(null)).toBe(false);
  });
});
