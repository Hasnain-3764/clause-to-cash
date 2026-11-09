// Shared PayPal sandbox helpers. Plain fetch, no SDK.
// Never logs the client secret, tokens, or request headers.
import dotenv from "dotenv";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

dotenv.config({ quiet: true });

export const SANDBOX_BASE ="https://api-m.sandbox.paypal.com";

/** Exit unless PAYPAL_BASE is exactly the sandbox host. Guards against ever calling live. */
export function assertSandbox(): void {
  const base = process.env.PAYPAL_BASE;
  if (base !== SANDBOX_BASE) {
    console.error(
      `REFUSING TO RUN: PAYPAL_BASE must be exactly ${SANDBOX_BASE} (got ${base ? JSON.stringify(base) : "nothing"}).`,
    );
    process.exit(1);
  }
}

// Run the guard as soon as any script imports this module.
assertSandbox();

/** Show only the first 6 chars of a secret-ish value. */
export function preview(value: string): string {
  return value.slice(0, 6) + "...";
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name} in .env`);
    process.exit(1);
  }
  return v;
}

/** Error thrown by paypalFetch; carries PayPal's error name and debug_id. */
export class PayPalError extends Error {
  constructor(
    public status: number,
    public errorName: string,
    message: string,
    public debugId: string | undefined,
    public body: any,
  ) {
    super(`${status} ${errorName}: ${message}`);
  }
}

let cached: { token: string; expiresAt: number } | null = null;

/** POST /v1/oauth2/token with client_credentials. Cached in memory until ~60s before expiry. */
export async function getAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

  const id = requireEnv("PAYPAL_CLIENT_ID");
  const secret = requireEnv("PAYPAL_CLIENT_SECRET");
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");

  const res = await fetch(`${SANDBOX_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    // OAuth errors use {error, error_description}; never contain the secret.
    const name = body.error ?? body.name ?? "UNKNOWN";
    const msg = body.error_description ?? body.message ?? res.statusText;
    const debugId = res.headers.get("paypal-debug-id") ?? body.debug_id;
    console.error(`PayPal token request failed: HTTP ${res.status}, error=${name}, message=${msg}, debug_id=${debugId ?? "n/a"}`);
    throw new PayPalError(res.status, name, msg, debugId ?? undefined, body);
  }
  cached = { token: body.access_token, expiresAt: Date.now() + Number(body.expires_in) * 1000 };
  return cached.token;
}

/** Seconds until the cached token expires (0 if none). */
export function tokenExpiresIn(): number {
  return cached ? Math.max(0, Math.round((cached.expiresAt - Date.now()) / 1000)) : 0;
}

/**
 * Call a PayPal sandbox endpoint. `path` must start with "/" so the bearer
 * token can only ever go to the sandbox host. Returns parsed JSON.
 */
export async function paypalFetch<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  if (!path.startsWith("/")) throw new Error(`paypalFetch path must start with "/": ${path}`);
  const token = await getAccessToken();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json");

  const res = await fetch(`${SANDBOX_BASE}${path}`, { ...init, headers });
  const text = await res.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 500) }; }

  if (!res.ok) {
    const name = body.name ?? body.error ?? "UNKNOWN";
    const msg = body.message ?? body.error_description ?? res.statusText;
    const debugId = body.debug_id ?? res.headers.get("paypal-debug-id") ?? undefined;
    console.error(`PayPal error on ${init.method ?? "GET"} ${path}`);
    console.error(`  status:   ${res.status}`);
    console.error(`  name:     ${name}`);
    console.error(`  message:  ${msg}`);
    console.error(`  debug_id: ${debugId ?? "n/a"}`);
    for (const d of body.details ?? []) {
      console.error(`  detail:   ${d.issue ?? ""}${d.field ? ` (${d.field})` : ""} ${d.description ?? ""}`.trimEnd());
    }
    throw new PayPalError(res.status, name, msg, debugId, body);
  }
  return body as T;
}

/** True when this file is the one being run directly (ESM main check). */
export function isMain(importMetaUrl: string): boolean {
  return process.argv[1] !== undefined && importMetaUrl === pathToFileURL(resolve(process.argv[1])).href;
}
