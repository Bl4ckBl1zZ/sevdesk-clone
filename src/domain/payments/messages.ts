/**
 * Exact German messages of F05 §5.1 (EC-PAY-*) and F07 §5.3/§5.4 used by the payment, matching and cash paths.
 * Shown verbatim in the UI and returned verbatim by REST/MCP.
 */
import { formatEuro } from "../money";
import { type CalendarDate, formatGermanDate } from "../time/calendar-date";

const eur = (c: number) => formatEuro(c).replace("-", "−");
const de = (d: string) => formatGermanDate(d as CalendarDate);
const mmyyyy = (period: string) => `${period.slice(5, 7)}/${period.slice(0, 4)}`;

export const PAY_MESSAGES = {
  excess: (diff: number) =>
    `Der Betrag übersteigt den offenen Betrag um ${eur(diff)}. Bitte den Mehrbetrag zuordnen (weitere Rechnung, Mahngebühren/Zinsen, Guthaben).`,
  sourceExceeded: (sum: number, available: number) =>
    `Die Zuordnungen (${eur(sum)}) übersteigen den verfügbaren Betrag der Zahlung (${eur(available)}).`,
  concurrent: "Diese Bankbuchung wurde soeben anderweitig zugeordnet. Bitte neu laden.",
  draft: "Zahlungen können nur auf fertiggestellte Rechnungen gebucht werden.",
  cancelled:
    "Die Rechnung ist storniert. Bitte die Zahlung der neuen Rechnung zuordnen oder als Guthaben des Kunden erfassen.",
  future: "Das Zahlungsdatum darf nicht in der Zukunft liegen.",
  beforeDocument: "Das Zahlungsdatum liegt vor dem Rechnungsdatum (Vorauszahlung). Bitte prüfen.",
  periodLocked: (period: string) =>
    `Der Zeitraum ${mmyyyy(period)} ist festgeschrieben. Bitte ein Datum in einem offenen Zeitraum wählen.`,
  skontoNotAllowed: (date: string, deadline: string, actual: number, agreed: number) =>
    `Skonto-Frist überschritten (Zahlung am ${de(date)}, Frist bis ${de(deadline)}) bzw. Abzug höher als vereinbart (${eur(actual)} statt ${eur(agreed)}). Der Restbetrag bleibt offen – oder als Kulanz-Preisminderung mit Begründung buchen.`,
  bankFeesHigh: (amount: number) =>
    `Ungewöhnlich hohe Bankgebühren (${eur(amount)}). Bitte prüfen, ob es sich um eine Teilzahlung handelt.`,
  noSkontoTerms: "Für diese Rechnung wurde kein Skonto vereinbart. Bitte ‚Sonstige Preisminderung‘ wählen.",
  skontoWithoutVatRate:
    "Skonto auf Umsätze ohne Steuersatz (z. B. Kleinunternehmer, steuerfrei, Reverse Charge) bitte als ‚Sonstige Preisminderung‘ mit Konto buchen.",
  writeOffReason: "Bitte den Grund des Forderungsausfalls angeben (Insolvenz, uneinbringlich, verjährt, Verzicht).",
  notYetBarred: (date: string) => `Die Forderung ist erst am ${de(date)} verjährt.`,
  writeOffIst: "Bei Ist-Versteuerung wurde die Umsatzsteuer noch nicht abgeführt – es erfolgt keine USt-Korrektur.",
  methodChanged: (method: string) =>
    `Besteuerungsart hat sich seit der Rechnung geändert. Die USt-Korrektur folgt der Versteuerung der Rechnung (${method}).`,
  writtenOff: "Die Forderung wurde abgeschrieben. Bitte ‚Zahlungseingang auf abgeschriebene Forderung‘ verwenden.",
  fxMissing: "Bitte den tatsächlich erhaltenen Euro-Betrag angeben (Fremdwährung).",
  fxDeferred:
    "Zahlungen in Fremdwährung können erst mit der EUR-Bewertung gebucht werden. Bitte die Rechnung in EUR ausstellen oder die Zahlung später erfassen.",
  alreadyReversed: "Diese Zahlung wurde bereits storniert.",
  advanceReopened: (number: string, open: number) =>
    `Die Zahlung auf Abschlagsrechnung ${number} wurde zurückgebucht; die Abschlagsrechnung ist wieder offen (${eur(open)}).`,
  reversalOfReversal: "Eine Stornobuchung kann nicht storniert werden. Bitte die Zahlung neu erfassen.",
  reversalLocked: (today: string) =>
    `Der ursprüngliche Zeitraum ist festgeschrieben. Die Stornobuchung erfolgt mit Datum ${de(today)}.`,
  creditInsufficient: (credit: number) => `Das Guthaben (${eur(credit)}) reicht nicht aus.`,
  creditOtherContact: "Guthaben kann nur auf Rechnungen desselben Kontakts angewendet werden.",
  refundExceeds: (open: number) => `Die Erstattung übersteigt den offenen Erstattungsbetrag (${eur(open)}).`,
  amountPositive: "Der Betrag muss größer als 0 sein.",
  otherIncomplete: "Bitte Grund (mind. 5 Zeichen) und Buchungskonto für die Differenz angeben.",
  reasonRequired: "Bitte einen Grund angeben (mindestens 5 Zeichen).",
  existingManual: (date: string, amount: number) =>
    `Für diese Bankbuchung existiert bereits eine manuell erfasste Zahlung vom ${de(date)} über ${eur(amount)}.`,
  cashWithoutInvoice:
    "Bareinnahmen ohne Rechnung sind nicht vorgesehen (keine Kassenfunktion). Bitte zuerst eine Rechnung erstellen.",
  cashDaily: (days: number) =>
    `Bareinnahmen sind täglich aufzuzeichnen (§ 146 Abs. 1 S. 2 AO). Das Zahlungsdatum liegt ${days} Tage zurück – bitte prüfen.`,
  cashReason: "Die Barzahlung liegt mehr als 10 Tage zurück. Bitte begründen, warum sie erst jetzt erfasst wird.",
  cashConcurrent: "Der Kassenbestand hat sich soeben geändert. Bitte neu laden und erneut versuchen.",
  privateOnSales: "‚Privat bezahlt‘ ist nur bei Eingangsbelegen möglich.",
  cashExcess:
    "Ein Mehrbetrag aus einer Barzahlung muss zugeordnet werden (weitere Rechnung, Mahngebühren/Zinsen oder Guthaben).",
  cashEurOnly: "Barzahlungen sind nur in EUR möglich.",
  feesExceedClaim: (claimed: number) =>
    `Mahngebühren und Zinsen können nur bis zur geltend gemachten Höhe (${eur(claimed)}) gebucht werden.`,
  immutable: "Zahlungen können nicht geändert oder gelöscht werden. Bitte stornieren und neu erfassen.",
  pendingTx: "Die Bankbuchung ist noch nicht gebucht (vorgemerkt). Eine Zuordnung ist erst nach der Buchung möglich.",
  txNotAllocatable: "Dieser Umsatz kann nicht zugeordnet werden (bereits markiert oder ignoriert).",
  txDirection: "Eingehende Zahlungen können nur Forderungen ausgleichen; ausgehende nur Erstattungen.",
  duplicateTarget: "Jede Rechnung darf in einer Zahlung nur einmal vorkommen.",
  noAllocations: "Bitte mindestens eine Zuordnung angeben.",
  differencesOnCredit: "Ein Guthaben kann keine Differenzen enthalten.",
  openingItemDifferences: "Für offene Posten aus der Eröffnungsbilanz sind nur Zahlungen ohne Differenz möglich.",
  creditPairUnbalanced: "Das angewendete Guthaben muss genau den Zuordnungen auf Rechnungen entsprechen.",
  warningsUnacknowledged: "Bitte die Hinweise bestätigen.",
  contactMismatch: "Alle Zuordnungen einer Zahlung müssen zum selben Kunden gehören.",
} as const;
