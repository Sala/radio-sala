const SECRET_NAMES = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "SESSION_SECRET",
  "YOUTUBE_API_KEY",
] as const;

export type SecretName = (typeof SECRET_NAMES)[number];

export function missingBindings(env: Env, names: readonly SecretName[] = SECRET_NAMES): SecretName[] {
  const missing: SecretName[] = [];
  for (const name of names) {
    const value = env[name];
    if (typeof value !== "string" || value.trim() === "") missing.push(name);
  }
  return missing;
}

export function bindingMessage(missing: readonly string[]): string {
  if (missing.length === 1) {
    return `${missing[0]} is unset. Add it to .dev.vars for local Wrangler, or with wrangler secret put before a deploy.`;
  }
  return `${missing.join(", ")} are unset. Add them to .dev.vars for local Wrangler, or with wrangler secret put before a deploy.`;
}
