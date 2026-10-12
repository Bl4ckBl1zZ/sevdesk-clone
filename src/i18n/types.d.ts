import type messages from "./messages/de.json";

// Type-safe message keys for useTranslations/getTranslations (German is the reference catalogue).
declare module "next-intl" {
  interface AppConfig {
    Locale: "de";
    Messages: typeof messages;
  }
}
