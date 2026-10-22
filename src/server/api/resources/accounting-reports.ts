import "server-only";
import { api } from "@convex/_generated/api";
import { sha256Hex } from "@/domain/audit/chain";
import {
  bwaOut,
  bwaQuery,
  euerOut,
  euerQuery,
  fileOut,
  ledgerOut,
  ledgerQuery,
  oposOut,
  oposQuery,
  serializeBwa,
  serializeEuer,
  serializeLedger,
  serializeOpos,
  serializeSusa,
  sheetParams,
  sheetPeriodValid,
  susaArgs,
  susaOut,
  susaQuery,
} from "@/domain/schemas/api/ledger-reports";
import { berlinCalendarDate } from "@/domain/time/berlin";
import { defineEndpoint, defineResource } from "../endpoint";
import { ApiProblem } from "../http";
import { rawId } from "./shared";

/**
 * 05 §4.7 read-only reports (F08 RPT-003…006, TAX-015) and the F09 EXP-020 Kennzahlen sheets over REST. Each handler
 * calls the same Convex query/action as the Auswertungen and Steuern pages and maps the result to the wire — the
 * values are F08's, nothing is computed here (CLAUDE.md rule 5). Sheet downloads are audited by the Convex action
 * (`export.kennzahlen`, attributed to the key).
 */

const TAG = "Auswertungen";

export const accountingReportsResource = defineResource("accounting-reports", "EÜR, BWA, SuSa, OPOS, Kennzahlen", [
  defineEndpoint({
    method: "GET",
    path: "/reports/euer",
    operationId: "getEuerReport",
    summary: "Anlage EÜR eines Jahres",
    description:
      "Zeilen der Anlage EÜR mit Kennzahlen, Summen, AVEÜR, Hinweisen, Blockern und Abgabestatus (F08 TAX-015) — Werte zum Übertragen in Mein ELSTER. Bilanzierende Unternehmen: 409.",
    tag: TAG,
    scope: "reports:read",
    query: euerQuery,
    response: { status: 200, schema: euerOut, description: "Die Anlage EÜR" },
    errors: ["conflict", "setup_incomplete"],
    handler: async ({ convex, query }) => ({
      body: serializeEuer((await convex.query(api.taxes.euer, { year: query.year })) as never),
    }),
  }),
  defineEndpoint({
    method: "GET",
    path: "/reports/bwa",
    operationId: "getBwaReport",
    summary: "BWA (Kurzfristige Erfolgsrechnung)",
    description:
      "Monat, kumuliert und Vorjahr je BWA-Zeile (RPT-005), Variante `accrual` (Soll) oder `cash` (Ist), optional je Kostenstelle.",
    tag: TAG,
    scope: "reports:read",
    query: bwaQuery,
    response: { status: 200, schema: bwaOut, description: "Die BWA" },
    handler: async ({ convex, query }) => ({
      body: serializeBwa(
        await convex.query(api.reports.bwa, {
          month: query.month,
          variant: query.variant,
          ...(query.cost_center_id ? { costCenterId: rawId("costCenters", query.cost_center_id) } : {}),
        }),
      ),
    }),
  }),
  defineEndpoint({
    method: "GET",
    path: "/reports/susa",
    operationId: "getSusaReport",
    summary: "Summen- und Saldenliste",
    description: "EB-Wert, Verkehrszahlen des Zeitraums und kumuliert, Salden je Konto und Klasse (RPT-004).",
    tag: TAG,
    scope: "reports:read",
    query: susaQuery,
    response: { status: 200, schema: susaOut, description: "Die SuSa" },
    handler: async ({ convex, query }) => ({
      body: serializeSusa(await convex.query(api.reports.susa, susaArgs(query))),
    }),
  }),
  defineEndpoint({
    method: "GET",
    path: "/reports/ledger",
    operationId: "getLedgerReport",
    summary: "Kontenblatt",
    description: "Buchungen eines Kontos mit Gegenkonto und laufendem Saldo (RPT-003).",
    tag: TAG,
    scope: "reports:read",
    query: ledgerQuery,
    response: { status: 200, schema: ledgerOut, description: "Das Kontenblatt" },
    handler: async ({ convex, query }) => ({
      body: serializeLedger(await convex.query(api.reports.ledger, query)),
    }),
  }),
  defineEndpoint({
    method: "GET",
    path: "/reports/open-items",
    operationId: "getOpenItemsReport",
    summary: "Offene Posten (OPOS) zum Stichtag",
    description:
      "Debitoren oder Kreditoren zum Stichtag mit Fälligkeitsrastern, Guthaben und Abstimmung mit dem Kontosaldo (RPT-006, E-RPT-06).",
    tag: TAG,
    scope: "reports:read",
    query: oposQuery,
    response: { status: 200, schema: oposOut, description: "Die offenen Posten" },
    handler: async ({ convex, query }) => ({
      body: serializeOpos(
        await convex.query(api.reports.openItems, {
          side: query.side,
          asOf: query.as_of ?? berlinCalendarDate(Date.now()),
        }),
      ),
    }),
  }),
  ...(["csv", "pdf"] as const).map((format) =>
    defineEndpoint({
      method: "GET",
      path: `/reports/{form}/{period}/sheet.${format}`,
      operationId: format === "csv" ? "getKennzahlenSheetCsv" : "getKennzahlenSheetPdf",
      summary: `Kennzahlen-Blatt als ${format.toUpperCase()}`,
      description:
        "UStVA/ZM eines Monats oder Quartals bzw. EÜR eines Jahres zum manuellen Übertragen in Mein ELSTER (F09 EXP-020) — Fußzeile mit Erzeugungszeit, Regelversionen, Festschreibungs- und Abgabestatus. JSON `{ file_name, content_type, sha256, content_base64 }`; der Download wird protokolliert.",
      tag: TAG,
      scope: "reports:read",
      params: sheetParams,
      response: { status: 200, schema: fileOut, description: "Die Datei (Base64)" },
      handler: async ({ convex, params }) => {
        if (!sheetPeriodValid(params.form, params.period)) {
          throw new ApiProblem("validation_failed", {
            errors: [
              {
                code: "invalid_period",
                field: "period",
                message:
                  params.form === "euer"
                    ? "Die EÜR gilt für ein Kalenderjahr (JJJJ)."
                    : "UStVA/ZM: Monat (JJJJ-MM) oder Quartal (JJJJ-Qn).",
              },
            ],
          });
        }
        const r = await convex.action(api.kennzahlenNode.download, { ...params, format });
        const bytes = new Uint8Array(r.data);
        return {
          body: {
            file_name: r.name,
            content_type: r.mime,
            sha256: await sha256Hex(bytes),
            content_base64: Buffer.from(bytes).toString("base64"),
          },
        };
      },
    }),
  ),
]);
