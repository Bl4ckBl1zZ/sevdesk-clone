/**
 * F09 E-IMP-18 (DSGVO Art. 14): personal data taken over from another system (sevdesk, lexoffice, any CSV) has not
 * been collected from the data subject here — the source belongs in the processing record (Verzeichnis von
 * Verarbeitungstätigkeiten, Einstellungen › Datenschutz). Shown as an info in every import preview with contacts.
 */
export const IMPORT_PRIVACY_NOTICE_CODE = "E-IMP-18";

export const importPrivacyNotice = (source: string): string =>
  `Sie übernehmen personenbezogene Daten aus ${source}. Bitte die Herkunft der Daten im Verzeichnis von ` +
  "Verarbeitungstätigkeiten (Einstellungen › Datenschutz) vermerken – Informationspflicht nach Art. 14 DSGVO.";
