/**
 * BZSt eVatR REST status codes (F02 CON-051/054/055, §4.2 result mapping, MISC-04). F02 §4.2: "The full status-code
 * table is loaded from `GET /v1/info/statusmeldungen` and bundled in the rule tables (updated with releases)."
 *
 * Source: https://api.evatr.vies.bzst.de/app/v1/info/statusmeldungen, retrieved 2026-10-12 (API v1.2.3.19.886).
 * The `outcome` column is our classification (F02 §4.2 table):
 *   valid        the ID is valid at the request time (qualified only with evatr-0000 + A codes, CON-054)
 *   invalid      the ID is not (or not yet / no longer) valid, or syntactically wrong
 *   unavailable  the service or the member state cannot answer now → CON-056 override path (EC-044)
 *   request      our request was rejected (configuration problem: own USt-IdNr, missing fields) → stored like
 *                "unavailable" with the BZSt message, never as "invalid"
 * LEGAL-OPEN: F02 Q2 / README A16 — classification of evatr-2002 (valid only from `gueltigAb`) and evatr-2008
 * ("Besonderheit", valid but not qualified) is our conservative reading; confirm with the Steuerberater.
 */
export type EvatrOutcome = "valid" | "invalid" | "unavailable" | "request";

export interface EvatrStatus {
  readonly status: string;
  readonly outcome: EvatrOutcome;
  readonly httpCode?: number;
  readonly message: string;
}

const s = (status: string, outcome: EvatrOutcome, httpCode: number | undefined, message: string): EvatrStatus => ({
  status,
  outcome,
  ...(httpCode === undefined ? {} : { httpCode }),
  message,
});

const BUSY = "Eine Bearbeitung Ihrer Anfrage ist zurzeit nicht möglich. Bitte versuchen Sie es später noch einmal.";

export const EVATR_STATUS_RETRIEVED_ON = "2026-10-12";

export const EVATR_STATUS: readonly EvatrStatus[] = [
  s("evatr-0000", "valid", 200, "Die angefragte USt-IdNr. ist zum Anfragezeitpunkt gültig."),
  s("evatr-0001", "request", undefined, "Bitte bestätigen Sie den Datenschutzhinweis."),
  s("evatr-0002", "request", 400, "Mindestens eins der Pflichtfelder ist nicht besetzt."),
  s(
    "evatr-0003",
    "valid",
    400,
    "Die angefragte USt-IdNr. ist zum Anfragezeitpunkt gültig. Mindestens eines der Pflichtfelder für eine qualifizierte Bestätigungsanfrage ist nicht besetzt.",
  ),
  s(
    "evatr-0004",
    "request",
    400,
    "Die anfragende DE USt-IdNr. ist syntaktisch falsch. Sie passt nicht in das deutsche Erzeugungsschema.",
  ),
  s("evatr-0005", "invalid", 400, "Die angegebene angefragte USt-IdNr. ist syntaktisch falsch."),
  s("evatr-0006", "request", 403, "Die anfragende DE USt-IdNr. ist nicht berechtigt eine DE USt-IdNr. anzufragen."),
  s("evatr-0007", "request", 403, "Fehlerhafter Aufruf."),
  s(
    "evatr-0008",
    "unavailable",
    403,
    "Die maximale Anzahl von qualifizierten Bestätigungsabfragen für diese Session wurde erreicht. Bitte starten Sie erneut mit einer einfachen Bestätigungsabfrage.",
  ),
  s("evatr-0011", "unavailable", 503, BUSY),
  s(
    "evatr-0012",
    "invalid",
    400,
    "Die angefragte USt-IdNr. ist syntaktisch falsch. Sie passt nicht in das Erzeugungsschema.",
  ),
  s("evatr-0013", "unavailable", 503, BUSY),
  s("evatr-1001", "unavailable", 503, BUSY),
  s("evatr-1002", "unavailable", 500, BUSY),
  s("evatr-1003", "unavailable", 500, BUSY),
  s("evatr-1004", "unavailable", 500, BUSY),
  s("evatr-2001", "invalid", 404, "Die angefragte USt-IdNr. ist zum Anfragezeitpunkt nicht vergeben."),
  s(
    "evatr-2002",
    "invalid",
    200,
    "Die angefragte USt-IdNr. ist zum Anfragezeitpunkt nicht gültig. Sie ist erst gültig ab dem Datum im Feld gueltigAb.",
  ),
  s("evatr-2003", "invalid", 400, "Das angegebene Länderkennzeichen der angefragten USt-IdNr. ist nicht gültig."),
  s("evatr-2004", "unavailable", 500, BUSY),
  s("evatr-2005", "request", 404, "Die angegebene eigene DE USt-IdNr. ist zum Anfragezeitpunkt nicht gültig."),
  s(
    "evatr-2006",
    "invalid",
    200,
    "Die angefragte USt-IdNr. ist zum Anfragezeitpunkt nicht gültig. Sie war gültig im Zeitraum, der durch die Werte in den Feldern gueltigAb und gueltigBis beschrieben ist.",
  ),
  s(
    "evatr-2007",
    "unavailable",
    500,
    "Bei der Verarbeitung der Daten aus dem angefragten EU-Mitgliedstaat ist ein Fehler aufgetreten. Ihre Anfrage kann deshalb nicht bearbeitet werden.",
  ),
  s(
    "evatr-2008",
    "valid",
    200,
    "Die angefragte USt-IdNr. ist zum Anfragezeitpunkt gültig. Für die qualifizierte Bestätigungsanfrage liegt einer Besonderheit vor. Für Rückfragen wenden Sie sich an das BZSt.",
  ),
  s("evatr-2011", "unavailable", 500, BUSY),
  s("evatr-3011", "unavailable", 500, BUSY),
];

const BY_STATUS = new Map(EVATR_STATUS.map((e) => [e.status, e]));

/** Unknown codes are treated as "unavailable" (block with override, never a silent "valid" or "invalid"). */
export function evatrStatus(status: string): EvatrStatus {
  return (
    BY_STATUS.get(status) ?? {
      status,
      outcome: "unavailable",
      message: `Unbekannte Statusmeldung des BZSt (${status}). Bitte später erneut prüfen.`,
    }
  );
}
