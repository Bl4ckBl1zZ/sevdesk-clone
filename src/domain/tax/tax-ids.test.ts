import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { type Bundesland, normalizeTaxNumber } from "./tax-number";
import { deVatIdCheckDigit, validateVatId } from "./vat-id";

const code = (r: { ok: true } | { ok: false; error: { code: string } }) => (r.ok ? null : r.error.code);

describe("USt-IdNr (UST-04, F02 §5.4)", () => {
  test("SET-031 DE IDs are DE + 9 digits with the MOD 11,10 check digit (DE123456788 valid, DE123456789 invalid)", () => {
    const ok = validateVatId("DE123456788");
    expect(ok.ok && ok.value).toEqual({ vatId: "DE123456788", countryCode: "DE" });
    const bad = validateVatId("DE123456789");
    expect(code(bad)).toBe("vat_id_checksum");
    expect(bad.ok ? "" : bad.error.message).toBe("Die USt-IdNr ist ungültig (Prüfziffer stimmt nicht).");
    expect(code(validateVatId("DE12345678"))).toBe("vat_id_format_invalid");
    expect(deVatIdCheckDigit("12345678")).toBe(8);
  });

  test("UST-04 DE check digit: any single-digit change of a valid ID is detected", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[1-9]\d{7}$/), fc.integer({ min: 0, max: 7 }), (body, pos) => {
        const id = `DE${body}${deVatIdCheckDigit(body)}`;
        expect(validateVatId(id).ok).toBe(true);
        const digit = Number(body[pos]);
        const changedBody = `${body.slice(0, pos)}${(digit + 1) % 10}${body.slice(pos + 1)}`;
        if (deVatIdCheckDigit(changedBody) !== deVatIdCheckDigit(body)) {
          expect(code(validateVatId(`DE${changedBody}${deVatIdCheckDigit(body)}`))).toBe("vat_id_checksum");
        }
      }),
    );
  });

  test("CON-050 per-country patterns after normalisation (upper case, no spaces, dots or hyphens; GR → EL)", () => {
    const valid = [
      "ATU12345678",
      "BE0123456789",
      "BG123456789",
      "CY12345678L",
      "CZ12345678",
      "DK12345678",
      "EE123456789",
      "EL123456789",
      "ESX1234567X",
      "FI12345678",
      "FRXX123456789",
      "HR12345678901",
      "HU12345678",
      "IE1234567WA",
      "IE1A23456B",
      "IT12345678901",
      "LT123456789012",
      "LU12345678",
      "LV12345678901",
      "MT12345678",
      "NL123456789B01",
      "PL1234567890",
      "PT123456789",
      "RO12",
      "SE123456789001",
      "SI12345678",
      "SK1234567890",
      "XI123456789",
      "XIGD123",
    ];
    for (const id of valid) expect(code(validateVatId(id)), id).toBeNull();
    const r = validateVatId("at u12.345-678");
    expect(r.ok && r.value).toEqual({ vatId: "ATU12345678", countryCode: "AT" });
    const gr = validateVatId("GR123456789");
    expect(gr.ok && gr.value).toEqual({ vatId: "EL123456789", countryCode: "EL", hint: "gr_converted_to_el" });
    expect(code(validateVatId("AT12345678"))).toBe("vat_id_format_invalid");
    expect(code(validateVatId("NL123456789A01"))).toBe("vat_id_format_invalid");
    expect(code(validateVatId("FRIO123456789"))).toBe("vat_id_format_invalid");
    const fmt = validateVatId("BE2123456789");
    expect(fmt.ok ? "" : fmt.error.message).toBe("Die USt-IdNr hat nicht das Format für BE.");
  });

  test("CON-050 non-EU prefixes are rejected with vat_id_not_eu", () => {
    for (const id of ["GB123456789", "CHE123456789", "NO123456789"]) {
      expect(code(validateVatId(id)), id).toBe("vat_id_not_eu");
    }
    expect(code(validateVatId("1234"))).toBe("vat_id_format_invalid");
    expect(code(validateVatId(""))).toBe("vat_id_format_invalid");
  });
});

describe("Steuernummer (SET-030)", () => {
  test("SET-030 Bayern 181/815/08155 normalises to the 13-digit ELSTER format 9181081508155", () => {
    const r = normalizeTaxNumber("181/815/08155", "BY");
    expect(r.ok && r.value).toEqual({ elster: "9181081508155", state: "BY", display: "181/815/08155" });
  });

  test("SET-030 regional formats of all 16 Länder map to the 13-digit format and back", () => {
    const cases: Array<[Bundesland, string, string, string]> = [
      ["BW", "93815/08152", "2893081508152", "93815/08152"],
      ["BY", "181/815/08155", "9181081508155", "181/815/08155"],
      ["BE", "21/815/08150", "1121081508150", "21/815/08150"],
      ["BB", "048/815/08155", "3048081508155", "048/815/08155"],
      ["HB", "75 815 08152", "2475081508152", "75 815 08152"],
      ["HH", "02/815/08156", "2202081508156", "02/815/08156"],
      ["HH", "002/815/08156", "2202081508156", "02/815/08156"],
      ["HE", "013 815 08153", "2613081508153", "013 815 08153"],
      ["MV", "079/815/08151", "4079081508151", "079/815/08151"],
      ["NI", "24/815/08151", "2324081508151", "24/815/08151"],
      ["NW", "133/8150/8159", "5133081508159", "133/8150/8159"],
      ["RP", "22/815/08154", "2722081508154", "22/815/08154"],
      ["SL", "010/815/08182", "1010081508182", "010/815/08182"],
      ["SN", "201/123/12340", "3201012312340", "201/123/12340"],
      ["ST", "101/815/08154", "3101081508154", "101/815/08154"],
      ["SH", "29 815 08158", "2129081508158", "29 815 08158"],
      ["TH", "151/815/08156", "4151081508156", "151/815/08156"],
    ];
    for (const [state, regional, elster, display] of cases) {
      const r = normalizeTaxNumber(regional, state);
      expect(r.ok && r.value, `${state} ${regional}`).toEqual({ elster, state, display });
      const back = normalizeTaxNumber(elster);
      expect(back.ok && back.value, elster).toEqual({ elster, state, display });
    }
  });

  test("UST-04 Steuernummer format errors return tax_number_invalid", () => {
    const bad: Array<[string, Bundesland?]> = [
      ["", "BY"],
      ["181/815/0815", "BY"], // 10 digits for an 11-digit Land
      ["181/815/08155", "BE"], // 11 digits for a 10-digit Land
      ["148/815/08155", "BB"], // Brandenburg starts with 0
      ["901/123/12340", "SN"], // Sachsen starts with 2
      ["9181181508155"], // 13 digits: 5th digit must be 0
      ["8181081508155"], // 13 digits: unknown Land prefix
      ["918108150815"], // 12 digits without a Land
      ["abc"],
    ];
    for (const [input, state] of bad) {
      const r = normalizeTaxNumber(input, state);
      expect(r.ok, `${input} ${state ?? ""}`).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("tax_number_invalid");
        expect(r.error.message).toBe("Die Steuernummer passt nicht zum Format des gewählten Bundeslandes.");
      }
    }
    // a 13-digit number whose Land contradicts the chosen Land is rejected
    expect(normalizeTaxNumber("9181081508155", "BE").ok).toBe(false);
    expect(normalizeTaxNumber("9181081508155", "BY").ok).toBe(true);
  });
});
