// Integer-cents helpers. BigInt is used internally so cents * weight never overflows.

/**
 * Split `totalCents` into integer parts proportional to `weights` using the
 * largest-remainder method. The parts always sum to exactly `totalCents`.
 * Ties on the remainder go to the lower index, so the result is deterministic.
 */
export function allocate(totalCents: number, weights: readonly bigint[]): number[] {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) throw new Error(`allocate: bad total ${totalCents}`);
  if (weights.some((w) => w < 0n)) throw new Error("allocate: negative weight");
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (weights.length === 0) return [];
  if (sum === 0n) {
    // Nothing to weigh by: give everything to the last bucket (callers put "retained" last).
    return weights.map((_, i) => (i === weights.length - 1 ? totalCents : 0));
  }
  const total = BigInt(totalCents);
  const floors = weights.map((w) => (total * w) / sum);
  const remainders = weights.map((w) => (total * w) % sum);
  let left = Number(total - floors.reduce((a, b) => a + b, 0n));
  const order = remainders
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  const out = floors.map(Number);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i] += 1;
    left -= 1;
  }
  return out;
}

/** floor(cents * bps / 10000) in exact integer math. */
export function bpsOf(cents: number, bps: number): number {
  return Number((BigInt(cents) * BigInt(bps)) / 10_000n);
}

export function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/** 123456 -> "1234.56" (PayPal's amount.value format). */
export function centsToValue(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error(`bad cents ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** "1234.56" -> 123456. Rejects anything that is not a plain 2-decimal amount. */
export function valueToCents(value: string): number {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) throw new Error(`bad money value ${JSON.stringify(value)}`);
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}

/** 123456 -> "$1,234.56" for display. */
export function formatUSD(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}
