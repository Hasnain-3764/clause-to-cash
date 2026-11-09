"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

export const DEFAULT_KEY = "creator-collab";
export const DEFAULT_PERIOD = "2026-11";

export function useSelection() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const key = sp.get("c") ?? DEFAULT_KEY;
  const period = sp.get("p") ?? DEFAULT_PERIOD;
  const href = useCallback((path: string, over: { c?: string; p?: string } = {}) => `${path}?c=${encodeURIComponent(over.c ?? key)}&p=${encodeURIComponent(over.p ?? period)}`, [key, period]);
  const set = useCallback((over: { c?: string; p?: string }) => router.push(href(pathname, over)), [router, href, pathname]);
  return { key, period, href, set };
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok || json?.error) throw new Error(json?.error ?? `HTTP ${res.status}`);
  return json as T;
}

/** Fetch JSON and re-fetch when deps change. `body` undefined = GET. */
export function useApi<T>(path: string | null, body?: unknown) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const bodyKey = JSON.stringify(body ?? null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setLoading(true);
    setError(null);
    api<T>(path, body)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(String(e.message ?? e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, bodyKey, tick]);
  return { data, error, loading, reload: () => setTick((t) => t + 1) };
}
