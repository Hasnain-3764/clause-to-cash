"use client";
import Link from "next/link";
import { useState } from "react";
import { api, useApi, useSelection } from "@/components/hooks";
import { Badge, Button, Card, DecisionBadge, ErrorBox, FixtureBadge, Loading, Money, PageTitle, Stat } from "@/components/ui";
import { describeRule } from "@/engine/describe";
import { formatUSD } from "@/engine/money";
import type { SubmitOutcome } from "@/core/payrun";
import type { PlanView } from "@/server/state";

export default function ApprovePage() {
  const { key, period, href } = useSelection();
  const { data, error, reload } = useApi<PlanView>("/api/plan", { key, period });
  const [approver, setApprover] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<SubmitOutcome | null>(null);

  async function approve(party: string) {
    setBusy(party);
    setErr(null);
    try {
      await api("/api/approve", { key, period, party, approvedBy: approver.trim() || "reviewer" });
      reload();
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(null);
    }
  }

  async function send() {
    if (!data) return;
    setBusy("send");
    setErr(null);
    setResult(null);
    try {
      setResult(await api<SubmitOutcome>("/api/payout", { key, period, confirmTotalCents: data.payableTotalCents }));
      setConfirming(false);
      reload();
    } catch (e) {
      setErr(String((e as Error).message));
      setConfirming(false);
    } finally {
      setBusy(null);
    }
  }

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  const rulesById = Object.fromEntries(data.contract.rules.map((r) => [r.id, r]));
  const inbox = data.plan.rows.filter((r) => r.policy.decision === "needs_approval" && !r.approved);
  const approved = data.plan.rows.filter((r) => r.approved);
  const denied = data.plan.rows.filter((r) => r.policy.decision === "deny");
  const payable = data.plan.rows.filter((r) => r.payable);
  const alreadySent = data.submittedBatches.find((b) => b.senderBatchId === data.plan.senderBatchId);

  return (
    <>
      <PageTitle
        title="Approve & pay"
        subtitle={<>Policy runs on every payout line. Risky lines wait here for a human; denied lines are never sent. Revenue: captured sandbox orders for {period}{data.milestones.some((m) => m.accepted) ? " · accepted milestones included" : ""}.</>}
        actions={data.demoMode ? <FixtureBadge /> : undefined}
      />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Captured revenue" cents={data.plan.revenueCents} hint={`${data.captures.length} sandbox order(s)`} />
        <Stat label="Ready to pay" cents={data.payableTotalCents} tone="green" hint={`${payable.length} line(s)`} />
        <Stat label="Waiting for approval" cents={inbox.reduce((a, r) => a + r.line.amountCents, 0)} tone="amber" hint={`${inbox.length} line(s)`} />
        <Stat label="Blocked by policy" cents={denied.reduce((a, r) => a + r.line.amountCents, 0)} hint={`${denied.length} line(s)`} />
      </div>
      <ErrorBox error={err} />

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-5">
          <Card
            title={<span className="flex items-center gap-2">Approval inbox <Badge tone="amber">{inbox.length}</Badge></span>}
            actions={<input value={approver} onChange={(e) => setApprover(e.target.value)} placeholder="Your name" className="w-36 rounded-lg border border-slate-300 px-2 py-1 text-sm" aria-label="Approver name" />}
          >
            {inbox.length === 0 && <p className="text-sm text-slate-500">Nothing waiting. Lines over the approval threshold, with low-confidence rules, or with conflicting rules land here.</p>}
            <ul className="space-y-3">
              {inbox.map((r) => (
                <li key={r.line.party} className="rounded-lg border border-amber-200 bg-amber-50/40 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-medium">{data.partyNames[r.line.party] ?? r.line.party}</div>
                      <div className="font-mono text-[11px] text-slate-500">{r.line.receiver}</div>
                    </div>
                    <Money cents={r.line.amountCents} className="text-lg font-semibold" />
                  </div>
                  <ul className="mt-2 space-y-1">
                    {r.policy.reasons.map((x, i) => (
                      <li key={i} className="text-sm text-amber-900"><Badge tone="amber">{x.code}</Badge> <span className="ml-1">{x.detail}</span></li>
                    ))}
                  </ul>
                  <details className="mt-2 text-xs text-slate-600">
                    <summary className="cursor-pointer text-slate-500">Rules behind this amount</summary>
                    <ul className="mt-1 space-y-1">
                      {r.line.ruleIds.map((id) => rulesById[id] && (
                        <li key={id}>
                          <span className="font-mono text-slate-400">{id}</span> {describeRule(rulesById[id])} · <i>“{rulesById[id].source.quote}”</i> (p.{rulesById[id].source.page}, {Math.round(rulesById[id].confidence * 100)}% conf, {rulesById[id].status})
                        </li>
                      ))}
                    </ul>
                  </details>
                  <div className="mt-3 flex gap-2">
                    <Button variant="primary" disabled={busy === r.line.party} onClick={() => approve(r.line.party)}>Approve {formatUSD(r.line.amountCents)}</Button>
                    <Link href={href("/contract")} className="self-center text-sm text-slate-500 underline-offset-2 hover:underline">Review rules</Link>
                  </div>
                </li>
              ))}
            </ul>
            {approved.length > 0 && (
              <p className="mt-3 text-xs text-slate-500">Approved: {approved.map((r) => `${data.partyNames[r.line.party] ?? r.line.party} (${formatUSD(r.line.amountCents)})`).join(", ")}. An approval covers that exact amount only.</p>
            )}
          </Card>

          {denied.length > 0 && (
            <Card title={<span className="flex items-center gap-2">Blocked by policy <Badge tone="red">{denied.length}</Badge></span>}>
              <ul className="space-y-2">
                {denied.map((r) => (
                  <li key={r.line.party} className="rounded-lg border border-rose-200 bg-rose-50/40 p-3 text-sm">
                    <div className="flex justify-between gap-3">
                      <span className="font-medium">{data.partyNames[r.line.party] ?? r.line.party} <span className="font-mono text-[11px] font-normal text-slate-500">{r.line.receiver ?? "no email"}</span></span>
                      <Money cents={r.line.amountCents} className="font-semibold" />
                    </div>
                    {r.policy.reasons.filter((x) => ["PAYOUTS_EXCEED_REVENUE", "RECIPIENT_NOT_ALLOWED", "RULE_REJECTED", "RULE_MISSING", "INVALID_AMOUNT"].includes(x.code)).map((x, i) => (
                      <p key={i} className="mt-1 text-rose-800"><Badge tone="red">{x.code}</Badge> <span className="ml-1">{x.detail}</span></p>
                    ))}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <Card title="Payout batch">
          {payable.length === 0 ? (
            <p className="text-sm text-slate-500">{data.plan.revenueCents === 0 ? `No captured revenue for ${period}, so there is nothing to pay.` : "No lines are payable yet."}</p>
          ) : (
            <>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="pb-2 font-medium">Recipient</th>
                    <th className="pb-2 font-medium">Policy</th>
                    <th className="pb-2 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {payable.map((r) => (
                    <tr key={r.line.party}>
                      <td className="py-2">
                        <div className="font-medium">{data.partyNames[r.line.party] ?? r.line.party}</div>
                        <div className="font-mono text-[11px] text-slate-500">{r.line.receiver}</div>
                      </td>
                      <td className="py-2"><DecisionBadge decision={r.policy.decision} approved={r.approved} /></td>
                      <td className="py-2 text-right"><Money cents={r.line.amountCents} className="font-semibold" /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-slate-200">
                    <td className="pt-2 font-medium" colSpan={2}>Total from sandbox business account</td>
                    <td className="pt-2 text-right"><Money cents={data.payableTotalCents} className="text-lg font-semibold text-emerald-700" /></td>
                  </tr>
                </tfoot>
              </table>
              <div className="mt-4 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
                <div>
                  <span className="text-slate-500">sender_batch_id</span> <code className="break-all font-mono">{data.plan.senderBatchId}</code>
                </div>
                <div className="mt-1">Hash of contract, period and sorted lines. The same batch can never be paid twice: PayPal rejects a reused id.</div>
                {alreadySent && (
                  <div className="mt-2 text-amber-800">
                    Already submitted {new Date(alreadySent.ts).toLocaleString()} as PayPal batch <code className="font-mono">{alreadySent.payoutBatchId}</code>. Sending again will be blocked as a duplicate and logged.
                  </div>
                )}
              </div>
              <div className="mt-4 flex items-center gap-3">
                <Button variant="primary" disabled={data.demoMode || busy === "send"} onClick={() => setConfirming(true)} title={data.demoMode ? "Disabled in demo mode" : undefined}>
                  Send payout
                </Button>
                {data.demoMode && <span className="text-xs text-violet-700">Demo mode: sending is disabled. See the recorded sandbox run in Reconcile.</span>}
              </div>
            </>
          )}
          {result && <OutcomeView result={result} reconcileHref={href("/reconcile")} />}
        </Card>
      </div>

      {confirming && (
        <div className="fixed inset-0 z-30 grid place-items-center bg-slate-900/40 p-4" onClick={() => busy !== "send" && setConfirming(false)}>
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-semibold">Send {formatUSD(data.payableTotalCents)} in sandbox money?</h2>
            <ul className="mt-3 space-y-1 text-sm">
              {payable.map((r) => (
                <li key={r.line.party} className="flex justify-between gap-3">
                  <span className="truncate font-mono text-xs">{r.line.receiver}</span>
                  <Money cents={r.line.amountCents} />
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-slate-500">PayPal Payouts, sandbox only. This waits up to 60 seconds for PayPal to settle the batch.</p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" disabled={busy === "send"} onClick={() => setConfirming(false)}>Cancel</Button>
              <Button variant="primary" disabled={busy === "send"} onClick={send}>{busy === "send" ? "Sending, polling PayPal…" : "Send payout"}</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function OutcomeView({ result, reconcileHref }: { result: SubmitOutcome; reconcileHref: string }) {
  if (result.kind === "nothing_to_pay") return <p className="mt-4 text-sm text-slate-500">Nothing to pay.</p>;
  if (result.kind === "duplicate") {
    return (
      <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        <div className="font-medium">Duplicate blocked ({result.outcome.replace("_", " ")})</div>
        <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px]">{JSON.stringify(result.detail, null, 2)}</pre>
      </div>
    );
  }
  return (
    <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
      <div className="font-medium">PayPal batch {result.payoutBatchId}: {result.final.batchStatus}{result.settled ? "" : " (still settling)"}</div>
      <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
        {result.final.items.map((i) => (
          <li key={i.senderItemId}>{i.receiver} {formatUSD(i.amountCents)} {i.transactionStatus} {i.transactionId ?? ""}</li>
        ))}
      </ul>
      <Link href={reconcileHref} className="mt-2 inline-block font-medium underline">Reconcile →</Link>
    </div>
  );
}
