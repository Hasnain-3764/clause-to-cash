// Step 4: product search on Channel3. The API key goes ONLY to api.trychannel3.com.
// Response shape (from channel3.ai/docs): { products: Product[], next_page_token }.
// Price / availability / buy URL live on product.offers[], not on the product itself.
import { isMain } from "./lib/paypal.ts"; // also enforces the sandbox guard

const CHANNEL3_URL = "https://api.trychannel3.com/v1/search";

const MISSING = "(missing)";

function cell(v: unknown, width: number): string {
  const s = v === undefined || v === null || v === "" ? MISSING : String(v);
  return s.length > width ? s.slice(0, width - 1) + "…" : s.padEnd(width);
}

export async function runChannel3(): Promise<boolean> {
  const key = process.env.CHANNEL3_API_KEY;
  if (!key) throw new Error("CHANNEL3_API_KEY missing from .env");

  const res = await fetch(CHANNEL3_URL, {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query: "running shoes", limit: 5 }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`Channel3 error: HTTP ${res.status}`);
    console.error(`  body: ${text.slice(0, 500)}`);
    return false;
  }
  const body = JSON.parse(text);
  console.log(`Response top-level keys: ${Object.keys(body).join(", ")}`);

  const products: any[] = Array.isArray(body.products) ? body.products : [];
  if (products.length === 0) {
    console.log("No products returned (or no 'products' array in the response).");
    return false;
  }
  console.log(`First result raw keys: ${Object.keys(products[0]).join(", ")}\n`);

  const W = { t: 44, p: 12, a: 12, u: 60 };
  console.log(`${"#".padEnd(3)}${cell("title", W.t)} ${cell("price", W.p)} ${cell("availability", W.a)} ${"buy URL"}`);
  console.log("-".repeat(3 + W.t + W.p + W.a + 3 + 20));
  products.forEach((p, i) => {
    const offer = Array.isArray(p.offers) ? p.offers[0] : undefined;
    const price = offer?.price?.price !== undefined
      ? `${offer.price.price} ${offer.price.currency ?? ""}`.trim()
      : offer ? "(missing: offer.price)" : "(no offers)";
    const avail = offer ? offer.availability ?? "(missing)" : "(no offers)";
    const url = offer ? offer.url ?? "(missing: offer.url)" : "(no offers)";
    console.log(`${String(i + 1).padEnd(3)}${cell(p.title, W.t)} ${cell(price, W.p)} ${cell(avail, W.a)} ${url}`);
    if (Array.isArray(p.offers) && p.offers.length > 1) {
      console.log(`   (+${p.offers.length - 1} more offer(s) from other retailers)`);
    }
  });
  return true;
}

if (isMain(import.meta.url)) {
  runChannel3().then((ok) => process.exit(ok ? 0 : 1), (e) => { console.error(String(e)); process.exit(1); });
}
