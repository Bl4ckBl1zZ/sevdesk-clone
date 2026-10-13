/**
 * ISO 20022 camt.053 parser (F07 BNK-033, BNK-120): versions .001.02 up to .001.13 on `fast-xml-parser`.
 *
 *  - only booked entries (`Sts = BOOK`, or `<Sts><Cd>BOOK</Cd></Sts>` from .001.08; an entry without `Sts` counts as
 *    booked) — pending items never enter the books (BNK-111);
 *  - `RvslInd = true` → `reversal`, signed by `CdtDbtInd` like every entry (EC-BNK-48, BNK-121);
 *  - batch entries are split per `TxDtls` when the details carry amounts that add up to the entry (BNK-033);
 *  - balances: opening = `OPBD` (else `PRCD`), closing = `CLBD`;
 *  - booking date: `BookgDt/Dt` as delivered, `BookgDt/DtTm` → Europe/Berlin date (BNK-112), else the value date.
 *
 * Revolut mapping assumptions (research 13 §5; **UNSURE** until the owner's real export, F07 Q-03): the Revolut
 * transaction ID is in `AcctSvcrRef` (entry or `TxDtls/Refs`), the Revolut type in `BkTxCd/Prtry/Cd`, card charges
 * in `Chrgs` included in the entry amount, and the counterparty in `RltdPties`.
 */
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { err, ok, type Result } from "../../result";
import { berlinCalendarDate } from "../../time/berlin";
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

type Node = Record<string, unknown>;

const ARRAYS = new Set(["Stmt", "Bal", "Ntry", "NtryDtls", "TxDtls", "Ustrd", "Strd", "Rcrd", "Chrgs"]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  isArray: (name) => ARRAYS.has(name),
});

const obj = (v: unknown): Node | undefined => (v !== null && typeof v === "object" ? (v as Node) : undefined);
const arr = (v: unknown): Node[] =>
  Array.isArray(v) ? v.map(obj).filter((x): x is Node => !!x) : obj(v) ? [v as Node] : [];
const str = (v: unknown): string | undefined => {
  if (typeof v === "string") return v.trim() || undefined;
  const o = obj(v);
  if (o && typeof o["#text"] === "string") return (o["#text"] as string).trim() || undefined;
  return undefined;
};
/** Path lookup: get(node, "Refs", "EndToEndId"). Arrays take their first element. */
function get(node: unknown, ...path: string[]): unknown {
  let cur: unknown = node;
  for (const p of path) {
    if (Array.isArray(cur)) cur = cur[0];
    const o = obj(cur);
    if (!o) return undefined;
    cur = o[p];
  }
  return Array.isArray(cur) && cur.length === 1 && path.length > 0 && !ARRAYS.has(path[path.length - 1] ?? "")
    ? cur[0]
    : cur;
}
const text = (node: unknown, ...path: string[]) => str(get(node, ...path));

const NOT_PROVIDED = new Set(["NOTPROVIDED", "NONREF"]);
const ref = (v: string | undefined) => (v && !NOT_PROVIDED.has(v.toUpperCase()) ? v : undefined);

/** `Dt` or `DtTm` (ISO with offset or Z) → calendar date (+ UTC instant for DtTm). */
function dateOf(node: unknown): { date?: string; instant?: string } {
  const d = text(node, "Dt");
  if (d && isCalendarDate(d.slice(0, 10))) return { date: d.slice(0, 10) };
  const dt = text(node, "DtTm");
  if (dt) {
    const ms = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(dt) ? dt : `${dt}Z`);
    if (Number.isFinite(ms))
      return { date: berlinCalendarDate(ms), instant: new Date(ms).toISOString().replace(".000Z", "Z") };
  }
  return {};
}

function amountOf(node: unknown): { literal: string; currency: string } | undefined {
  const a = get(node, "Amt");
  const literal = str(a);
  const currency = obj(a)?.["@Ccy"];
  if (!literal || typeof currency !== "string") return undefined;
  return { literal, currency };
}

function signed(cents: number, indicator: string | undefined): number {
  return indicator === "DBIT" ? -Math.abs(cents) : Math.abs(cents);
}

/** Line number of the n-th `<Ntry` element (0-based) for messages (EC-BNK-49 „Zeile {n}“). */
function entryLines(xml: string): number[] {
  const lines: number[] = [];
  let line = 1;
  const re = /\n|<(?:\w+:)?Ntry[\s>]/g;
  for (const m of xml.matchAll(re)) {
    if (m[0] === "\n") line++;
    else lines.push(line);
  }
  return lines;
}

function bankTransactionCode(ntry: Node): { code?: string; proprietary?: string } {
  const domain = text(ntry, "BkTxCd", "Domn", "Cd");
  const family = text(ntry, "BkTxCd", "Domn", "Fmly", "Cd");
  const sub = text(ntry, "BkTxCd", "Domn", "Fmly", "SubFmlyCd");
  const code = domain ? [domain, family, sub].filter(Boolean).join("-") : undefined;
  return {
    ...(code ? { code } : {}),
    ...(text(ntry, "BkTxCd", "Prtry", "Cd") ? { proprietary: text(ntry, "BkTxCd", "Prtry", "Cd") } : {}),
  };
}

function charges(ntry: Node, currency: string): number | undefined {
  let total = 0;
  for (const c of arr(get(ntry, "Chrgs"))) {
    const records = arr(c.Rcrd);
    for (const r of records.length > 0 ? records : [c]) {
      const a = amountOf(r);
      if (!a || a.currency !== currency) continue;
      const p = parseBankAmount(a.literal, a.currency);
      if (p.ok) total += Math.abs(p.value);
    }
  }
  return total > 0 ? total : undefined;
}

/** Party name in v02 (`Dbtr/Nm`) and v08+ (`Dbtr/Pty/Nm`). */
const partyName = (parties: unknown, role: "Dbtr" | "Cdtr") =>
  text(parties, role, "Nm") ?? text(parties, role, "Pty", "Nm");

function detailsOf(tx: Node | undefined, credit: boolean) {
  if (!tx) return {};
  const role = credit ? "Dbtr" : "Cdtr";
  const parties = get(tx, "RltdPties");
  const name = partyName(parties, role) ?? text(parties, credit ? "UltmtDbtr" : "UltmtCdtr", "Nm");
  const iban = text(parties, `${role}Acct`, "Id", "IBAN");
  const bic =
    text(tx, "RltdAgts", `${role}Agt`, "FinInstnId", "BIC") ??
    text(tx, "RltdAgts", `${role}Agt`, "FinInstnId", "BICFI");
  const ustrd = arr(get(tx, "RmtInf"))
    .flatMap((r) => (Array.isArray(r.Ustrd) ? r.Ustrd : [r.Ustrd]))
    .map(str)
    .filter((s): s is string => !!s);
  const strdRef = arr(get(tx, "RmtInf", "Strd"))
    .map((s) => text(s, "CdtrRefInf", "Ref"))
    .find(Boolean);
  const creditorId =
    text(parties, "Cdtr", "Id", "PrvtId", "Othr", "Id") ??
    text(parties, "Cdtr", "Pty", "Id", "PrvtId", "Othr", "Id") ??
    text(tx, "CdtrSchmeId", "Id", "PrvtId", "Othr", "Id");
  const instd = get(tx, "AmtDtls", "InstdAmt");
  const instdAmt = amountOf(instd);
  const rate =
    text(tx, "AmtDtls", "TxAmt", "CcyXchg", "XchgRate") ?? text(tx, "AmtDtls", "InstdAmt", "CcyXchg", "XchgRate");
  return {
    name,
    iban: iban ? normaliseIban(iban) : undefined,
    bic,
    purpose: ustrd.join(" "),
    reference: strdRef,
    endToEndId: ref(text(tx, "Refs", "EndToEndId")),
    mandateRef: ref(text(tx, "Refs", "MndtId")),
    acctSvcrRef: ref(text(tx, "Refs", "AcctSvcrRef")),
    creditorId: creditorId && /^[A-Z]{2}\d{2}/.test(creditorId) ? creditorId : undefined,
    instructed: instdAmt,
    rate,
    addtl: text(tx, "AddtlTxInf"),
  };
}

const compact = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export function parseCamt053(xml: string): Result<ParsedStatement, UnreadableFile> {
  const valid = XMLValidator.validate(xml);
  if (valid !== true) return err(unreadable(valid.err.line, valid.err.msg));
  const ns = /xmlns(?::\w+)?="urn:iso:std:iso:20022:tech:xsd:camt\.053\.001\.(\d{2})"/.exec(xml);
  if (!ns) return err(unreadable(1, "kein camt.053-Kontoauszug (Namespace camt.053.001.xx fehlt)"));
  let root: Node;
  try {
    root = parser.parse(xml) as Node;
  } catch (e) {
    return err(unreadable(1, e instanceof Error ? e.message : String(e)));
  }
  const statements = arr(get(root, "Document", "BkToCstmrStmt", "Stmt"));
  if (statements.length === 0) return err(unreadable(1, "kein Kontoauszug (Stmt) enthalten"));

  const lines = entryLines(xml);
  let entryIndex = 0;
  const transactions: ParsedTransaction[] = [];
  const issues: ParseIssue[] = [];
  const skipped: { line: number; reason: string }[] = [];
  const first = statements[0] as Node;
  const iban = text(first, "Acct", "Id", "IBAN");
  const currency = text(first, "Acct", "Ccy");
  let opening: number | undefined;
  let closing: number | undefined;
  let periodStart: { date?: string; instant?: string } = {};
  let periodEnd: { date?: string; instant?: string } = {};
  let openingDate: string | undefined;
  let closingDate: string | undefined;

  for (const [si, stmt] of statements.entries()) {
    const sIban = text(stmt, "Acct", "Id", "IBAN");
    if (si > 0 && sIban !== iban) return err(unreadable(1, "die Datei enthält Kontoauszüge mehrerer Konten"));
    const balances = new Map<string, { value: number; date?: string }>();
    for (const bal of arr(stmt.Bal)) {
      const cd = text(bal, "Tp", "CdOrPrtry", "Cd");
      const a = amountOf(bal);
      if (!cd || !a) continue;
      const p = parseBankAmount(a.literal, a.currency);
      if (!p.ok) return err(unreadable(1, p.error.message));
      const d = dateOf(get(bal, "Dt")).date;
      balances.set(cd, { value: signed(p.value, text(bal, "CdtDbtInd")), ...(d ? { date: d } : {}) });
    }
    const open = balances.get("OPBD") ?? balances.get("PRCD");
    if (si === 0 && open) {
      opening = open.value;
      openingDate = open.date;
    }
    const close = balances.get("CLBD");
    if (close) {
      closing = close.value;
      closingDate = close.date;
    }
    const fr = get(stmt, "FrToDt");
    if (fr && si === 0) {
      const s = text(fr, "FrDtTm");
      const e = text(fr, "ToDtTm");
      if (s) periodStart = { date: s.slice(0, 10), instant: s };
      if (e) periodEnd = { date: e.slice(0, 10), instant: e };
    } else if (fr) {
      const e = text(fr, "ToDtTm");
      if (e) periodEnd = { date: e.slice(0, 10), instant: e };
    }

    for (const ntry of arr(stmt.Ntry)) {
      const line = lines[entryIndex++] ?? 1;
      const status = text(ntry, "Sts") ?? text(ntry, "Sts", "Cd");
      if (status && status !== "BOOK") {
        skipped.push({ line, reason: `Status ${status} (nicht gebucht)` });
        continue;
      }
      const a = amountOf(ntry);
      if (!a) {
        issues.push({ line, code: "bank_amount_invalid", message: "Ungültiger Betrag in Bankdaten (leer)." });
        continue;
      }
      const amount = parseBankAmount(a.literal, a.currency);
      if (!amount.ok) {
        issues.push({ line, code: amount.error.code, message: amount.error.message });
        continue;
      }
      const indicator = text(ntry, "CdtDbtInd");
      const total = signed(amount.value, indicator);
      const credit = total > 0;
      const booking = dateOf(get(ntry, "BookgDt"));
      const value = dateOf(get(ntry, "ValDt"));
      const bookingDate = booking.date ?? value.date;
      if (!bookingDate) {
        issues.push({ line, code: "bank_date_invalid", message: "Buchungsdatum fehlt." });
        continue;
      }
      const btc = bankTransactionCode(ntry);
      const fee = charges(ntry, a.currency);
      const reversal = text(ntry, "RvslInd") === "true";
      const ntryRef = ref(text(ntry, "AcctSvcrRef"));
      const details = arr(ntry.NtryDtls).flatMap((d) => arr(d.TxDtls));
      const addtlNtry = text(ntry, "AddtlNtryInf");

      // Batch split (BNK-033): only if every TxDtls has its own amount and they add up to the entry.
      const txAmounts = details.map((d) => {
        const da = amountOf(d) ?? amountOf(get(d, "AmtDtls", "TxAmt"));
        if (!da || da.currency !== a.currency) return null;
        const p = parseBankAmount(da.literal, da.currency);
        return p.ok ? signed(p.value, text(d, "CdtDbtInd") ?? indicator) : null;
      });
      const split =
        details.length > 1 &&
        txAmounts.every((x) => x !== null) &&
        (txAmounts as number[]).reduce((s, x) => s + x, 0) === total;
      const parts: { tx: Node | undefined; amount: number; idx: number }[] = split
        ? details.map((d, idx) => ({ tx: d, amount: txAmounts[idx] as number, idx }))
        : [{ tx: details[0], amount: total, idx: 0 }];

      for (const part of parts) {
        const d = detailsOf(part.tx, credit);
        const entryReference = split
          ? (d.acctSvcrRef ?? (ntryRef ? `${ntryRef}/${part.idx + 1}` : undefined))
          : (d.acctSvcrRef ?? ntryRef);
        const raw = JSON.stringify(split ? { ...ntry, NtryDtls: [{ TxDtls: [part.tx] }] } : ntry);
        transactions.push(
          compact<ParsedTransaction>({
            line,
            bookingDate,
            bookedAtRaw: booking.instant,
            valueDate: value.date,
            amountCents: part.amount,
            currency: a.currency,
            counterpartyName: d.name,
            counterpartyIban: d.iban,
            counterpartyBic: d.bic,
            counterpartySource: d.name || d.iban ? "statement" : undefined,
            purpose: d.purpose || (split ? "" : (d.addtl ?? addtlNtry ?? "")),
            reference: d.reference,
            endToEndId: d.endToEndId,
            mandateRef: d.mandateRef,
            creditorId: d.creditorId,
            bankRef: ntryRef,
            entryReference,
            bankTransactionCode: btc.code,
            proprietaryCode: btc.proprietary,
            merchantName: !credit && !d.iban && d.name && btc.code?.includes("CCRD") ? d.name : undefined,
            feeCents: split ? undefined : fee,
            exchangeRate: d.rate,
            instructedAmount:
              d.instructed && d.instructed.currency !== a.currency
                ? (() => {
                    const p = parseBankAmount(d.instructed.literal, d.instructed.currency);
                    return p.ok ? { amountMinor: Math.abs(p.value), currency: d.instructed.currency } : undefined;
                  })()
                : undefined,
            reversal: reversal || undefined,
            raw,
          }),
        );
      }
    }
  }

  const sorted = [...transactions].map((t) => t.bookingDate).sort();
  return ok(
    compact<ParsedStatement>({
      format: "camt053",
      statementId: text(first, "Id"),
      iban: iban ? normaliseIban(iban) : undefined,
      currency,
      periodFrom: periodStart.date ?? openingDate ?? sorted[0],
      periodTo: periodEnd.date ?? closingDate ?? sorted[sorted.length - 1],
      periodStartUtc: periodStart.instant,
      periodEndUtc: periodEnd.instant,
      openingBalanceCents: opening,
      closingBalanceCents: closing,
      balanceSource: opening !== undefined && closing !== undefined ? "statement" : "none",
      transactions,
      issues,
      skipped,
    }),
  );
}
