/**
 * SWIFT MT940 parser (F07 BNK-033): own implementation (no runtime dependency), tolerant of the SWIFT envelope
 * (`{1:…}{4:` … `-}`), several statements per file (`:20:` blocks of the same account), `:60F/M:` → opening,
 * `:62F/M:` → closing, and `:61:` lines with value date, optional entry date (MMDD, the booking date), `C`/`D`/`RC`/`RD`,
 * optional funds code, decimal-comma amount, transaction type and references (`customer//bank`).
 *
 * `:86:` is read as German structured format (DK „Mehrzweckfeld“: GVC + `?00` Buchungstext, `?20–?29`/`?60–?63`
 * purpose, `?30` BIC/BLZ, `?31` IBAN/account, `?32/?33` name) with the SEPA tags `EREF+ MREF+ CRED+ SVWZ+ …`; any
 * other `:86:` is unstructured purpose text. Physical lines are joined without separator (MT940 hard-wraps at 65
 * characters). Revolut's MT940 layout (`:86:` content, references) is **UNSURE** until the owner's export (Q-03).
 */
import { err, ok, type Result } from "../../result";
import { isCalendarDate } from "../../time/calendar-date";
import { parseBankAmount } from "../amount";
import { normaliseIban } from "../normalise";
import {
  type ParsedStatement,
  type ParsedTransaction,
  type ParseIssue,
  type UnreadableFile,
  unreadable,
} from "../types";

interface Field {
  tag: string;
  value: string;
  line: number;
}

function fields(text: string): Field[] {
  const out: Field[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (const [i, raw] of lines.entries()) {
    let l = raw;
    if (i === 0) l = l.replace(/^(\{\d:[^}]*\})*\{4:/, "");
    if (/^-\}?\s*$/.test(l) || l.trim() === "") continue;
    const m = /^:(\d{2}[A-Z]?):(.*)$/.exec(l);
    if (m) out.push({ tag: m[1] as string, value: m[2] as string, line: i + 1 });
    else if (out.length > 0) {
      const last = out[out.length - 1] as Field;
      // :61: supplementary details live on their own line; everything else is hard-wrapped text.
      last.value += last.tag === "61" ? `\n${l}` : l;
    }
  }
  return out;
}

function yymmdd(s: string): string | undefined {
  const y = Number(s.slice(0, 2));
  const d = `${y >= 80 ? 1900 + y : 2000 + y}-${s.slice(2, 4)}-${s.slice(4, 6)}`;
  return isCalendarDate(d) ? d : undefined;
}

/** `C261001EUR1234,56` → balance. */
function balance(value: string): { cents: number; date: string; currency: string } | null {
  const m = /^([CD])(\d{6})([A-Z]{3})(\d+,\d*)/.exec(value.trim());
  if (!m) return null;
  const date = yymmdd(m[2] as string);
  const p = parseBankAmount(m[4] as string, m[3] as string, { decimalSeparator: "," });
  if (!date || !p.ok) return null;
  return { cents: m[1] === "D" ? -p.value : p.value, date, currency: m[3] as string };
}

const SEPA_TAGS = ["EREF", "KREF", "MREF", "CRED", "DEBT", "SVWZ", "ABWA", "ABWE", "IBAN", "BIC", "COAM", "OAMT"];

function sepaTags(purpose: string): Record<string, string> | null {
  const re = new RegExp(`(${SEPA_TAGS.join("|")})\\+`, "g");
  const hits = [...purpose.matchAll(re)];
  if (hits.length === 0) return null;
  const out: Record<string, string> = {};
  for (const [i, h] of hits.entries()) {
    const start = (h.index ?? 0) + (h[0] as string).length;
    const end = hits[i + 1]?.index ?? purpose.length;
    out[h[1] as string] = purpose.slice(start, end).trim();
  }
  if ((hits[0]?.index ?? 0) > 0) out.PREFIX = purpose.slice(0, hits[0]?.index).trim();
  return out;
}

interface Info86 {
  gvc?: string;
  purpose: string;
  name?: string;
  iban?: string;
  bic?: string;
  endToEndId?: string;
  mandateRef?: string;
  creditorId?: string;
}

const clean = (s: string | undefined) => (s ? s.replace(/\s+/g, " ").trim() || undefined : undefined);
const ref = (s: string | undefined) => (s && !/^(NOTPROVIDED|NONREF)$/i.test(s) ? s : undefined);

function parse86(value: string): Info86 {
  const m = /^(\d{3})(\D)(\d{2}.*)$/s.exec(value);
  if (!m) return { purpose: clean(value) ?? "" };
  const sep = m[2] as string;
  const sub: Record<string, string> = {};
  for (const part of `${sep}${m[3]}`.split(sep).slice(1)) {
    const k = part.slice(0, 2);
    sub[k] = (sub[k] ?? "") + part.slice(2);
  }
  const purposeRaw = ["20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "60", "61", "62", "63"]
    .map((k) => sub[k] ?? "")
    .join("");
  const tags = sepaTags(purposeRaw);
  const iban = sub["31"] && /^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(sub["31"].trim()) ? normaliseIban(sub["31"]) : undefined;
  const bic = sub["30"] && /^[A-Z]{6}[A-Z0-9]{2,5}$/.test(sub["30"].trim()) ? sub["30"].trim() : undefined;
  return {
    gvc: m[1] as string,
    purpose: clean(tags ? (tags.SVWZ ?? tags.PREFIX ?? "") : purposeRaw) ?? "",
    name: clean(`${sub["32"] ?? ""}${sub["33"] ?? ""}`),
    iban: iban ?? (tags?.IBAN ? normaliseIban(tags.IBAN) : undefined),
    bic: bic ?? tags?.BIC,
    endToEndId: ref(tags?.EREF),
    mandateRef: ref(tags?.MREF),
    creditorId: ref(tags?.CRED),
  };
}

const LINE_61 = /^(\d{6})(\d{4})?(RC|RD|C|D)([A-Z])?(\d+,\d*)([NFS])([A-Z0-9]{3})([^\n]*)(?:\n([\s\S]*))?$/;

const compact = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export function parseMt940(text: string): Result<ParsedStatement, UnreadableFile> {
  const all = fields(text);
  if (!all.some((f) => f.tag === "20") || !all.some((f) => f.tag === "25")) {
    return err(unreadable(1, "kein MT940-Kontoauszug (Felder :20: und :25: fehlen)"));
  }
  const transactions: ParsedTransaction[] = [];
  const issues: ParseIssue[] = [];
  let account: string | undefined;
  let currency: string | undefined;
  let opening: { cents: number; date: string } | undefined;
  let closing: { cents: number; date: string } | undefined;
  let statementId: string | undefined;

  for (const [i, f] of all.entries()) {
    switch (f.tag) {
      case "20":
        statementId ??= f.value.trim();
        break;
      case "28C":
        statementId = `${statementId ?? ""}${statementId ? " " : ""}${f.value.trim()}`;
        break;
      case "25": {
        const v = f.value.trim();
        if (account !== undefined && account !== v)
          return err(unreadable(f.line, "die Datei enthält Kontoauszüge mehrerer Konten"));
        account = v;
        break;
      }
      case "60F":
      case "60M": {
        const b = balance(f.value);
        if (!b) return err(unreadable(f.line, `Anfangssaldo nicht lesbar (${f.value.trim()})`));
        currency ??= b.currency;
        if (!opening) opening = b;
        break;
      }
      case "62F":
      case "62M": {
        const b = balance(f.value);
        if (!b) return err(unreadable(f.line, `Endsaldo nicht lesbar (${f.value.trim()})`));
        closing = b;
        break;
      }
      case "61": {
        const m = LINE_61.exec(f.value.trim());
        if (!m) {
          issues.push({
            line: f.line,
            code: "bank_line_invalid",
            message: `Umsatzzeile nicht lesbar (:61:${f.value.trim()}).`,
          });
          break;
        }
        const ccy = currency ?? "EUR";
        const amount = parseBankAmount(m[5] as string, ccy, { decimalSeparator: "," });
        if (!amount.ok) {
          issues.push({ line: f.line, code: amount.error.code, message: amount.error.message });
          break;
        }
        const valueDate = yymmdd(m[1] as string);
        if (!valueDate) {
          issues.push({ line: f.line, code: "bank_date_invalid", message: `Ungültiges Datum (${m[1]}).` });
          break;
        }
        let bookingDate = valueDate;
        if (m[2]) {
          const vm = Number(valueDate.slice(5, 7));
          const em = Number(m[2].slice(0, 2));
          let year = Number(valueDate.slice(0, 4));
          if (vm === 12 && em === 1) year++;
          if (vm === 1 && em === 12) year--;
          const d = `${year}-${m[2].slice(0, 2)}-${m[2].slice(2, 4)}`;
          if (isCalendarDate(d)) bookingDate = d;
        }
        const mark = m[3] as string;
        const debit = mark === "D" || mark === "RC";
        const [customerRef, bankRefRaw] = (m[8] as string).split("//");
        const bankRef = ref(bankRefRaw?.trim());
        const next = all[i + 1];
        const info = next?.tag === "86" ? parse86(next.value) : { purpose: "" };
        transactions.push(
          compact<ParsedTransaction>({
            line: f.line,
            bookingDate,
            valueDate,
            amountCents: debit ? -amount.value : amount.value,
            currency: ccy,
            counterpartyName: info.name,
            counterpartyIban: info.iban,
            counterpartyBic: info.bic,
            counterpartySource: info.name || info.iban ? "statement" : undefined,
            purpose: info.purpose || clean(m[9]) || "",
            endToEndId: info.endToEndId ?? ref(customerRef?.trim()),
            mandateRef: info.mandateRef,
            creditorId: info.creditorId,
            bankRef: bankRef ?? ref(customerRef?.trim()),
            entryReference: bankRef,
            bankTransactionCode: info.gvc,
            proprietaryCode: `${m[6]}${m[7]}`,
            reversal: mark.startsWith("R") || undefined,
            raw: JSON.stringify({ ":61:": f.value, ...(next?.tag === "86" ? { ":86:": next.value } : {}) }),
          }),
        );
        break;
      }
    }
  }

  let iban: string | undefined;
  if (account) {
    const compactAccount = account.replace(/\s+/g, "");
    const withoutCcy = compactAccount.replace(/[A-Z]{3}$/, "");
    if (/^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(withoutCcy)) iban = normaliseIban(withoutCcy);
    else if (/^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(compactAccount)) iban = normaliseIban(compactAccount);
  }
  const dates = transactions.map((t) => t.bookingDate).sort();
  return ok(
    compact<ParsedStatement>({
      format: "mt940",
      statementId,
      iban,
      currency,
      periodFrom: [opening?.date, dates[0]].filter((d): d is string => !!d).sort()[0],
      periodTo: closing?.date ?? dates[dates.length - 1],
      openingBalanceCents: opening?.cents,
      closingBalanceCents: closing?.cents,
      balanceSource: opening && closing ? "statement" : "none",
      transactions,
      issues,
      skipped: [],
    }),
  );
}
