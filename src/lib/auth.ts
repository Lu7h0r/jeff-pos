import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { db } from "./db";

const isProd = process.env.NODE_ENV === "production";

// trustedOrigins accepts a comma-separated list, e.g.
// "https://admin.sanctum.tattoo,https://www.sanctum.tattoo"
const trustedOrigins = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: trustedOrigins.length > 0 ? trustedOrigins : undefined,
  database: drizzleAdapter(db, {
    provider: "pg",
  }),
  emailAndPassword: {
    enabled: true,
  },
  advanced: {
    cookiePrefix: "sanctum",
    useSecureCookies: isProd,
    defaultCookieAttributes: {
      sameSite: "lax",
      secure: isProd,
      httpOnly: true,
    },
  },
  plugins: [nextCookies()],
});
