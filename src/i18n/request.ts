import { getRequestConfig } from "next-intl/server";

// Single-locale setup for Jeff Studio (Colombia). The structure (locale +
// dynamic messages import) keeps the door open to plug `en` or another
// locale later without rewriting consumers.
const DEFAULT_LOCALE = "es";

export default getRequestConfig(async () => {
  // We name the file `es.json` (not `es-AR.json`) because the next-intl
  // plugin auto-discovers locale files by base language code. The locale
  // we expose to the runtime is still "es-AR" so Intl APIs format dates
  // and currency for Argentina.
  const messages = (await import("../../messages/es.json")).default;

  return {
    locale: DEFAULT_LOCALE,
    messages,
    timeZone: "America/Bogota",
    now: new Date(),
  };
});
