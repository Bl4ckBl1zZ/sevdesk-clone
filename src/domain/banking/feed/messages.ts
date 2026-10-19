/** German messages of the Enable Banking feed (F07 §5.1 EC-BNK-06, EC-BNK-80…92; F01 T-SET-104), shown verbatim. */
export const FEED_MESSAGES = {
  outage: (time: string) =>
    `Enable Banking nicht erreichbar seit ${time}. Wird automatisch wiederholt; fehlende Zeiträume bitte per Kontoauszug importieren.`,
  callbackInvalid:
    "Die Bankfreigabe konnte nicht abgeschlossen werden (Sitzung abgelaufen oder ungültig). Bitte ‚Neu verbinden‘ erneut ausführen.",
  authAborted: "Autorisierung abgebrochen oder abgelaufen — bitte erneut verbinden.",
  jwtRejected: "Enable Banking hat die Anmeldung abgelehnt: Anwendungs-ID und Schlüssel prüfen.",
  reauth: (time: string) =>
    `Bankverbindung muss erneuert werden. Seit ${time} werden keine Umsätze abgerufen – Kontoauszug-Import bleibt möglich.`,
  expiring: (date: string) => `Bankverbindung läuft am ${date} ab. Bitte jetzt erneuern.`,
  rateLimited: (time: string) => `Abruflimit der Bank erreicht – nächster automatischer Abruf ab ${time}.`,
  ownerPresence: "Ein manueller Abruf ist nur in der Oberfläche möglich, solange Sie angemeldet sind.",
  backfillGap: (from: string, to: string) =>
    `Ältere Umsätze konnten nicht abgerufen werden. Bitte Kontoauszüge für ${from}–${to} importieren.`,
  identicalRows: (n: number, date: string) =>
    `${n} gleichartige Umsätze am ${date} – bitte prüfen, ob es Dubletten sind.`,
  feedLost: "Bankdaten nur per Kontoauszug-Import – die automatische Verbindung ist nicht mehr verfügbar.",
  newAccount: (currency: string) => `Neues Konto gefunden (${currency}) – übernehmen?`,
  missingAccount: (name: string) =>
    `Konto ${name} ist in der neuen Freigabe nicht enthalten. Bitte bei der Erneuerung auswählen oder Kontoauszüge importieren.`,
  evaluationPending: "Nutzung im Evaluationsmodus – schriftliche Bestätigung von Enable Banking ausstehend",
  notConfigured: "Bitte zuerst Anwendungs-ID und privaten Schlüssel hinterlegen.",
  balanceMismatch: (provider: string, ours: string) =>
    `Kontostand laut Bank (${provider}) weicht vom gebuchten Stand (${ours}) ab.`,
  accountClosed: (name: string) =>
    `Das Bankkonto ${name} wurde von der Bank als geschlossen gemeldet und archiviert. Offene Rechnungen mit diesem Konto bitte prüfen (Rechnungsberichtigung).`,
  onlyInvoiceAccountClosed: (currency: string) =>
    `Es gibt kein Rechnungskonto in ${currency} mehr. Bitte ein anderes Konto für Rechnungen wählen.`,
} as const;
