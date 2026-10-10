import { z } from 'zod';

// An origin is scheme + host + port only, e.g. https://choplist.onrender.com.
// The browser sends it in that exact form, so "https://x.com/" (trailing slash)
// or "https://x.com/app" would never match and CORS would silently block it.
function isOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),

  // How many proxies sit between the internet and this app (see app.ts). The
  // rate limits need it to find the real customer address. 0 = none (local).
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),

  MONGO_URI: z
    .string({ error: 'MONGO_URI is required' })
    .regex(/^mongodb(\+srv)?:\/\/.+/, 'MONGO_URI must start with mongodb:// or mongodb+srv://'),

  ALLOWED_ORIGINS: z
    .string({ error: 'ALLOWED_ORIGINS is required' })
    .transform((raw) =>
      raw
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    )
    .pipe(
      z
        .array(
          z.string().refine(isOrigin, {
            error: (issue) =>
              `"${String(issue.input)}" is not an origin (use scheme://host[:port], no path or trailing slash)`,
          }),
        )
        .min(1, 'ALLOWED_ORIGINS must list at least one origin'),
    ),

  // From the Clerk dashboard (API keys). The publishable key is the same value
  // the frontend uses as VITE_CLERK_PUBLISHABLE_KEY.
  CLERK_SECRET_KEY: z
    .string({ error: 'CLERK_SECRET_KEY is required' })
    .startsWith('sk_', 'CLERK_SECRET_KEY must start with sk_'),
  CLERK_PUBLISHABLE_KEY: z
    .string({ error: 'CLERK_PUBLISHABLE_KEY is required' })
    .startsWith('pk_', 'CLERK_PUBLISHABLE_KEY must start with pk_'),
});

export type Config = z.infer<typeof EnvSchema>;

// Pure: takes the env as an argument and throws on bad input, so tests can call
// it with any object. server.ts calls it once with process.env and exits on error.
export function parseEnv(env: Record<string, string | undefined>): Config {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
