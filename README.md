# Clause-to-Cash

**Upload a revenue-share or freelancer contract → AI extracts the payment rules, each citing the exact clause → simulate who gets paid what from real PayPal revenue → a human approves the risky lines → pay everyone with PayPal Payouts → reconcile what the contract expected against what PayPal actually paid.**

Built for the PayPal AI Hackathon (Nov 2026). Everything runs in the **PayPal sandbox**.

## The problem

Creators, agencies and small labels pay collaborators out of revenue under contracts full of tiers, milestones, caps, reserves and recoupments. Today that means someone reads the PDF, rebuilds the maths in a spreadsheet, sends payments by hand, and hopes nobody gets paid twice. Mistakes are expensive, and nobody can point to *which clause* justified *which dollar*.

Clause-to-Cash makes every payout traceable from a contract clause to a PayPal transaction ID.

## How it works

| Step | What happens | PayPal / AI |
|---|---|---|
| 1. Contract | Gemini reads the contract and returns typed payment rules. Every rule carries a **verbatim quote + page**, and the code checks the quote really is in the contract. A rule whose quote can't be found gets confidence 0. Gemini also lists **money clauses the rule types can't express** (e.g. "any amount above that limit rolls over to the following month"). | Gemini via Vercel AI SDK |
| 2. Simulate | Revenue = real captured sandbox orders. The engine computes each person's share in integer cents and compares it with a naive equal split. | PayPal Orders v2 |
| 3. Approve & pay | A policy engine marks each line **allow / needs approval / deny**. Approvals are recorded in the ledger. Payable lines go out as one PayPal Payouts batch with an idempotent `sender_batch_id`. | PayPal Payouts |
| 4. Reconcile | Contract-expected vs PayPal-paid per person, with batch, item and transaction IDs. Every step is in a hash-chained, append-only ledger. | PayPal Payouts (GET batch) |

### Policy (deny > needs approval > allow)

- **Deny:** payouts + reserve would exceed revenue; recipient is not a known sandbox account in `config/accounts.json`; the line depends on a rejected rule.
- **Needs approval:** a rule has confidence < 0.7 and is unconfirmed; the amount is over the threshold ($1,000 by default); rules conflict; the AI found a clause affecting this party that the rules don't encode.
- An approval covers one exact amount. If revenue changes, it has to be approved again.

### Paying twice is impossible by construction

`sender_batch_id = hash(contractId, period, sorted lines)`, sent again as the `PayPal-Request-Id` header. Two guards:
1. Our ledger refuses to resubmit a batch it already sent.
2. PayPal itself rejects a reused `sender_batch_id`. We tested this live in the sandbox, with both the same and a different `PayPal-Request-Id`: `400 USER_BUSINESS_ERROR: Batch with given sender_batch_id already exists`.

## Real sandbox results (recorded 2026-11-09)

| Contract | Revenue captured | Payout batch | Paid | Notes |
|---|---|---|---|---|
| Creator collab (tiered 20%/30% + 10% reserve) | $800.00 (2 orders) | `L4R55LW2LHLVL` | $144.00 + $40.00 | $16 held in reserve; 3 duplicate attempts refused |
| Music split (50/30/5 + advance clawback) | $1,000.00 | `SR79VSPKE9VQ6` | $250.00 + $300.00 | $250 recouped; guitarist's $50 **denied** (unknown recipient) |
| Agency freelancer (milestones + $3k cap + $250 minimum) | $4,000.00 | `VX5DVZ7VTCJXC` | $3,000.00 + $320.00 | Designer capped at $3,000 and **approved by a human** first |

All paid lines reconcile to the cent. The ledger from this run ships as `fixtures/ledger.sandbox-2026-11-09.jsonl` and is what DEMO_MODE replays.

AI extraction on the three sample contracts (Gemini 3.5 Flash, ~10–25 s each): **12/12 rules exact**, every quote verified, and payouts identical to our hand-checked rules at four revenue levels. It correctly skipped the non-binding "Studio *may* pay a bonus" clause as a rule and flagged it as an unmodeled clause instead.

## Run it

Requires Node 22+.

### Demo mode (no keys, no network calls)

```bash
npm install
npm run dev:demo        # http://localhost:3101
```

DEMO_MODE uses cached AI extractions (`fixtures/extractions/`) and the recorded sandbox ledger. Recorded data is marked with a **FIXTURE** badge, and sending payouts is disabled.

### Live sandbox mode

```bash
cp .env.example .env    # fill in PayPal sandbox app + Gemini key
npm install
npm run dev             # http://localhost:3100
```

`.env` needs `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_BASE=https://api-m.sandbox.paypal.com` (any other value is refused), `GEMINI_API_KEY` (free from Google AI Studio) and `GEMINI_MODEL` (we used `gemini-3.5-flash`). Payouts must be enabled on the sandbox app. Payees must be listed in `config/accounts.json`.

### CLI

```bash
npm run revenue -- create --contract creator-collab --period 2026-11 --amount 500.00   # prints an approve link
npm run revenue -- capture          # after a sandbox buyer approves in the browser
npm run extract                     # AI extraction + score vs hand-checked rules (DEMO_MODE=1 uses cache)
npm run demo                        # dry-run payout plan; add --send to pay, --resubmit to test duplicates
npm test                            # 40 tests incl. property tests
npm run typecheck
```

## What works, what is simulated, what is out of scope

**Works for real (sandbox):** order create/capture as revenue, payout batches, polling every 3s up to 60s, duplicate protection, reconciliation, AI extraction with quote verification, approvals, and the ledger.

**Simulated or simplified:**
- The "what-if revenue" box in the simulator is clearly labelled and can never be paid out.
- Reserves are computed and held back, but nothing releases them after the hold period (no scheduler).
- The clawback balance is the contract's stated advance each period. Recoupment across periods is not tracked.
- The cap rollover in the agency contract is **not** modelled. The AI flags it and the payout needs approval instead.

**Out of scope / not built:**
- PDF upload (`.txt` only).
- Currencies other than USD.
- User accounts and authentication (single-operator demo).
- PayPal webhooks (status comes from polling).
- Production PayPal: the client refuses any non-sandbox URL.
- The ledger is a local JSONL file. On a host with an ephemeral disk it resets on redeploy.

`contracts/upload-example.txt` is a fourth contract for trying the upload flow. Its extraction is cached, so uploading it also works in DEMO_MODE.

Sample contracts in `contracts/` are fictional and written by us. Every PayPal address in them is a sandbox test account.

## Tools used

- **PayPal REST APIs (sandbox):** OAuth2, Orders v2 (create + capture) for revenue, Payouts v1 (create batch + get batch) for paying. Plain `fetch` through one client (`scripts/lib/paypal.ts`) that only talks to `api-m.sandbox.paypal.com`.
- **Google Gemini (`gemini-3.5-flash`)** via the **Vercel AI SDK** (`ai` + `@ai-sdk/google`, `generateObject` with a zod schema). It extracts rules, parties and unmodeled clauses. `generateObject` is deprecated in AI SDK v7 but works; it logs a warning.
- **AG Grid Community** for the payout and reconciliation grids. **Next.js 16** (App Router), **Tailwind 4**, **zod**, **vitest** + **fast-check** for property tests.
- Development was assisted by Claude Code (Anthropic).

## Project layout

```
contracts/            3 sample contracts (.txt) + hand-checked expected rules
config/accounts.json  sandbox payee allow-list (emails only, no secrets)
fixtures/             cached AI extractions + recorded sandbox ledger (DEMO_MODE)
scripts/              PayPal client, revenue capture, extraction, demo CLI
src/engine/           schemas, simulate(), policy(), rounding, quote matching (pure, no I/O)
src/ai/               Gemini extraction, cache, scoring
src/paypal/           Payouts adapter (idempotent create, get, poll)
src/ledger/           append-only hash-chained JSONL ledger
src/core/payrun.ts    plan → approve → submit → reconcile
src/app/              Next.js UI (4 screens) + API routes
tests/                unit, property and end-to-end tests (fake PayPal)
```

### Engine guarantees (property-tested with fast-check, 2,000 random rule sets per property)

- Payouts + reserve never exceed revenue, and lines + reserve + retained equal revenue **to the cent** (largest-remainder rounding).
- Percentage splits that add to 100% pay out exactly the revenue.
- Caps are never breached. Rejected rules never contribute.
- The same input always gives the same decision. The batch key is stable under any reordering of lines.

## License

MIT
