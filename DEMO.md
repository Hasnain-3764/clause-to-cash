# Clause-to-Cash: 3-minute demo script

Target: **2:50**. Judges stop at 3:00.

## Before recording (10 minutes)

1. `npm run dev` (live sandbox mode, http://localhost:3100). Browser at 1440×900, zoom 110%.
2. Set up a fresh live payout to show on camera, using a period that has no payouts yet:
   ```bash
   npm run revenue -- create --contract creator-collab --period 2026-12 --amount 800.00
   # approve the link as sandbox buyer-1, then:
   npm run revenue -- capture
   ```
3. Open these tabs in order:
   - `/contract?c=agency-freelancer&p=2026-11`
   - `/simulate?c=creator-collab&p=2026-12`
   - `/approve?c=creator-collab&p=2026-12`
   - `/reconcile?c=music-split&p=2026-11`
4. Close anything showing secrets (`.env`, terminal history).

If anything fails live, record the same path with `npm run dev:demo` (port 3101). Everything except "Send payout" works there from fixtures; say so on camera.

## Script

**0:00–0:20 · Problem** (title card or the contract tab)
> "Creators, agencies and labels pay collaborators out of revenue under contracts full of tiers, caps, milestones and advances. Someone rebuilds that in a spreadsheet and sends payments by hand. Clause-to-Cash turns the contract into payouts on PayPal, and every dollar traces back to a clause."

**0:20–0:55 · AI reads the contract** (agency contract tab)
- Click rule **r3 (cap $3,000)**. The clause highlights in the contract.
> "Gemini extracted five rules. Each cites the exact sentence, and our code checks the quote really is in the contract. If the model invents a quote, confidence drops to zero and the payout can't go out without a human."
- Scroll to **"Clauses the rules can't express"** and click the rollover clause.
> "It also flags what it *can't* model: this cap rollover. That's not silently ignored; it sends the designer's payout to approval."
- Click **Confirm** on one rule.
- Optional (+15 s): **Upload contract** → choose `contracts/upload-example.txt` → about 10 s later, 3 new rules plus a flagged "may deduct refunds" clause. Its extraction is cached, so this also works in demo mode.

**0:55–1:30 · Simulate with real PayPal revenue** (simulate tab, creator-collab, 2026-12)
> "Revenue isn't typed in. These are real sandbox orders, captured through PayPal Orders."
- Point at the stats and the grid: creator $144 (tiered 20% with 10% held in reserve), editor $40.
> "A naive equal split of the same money would send $52 to the wrong person. Every amount shows how it was computed, to the cent."
- Untick one order and show the numbers change. Re-tick it.

**1:30–2:15 · Policy, approval, PayPal Payouts** (approve tab)
> "Every line goes through a policy engine: allow, needs approval, or deny."
- The creator line is in the inbox (UNMODELED_CLAUSE: the discretionary bonus). Type your name and click **Approve**.
- Click **Send payout** and confirm. Wait for **SUCCESS** with transaction IDs (about 30 s; keep talking):
> "One PayPal Payouts batch. The batch id is a hash of contract, period and lines, so the same payout can't be sent twice."
- Click **Send payout** again and show **Duplicate blocked**.
> "We also tested PayPal directly: it rejects a reused batch id with USER_BUSINESS_ERROR."

**2:15–2:45 · Reconcile** (reconcile tab, music-split)
> "Here the contract says the guitarist is owed $50, but their PayPal account isn't on our allow-list, so policy denied it. It shows as blocked, not lost. Artist and producer match PayPal to the cent, with batch, item and transaction IDs."
- Scroll to the ledger: **Hash chain intact**.
> "Every decision, approval and PayPal response is in an append-only, hash-chained ledger."

**2:45–2:55 · Close**
> "Clause-to-Cash: contract in, PayPal payouts out, every dollar cited. Built on PayPal Orders and Payouts with Gemini. All sandbox, all open source."

## Numbers to say (from the recorded run)

- 3 contracts, 12/12 rules extracted exactly, every quote verified.
- $5,800 captured, 3 payout batches, $4,054 paid, 1 line blocked, 0 mismatches.
- 40 tests, including property tests over 2,000 random rule sets each.
