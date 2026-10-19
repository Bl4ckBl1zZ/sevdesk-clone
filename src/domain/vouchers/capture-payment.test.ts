import { describe, expect, test } from "vitest";
import { ersetzendesScannen } from "../docs/ersetzendes-scannen";
import { zugriffskonzeptMarkdown } from "../docs/zugriffskonzept";
import type { CalendarDate } from "../time/calendar-date";
import {
  activeOriginals,
  checkReplacement,
  checkUpload,
  hasBeleg,
  missingCaptureMetadata,
  type OriginalFile,
  pageCount,
  replaceOriginal,
  sniffMime,
} from "./capture";
import {
  overdueVouchers,
  receiptSuggestions,
  recurringWithoutDebit,
  transactionsWithoutReceipt,
  unbookedMessage,
  unbookedOlderThan,
} from "./missing-receipts";
import { checkPaymentChoice, methodsFor, preselectPaymentMethod } from "./payment-choice";
import { dueVoucherDates, nextVoucherDate, upcomingVoucherDates } from "./recurring";

const d = (s: string) => s as CalendarDate;
const bytes = (s: string) => new TextEncoder().encode(s);

describe("capture metadata and originals (VOU-120…122, GOBD-08)", () => {
  test("VOU-120 GOBD-08 INB-001 MIME is sniffed from magic bytes, not the extension", () => {
    expect(sniffMime(bytes("%PDF-1.7\n"))).toBe("application/pdf");
    expect(sniffMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffMime(bytes('<?xml version="1.0"?><Invoice/>'))).toBe("application/xml");
    expect(sniffMime(bytes("<rsm:CrossIndustryInvoice xmlns:rsm='x'/>"))).toBe("application/xml");
    expect(sniffMime(bytes("Received: from mx\r\nSubject: Rechnung\r\n"))).toBe("message/rfc822");
    expect(sniffMime(new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]))).toBe(
      "image/heic",
    );
    // An .exe renamed to .pdf is rejected (EC-INB-01).
    expect(checkUpload(bytes("MZ\x90\x00"))).toMatchObject({ ok: false, error: { code: "file_unsupported" } });
    expect(checkUpload(new Uint8Array(21 * 1024 * 1024).fill(0x25))).toMatchObject({
      ok: false,
      error: { code: "file_too_large" },
    });
  });

  test("VOU-120 GOBD-08 page count and completeness of the capture metadata", () => {
    const pdf = bytes(
      "%PDF-1.4\n1 0 obj <</Type /Pages /Kids [2 0 R 3 0 R]>> 2 0 obj <</Type /Page>> 3 0 obj <</Type /Page>>",
    );
    expect(pageCount(pdf, "application/pdf")).toBe(2);
    expect(pageCount(new Uint8Array([1]), "image/jpeg")).toBe(1);
    const f: OriginalFile = {
      storageId: "s1",
      sha256: "a".repeat(64),
      bytes: 10,
      mime: "application/pdf",
      name: "rechnung.pdf",
      role: "original",
      capturedAt: 1,
      capturedBy: "user:u1",
      capturedVia: "upload",
    };
    expect(missingCaptureMetadata(f)).toEqual([]);
    expect(missingCaptureMetadata({ ...f, sha256: "x", capturedBy: "" })).toEqual(["sha256", "capturedBy"]);
  });

  test("VOU-122 EC-161 EC-VOU-22/23 GOBD-08: replacement appends a version, the old file stays; reason after booking, never after lock", () => {
    const f = {
      storageId: "s1",
      sha256: "a".repeat(64),
      bytes: 1,
      mime: "application/pdf",
      name: "a.pdf",
      role: "original",
      capturedAt: 1,
      capturedBy: "user:u",
      capturedVia: "upload",
    } as OriginalFile;
    expect(checkReplacement({ files: [f], index: 0, booked: false, locked: false }).ok).toBe(true);
    expect(checkReplacement({ files: [f], index: 0, booked: true, locked: false })).toMatchObject({
      ok: false,
      error: { message: "Bitte angeben, warum die Datei ersetzt wird." },
    });
    expect(checkReplacement({ files: [f], index: 0, booked: true, locked: false, reason: "Scan unleserlich" }).ok).toBe(
      true,
    );
    expect(
      checkReplacement({ files: [f], index: 0, booked: true, locked: true, reason: "Scan unleserlich" }),
    ).toMatchObject({
      ok: false,
      error: { message: "Originaldateien festgeschriebener Belege können nicht ersetzt werden." },
    });
    const next = replaceOriginal([f], 0, { ...f, storageId: "s2", sha256: "b".repeat(64) });
    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({ storageId: "s1", sha256: "a".repeat(64), replacedBy: 1 });
    expect(activeOriginals(next).map((x) => x.storageId)).toEqual(["s2"]);
    expect(checkReplacement({ files: next, index: 0, booked: false, locked: false }).ok).toBe(false);
  });

  test("VOU-121 EC-VOU-01 RI-21 a voucher needs an original (renditions do not count) or an approved Eigenbeleg", () => {
    expect(hasBeleg({ files: [], kind: "standard" })).toBe(false);
    expect(hasBeleg({ files: [{ replacedBy: 1 }], kind: "standard" })).toBe(false);
    expect(hasBeleg({ files: [{}], kind: "standard" })).toBe(true);
    expect(hasBeleg({ files: [], kind: "eigenbeleg", eigenbelegApproved: true })).toBe(true);
    expect(hasBeleg({ files: [], kind: "standard", recurringReference: true })).toBe(true);
  });
});

describe("„Bezahlt mit“ (VOU-136…138, CSH-022/023)", () => {
  const base = {
    direction: "expense" as const,
    date: "2026-10-19",
    amountCents: 8000,
    openCents: 8000,
    today: d("2026-10-19"),
    closedPeriods: new Set<string>(),
    corporation: false,
  };

  test("VOU-136 bank and card_pending settle nothing at booking; income vouchers offer Bank and Bar only", () => {
    expect(checkPaymentChoice({ ...base, method: "bank" })).toEqual({
      ok: true,
      value: { settles: false, warnings: [] },
    });
    expect(checkPaymentChoice({ ...base, method: "card_pending" }).ok).toBe(true);
    expect(methodsFor("income")).toEqual(["bank", "cash"]);
    expect(checkPaymentChoice({ ...base, direction: "income", method: "private" })).toMatchObject({
      ok: false,
      error: { code: "payment_private_income" },
    });
    expect(preselectPaymentMethod("paid_cash", "expense")).toBe("cash");
    expect(preselectPaymentMethod("paid_card", "expense")).toBe("card_pending");
    expect(preselectPaymentMethod("unknown", "expense")).toBe("bank");
  });

  test("VOU-137 CSH-022 EC-VOU-40/41/44: date tomorrow blocked; 3 days back ⚑ § 146 warning; 12 days back needs a reason; locked period blocked", () => {
    expect(checkPaymentChoice({ ...base, method: "cash", date: "2026-10-20" })).toMatchObject({
      ok: false,
      error: {
        message: "Das Zahlungsdatum darf nicht in der Zukunft oder in einem festgeschriebenen Zeitraum liegen.",
      },
    });
    const three = checkPaymentChoice({ ...base, method: "cash", date: "2026-10-16" });
    expect(three.ok && three.value.warnings).toEqual([
      {
        code: "cash_backdated",
        message:
          "Barausgaben sind täglich aufzuzeichnen (§ 146 Abs. 1 S. 2 AO). Zahlungsdatum 16.10.2026 liegt 3 Tage zurück.",
        acknowledge: true,
      },
    ]);
    expect(checkPaymentChoice({ ...base, method: "cash", date: "2026-10-07" })).toMatchObject({
      ok: false,
      error: { message: "Bitte begründen, warum die Barzahlung erst jetzt erfasst wird (mehr als 10 Tage zurück)." },
    });
    expect(
      checkPaymentChoice({ ...base, method: "cash", date: "2026-10-07", backdateReason: "Beleg lag im Auto" }).ok,
    ).toBe(true);
    expect(
      checkPaymentChoice({
        ...base,
        method: "cash",
        date: "2026-09-30",
        backdateReason: "spät",
        closedPeriods: new Set(["2026-09"]),
      }),
    ).toMatchObject({ ok: false, error: { code: "payment_date_invalid" } });
    expect(checkPaymentChoice({ ...base, method: "cash", amountCents: 9000 })).toMatchObject({
      ok: false,
      error: { code: "payment_amount_invalid" },
    });
  });

  test("VOU-138 CSH-023 EC-VOU-42: „Privat bezahlt“ for a corporation posts to the shareholder clearing account (info)", () => {
    expect(checkPaymentChoice({ ...base, method: "private" })).toEqual({
      ok: true,
      value: { settles: true, warnings: [] },
    });
    const corp = checkPaymentChoice({ ...base, method: "private", corporation: true });
    expect(corp.ok && corp.value.warnings[0]).toEqual({
      code: "shareholder_clearing",
      message: "Auslage durch Gesellschafter – wird auf dem Verrechnungskonto Gesellschafter gebucht.",
      acknowledge: false,
    });
  });
});

describe("recurring vouchers (VOU-064)", () => {
  test("VOU-064 T06-115 monthly from 2026-01-31 → 2026-02-28, 2026-03-31; catch-up after 3 missed months in order (EC-VOU-33)", () => {
    const s = { interval: "P1M" as const, firstDate: "2026-01-31", nextDate: "2026-01-31", active: true };
    expect(upcomingVoucherDates(s, 3)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
    expect(nextVoucherDate(s, 0)).toBe("2026-02-28");
    const due = dueVoucherDates({ ...s, nextDate: "2026-02-28" }, d("2026-04-30"));
    expect(due.map((x) => x.date)).toEqual(["2026-02-28", "2026-03-31", "2026-04-30"]);
    expect(dueVoucherDates({ ...s, active: false }, d("2026-04-30"))).toEqual([]);
    expect(dueVoucherDates({ ...s, endDate: "2026-02-28" }, d("2026-04-30")).map((x) => x.date)).toEqual([
      "2026-01-31",
      "2026-02-28",
    ]);
    expect(
      upcomingVoucherDates({ interval: "P2W", firstDate: "2026-01-05", nextDate: "2026-01-05", active: true }, 2),
    ).toEqual(["2026-01-05", "2026-01-19"]);
  });
});

describe("missing receipts and unbooked items (VOU-110/111)", () => {
  const tx = (over: Partial<Parameters<typeof transactionsWithoutReceipt>[0][number]>) => ({
    id: "t1",
    bookingDate: "2026-10-01",
    amountCents: -4999,
    counterpartyName: "Telekom Deutschland",
    status: "open",
    allocatedCents: 0,
    hasVoucher: false,
    waived: false,
    ...over,
  });

  test("VOU-110 GOBD-07 T06-132 unallocated bank transactions without voucher are listed; marked, allocated, waived ones are not", () => {
    const rows = [
      tx({}),
      tx({ id: "t2", status: "private" }),
      tx({ id: "t3", allocatedCents: 4999, status: "matched" }),
      tx({ id: "t4", waived: true }),
      tx({ id: "t5", hasVoucher: true }),
      tx({ id: "t6", amountCents: 12_000 }),
    ];
    expect(transactionsWithoutReceipt(rows).map((t) => t.id)).toEqual(["t1", "t6"]);
    expect(
      receiptSuggestions(tx({}), [
        { id: "d1", kind: "draft", grossCents: 4999, date: "2026-10-02", name: "Telekom" },
        { id: "d2", kind: "inbox", grossCents: 5000, date: "2026-10-01" },
        { id: "d3", kind: "inbox", grossCents: 4999, date: "2026-12-30" },
      ]).map((c) => c.id),
    ).toEqual(["d1"]);
  });

  test("VOU-110 overdue open vouchers and recurring vouchers without matching debit", () => {
    const today = d("2026-10-19");
    const v = [
      { id: "a", status: "open", dueDate: "2026-10-01", documentDate: "2026-09-20", openAmountCents: 1 },
      { id: "b", status: "paid", dueDate: "2026-10-01", documentDate: "2026-09-20", openAmountCents: 0 },
      { id: "c", status: "open", documentDate: "2026-10-01", openAmountCents: 1, recurringVoucherId: "r1" },
      { id: "e", status: "open", documentDate: "2026-10-15", openAmountCents: 1, recurringVoucherId: "r1" },
    ];
    expect(overdueVouchers(v, today).map((x) => x.id)).toEqual(["a"]);
    expect(recurringWithoutDebit(v, today).map((x) => x.id)).toEqual(["c"]);
  });

  test("VOU-111 GOBD-04 EC-INB-22 T06-133: items received 12 days ago appear in „Unbearbeitet > 10 Tage“", () => {
    const now = Date.UTC(2026, 9, 19, 12);
    const items = [
      { id: "x", receivedAt: now - 12 * 86_400_000 },
      { id: "y", receivedAt: now - 3 * 86_400_000 },
    ];
    expect(unbookedOlderThan(items, now).map((i) => i.id)).toEqual(["x"]);
    expect(unbookedMessage(1)).toBe("1 Belege sind seit mehr als 10 Tagen unbearbeitet.");
  });
});

describe("Verfahrensdokumentation „Ersetzendes Scannen“ (VOU-125)", () => {
  test("VOU-125 GOBD-08 GOBD-10 T06-139 the scanning procedure is generated with the settings values", () => {
    const doc = ersetzendesScannen({
      today: "2026-10-19",
      companyName: "Muster Design",
      responsible: ["Max Mustermann"],
      channels: ["upload", "app"],
      captureWithinDays: 10,
      paperDestructionAllowed: false,
      retentionYears: 8,
      storage: "Convex-Dateispeicher mit nächtlicher Sicherung",
    });
    expect(doc.title).toBe("Ersetzendes Scannen und Belegerfassung");
    expect(doc.stand).toBe("19.10.2026");
    const md = zugriffskonzeptMarkdown(doc);
    expect(md).toContain("Belege erfassen: Max Mustermann.");
    expect(md).toContain("spätestens 10 Tage nach Eingang");
    expect(md).toContain("SHA-256");
    expect(md).toContain("Papierbelege werden derzeit nicht vernichtet");
    expect(md).toContain("8 Jahre");
    expect(md).toContain("| Smartphone-Kamera und Teilen-Funktion der App (PWA) |");
    expect(
      zugriffskonzeptMarkdown(
        ersetzendesScannen({
          ...doc,
          ...{
            today: "2026-10-19",
            companyName: "X",
            responsible: [],
            channels: [],
            captureWithinDays: 5,
            paperDestructionAllowed: true,
            retentionYears: 8,
            storage: "S",
          },
        }),
      ),
    ).toContain("vollständig geprüft");
  });
});
