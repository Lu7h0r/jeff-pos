import { getRequestConfig } from "next-intl/server";

// Single-locale setup for Jeff Studio (Colombia). The structure (locale +
// dynamic messages import) keeps the door open to plug `en` or another
// locale later without rewriting consumers.
const DEFAULT_LOCALE = "es";

export default getRequestConfig(async () => {
  const messages = (await import(`../../messages/${DEFAULT_LOCALE}.json`))
    .default;

  return {
    locale: DEFAULT_LOCALE,
    messages,
    timeZone: "America/Bogota",
    now: new Date(),
  };
});
