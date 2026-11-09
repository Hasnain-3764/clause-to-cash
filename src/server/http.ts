import { NextResponse } from "next/server";

/** Run a handler and turn thrown errors into a JSON 400 (never leaks stack traces). */
export async function handle(fn: () => Promise<unknown>) {
  try {
    return NextResponse.json(await fn());
  } catch (e) {
    const err = e as { message?: string; status?: number; errorName?: string; debugId?: string };
    const msg = err.errorName ? `PayPal ${err.status} ${err.errorName}${err.debugId ? ` (debug_id ${err.debugId})` : ""}` : (err.message ?? String(e));
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
