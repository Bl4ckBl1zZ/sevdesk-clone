import { getRequestConfig } from "next-intl/server";
import { defaultLocale, timeZone } from "./config";

/**
 * next-intl request config (no locale prefix in URLs). When English is added, resolve the locale from the
 * member's preference / a `NEXT_LOCALE` cookie here and add `messages/en.json`.
 */
export default getRequestConfig(async () => {
  const locale = defaultLocale;
  return {
    locale,
    timeZone,
    messages: (await import(`./messages/${locale}.json`)).default,
  };
});
