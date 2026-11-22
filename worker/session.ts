import { getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import { missingBindings } from "./bindings";
import type { SessionUser } from "./types";

const SESSION_COOKIE = "sala_session";
const STATE_COOKIE = "sala_oauth_state";
const SESSION_DAYS = 14;

type AppContext = Context<{ Bindings: Env }>;

type SessionPayload = {
  userId: string;
  email: string;
  exp: number;
};

function bytesToBase64Url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array | null {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

async function signBody(secret: string, body: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), new TextEncoder().encode(body));
  return `${body}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

async function readSignedBody(secret: string, token: string): Promise<string | null> {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const signature = base64UrlToBytes(token.slice(dot + 1));
  if (!signature) return null;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, "verify"),
    signature,
    new TextEncoder().encode(body),
  );
  return valid ? body : null;
}

function cookieFlags(requestUrl: string): { httpOnly: true; secure: boolean; sameSite: "Lax"; path: "/" } {
  return {
    httpOnly: true,
    secure: new URL(requestUrl).protocol === "https:",
    sameSite: "Lax",
    path: "/",
  };
}

export async function establishSession(c: AppContext, user: SessionUser): Promise<void> {
  const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const payload: SessionPayload = { userId: user.id, email: user.email, exp };
  const body = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const token = await signBody(c.env.SESSION_SECRET, body);
  setCookie(c, SESSION_COOKIE, token, { ...cookieFlags(c.req.url), maxAge: SESSION_DAYS * 24 * 60 * 60 });
}

export async function readSessionUser(c: AppContext): Promise<SessionUser | null> {
  if (missingBindings(c.env, ["SESSION_SECRET"]).length > 0) return null;
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const body = await readSignedBody(c.env.SESSION_SECRET, token);
  if (!body) return null;
  const jsonBytes = base64UrlToBytes(body);
  if (!jsonBytes) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(jsonBytes)) as SessionPayload;
  } catch {
    return null;
  }
  if (!payload.userId || !payload.email || typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
  const row = await c.env.DB.prepare("SELECT id, email, name FROM users WHERE id = ? AND email = ?")
    .bind(payload.userId, payload.email)
    .first<{ id: string; email: string; name: string }>();
  if (!row) return null;
  return { id: row.id, email: row.email, name: row.name };
}

export async function beginGoogleLogin(c: AppContext): Promise<Response> {
  const missing = missingBindings(c.env, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SESSION_SECRET"]);
  if (missing.length > 0) {
    return c.json(
      {
        missing,
        error: "Google sign-in needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and SESSION_SECRET.",
      },
      503,
    );
  }
  const state = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(24)));
  const signedState = await signBody(c.env.SESSION_SECRET, state);
  setCookie(c, STATE_COOKIE, signedState, { ...cookieFlags(c.req.url), maxAge: 10 * 60 });
  const redirectUri = new URL("/api/auth/callback", c.req.url).toString();
  const authorize = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorize.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "openid email profile");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("prompt", "select_account");
  return c.redirect(authorize.toString());
}

function sameText(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  const length = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let index = 0; index < length; index += 1) diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return diff === 0;
}

export async function finishGoogleLogin(c: AppContext): Promise<Response> {
  const missing = missingBindings(c.env, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SESSION_SECRET"]);
  const home = new URL("/", c.req.url);
  if (c.req.query("error")) {
    home.searchParams.set("error", "auth");
    return c.redirect(home.toString());
  }
  if (missing.length > 0) {
    home.searchParams.set("error", "missing-bindings");
    return c.redirect(home.toString());
  }
  const code = c.req.query("code");
  const state = c.req.query("state");
  const stored = getCookie(c, STATE_COOKIE);
  setCookie(c, STATE_COOKIE, "", { ...cookieFlags(c.req.url), maxAge: 0 });
  if (!code || !state || !stored) {
    home.searchParams.set("error", "auth");
    return c.redirect(home.toString());
  }
  const unsigned = await readSignedBody(c.env.SESSION_SECRET, stored);
  if (!unsigned || !sameText(unsigned, state)) {
    home.searchParams.set("error", "auth");
    return c.redirect(home.toString());
  }
  const redirectUri = new URL("/api/auth/callback", c.req.url).toString();
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResponse.ok) {
    console.error(JSON.stringify({ message: "google token exchange failed", status: tokenResponse.status }));
    home.searchParams.set("error", "auth");
    return c.redirect(home.toString());
  }
  const tokenJson = (await tokenResponse.json()) as { access_token?: string };
  if (!tokenJson.access_token) {
    home.searchParams.set("error", "auth");
    return c.redirect(home.toString());
  }
  const profileResponse = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { authorization: `Bearer ${tokenJson.access_token}`, accept: "application/json" },
  });
  if (!profileResponse.ok) {
    home.searchParams.set("error", "auth");
    return c.redirect(home.toString());
  }
  const profile = (await profileResponse.json()) as {
    email?: string;
    email_verified?: boolean;
    name?: string;
  };
  const email = profile.email?.trim().toLowerCase() ?? "";
  if (!email || profile.email_verified === false) {
    home.searchParams.set("error", "auth");
    return c.redirect(home.toString());
  }
  const allowed = await c.env.DB.prepare("SELECT email FROM allowed_emails WHERE email = ?").bind(email).first();
  if (!allowed) {
    home.searchParams.set("error", "not-allowed");
    return c.redirect(home.toString());
  }
  const existing = await c.env.DB.prepare("SELECT id, email, name FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string; email: string; name: string }>();
  const user: SessionUser = existing ?? {
    id: crypto.randomUUID(),
    email,
    name: profile.name?.trim() || email,
  };
  if (!existing) {
    const createdAt = new Date().toISOString();
    await c.env.DB.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)")
      .bind(user.id, user.email, user.name, createdAt)
      .run();
    await c.env.DB.prepare(
      `INSERT INTO settings (
        user_id, favorite_dj_ids, break_every_n_songs, break_length, break_max_seconds,
        topic_today, topic_next_song, topic_weather, weather_city, topic_events, events_scope
      ) VALUES (?, ?, 2, 'medium', 40, 1, 1, 0, '', 0, 'world')`,
    )
      .bind(user.id, JSON.stringify(["vinnie-vega", "rosa-marquez", "miles-crowe"]))
      .run();
  }
  await establishSession(c, user);
  return c.redirect(home.toString());
}
