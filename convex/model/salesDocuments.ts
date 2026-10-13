import type { InvoiceFinalisedEvent } from "../../src/domain/accounting/events";
import { validateCompanyForDocuments } from "../../src/domain/company/validate";
import { ADDRESS_REMOVED_WARNING, attentionLine } from "../../src/domain/contacts/snapshot";
import { buildSnapshot } from "../../src/domain/documents/build-snapshot";
import { revisionNumber } from "../../src/domain/documents/conversion";
import {
  type ArchivedArtifact,
  effectiveMark,
  exportedNotMarkedDue,
  exportedNotMarkedTitle,
  type SendLogRow,
  sentStateOf,
  validateMarkSent,
  validateRetraction,
} from "../../src/domain/documents/dispatch";
import { displayStatus } from "../../src/domain/documents/display-status";
import { carriesReceivable, DRAFT_TYPES, documentPath } from "../../src/domain/documents/doc-types";
import type {
  CompanyContext,
  ContactContext,
  DocumentContext,
  DraftDocument,
  DraftLine,
  ResolvedDraft,
} from "../../src/domain/documents/draft";
import { resolveDraft } from "../../src/domain/documents/draft";
import { buildSnapshotInput, retentionClassFor, retentionUntil } from "../../src/domain/documents/finalize";
import { transition } from "../../src/domain/documents/lifecycle";
import {
  canonicalSnapshotJson,
  type DocumentSnapshot,
  PREVIEW_NUMBER,
  type SnapshotAddress,
  type SnapshotBuyer,
  snapshotHash,
  type TaxCase,
} from "../../src/domain/documents/snapshot";
import { blocking, type Finding, validateDocument } from "../../src/domain/documents/validate";
import type { ValidateOptions, ValidationResult } from "../../src/domain/documents/validate/index";
import { isVatRateKey, VAT_RATE_KEY_LABELS } from "../../src/domain/rules/vat-rates";
import type { DraftValues, MarkSentValues } from "../../src/domain/schemas/documents";
import { companyForValidation, type ProfileData } from "../../src/domain/settings/profile";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { addDays, type CalendarDate } from "../../src/domain/time/calendar-date";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { appendAudit, auditedDelete, auditedInsert, auditedPatch } from "./audit";
import { defaultInvoiceAccount } from "./bankAccounts";
import { getCompanyProfile } from "./companyProfile";
import { contactAddresses, contactChannels, defaultAddressOf, getContact } from "./contacts";
import { chainContextFor, chainReferencesFor, inChain, recomputeChainOf } from "./documentChains";
import { unacknowledgedFailure } from "./integrity";
import { postJournalEntry } from "./journal";
import { defaultLayout } from "./layouts";
import { listCustomFieldDefs, listPaymentMethods, listUnits } from "./lookups";
import { assignCounterNumber, listDefaultRanges, registerDerivedNumber } from "./numberRanges";
import type { ModelCtx, ReadCtx } from "./types";
import { contactChecks } from "./vatChecks";

/**
 * Sales documents (F04) — the only writer of `salesDocuments`, `documentLines`, `documentSnapshots`,
 * `documentArtifacts`, `sendLog` and the document to-dos in `notifications`. P1 invoices core: plain invoices.
 *
 * Extension points for the later slices (quotes, advances/finals, Storno, corrections, reminders):
 *  - `transitionStatus()` checks every status change against src/domain/documents/lifecycle.ts;
 *  - `commitFinalization()` is type-agnostic up to the journal hook (`journalEventFor`) and the number range
 *    (`assignCounterNumber` by `docType`); chain/deduction/original references go into `buildSnapshotInput`;
 *  - `paymentStatus` / `openAmountCents` are initialised here and owned by the payments slice afterwards.
 */

export type SalesDocumentDoc = Doc<"salesDocuments">;
export type DocumentLineDoc = Doc<"documentLines">;

const label = (d: Pick<SalesDocumentDoc, "number" | "type">) => d.number ?? `Entwurf (${d.type})`;

// ── reads ───────────────────────────────────────────────────────────────────────────────────────────────

export async function getDocument(ctx: ReadCtx, id: Id<"salesDocuments">): Promise<SalesDocumentDoc> {
  const d = await ctx.db.get(id);
  if (!d) throw appError("not_found", "Dokument nicht gefunden.");
  return d;
}

export async function documentLines(ctx: ReadCtx, id: Id<"salesDocuments">): Promise<DocumentLineDoc[]> {
  return ctx.db
    .query("documentLines")
    .withIndex("by_document", (q) => q.eq("documentId", id))
    .collect();
}

export async function documentArtifacts(ctx: ReadCtx, id: Id<"salesDocuments">): Promise<Doc<"documentArtifacts">[]> {
  return ctx.db
    .query("documentArtifacts")
    .withIndex("by_document", (q) => q.eq("documentId", id))
    .collect();
}

export async function sendLogOf(ctx: ReadCtx, id: Id<"salesDocuments">): Promise<Doc<"sendLog">[]> {
  return ctx.db
    .query("sendLog")
    .withIndex("by_document_at", (q) => q.eq("documentId", id))
    .collect();
}

export async function snapshotOf(ctx: ReadCtx, doc: SalesDocumentDoc): Promise<DocumentSnapshot | null> {
  if (!doc.snapshotId) return null;
  const s = await ctx.db.get(doc.snapshotId);
  return s ? (JSON.parse(s.json) as DocumentSnapshot) : null;
}

export const sendLogRows = (rows: readonly Doc<"sendLog">[]): SendLogRow[] =>
  rows.map((r) => ({
    id: r._id,
    kind: r.kind,
    ...(r.retractsId ? { retractsId: r.retractsId } : {}),
    sentOn: r.sentOn,
    channel: r.channel,
    at: r.at,
  }));

export const archivedArtifacts = (rows: readonly Doc<"documentArtifacts">[]): ArchivedArtifact[] =>
  rows
    .filter((a) => a.kind === "pdf" || a.kind === "zugferd_pdf" || a.kind === "xrechnung_xml")
    .map((a) => ({ id: a._id, kind: a.kind, variant: a.variant ?? "original", sha256: a.sha256, name: a.name }));

export function displayStatusOf(d: SalesDocumentDoc, today: string) {
  return displayStatus(
    {
      type: d.type,
      status: d.status,
      ...(d.paymentStatus ? { paymentStatus: d.paymentStatus } : {}),
      ...(d.artifactStatus ? { artifactStatus: d.artifactStatus } : {}),
      ...(d.openAmountCents !== undefined ? { openAmountCents: d.openAmountCents } : {}),
      ...(d.dueDate ? { dueDate: d.dueDate } : {}),
    },
    today,
  );
}

// ── stored row ↔ domain draft ───────────────────────────────────────────────────────────────────────────

const LINE_FIELDS = [
  "productId",
  "productType",
  "productSyncedVersion",
  "name",
  "description",
  "quantityMilli",
  "unitCode",
  "unitPriceMicros",
  "discount",
  "vatRateKey",
  "vatCategoryOverride",
  "vatCategory",
  "vatRateBp",
  "exemptionReasonCode",
  "exemptionReasonText",
  "placeOfSupplyRule",
  "reverseCharge13b",
  "linePeriod",
  "isLaborCost",
  "itemNumber",
  "revenueAccount",
  "optional",
  "sourceLineId",
] as const;

function lineFromDoc(l: DocumentLineDoc): DraftLine {
  const out: Record<string, unknown> = { kind: l.kind };
  for (const k of LINE_FIELDS) if (l[k] !== undefined) out[k] = l[k];
  return out as unknown as DraftLine;
}

export function draftFromDoc(
  d: SalesDocumentDoc,
  lines: readonly DocumentLineDoc[],
  billing?: SnapshotAddress,
): DraftDocument {
  return {
    type: d.type,
    ...(d.contactId ? { contactId: d.contactId } : {}),
    ...(billing ? { billingAddress: billing } : {}),
    ...(d.deliveryAddress ? { deliveryAddress: d.deliveryAddress } : {}),
    ...(d.supplyDate ? { supplyDate: d.supplyDate } : {}),
    supplyDateMode: d.supplyDateMode,
    ...(d.documentDate && d.status === "draft" ? { documentDate: d.documentDate } : {}),
    ...(d.backdateReason ? { backdateReason: d.backdateReason } : {}),
    currency: d.currency,
    ...(d.fxRateToEur && d.fxRateToEur.source !== "transaction"
      ? { fxRateToEur: d.fxRateToEur as DraftDocument["fxRateToEur"] }
      : {}),
    priceMode: d.priceMode,
    ...(d.taxCaseOverridden ? { taxCaseOverride: { taxCase: d.taxCase, reason: d.taxCaseOverridden.reason } } : {}),
    ...(d.subject ? { subject: d.subject } : {}),
    ...(d.headText ? { headText: d.headText } : {}),
    ...(d.footText ? { footText: d.footText } : {}),
    ...(d.buyerReference ? { buyerReference: d.buyerReference } : {}),
    ...(d.orderReference ? { orderReference: d.orderReference } : {}),
    ...(d.contractReference ? { contractReference: d.contractReference } : {}),
    paymentTerms: d.paymentTerms,
    showEpcQr: d.showEpcQr,
    ...(d.kleinbetrag ? { kleinbetrag: true } : {}),
    ...(d.propertyRelated ? { propertyRelated: true } : {}),
    ...(d.constructionWork ? { constructionWork: true } : {}),
    ...(d.documentDiscount ? { documentDiscount: d.documentDiscount } : {}),
    language: d.language,
    ...(d.einvoice.format ? { einvoiceFormat: d.einvoice.format } : {}),
    ...(d.validUntil ? { validUntil: d.validUntil } : {}),
    ...(d.deliveryTerms ? { deliveryTerms: d.deliveryTerms } : {}),
    ...(d.showPrices ? { showPrices: true } : {}),
    lines: [...lines].sort((a, b) => a.position - b.position).map(lineFromDoc),
  };
}

// ── context (DOC-22: drafts read the live company and contact; the commit re-reads them, EC-004) ─────────

function sellerFrom(p: Doc<"companyProfile">): CompanyContext["seller"] {
  const { name: _n, street2: _s2, ...address } = p.address as typeof p.address & { street2?: string };
  return {
    legalForm: p.legalForm,
    name: p.name,
    ...(p.tradeName ? { tradeName: p.tradeName } : {}),
    address: {
      street: address.street,
      postalCode: address.postalCode,
      city: address.city,
      countryCode: address.countryCode,
      ...(address.poBox ? { poBox: address.poBox } : {}),
    },
    ...(p.seat ? { seat: p.seat } : {}),
    contact: p.contact,
    ...(p.register ? { register: p.register } : {}),
    representatives: p.representatives,
    ...(p.generalPartner ? { generalPartner: p.generalPartner } : {}),
    ...(p.supervisoryBoardChair ? { supervisoryBoardChair: p.supervisoryBoardChair } : {}),
    ...(p.shareCapital ? { shareCapital: p.shareCapital } : {}),
    ...(p.taxNumber ? { taxNumber: p.taxNumber } : {}),
    ...(p.taxNumberState ? { taxNumberState: p.taxNumberState } : {}),
    ...(p.vatId ? { vatId: p.vatId } : {}),
    ...(p.electronicAddress?.value ? { electronicAddress: p.electronicAddress } : {}),
  };
}

const postal = (a: Doc<"contactAddresses">["address"], buyerName: string): SnapshotAddress => ({
  ...(a.name && a.name !== buyerName ? { name: a.name } : {}),
  ...(a.name2 ? { name2: a.name2 } : {}),
  ...(a.department ? { department: a.department } : {}),
  street: a.street,
  ...(a.street2 ? { street2: a.street2 } : {}),
  postalCode: a.postalCode,
  city: a.city,
  countryCode: a.countryCode,
  ...(a.poBox ? { poBox: a.poBox } : {}),
});

export interface ContactRead {
  context: ContactContext;
  /** The address the draft would freeze (CON-024 fallback applied). */
  billingAddressId?: Id<"contactAddresses">;
  warnings: Finding[];
  printableCustomFields: { label: string; value: string }[];
}

/** Buyer block as frozen now (DOC-22, CON-009/180): a person under an organisation bills the organisation. */
export async function readContact(
  ctx: ReadCtx,
  contactId: Id<"contacts">,
  chosenAddressId?: Id<"contactAddresses">,
): Promise<ContactRead> {
  const contact = await getContact(ctx, contactId);
  const parent = contact.kind === "person" && contact.parentId ? await ctx.db.get(contact.parentId) : null;
  const billingOwner = parent ?? contact;
  const buyerName =
    billingOwner.kind === "organization"
      ? (billingOwner.organizationName ?? billingOwner.displayName)
      : billingOwner.displayName;
  const warnings: Finding[] = [];
  const own = await contactAddresses(ctx, contact._id);
  const ownerAddresses = parent ? [...own, ...(await contactAddresses(ctx, parent._id))] : own;
  let address = chosenAddressId ? ownerAddresses.find((a) => a._id === chosenAddressId) : undefined;
  if (address?.archivedAt !== undefined || (chosenAddressId && !address)) {
    warnings.push({
      code: "address_removed",
      severity: "W",
      rule: "UST-03",
      group: "pflichtangaben",
      message: ADDRESS_REMOVED_WARNING,
      field: "billingAddress",
    });
    address = undefined;
  }
  address ??=
    defaultAddressOf(own, "billing") ??
    (parent ? defaultAddressOf(await contactAddresses(ctx, parent._id), "billing") : undefined);
  const channels = [
    ...(await contactChannels(ctx, contact._id)),
    ...(parent ? await contactChannels(ctx, parent._id) : []),
  ];
  const invoiceEmail = channels.find((c) => c.type === "email" && c.isInvoiceEmail)?.value;
  const src = billingOwner;
  const buyer: SnapshotBuyer = {
    name: buyerName,
    ...(src.kind === "organization" && src.organizationName2 ? { tradeName: src.organizationName2 } : {}),
    ...(address ? { address: postal(address.address, buyerName) } : {}),
    contactNumber: src.number,
    ...(src.vatId ? { vatId: src.vatId } : {}),
    ...(src.taxNumber ? { taxNumber: src.taxNumber } : {}),
    ...(src.registerNumber ? { registerNumber: src.registerNumber } : {}),
    ...(src.electronicAddress ? { electronicAddress: src.electronicAddress } : {}),
    ...(invoiceEmail ? { invoiceEmail } : {}),
    ...(parent ? { contactPerson: { name: attentionLine(contact).replace(/^z\. Hd\. /, "") } } : {}),
    isConsumer: src.isConsumer,
    isPublicAuthority: src.isPublicAuthority,
  };
  const checks = src.vatId ? (await contactChecks(ctx, src._id)).filter((c) => c.vatId === src.vatId) : [];
  const defs = (await listCustomFieldDefs(ctx)).filter(
    (d) => d.entity === "contact" && d.printOnDocuments && !d.archivedAt,
  );
  const printableCustomFields = defs
    .filter((d) => src.customFields[d.key] !== undefined && src.customFields[d.key] !== "")
    .map((d) => ({ label: d.label, value: String(src.customFields[d.key]) }));
  return {
    context: {
      id: contact._id,
      buyer,
      countryCode: address?.address.countryCode ?? "DE",
      isConsumer: src.isConsumer,
      isPublicAuthority: src.isPublicAuthority,
      ...(src.vatId ? { vatId: src.vatId } : {}),
      ...(src.vatIdStatus
        ? { vatIdStatus: { status: src.vatIdStatus.status, qualified: src.vatIdStatus.qualified } }
        : {}),
      vatChecks: [...checks]
        .sort((a, b) => b.checkedAt - a.checkedAt)
        .map((c) => ({
          id: c._id,
          vatId: c.vatId,
          provider: c.provider,
          status: c.status,
          ...(c.qualified ? { qualified: c.qualified } : {}),
          checkedOn: berlinCalendarDate(c.checkedAt),
        })),
      ...(src.defaultTaxCase ? { defaultTaxCase: src.defaultTaxCase as TaxCase } : {}),
      preferredFormat: src.einvoice.preferredFormat,
      pdfConsents: src.einvoice.pdfConsents.map((c) => ({
        givenAt: c.givenAt,
        source: c.source,
        recordedAt: c.recordedAt,
        ...(c.revokedAt ? { revokedAt: c.revokedAt } : {}),
      })),
      certificates13b: src.reverseCharge13bCertificates,
      ...(src.buyerReference ? { buyerReference: src.buyerReference } : {}),
      ...(contact.status === "archived" ? { archived: true } : {}),
    },
    ...(address ? { billingAddressId: address._id } : {}),
    warnings,
    printableCustomFields,
  };
}

export interface LoadedContext {
  ctx: DocumentContext;
  contact: ContactRead | null;
  layoutVersionId: string;
  postalDeliveryDays: number;
}

/** Everything `validateDocument` needs, read in the current transaction. */
export async function loadDocumentContext(
  ctx: ReadCtx,
  doc: SalesDocumentDoc,
  now: number,
  draftLines?: readonly { readonly sourceLineId?: string | undefined }[],
): Promise<LoadedContext> {
  const profile = await getCompanyProfile(ctx);
  const today = berlinCalendarDate(now);
  const contact = doc.contactId ? await readContact(ctx, doc.contactId, doc.billingAddressId) : null;
  const company: CompanyContext = profile
    ? {
        seller: sellerFrom(profile),
        validation: validateCompanyForDocuments(companyForValidation(profile as unknown as ProfileData)),
        kleinunternehmer: profile.kleinunternehmer,
        taxationMethod: profile.taxationMethod,
        priorYearTurnover: profile.priorYearTotalTurnoverCents,
        ...(profile.foundedOn ? { foundedOn: profile.foundedOn } : {}),
        backdateWindowDays: profile.defaults.backdateWindowDays,
        quoteValidityDays: profile.defaults.quoteValidityDays,
        ...(profile.defaults.paymentReferencePrefix
          ? { paymentReferencePrefix: profile.defaults.paymentReferencePrefix }
          : {}),
      }
    : {
        seller: {
          legalForm: "einzelunternehmen",
          name: "",
          address: { street: "", postalCode: "", city: "", countryCode: "DE" },
          contact: { name: "", phone: "", email: "" },
          representatives: [],
        },
        validation: {
          blocking: [{ code: "required", message: "Firmenname fehlt.", params: { field: "name" } }],
          warnings: [],
        },
        kleinunternehmer: [],
        taxationMethod: [],
        priorYearTurnover: [],
        backdateWindowDays: 10,
      };
  const bank = doc.bankAccountId ? await ctx.db.get(doc.bankAccountId) : null;
  const methods = await listPaymentMethods(ctx);
  const method = (doc.paymentMethodId ? methods.find((m) => m._id === doc.paymentMethodId) : undefined) ??
    methods.find((m) => m.isDefault && m.active) ?? { kind: "transfer" as const, text: "Überweisung" };
  const units = (await listUnits(ctx)).filter((u) => u.archivedAt === undefined);
  const layout = await defaultLayout(ctx);
  const locked = (await ctx.db.query("periods").collect())
    .filter((p) => p.status !== "open")
    .map((p) => p.period)
    .sort()
    .at(-1);
  const recentInvoices: { number: string; documentDate: string; grossCents: number; supplyEnd?: string }[] = [];
  let kuYearTurnoverCents = 0;
  const year = today.slice(0, 4);
  if (doc.contactId) {
    for (const d of await ctx.db
      .query("salesDocuments")
      .withIndex("by_contact", (q) => q.eq("contactId", doc.contactId).eq("type", "invoice"))
      .collect()) {
      if (d._id === doc._id || d.status === "draft" || d.status === "cancelled" || !d.number || !d.documentDate)
        continue;
      recentInvoices.push({
        number: d.number,
        documentDate: d.documentDate,
        grossCents: d.totals.grossCents,
        ...(d.supplyDate ? { supplyEnd: supplyEndOf(d.supplyDate) } : {}),
      });
    }
  }
  if (profile?.kleinunternehmer.some((k) => k.isKU)) {
    for (const d of await ctx.db
      .query("salesDocuments")
      .withIndex("by_type_status_date", (q) => q.eq("type", "invoice"))
      .collect()) {
      if (d.status === "draft" || d.status === "cancelled" || !d.documentDate?.startsWith(year)) continue;
      kuYearTurnoverCents += d.totals.grossCents;
    }
  }
  const chain = await chainContextFor(ctx, doc, draftLines ?? []);
  return {
    ctx: {
      ...chain,
      today,
      setupComplete: profile?.setupCompletedAt !== undefined,
      integrityAlertOpen: (await unacknowledgedFailure(ctx)) !== null,
      numberRangeAvailable: (await listDefaultRanges(ctx)).some((r) => r.docTypes.includes(doc.type)),
      company,
      contact: contact?.context ?? null,
      ...(bank?.iban
        ? {
            bankAccount: {
              iban: bank.iban,
              ...(bank.bic ? { bic: bank.bic } : {}),
              accountHolder: bank.accountHolder,
              ...(bank.name ? { bankName: bank.name } : {}),
            },
          }
        : {}),
      paymentMethod: { kind: method.kind, ...(method.text ? { text: method.text } : {}) },
      unitCodes: new Set(units.map((u) => u.code)),
      unitLabels: Object.fromEntries(units.map((u) => [u.code, u.label])),
      ...(locked ? { lockedThrough: `${locked}-31` } : {}),
      recentInvoices,
      kuYearTurnoverCents,
    },
    contact,
    layoutVersionId: layout?.version?._id ?? "default",
    postalDeliveryDays: profile?.receivables.postalDeliveryDays ?? 3,
  };
}

const supplyEndOf = (s: NonNullable<SalesDocumentDoc["supplyDate"]>): string =>
  s.kind === "date" ? s.date : s.kind === "period" ? s.to : `${s.month}-31`;

/** Full validation of a stored draft (compliance panel, preview, commit). */
export async function validateStored(
  ctx: ReadCtx,
  doc: SalesDocumentDoc,
  now: number,
  opts: ValidateOptions = {},
): Promise<{ loaded: LoadedContext; draft: DraftDocument; result: ValidationResult }> {
  const lines = await documentLines(ctx, doc._id);
  const loaded = await loadDocumentContext(ctx, doc, now, lines);
  const draft = draftFromDoc(doc, lines, loaded.contact?.context.buyer.address);
  const result = validateDocument(draft, loaded.ctx, opts);
  const extra = loaded.contact?.warnings ?? [];
  return { loaded, draft, result: extra.length ? { ...result, findings: [...result.findings, ...extra] } : result };
}

// ── draft writes (DOC-03, DOC-52) ─────────────────────────────────────────────────────────────────────────

/** DOC-08: a draft created without bank account / payment method (REST, MCP, conversions) gets the defaults. */
export async function withPaymentDefaults(ctx: ReadCtx, values: DraftValues): Promise<DraftValues> {
  let out = values;
  if (!values.bankAccountId) {
    const bank = await defaultInvoiceAccount(ctx, values.currency);
    if (bank) out = { ...out, bankAccountId: bank._id };
  }
  if (!values.paymentMethodId) {
    const contact = values.contactId ? await ctx.db.get(values.contactId as Id<"contacts">) : null;
    const methods = await listPaymentMethods(ctx);
    const method =
      (contact?.paymentMethodId ? methods.find((m) => m._id === contact.paymentMethodId) : undefined) ??
      methods.find((m) => m.isDefault && m.active);
    if (method) out = { ...out, paymentMethodId: method._id };
  }
  return out;
}

function headerFrom(values: DraftValues) {
  return {
    ...(values.contactId ? { contactId: values.contactId as Id<"contacts"> } : {}),
    ...(values.deliveryAddress ? { deliveryAddress: values.deliveryAddress } : {}),
    ...(values.supplyDate ? { supplyDate: values.supplyDate } : {}),
    supplyDateMode: values.supplyDateMode,
    ...(values.documentDate ? { documentDate: values.documentDate } : {}),
    ...(values.backdateReason?.trim() ? { backdateReason: values.backdateReason.trim() } : {}),
    currency: values.currency,
    ...(values.fxRateToEur ? { fxRateToEur: values.fxRateToEur } : {}),
    priceMode: values.priceMode,
    ...(values.subject ? { subject: values.subject } : {}),
    ...(values.headText ? { headText: values.headText } : {}),
    ...(values.footText ? { footText: values.footText } : {}),
    ...(values.buyerReference?.trim() ? { buyerReference: values.buyerReference.trim() } : {}),
    ...(values.orderReference?.trim() ? { orderReference: values.orderReference.trim() } : {}),
    ...(values.contractReference?.trim() ? { contractReference: values.contractReference.trim() } : {}),
    paymentTerms: values.paymentTerms,
    ...(values.paymentMethodId ? { paymentMethodId: values.paymentMethodId as Id<"paymentMethods"> } : {}),
    ...(values.bankAccountId ? { bankAccountId: values.bankAccountId as Id<"bankAccounts"> } : {}),
    showEpcQr: values.showEpcQr,
    ...(values.kleinbetrag ? { kleinbetrag: true } : {}),
    ...(values.propertyRelated ? { propertyRelated: true } : {}),
    ...(values.constructionWork ? { constructionWork: true } : {}),
    ...(values.documentDiscount ? { documentDiscount: values.documentDiscount } : {}),
    language: values.language,
    ...(values.internalNote ? { internalNote: values.internalNote } : {}),
    ...(values.validUntil && values.type === "quote" ? { validUntil: values.validUntil } : {}),
    ...(values.deliveryTerms?.trim() && (values.type === "quote" || values.type === "order_confirmation")
      ? { deliveryTerms: values.deliveryTerms.trim() }
      : {}),
    ...(values.showPrices && values.type === "delivery_note" ? { showPrices: true } : {}),
  };
}

/** Optional header fields a save may remove (absent in `values` = cleared). */
const CLEARABLE = [
  "contactId",
  "deliveryAddress",
  "supplyDate",
  "documentDate",
  "backdateReason",
  "fxRateToEur",
  "subject",
  "headText",
  "footText",
  "buyerReference",
  "orderReference",
  "contractReference",
  "paymentMethodId",
  "bankAccountId",
  "kleinbetrag",
  "propertyRelated",
  "constructionWork",
  "documentDiscount",
  "internalNote",
  "taxCaseOverridden",
  "billingAddressId",
  "validUntil",
  "deliveryTerms",
  "showPrices",
] as const;

function lineRow(
  l: DraftValues["lines"][number],
  position: number,
  resolved?: ResolvedDraft["lines"][number],
  netCents?: number,
) {
  const row: Record<string, unknown> = { position, kind: l.kind };
  for (const k of LINE_FIELDS) {
    const value = (l as Record<string, unknown>)[k];
    if (value !== undefined && value !== "") row[k] = value;
  }
  delete row.vatCategory;
  delete row.vatRateBp;
  if (resolved) {
    row.vatCategory = resolved.vatCategory;
    row.vatRateBp = resolved.vatRateBp;
  }
  if (netCents !== undefined) row.lineNetCents = netCents;
  return row;
}

const totalsCache = (r: ResolvedDraft): SalesDocumentDoc["totals"] => {
  const t = r.totals;
  if (!t)
    return { netCents: 0, vatCents: 0, grossCents: 0, advancesDeductedGrossCents: 0, payableCents: 0, byGroup: [] };
  return {
    netCents: t.taxExclusiveCents,
    vatCents: t.vatTotalCents,
    grossCents: t.grossCents,
    advancesDeductedGrossCents: t.prepaidCents,
    payableCents: t.payableCents,
    byGroup: t.groups.map((g) => ({
      category: g.vatCategory,
      rateBp: g.rateBp,
      netCents: g.baseCents,
      vatCents: g.vatCents,
    })),
  };
};

async function assertDraft(ctx: ReadCtx, id: Id<"salesDocuments">, version?: number): Promise<SalesDocumentDoc> {
  const doc = await getDocument(ctx, id);
  if (doc.status !== "draft") throw appError("document_not_draft");
  if (version !== undefined && doc.version !== version) {
    throw appError("version_conflict", "Der Entwurf wurde zwischenzeitlich geändert. Bitte Vorschau aktualisieren.");
  }
  return doc;
}

async function assertContactUsable(ctx: ReadCtx, contactId: string | undefined) {
  if (!contactId) return;
  const c = await ctx.db.get(contactId as Id<"contacts">);
  if (!c) throw appError("invalid_input", "Kontakt nicht gefunden.", { reason: "contact_missing" });
}

/**
 * PRD-071 / EC-041: lines from a product take the product's new `vatRateKey` on the next edit; name, price etc.
 * stay as copied ("Produkt geändert – übernehmen?" is offered by the editor).
 */
/**
 * PRD-071 / EC-041: product lines keep their copied texts and price, but take a changed `vatRateKey` of the product on
 * the next save, with the notice „Steuersatz geändert: {alt} → {neu}“.
 */
async function syncProductRateKeys(
  ctx: ReadCtx,
  lines: DraftValues["lines"],
): Promise<{ lines: DraftValues["lines"]; notices: string[] }> {
  const out: DraftValues["lines"] = [];
  const notices: string[] = [];
  const labelOf = (k: string | undefined) => (k && isVatRateKey(k) ? VAT_RATE_KEY_LABELS[k] : (k ?? "–"));
  for (const l of lines) {
    if (l.kind !== "item" || !l.productId) {
      out.push(l);
      continue;
    }
    const product = await ctx.db.get(l.productId as Id<"products">);
    if (product && product.vatRateKey !== l.vatRateKey) {
      if (l.vatRateKey) {
        notices.push(
          `Steuersatz geändert: ${labelOf(l.vatRateKey)} → ${labelOf(product.vatRateKey)} (${l.name ?? product.name})`,
        );
      }
      out.push({ ...l, vatRateKey: product.vatRateKey });
    } else out.push(l);
  }
  return { lines: out, notices };
}

/** Resolves the draft (tax case, rates, totals) against the live context for the cached fields. */
async function resolveForSave(ctx: ReadCtx, doc: SalesDocumentDoc, values: DraftValues, now: number) {
  const loaded = await loadDocumentContext(ctx, doc, now, values.lines);
  const draft: DraftDocument = {
    ...(values as unknown as DraftDocument),
    ...(loaded.contact?.context.buyer.address ? { billingAddress: loaded.contact.context.buyer.address } : {}),
  };
  return { loaded, resolved: resolveDraft(draft, loaded.ctx) };
}

/** Chain relations a conversion or revision sets on the new draft (DOC-33/34, QUO-06/11). */
export interface DraftRelations {
  originId?: Id<"salesDocuments">;
  sourceDocumentIds?: Id<"salesDocuments">[];
  chainRootId?: Id<"salesDocuments">;
  revision?: number;
}

export async function createDraft(
  ctx: ModelCtx,
  input: DraftValues,
  relations: DraftRelations = {},
  opts: { action?: string; reason?: string; billingAddressId?: Id<"contactAddresses"> } = {},
): Promise<Id<"salesDocuments">> {
  const action = opts.action ?? "document.create_draft";
  const reason = opts.reason?.trim() ? { reason: opts.reason.trim() } : {};
  await assertContactUsable(ctx, input.contactId);
  const values = await withPaymentDefaults(ctx, input);
  const { lines } = await syncProductRateKeys(ctx, values.lines);
  const contactName = values.contactId
    ? (await ctx.db.get(values.contactId as Id<"contacts">))?.displayName
    : undefined;
  const base = {
    type: values.type,
    status: "draft" as const,
    ...headerFrom(values),
    ...(contactName ? { contactName } : {}),
    taxCase: "domestic" as const,
    einvoice: values.einvoiceFormat ? { format: values.einvoiceFormat } : {},
    totals: { netCents: 0, vatCents: 0, grossCents: 0, advancesDeductedGrossCents: 0, payableCents: 0, byGroup: [] },
    retentionClass: retentionClassFor(values.type),
    tags: [],
    customFields: {},
    createdBy: ctx.actor,
    channel: ctx.actorContext.channel === "cron" ? ("system" as const) : ctx.actorContext.channel,
    version: 1,
    ...(relations.originId ? { originId: relations.originId } : {}),
    ...(relations.sourceDocumentIds?.length ? { sourceDocumentIds: relations.sourceDocumentIds } : {}),
    ...(relations.chainRootId ? { chainRootId: relations.chainRootId } : {}),
    ...(relations.revision ? { revision: relations.revision } : {}),
    ...(opts.billingAddressId ? { billingAddressId: opts.billingAddressId } : {}),
  };
  const id = await auditedInsert(ctx, "salesDocuments", base, { action, label: "Entwurf", ...reason });
  const doc = await getDocument(ctx, id);
  const { resolved, loaded } = await resolveForSave(ctx, doc, { ...values, lines }, ctx.now());
  let k = 0;
  for (const [i, l] of lines.entries()) {
    const r = l.kind === "item" ? resolved.lines[k] : undefined;
    const net = l.kind === "item" ? resolved.itemNetCents[k++] : undefined;
    await auditedInsert(ctx, "documentLines", { documentId: id, ...lineRow(l, i + 1, r, net) } as never, {
      action,
    });
  }
  await auditedPatch(
    ctx,
    "salesDocuments",
    id,
    {
      taxCase: resolved.taxCase,
      ...(values.taxCaseOverride
        ? {
            taxCaseOverridden: {
              reason: values.taxCaseOverride.reason,
              ...(resolved.derivedTaxCase ? { derived: resolved.derivedTaxCase } : {}),
            },
          }
        : {}),
      ...(loaded.contact?.billingAddressId ? { billingAddressId: loaded.contact.billingAddressId } : {}),
      totals: totalsCache(resolved),
    },
    { action },
  );
  return id;
}

export async function updateDraft(
  ctx: ModelCtx,
  id: Id<"salesDocuments">,
  version: number,
  input: DraftValues,
  opts: { billingAddressId?: Id<"contactAddresses"> } = {},
): Promise<{ version: number; notices: string[] }> {
  const doc = await assertDraft(ctx, id, version);
  if (input.type !== doc.type) {
    throw appError("invalid_input", "Der Dokumenttyp eines Entwurfs kann nicht geändert werden.", {
      reason: "type_immutable",
    });
  }
  await assertContactUsable(ctx, input.contactId);
  const values = await withPaymentDefaults(ctx, input);
  const { lines, notices } = await syncProductRateKeys(ctx, values.lines);
  const contactChanged = (values.contactId ?? undefined) !== doc.contactId;
  const header: Record<string, unknown> = headerFrom(values);
  for (const k of CLEARABLE) if (!(k in header)) header[k] = undefined;
  if (!contactChanged) {
    const addr = opts.billingAddressId ?? doc.billingAddressId;
    if (addr) header.billingAddressId = addr;
  }
  header.contactName = values.contactId
    ? (await ctx.db.get(values.contactId as Id<"contacts">))?.displayName
    : undefined;
  header.einvoice = values.einvoiceFormat ? { format: values.einvoiceFormat } : {};
  const probe = { ...doc, ...header } as SalesDocumentDoc;
  const { resolved, loaded } = await resolveForSave(ctx, probe, { ...values, lines }, ctx.now());
  header.taxCase = resolved.taxCase;
  header.taxCaseOverridden = values.taxCaseOverride
    ? {
        reason: values.taxCaseOverride.reason,
        ...(resolved.derivedTaxCase ? { derived: resolved.derivedTaxCase } : {}),
      }
    : undefined;
  if (loaded.contact?.billingAddressId && !header.billingAddressId)
    header.billingAddressId = loaded.contact.billingAddressId;
  header.totals = totalsCache(resolved);
  header.version = doc.version + 1;

  // Lines: patch in place by position, insert extra, delete surplus — only changed rows are written (and audited).
  const existing = (await documentLines(ctx, id)).sort((a, b) => a.position - b.position);
  let k = 0;
  for (const [i, l] of lines.entries()) {
    const r = l.kind === "item" ? resolved.lines[k] : undefined;
    const net = l.kind === "item" ? resolved.itemNetCents[k++] : undefined;
    const row = lineRow(l, i + 1, r, net);
    const old = existing[i];
    if (old) {
      const patch: Record<string, unknown> = { ...row };
      for (const f of [...LINE_FIELDS, "lineNetCents"]) if (!(f in patch)) patch[f] = undefined;
      await auditedPatch(ctx, "documentLines", old._id, patch as never, { action: "document.update_draft" });
    } else {
      await auditedInsert(ctx, "documentLines", { documentId: id, ...row } as never, {
        action: "document.update_draft",
      });
    }
  }
  for (const old of existing.slice(lines.length)) {
    await auditedDelete(ctx, "documentLines", old._id, { action: "document.update_draft" });
  }
  await auditedPatch(ctx, "salesDocuments", id, header as never, {
    action: "document.update_draft",
    label: label(doc),
  });
  return { version: doc.version + 1, notices };
}

/** DOC-03: drafts are deletable; the audit log keeps the full content (no number was consumed, EC-013). */
export async function deleteDraft(ctx: ModelCtx, id: Id<"salesDocuments">): Promise<void> {
  const doc = await assertDraft(ctx, id);
  const t = transition(doc.type, doc.status, "delete");
  if (!t.ok) throw appError("illegal_transition", t.error.message);
  for (const l of await documentLines(ctx, id)) {
    await auditedDelete(ctx, "documentLines", l._id, { action: "document.delete_draft" });
  }
  await auditedDelete(ctx, "salesDocuments", id, { action: "document.delete_draft", label: label(doc) });
}

// ── status changes (DOC-02) ───────────────────────────────────────────────────────────────────────────────

/** Every status change goes through the lifecycle table of the type. */
export function nextStatus(doc: SalesDocumentDoc, event: Parameters<typeof transition>[2]) {
  const t = transition(doc.type, doc.status, event);
  if (!t.ok || t.value === null) throw appError("illegal_transition", t.ok ? undefined : t.error.message);
  return t.value;
}

// ── finalisation (DOC-24…28, §4.6) ──────────────────────────────────────────────────────────────────────────

export interface FinalizeOptions {
  /** Chosen earlier document date (DOC-26); default = Berlin date of the commit instant. */
  documentDate?: string;
  backdateReason?: string;
  /** EC-044 / CON-071 audited releases. */
  overrides?: { vatCheck?: { reason: string }; rc13bCertificate?: { reason: string } };
}

const OVERRIDE_MIN = 10;

function validateOptions(o: FinalizeOptions): ValidateOptions {
  return {
    vatCheckOverride: (o.overrides?.vatCheck?.reason.trim().length ?? 0) >= OVERRIDE_MIN,
    rc13bConfirmed: (o.overrides?.rc13bCertificate?.reason.trim().length ?? 0) >= OVERRIDE_MIN,
  };
}

/** Draft with the finalisation options applied (document date, backdate reason). */
function withOptions(doc: SalesDocumentDoc, o: FinalizeOptions): SalesDocumentDoc {
  return {
    ...doc,
    ...(o.documentDate ? { documentDate: o.documentDate } : {}),
    ...(o.backdateReason?.trim() ? { backdateReason: o.backdateReason.trim() } : {}),
  };
}

export interface FinalizePreview {
  findings: Finding[];
  snapshot: DocumentSnapshot | null;
  format: NonNullable<SalesDocumentDoc["einvoice"]["format"]>;
  decision: NonNullable<SalesDocumentDoc["einvoice"]["decision"]>;
  documentDate: string;
}

/** Step 1a/1b: validation and the preview snapshot with number PREVIEW-0000 (nothing is written). */
export async function finalizePreview(
  ctx: ReadCtx,
  id: Id<"salesDocuments">,
  now: number,
  o: FinalizeOptions = {},
): Promise<FinalizePreview> {
  const doc = withOptions(await getDocument(ctx, id), o);
  const { loaded, draft, result } = await validateStored(ctx, doc, now, validateOptions(o));
  const documentDate = result.resolved.documentDate;
  const base = {
    findings: [...result.findings],
    format: result.einvoice.format,
    decision: result.einvoice.er03.decision,
    documentDate,
  };
  if (blocking(result.findings).length > 0 || !loaded.ctx.contact) return { ...base, snapshot: null };
  const input = buildSnapshotInput(draft, loaded.ctx, result.resolved, {
    number: PREVIEW_NUMBER,
    documentDate,
    layoutVersionId: loaded.layoutVersionId,
    plan: result.einvoice,
  });
  const snap = buildSnapshot({
    ...input,
    ...(loaded.contact?.printableCustomFields.length ? { customFields: loaded.contact.printableCustomFields } : {}),
  });
  if (!snap.ok) {
    return {
      ...base,
      findings: [
        ...base.findings,
        { code: snap.error.code, severity: "E", rule: "UST-03", group: "pflichtangaben", message: snap.error.message },
      ],
      snapshot: null,
    };
  }
  return { ...base, snapshot: snap.value };
}

export type CommitResult =
  | { status: "finalized"; number: string; idempotentReplay: boolean }
  | { status: "invalid"; findings: Finding[] };

/** INV-31: the journal event of a finalised invoice-family document (plain invoices in this slice). */
function journalEventFor(doc: SalesDocumentDoc, s: DocumentSnapshot): InvoiceFinalisedEvent | null {
  if (doc.type !== "invoice" || !s.supplyDate) return null;
  return {
    kind: "invoice_finalised",
    documentId: doc._id,
    documentNumber: s.number,
    documentType: "invoice",
    date: s.documentDate,
    supplyDate: s.supplyDate,
    taxCase: s.taxCase,
    ...(doc.contactId ? { contactId: doc.contactId } : { contactId: "" }),
    counterpartyName: s.buyer.name,
    vatGroups: s.totals.byGroup.map((g) => ({
      category: g.category,
      rateBp: g.rateBp,
      netCents: g.baseCents,
      vatCents: g.vatCents,
    })),
  };
}

/**
 * Step 2 (single transaction): version check, re-validation against freshly read data (EC-004), KU-01, number,
 * snapshot + hash, status/dates/decision, `artifactStatus = pending`, retention, journal, audit. Returns the number;
 * the caller schedules step 3 (`renderArtifacts`). Idempotent per (document, version) (§4.6.4, EC-002).
 */
export async function commitFinalization(
  ctx: ModelCtx,
  id: Id<"salesDocuments">,
  version: number,
  o: FinalizeOptions & { validation: "passed" | "skipped" | "not_required" },
): Promise<CommitResult> {
  const stored = await getDocument(ctx, id);
  if (stored.status !== "draft") {
    if (stored.finalizedFromVersion === version && stored.number) {
      return { status: "finalized", number: stored.number, idempotentReplay: true };
    }
    throw appError("document_not_draft");
  }
  if (stored.version !== version) {
    throw appError("version_conflict", "Der Entwurf wurde zwischenzeitlich geändert. Bitte Vorschau aktualisieren.");
  }
  const now = ctx.now();
  const doc = withOptions(stored, o);
  const { loaded, draft, result } = await validateStored(ctx, doc, now, validateOptions(o));
  const errors = blocking(result.findings);
  if (errors.length > 0) return { status: "invalid", findings: errors };
  const documentDate = result.resolved.documentDate;
  const predecessor = await revisedQuoteOf(ctx, stored);
  const assigned = await assignDocumentNumber(ctx, stored, documentDate, predecessor).catch((e: unknown) => {
    const reason = (e as { data?: { reason?: string } }).data?.reason;
    if (reason === "NUMBER_COLLISION") throw appError("number_conflict", (e as Error).message);
    throw e;
  });
  const chainReferences = await chainReferencesFor(ctx, stored);
  const input = buildSnapshotInput(draft, loaded.ctx, result.resolved, {
    number: assigned.number,
    documentDate,
    layoutVersionId: loaded.layoutVersionId,
    plan: result.einvoice,
    ...(Object.keys(chainReferences).length ? { chainReferences } : {}),
  });
  const built = buildSnapshot({
    ...input,
    ...(loaded.contact?.printableCustomFields.length ? { customFields: loaded.contact.printableCustomFields } : {}),
  });
  if (!built.ok) throw appError("validation_failed", built.error.message, { reason: built.error.code });
  const snapshot = built.value;
  const json = canonicalSnapshotJson(snapshot);
  const hash = await snapshotHash(snapshot);
  const snapshotId = await auditedInsert(
    ctx,
    "documentSnapshots",
    {
      documentId: id,
      json,
      snapshotHash: hash,
      ruleVersions: { ...snapshot.ruleVersions },
      layoutVersionId: snapshot.layoutVersionId,
      createdAt: now,
    },
    { action: "document.finalize", label: assigned.number },
  );
  const payable = snapshot.totals.payableCents;
  const status = nextStatus(stored, "finalize");
  const reasons = [o.backdateReason, o.overrides?.vatCheck?.reason, o.overrides?.rc13bCertificate?.reason].filter(
    Boolean,
  );
  await auditedPatch(
    ctx,
    "salesDocuments",
    id,
    {
      status,
      number: assigned.number,
      ...(assigned.rangeId ? { numberRangeId: assigned.rangeId } : {}),
      documentDate,
      ...(snapshot.supplyDate ? { supplyDate: snapshot.supplyDate } : {}),
      ...(snapshot.dueDate ? { dueDate: snapshot.dueDate } : {}),
      ...(o.backdateReason?.trim() ? { backdateReason: o.backdateReason.trim() } : {}),
      taxCase: snapshot.taxCase,
      contactName: snapshot.buyer.name,
      ...(loaded.contact?.billingAddressId ? { billingAddressId: loaded.contact.billingAddressId } : {}),
      einvoice: {
        format: snapshot.einvoice.format,
        decision: result.einvoice.er03.decision,
        decidedAt: now,
        validation: o.validation,
      },
      ...(o.overrides ? { overrides: o.overrides } : {}),
      totals: totalsCache(result.resolved),
      // Only the invoice family opens a receivable (03 §4); quotes, orders, delivery notes and proforma never do.
      ...(carriesReceivable(stored.type)
        ? { paymentStatus: payable <= 0 ? ("paid" as const) : ("open" as const), openAmountCents: payable }
        : {}),
      ...(snapshot.validUntil ? { validUntil: snapshot.validUntil } : {}),
      snapshotId,
      artifactStatus: "pending",
      artifactAttempts: 0,
      finalizedAt: now,
      finalizedBy: ctx.actor,
      finalizedFromVersion: version,
      retentionClass: retentionClassFor(doc.type),
      retentionUntil: retentionUntil(doc.type, documentDate),
    },
    { action: "document.finalize", label: assigned.number, ...(reasons.length ? { reason: reasons.join(" · ") } : {}) },
  );
  const event = journalEventFor(stored, snapshot);
  if (event) await postJournalEntry(ctx, event);
  if (predecessor) {
    // QUO-06: finalising the new version replaces the previous one (T-QUO-004).
    await auditedPatch(
      ctx,
      "salesDocuments",
      predecessor._id,
      { status: nextStatus(predecessor, "supersede") },
      { action: "document.supersede", label: label(predecessor), reason: `Ersetzt durch ${assigned.number}` },
    );
  }
  const finalized = await getDocument(ctx, id);
  if (await inChain(ctx, finalized)) await recomputeChainOf(ctx, finalized, "document.progress");
  return { status: "finalized", number: assigned.number, idempotentReplay: false };
}

/** The previous quote version a revision draft replaces (QUO-06); it must still be replaceable at the commit. */
async function revisedQuoteOf(ctx: ReadCtx, doc: SalesDocumentDoc): Promise<SalesDocumentDoc | null> {
  if (doc.type !== "quote" || !doc.originId || (doc.revision ?? 1) < 2) return null;
  const prev = await ctx.db.get(doc.originId);
  if (prev?.type !== "quote") return null;
  const t = transition(prev.type, prev.status, "supersede");
  if (!t.ok || t.value === null) {
    throw appError(
      "conflict",
      `${label(prev)} ist ${prev.status === "accepted" ? "angenommen" : "nicht mehr ersetzbar"}; die neue Version kann nicht fertiggestellt werden.`,
      { reason: prev.status === "accepted" ? "quote_accepted_frozen" : "illegal_transition" },
    );
  }
  return prev;
}

/**
 * DOC-25 number: the next number of the type's default range — except a quote revision in `suffix` mode
 * (`quoteRevisionNumbering`, QUO-06), which takes `{number of version 1}-V{n}`.
 */
async function assignDocumentNumber(
  ctx: ModelCtx,
  doc: SalesDocumentDoc,
  documentDate: string,
  predecessor: SalesDocumentDoc | null,
): Promise<{ number: string; rangeId?: Id<"numberRanges"> }> {
  const profile = await getCompanyProfile(ctx);
  if (predecessor && (profile?.defaults.quoteRevisionNumbering ?? "suffix") === "suffix") {
    let first: SalesDocumentDoc = predecessor;
    for (let i = 0; i < 100 && first.originId && (first.revision ?? 1) > 1; i++) {
      const prev = await ctx.db.get(first.originId);
      if (prev?.type !== "quote") break;
      first = prev;
    }
    const number = revisionNumber(first.number ?? "", doc.revision ?? 2);
    await registerDerivedNumber(ctx, {
      number,
      ...(first.numberRangeId ? { rangeId: first.numberRangeId } : {}),
      docType: doc.type,
      documentId: doc._id,
      action: "document.finalize",
    });
    return { number, ...(first.numberRangeId ? { rangeId: first.numberRangeId } : {}) };
  }
  const [year, month] = documentDate.split("-").map(Number) as [number, number];
  return assignCounterNumber(ctx, {
    docType: doc.type,
    date: { year, month },
    documentId: doc._id,
    action: "document.finalize",
  });
}

// ── artifacts (DOC-28, §4.6.5) ──────────────────────────────────────────────────────────────────────────────

/** Retry schedule of step 3: 10 s, 1 min, 5 min, 30 min, 2 h (02 §6, EC-005/006). */
export const ARTIFACT_RETRY_DELAYS_MS = [10_000, 60_000, 300_000, 1_800_000, 7_200_000] as const;

export interface StoredArtifact {
  kind: Doc<"documentArtifacts">["kind"];
  variant?: "original" | "copy" | "reading";
  storageId: Id<"_storage">;
  sha256: string;
  bytes: number;
  mime: string;
  name: string;
  tool?: { name: string; version: string; config?: string };
}

export async function recordArtifacts(
  ctx: ModelCtx,
  id: Id<"salesDocuments">,
  artifacts: readonly StoredArtifact[],
  opts: { initial: boolean },
): Promise<Id<"documentArtifacts">[]> {
  const doc = await getDocument(ctx, id);
  if (doc.status === "draft") throw appError("document_not_draft");
  const ids: Id<"documentArtifacts">[] = [];
  const action = opts.initial ? "document.artifacts_ready" : "document.artifact_archived";
  for (const a of artifacts) {
    ids.push(
      await auditedInsert(
        ctx,
        "documentArtifacts",
        {
          documentId: id,
          ...a,
          createdAt: ctx.now(),
          retentionUntil: doc.retentionUntil ?? retentionUntil(doc.type, doc.documentDate ?? "2000-01-01"),
        },
        { action, label: `${label(doc)} · ${a.name}` },
      ),
    );
  }
  if (opts.initial && doc.artifactStatus !== "ready") {
    await auditedPatch(ctx, "salesDocuments", id, { artifactStatus: "ready" }, { action, label: label(doc) });
  }
  return ids;
}

/** A failed attempt: retry later, or `blocked` + alert after the last retry (EC-005/006). */
export async function recordArtifactFailure(
  ctx: ModelCtx,
  id: Id<"salesDocuments">,
  error: string,
): Promise<{ retryInMs: number | null }> {
  const doc = await getDocument(ctx, id);
  if (doc.artifactStatus !== "pending") return { retryInMs: null }; // a late failure after a successful retry
  const attempts = (doc.artifactAttempts ?? 0) + 1;
  const delay = ARTIFACT_RETRY_DELAYS_MS[attempts - 1];
  if (delay !== undefined) {
    await auditedPatch(
      ctx,
      "salesDocuments",
      id,
      { artifactAttempts: attempts, artifactError: error.slice(0, 2000) } as never,
      {
        action: "document.artifacts_retry",
        label: label(doc),
      },
    );
    return { retryInMs: delay };
  }
  await auditedPatch(
    ctx,
    "salesDocuments",
    id,
    { artifactStatus: "blocked", artifactAttempts: attempts, artifactError: error.slice(0, 2000) } as never,
    { action: "document.artifacts_blocked", label: label(doc) },
  );
  await upsertNotification(ctx, {
    kind: "artifacts_blocked",
    severity: "error",
    title: `E-Rechnung konnte nicht erzeugt werden: ${label(doc)}`,
    body: error.slice(0, 500),
    link: documentPath(doc.type, id),
    entity: { table: "salesDocuments", id },
    dedupeKey: `artifacts_blocked:${id}`,
  });
  return { retryInMs: null };
}

/** Step-3 action in `_scheduled_functions` (the backend records "documentArtifacts.js:render"). */
const isRenderJob = (name: string) => name.replace(/\.js:/, ":") === "documentArtifacts:render";

/**
 * EC-005 watchdog: a render whose process died (e.g. an unhandled rejection inside a dependency ends the Node action
 * before it reaches `artifactFailure`) leaves the document `pending` with no job. Each such document gets a failed
 * attempt recorded; the returned ids are re-rendered by the caller (or end `blocked` after the last retry).
 */
export async function orphanedArtifactRenders(ctx: ModelCtx): Promise<Id<"salesDocuments">[]> {
  const pending = await ctx.db
    .query("salesDocuments")
    .withIndex("by_artifactStatus", (q) => q.eq("artifactStatus", "pending"))
    .collect();
  if (pending.length === 0) return [];
  const running = new Set<string>();
  for (const j of await ctx.db.system.query("_scheduled_functions").collect()) {
    if (!isRenderJob(j.name) || (j.state.kind !== "pending" && j.state.kind !== "inProgress")) continue;
    const arg = j.args[0] as { id?: string } | undefined;
    if (arg?.id) running.add(arg.id);
  }
  const restart: Id<"salesDocuments">[] = [];
  for (const d of pending) {
    if (running.has(d._id)) continue;
    const r = await recordArtifactFailure(ctx, d._id, "Erzeugung abgebrochen (Prozess beendet)");
    if (r.retryInMs !== null) restart.push(d._id);
  }
  return restart;
}

/** „Erneut erzeugen“ (§4.6.5): back to `pending` from `blocked`, re-rendered from the unchanged snapshot. */
export async function restartArtifacts(ctx: ModelCtx, id: Id<"salesDocuments">): Promise<void> {
  const doc = await getDocument(ctx, id);
  if (doc.artifactStatus !== "blocked")
    throw appError("conflict", "Die Dateien werden bereits erzeugt oder liegen vor.");
  await auditedPatch(ctx, "salesDocuments", id, { artifactStatus: "pending", artifactAttempts: 0 } as never, {
    action: "document.artifacts_retry",
    label: label(doc),
  });
  await resolveNotifications(ctx, id, "artifacts_blocked");
}

// ── export (SND-05, SND-06, SND-16, SND-22) ───────────────────────────────────────────────────────────────────

export const EXPORT_ENTITY = "documentExports";

/** Records an export: audit `document.export` with artifact IDs + sha256 + variant; `firstExportedAt` once. */
export async function recordExport(
  ctx: ModelCtx,
  id: Id<"salesDocuments">,
  input: { artifactIds: readonly Id<"documentArtifacts">[]; entry: string; original: boolean; reason?: string },
): Promise<void> {
  const doc = await getDocument(ctx, id);
  if (doc.status === "draft") throw appError("document_not_draft");
  const rows = await documentArtifacts(ctx, id);
  const files = input.artifactIds.map((aid) => {
    const a = rows.find((r) => r._id === aid);
    if (!a) throw appError("invalid_input", "Datei gehört nicht zu diesem Dokument.");
    return { artifactId: a._id, sha256: a.sha256, variant: a.variant ?? "original", name: a.name };
  });
  const forSending = input.entry !== "archive";
  if (forSending && doc.firstExportedAt === undefined) {
    await auditedPatch(
      ctx,
      "salesDocuments",
      id,
      { firstExportedAt: ctx.now() },
      { action: "document.export", label: label(doc) },
    );
  }
  // Pseudo-entity "documentExports" (keyed by the document id): the entry carries what left the system without
  // being a state diff of the document (RI-15 replays only real tables).
  await appendAudit(ctx, {
    action: input.original && doc.sentAt !== undefined ? "document.download_original" : "document.export",
    entity: { table: EXPORT_ENTITY, id, label: label(doc) },
    diff: { after: { entry: input.entry, files } },
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
  });
}

/** Latest export's artifact IDs (preselection in the mark dialog, SND-07). */
export async function lastExportArtifactIds(ctx: ReadCtx, id: Id<"salesDocuments">): Promise<string[] | undefined> {
  const entries = await ctx.db
    .query("auditLog")
    .withIndex("by_entity", (q) => q.eq("entity.table", EXPORT_ENTITY).eq("entity.id", id))
    .order("desc")
    .take(1);
  const last = entries.find((e) => e.action === "document.export" || e.action === "document.download_original");
  const files = (last?.diff as { after?: { files?: { artifactId: string }[] } } | undefined)?.after?.files;
  return files?.map((f) => f.artifactId);
}

// ── sent mark and retraction (SND-07, SND-17, SND-18, SND-23) ─────────────────────────────────────────────────

export async function markSent(
  ctx: ModelCtx,
  id: Id<"salesDocuments">,
  values: MarkSentValues,
): Promise<{ sendLogId: Id<"sendLog">; firstEffective: boolean; warnings: Finding[] }> {
  const doc = await getDocument(ctx, id);
  if (doc.status !== "finalized" && doc.status !== "sent") {
    throw appError("illegal_transition", "Nur fertiggestellte Dokumente können als versendet markiert werden.");
  }
  const profile = await getCompanyProfile(ctx);
  const contact = doc.contactId ? await ctx.db.get(doc.contactId) : null;
  const log = await sendLogOf(ctx, id);
  const r = validateMarkSent(
    {
      sentOn: values.sentOn,
      channel: values.channel as SendLogRow["channel"],
      ...(values.note ? { note: values.note } : {}),
      ...(values.electronicConfirmed ? { electronicConfirmed: true } : {}),
      artifactIds: values.artifactIds,
      ...(values.suppliedSha256 ? { suppliedSha256: values.suppliedSha256 } : {}),
    },
    {
      today: berlinCalendarDate(ctx.now()),
      finalizedOn: berlinCalendarDate(doc.finalizedAt ?? ctx.now()),
      backdateWindowDays: profile?.defaults.backdateWindowDays ?? 10,
      artifactStatus: doc.artifactStatus,
      artifacts: archivedArtifacts(await documentArtifacts(ctx, id)),
      ...(doc.einvoice.decision ? { decision: doc.einvoice.decision } : {}),
      consents: (contact?.einvoice.pdfConsents ?? []).map((c) => ({
        givenAt: c.givenAt,
        source: c.source,
        recordedAt: c.recordedAt,
        ...(c.revokedAt ? { revokedAt: c.revokedAt } : {}),
      })),
      sendLog: sendLogRows(log),
    },
  );
  const errors = blocking([...r.findings]);
  if (errors.length > 0) {
    throw appError("mark_sent_invalid", errors[0]?.message, {
      reason: errors[0]?.code ?? "mark_sent_invalid",
      findings: errors.map((f) => ({ code: f.code, message: f.message })),
    });
  }
  const now = ctx.now();
  const sendLogId = await auditedInsert(
    ctx,
    "sendLog",
    {
      documentId: id,
      purpose: "document",
      kind: "mark_sent",
      sentOn: values.sentOn,
      channel: values.channel as SendLogRow["channel"],
      ...(values.note?.trim() ? { note: values.note.trim() } : {}),
      artifacts: r.artifacts.map((a) => ({ artifactId: a.artifactId as Id<"documentArtifacts">, sha256: a.sha256 })),
      ...(r.einvoiceHandedOverElectronically ? { einvoiceHandedOverElectronically: true } : {}),
      at: now,
      actor: ctx.actor,
    },
    { action: "document.mark_sent", label: label(doc) },
  );
  if (r.firstEffective) {
    const state = sentStateOf(sendLogRows(await sendLogOf(ctx, id)), profile?.receivables.postalDeliveryDays ?? 3);
    await auditedPatch(
      ctx,
      "salesDocuments",
      id,
      {
        status: nextStatus(doc, "mark_sent"),
        sentAt: now,
        ...(state.sentOn ? { sentOn: state.sentOn } : {}),
        ...(state.zugang ? { zugang: state.zugang } : {}),
      },
      { action: "document.mark_sent", label: label(doc) },
    );
    await resolveNotifications(ctx, id, "exported_not_marked");
  }
  return { sendLogId, firstEffective: r.firstEffective, warnings: r.findings.filter((f) => f.severity !== "E") };
}

export async function retractMark(
  ctx: ModelCtx,
  id: Id<"salesDocuments">,
  input: { retractsId: string; reason: string },
): Promise<{ status: string }> {
  const doc = await getDocument(ctx, id);
  const profile = await getCompanyProfile(ctx);
  const rows = sendLogRows(await sendLogOf(ctx, id));
  const r = validateRetraction(input, rows, {
    postalDeliveryDays: profile?.receivables.postalDeliveryDays ?? 3,
    at: ctx.now(),
  });
  const errors = blocking([...r.findings]);
  if (errors.length > 0)
    throw appError("retraction_invalid", errors[0]?.message, { reason: errors[0]?.code ?? "retraction_invalid" });
  const target = rows.find((x) => x.id === input.retractsId);
  await auditedInsert(
    ctx,
    "sendLog",
    {
      documentId: id,
      purpose: "document",
      kind: "retraction",
      retractsId: input.retractsId as Id<"sendLog">,
      sentOn: target?.sentOn ?? berlinCalendarDate(ctx.now()),
      channel: target?.channel ?? "other",
      note: input.reason.trim(),
      artifacts: [],
      at: ctx.now(),
      actor: ctx.actor,
    },
    { action: "document.mark_sent_retracted", label: label(doc), reason: input.reason.trim() },
  );
  if (!r.wasEffective) return { status: doc.status };
  if (r.next.status === "finalized") {
    await auditedPatch(
      ctx,
      "salesDocuments",
      id,
      { status: nextStatus(doc, "retract_mark"), sentAt: undefined, sentOn: undefined, zugang: undefined },
      { action: "document.mark_sent_retracted", label: label(doc), reason: input.reason.trim() },
    );
    return { status: "finalized" };
  }
  const next = effectiveMark(await sendLogRowsAfter(ctx, id));
  await auditedPatch(
    ctx,
    "salesDocuments",
    id,
    { sentAt: next?.at, sentOn: r.next.sentOn, zugang: r.next.zugang },
    { action: "document.mark_sent_retracted", label: label(doc), reason: input.reason.trim() },
  );
  return { status: doc.status };
}

const sendLogRowsAfter = async (ctx: ReadCtx, id: Id<"salesDocuments">) => sendLogRows(await sendLogOf(ctx, id));

// ── to-dos (SND-21, 03 §10) ──────────────────────────────────────────────────────────────────────────────────

interface NotificationInput {
  kind: string;
  severity: Doc<"notifications">["severity"];
  title: string;
  body?: string;
  link?: string;
  entity?: { table: string; id: string };
  dedupeKey: string;
}

export async function upsertNotification(ctx: ModelCtx, n: NotificationInput): Promise<Id<"notifications">> {
  const existing = await ctx.db
    .query("notifications")
    .withIndex("by_dedupe", (q) => q.eq("dedupeKey", n.dedupeKey))
    .first();
  if (existing && existing.resolvedAt === undefined) return existing._id;
  if (existing) {
    await auditedPatch(
      ctx,
      "notifications",
      existing._id,
      { resolvedAt: undefined, readAt: undefined, count: existing.count + 1, title: n.title },
      {
        action: "notification.create",
      },
    );
    return existing._id;
  }
  return auditedInsert(
    ctx,
    "notifications",
    { ...n, count: 1, createdAt: ctx.now() },
    { action: "notification.create", label: n.title },
  );
}

export async function resolveNotifications(
  ctx: ModelCtx,
  documentId: Id<"salesDocuments">,
  kind: string,
): Promise<void> {
  for (const n of await ctx.db
    .query("notifications")
    .withIndex("by_entity", (q) => q.eq("entity.table", "salesDocuments").eq("entity.id", documentId))
    .collect()) {
    if (n.kind === kind && n.resolvedAt === undefined) {
      await auditedPatch(ctx, "notifications", n._id, { resolvedAt: ctx.now() }, { action: "notification.resolve" });
    }
  }
}

/** `deadlines.notify` (02 §7): creates the SND-21 to-dos; returns how many were created. */
export async function notifyExportedNotMarked(ctx: ModelCtx): Promise<number> {
  const today = berlinCalendarDate(ctx.now());
  let created = 0;
  for (const d of await ctx.db
    .query("salesDocuments")
    .withIndex("by_firstExportedAt", (q) => q.eq("status", "finalized").gt("firstExportedAt", 0))
    .collect()) {
    const due = exportedNotMarkedDue({
      firstExportedOn: d.firstExportedAt !== undefined ? berlinCalendarDate(d.firstExportedAt) : undefined,
      status: d.status,
      hasEffectiveMark: effectiveMark(sendLogRows(await sendLogOf(ctx, d._id))) !== null,
      today,
    });
    if (!due || !d.number) continue;
    const key = `exported_not_marked:${d._id}`;
    const existing = await ctx.db
      .query("notifications")
      .withIndex("by_dedupe", (q) => q.eq("dedupeKey", key))
      .first();
    if (existing && existing.resolvedAt === undefined) continue;
    await upsertNotification(ctx, {
      kind: "exported_not_marked",
      severity: "warning",
      title: exportedNotMarkedTitle(d.number),
      link: documentPath(d.type, d._id),
      entity: { table: "salesDocuments", id: d._id },
      dedupeKey: key,
    });
    created++;
  }
  return created;
}

export async function openTodos(ctx: ReadCtx): Promise<Doc<"notifications">[]> {
  return ctx.db
    .query("notifications")
    .withIndex("by_open", (q) => q.eq("resolvedAt", undefined))
    .order("desc")
    .take(100);
}

// ── usage counts for contacts/products (CON-024, CON-150, PRD-062, F01 SET-021) ──────────────────────────────

export async function documentsOfContact(ctx: ReadCtx, contactId: Id<"contacts">): Promise<SalesDocumentDoc[]> {
  return ctx.db
    .query("salesDocuments")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .collect();
}

export async function countDrafts(ctx: ReadCtx): Promise<number> {
  let n = 0;
  for (const type of DRAFT_TYPES) {
    n += (
      await ctx.db
        .query("salesDocuments")
        .withIndex("by_type_status_date", (q) => q.eq("type", type).eq("status", "draft"))
        .collect()
    ).length;
  }
  return n;
}

export async function linesUsingProduct(ctx: ReadCtx, productId: Id<"products">): Promise<number> {
  return (
    await ctx.db
      .query("documentLines")
      .withIndex("by_product", (q) => q.eq("productId", productId))
      .collect()
  ).length;
}

export async function addressReferenced(
  ctx: ReadCtx,
  contactId: Id<"contacts">,
  addressId: Id<"contactAddresses">,
): Promise<boolean> {
  return (await documentsOfContact(ctx, contactId)).some((d) => d.billingAddressId === addressId);
}

export const todayBerlin = (now: number): CalendarDate => berlinCalendarDate(now);
export const plusDays = addDays;
