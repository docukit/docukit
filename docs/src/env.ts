import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

const localDocSyncServerUrl =
  process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test"
    ? "ws://localhost:8081"
    : undefined;

export const env = createEnv({
  /**
   * Server-side environment variables schema.
   * These are only available on the server and are never sent to the client.
   */
  server: {
    SMTP_URL: z
      .string()
      .url()
      .describe(
        "SMTP connection URL. For Gmail with App Password: smtp://youremail@gmail.com:your-16-char-app-password@smtp.gmail.com:587. Generate App Password at: https://myaccount.google.com/apppasswords",
      ),
    CONTACT_EMAIL_TO: z
      .string()
      .email()
      .describe("Email address to receive contact form submissions"),
  },

  /**
   * Client-side environment variables schema.
   * These are exposed to the browser and must be prefixed with NEXT_PUBLIC_.
   */
  client: {
    NEXT_PUBLIC_DOCSYNC_SERVER_URL: z
      .string()
      .url()
      .refine(
        (value) => value.startsWith("ws://") || value.startsWith("wss://"),
        "Must be a ws:// or wss:// URL",
      ),
  },

  /**
   * Runtime environment variables.
   * For Next.js >= 13.4.4, you only need to destructure client variables.
   */
  experimental__runtimeEnv: {
    NEXT_PUBLIC_DOCSYNC_SERVER_URL:
      process.env.NEXT_PUBLIC_DOCSYNC_SERVER_URL ?? localDocSyncServerUrl,
  },

  /**
   * By default, this library will only validate server variables on the server
   * and only client variables on the client. This saves on bundle size.
   * If you want to always validate, set this to true.
   */
  skipValidation:
    process.env.SKIP_ENV_VALIDATION === "true" ||
    process.env.NODE_ENV === "development" ||
    process.env.NODE_ENV === "test",

  /**
   * Makes it so that empty strings are treated as undefined.
   * `SOME_VAR: z.string()` and `SOME_VAR=''` will throw an error.
   */
  emptyStringAsUndefined: true,
});
