import "server-only";
import { api } from "@convex/_generated/api";
import { serializeTaxReserve, taxReserveArgs, taxReserveOut, taxReserveQuery } from "@/domain/schemas/api/reports";
import { berlinCalendarDate } from "@/domain/time/berlin";
import { defineEndpoint, defineResource } from "../endpoint";

const TAG = "Auswertungen";

/** 05 §4 reports (F08 §7): the tax reserve estimate (RPT-010/011). */
export const reportsResource = defineResource("reports", "Auswertungen und Schätzungen", [
  defineEndpoint({
    method: "GET",
    path: "/reports/tax-reserve",
    operationId: "getTaxReserveEstimate",
    summary: "Steuer-Rücklage (Schätzung)",
    description:
      "Schätzung – keine Steuerberatung. Offene Umsatzsteuer, Einkommen-/Gewerbe-/Körperschaftsteuer auf den hochgerechneten Gewinn, Rücklage jetzt und Monatsbetrag. Antwort enthält immer `estimate: true`, `disclaimer` und `assumptions[]`; Abfrageparameter überschreiben die gespeicherten Annahmen nur für diese Anfrage.",
    tag: TAG,
    scope: "reports:read",
    query: taxReserveQuery,
    response: { status: 200, schema: taxReserveOut, description: "Schätzung" },
    handler: async ({ convex, query }) => ({
      body: serializeTaxReserve(
        await convex.query(
          api.reports.taxReserve,
          taxReserveArgs(query, Number(berlinCalendarDate(Date.now()).slice(0, 4))),
        ),
      ),
    }),
  }),
]);
