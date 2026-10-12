/** i18n settings (04-ui-ux §1, §2). German is the default; English is planned as the second locale. */
export const locales = ["de"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "de";

/** Every business date is interpreted in Europe/Berlin (GOBD-22). */
export const timeZone = "Europe/Berlin";
