"use client";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { useMemo, useState } from "react";
import { Grid } from "@/components/Grid";
import { api, useApi, useSelection } from "@/components/hooks";
import { Badge, Button, Card, ErrorBox, FixtureBadge, Loading, PageTitle } from "@/components/ui";
import type { ReconRow } from "@/core/payrun";
import { formatUSD } from "@/engine/money";
import type { LedgerEntry } from "@/ledger/ledger";
import type { PlanView } from "@/server/state";

type ReconGridRow = ReconRow & { name: string };

const STATUS: Record<ReconRow["status"], { tone: "green" | "amber" | "red" | "slate" | "blue"; label: string }> = {
  matched: { tone: "green", label: "✓ Matched" },
  pending: { tone: "blue", label: "Pending at PayPal" },
  underpaid: { tone: "red", label: "Underpaid" },
  overpaid: { tone: "red", label: "Overpaid" },
  blocked: { tone: "red", label: "Blocked by policy" },
  awaiting_approval: { tone: "amber", label: "Awaiting approval" },
  not_sent: { tone: "slate", label: "Not sent" },
};

const moneyCol = (field: keyof ReconGridRow, headerName: string): ColDef<ReconGridRow> => ({
  field,
  headerName,
  type: "rightAligned",
  minWidth: 105,
  valueFormatter: (p) => formatUSD(p.value as number),
});

const ids = (field: "payoutBatchIds" | "payoutItemIds" | "transactionIds", headerName: string): ColDef<ReconGridRow> => ({
  field,
  headerName,
  minWidth: 150,
  autoHeight: true,
  cellRenderer: (p: ICellRendererParams<ReconGridRow>) => {
    const v = (p.value as string[]) ?? [];
    return v.length ? <div className="py-2 font-mono text-[11px] leading-4">{v.map((x) => <div key={x}>{x}</div>)}</div> : <span className="text-slate-300">—</span>;
  },
});

export default function ReconcilePage() {
  const { key, period } = useSelection();
  const plan = useApi<PlanView>("/api/plan", { key, period });
  const contractId = plan.data?.contract.contractId;
  const [allContracts, setAllContracts] = useState(false);
  const ledger = useApi<{ path: string; brokenAt: number | null; entries: LedgerEntry[]; demoMode: boolean }>(contractId ? `/api/ledger${allContracts ? "" : `?contractId=${encodeURIComponent(contractId)}`}` : null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const rows: ReconGridRow[] = useMemo(() => (plan.data ? plan.data.recon.map((r) => ({ ...r, name: plan.data!.partyNames[r.party] ?? r.party })) : []), [plan.data]);
  const cols: ColDef<ReconGridRow>[] = useMemo(
    () => [
      {
        field: "name",
        headerName: "Party",
        minWidth: 190,
        flex: 1.4,
        autoHeight: true,
        cellRenderer: (p: ICellRendererParams<ReconGridRow>) => (
          <div className="py-2 leading-5">
            <div className="font-medium">{p.data!.name}</div>
            <div className="truncate font-mono text-[11px] text-slate-500">{p.data!.receiver ?? "no email"}</div>
          </div>
        ),
      },
      moneyCol("expectedCents", "Expected"),
      moneyCol("paidCents", "Paid"),
      {
        ...moneyCol("diffCents", "Difference"),
        cellRenderer: (p: ICellRendererParams<ReconGridRow>) => <span className={`tabular-nums ${p.value === 0 ? "text-slate-400" : "font-medium text-rose-700"}`}>{formatUSD(p.value)}</span>,
      },
      { field: "status", headerName: "Status", minWidth: 150, cellRenderer: (p: ICellRendererParams<ReconGridRow>) => <Badge tone={STATUS[p.value as ReconRow["status"]].tone}>{STATUS[p.value as ReconRow["status"]].label}</Badge> },
      ids("payoutBatchIds", "PayPal batch"),
      ids("payoutItemIds", "Payout item"),
      ids("transactionIds", "Transaction"),
    ],
    [],
  );

  const pendingBatches = plan.data ? [...new Set(plan.data.recon.filter((r) => r.status === "pending").flatMap((r) => r.payoutBatchIds))] : [];

  async function refresh(payoutBatchId: string) {
    setBusy(true);
    setErr(null);
    try {
      await api("/api/refresh", { key, period, payoutBatchId });
      plan.reload();
      ledger.reload();
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  if (plan.error) return <ErrorBox error={plan.error} />;
  if (!plan.data) return <Loading />;
  const matched = rows.filter((r) => r.status === "matched").length;
  const sentRows = rows.filter((r) => r.paidCents > 0 || r.pendingCents > 0);

  return (
    <>
      <PageTitle
        title="Reconcile"
        subtitle={<>What the contract says each person is owed for {period}, against what PayPal reports as paid. Every number comes from the ledger.</>}
        actions={plan.data.demoMode ? <FixtureBadge /> : undefined}
      />
      <ErrorBox error={err} />
      <Card
        title={
          <span className="flex items-center gap-2">
            Expected vs paid
            {sentRows.length > 0 && matched === sentRows.length && <Badge tone="green">All paid lines match to the cent</Badge>}
          </span>
        }
        actions={pendingBatches.map((b) => (
          <Button key={b} disabled={busy || plan.data!.demoMode} onClick={() => refresh(b)}>
            Refresh {b} from PayPal
          </Button>
        ))}
      >
        <Grid rows={rows} cols={cols} />
        {rows.length === 0 && <p className="mt-2 text-sm text-slate-500">No payout lines for this period.</p>}
      </Card>

      <Card
        className="mt-5"
        title={
          <span className="flex flex-wrap items-center gap-2">
            Ledger
            {ledger.data && (ledger.data.brokenAt === null ? <Badge tone="green" title="Each entry includes the SHA-256 of the previous one">Hash chain intact</Badge> : <Badge tone="red">Chain broken at #{ledger.data.brokenAt}</Badge>)}
            {ledger.data && <span className="font-mono text-xs font-normal text-slate-400">{ledger.data.path}</span>}
          </span>
        }
        actions={
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" className="accent-emerald-600" checked={allContracts} onChange={(e) => setAllContracts(e.target.checked)} />
            All contracts
          </label>
        }
      >
        {!ledger.data ? <Loading /> : <LedgerTable entries={ledger.data.entries} />}
      </Card>
    </>
  );
}

function summarize(e: LedgerEntry): { tone: "green" | "amber" | "red" | "slate" | "blue" | "violet"; text: string; ids: string[] } {
  switch (e.type) {
    case "revenue":
      return { tone: "blue", text: `Captured ${formatUSD(e.amountCents)} from ${e.payerEmail ?? "buyer"} (${e.period})`, ids: [`order ${e.orderId}`, `capture ${e.captureId}`] };
    case "rules":
      return { tone: "slate", text: `Rules snapshot: ${e.rules.length} rules`, ids: [`hash ${e.rulesHash}`] };
    case "rule_review":
      return { tone: e.status === "rejected" ? "red" : e.status === "confirmed" ? "green" : "slate", text: `Rule ${e.ruleId} ${e.status} by ${e.by}`, ids: [] };
    case "milestone_accepted":
      return { tone: "slate", text: `Milestone "${e.milestone}" ${e.accepted ? "accepted" : "un-accepted"} by ${e.by} (${e.period})`, ids: [] };
    case "decision":
      return { tone: e.decision === "deny" ? "red" : e.decision === "allow" || e.approved ? "green" : "amber", text: `${e.party}: ${formatUSD(e.amountCents)} → ${e.approved ? "approved" : e.decision}${e.reasons.length ? ` (${e.reasons.map((r) => r.code).join(", ")})` : ""}`, ids: [] };
    case "approval":
      return { tone: "green", text: `${e.approvedBy} approved ${formatUSD(e.amountCents)} to ${e.party}`, ids: [] };
    case "payout_submitted":
      return { tone: "violet", text: `Payout batch sent: ${e.items.length} item(s), ${formatUSD(e.items.reduce((a, i) => a + i.amountCents, 0))} · ${e.batchStatus}`, ids: [`payout_batch_id ${e.payoutBatchId}`, `sender_batch_id ${e.senderBatchId}`] };
    case "payout_status":
      return {
        tone: e.batchStatus === "SUCCESS" ? "green" : "blue",
        text: `Batch ${e.batchStatus}${e.final ? "" : " (not final)"}: ${e.items.map((i) => `${i.party} ${formatUSD(i.amountCents)} ${i.transactionStatus}`).join(", ")}`,
        ids: [`payout_batch_id ${e.payoutBatchId}`, ...e.items.flatMap((i) => [i.payoutItemId && `item ${i.payoutItemId}`, i.transactionId && `txn ${i.transactionId}`].filter((x): x is string => !!x))],
      };
    case "payout_duplicate":
      return {
        tone: "amber",
        text: `Duplicate ${e.outcome.replace("_", " ")}${e.paypal?.name ? `: PayPal ${e.paypal.status} ${e.paypal.name}, ${e.paypal.issue ?? e.paypal.message}` : ""}`,
        ids: [`sender_batch_id ${e.senderBatchId}`, `PayPal-Request-Id ${e.requestId}`, ...(e.paypal?.debugId ? [`debug_id ${e.paypal.debugId}`] : [])],
      };
  }
}

function LedgerTable({ entries }: { entries: LedgerEntry[] }) {
  const rows = useMemo(() => entries.map((e) => ({ e, ...summarize(e) })), [entries]);
  type R = (typeof rows)[number];
  const cols: ColDef<R>[] = [
    { headerName: "#", valueGetter: (p) => p.data!.e.seq, width: 64, minWidth: 64, maxWidth: 70 },
    { headerName: "Time", valueGetter: (p) => p.data!.e.ts, valueFormatter: (p) => new Date(p.value).toLocaleString(), minWidth: 165, maxWidth: 190 },
    { headerName: "Type", valueGetter: (p) => p.data!.e.type, minWidth: 150, maxWidth: 170, cellRenderer: (p: ICellRendererParams<R>) => <Badge tone={p.data!.tone}>{p.value.replace("_", " ")}</Badge> },
    { headerName: "What happened", valueGetter: (p) => p.data!.text, flex: 2, minWidth: 260, wrapText: true, autoHeight: true, cellClass: "leading-5 py-2" },
    {
      headerName: "PayPal / ledger IDs",
      valueGetter: (p) => p.data!.ids.join(" "),
      flex: 1.6,
      minWidth: 230,
      autoHeight: true,
      cellRenderer: (p: ICellRendererParams<R>) => <div className="py-2 font-mono text-[11px] leading-4 text-slate-600">{p.data!.ids.map((x) => <div key={x} className="truncate">{x}</div>)}</div>,
    },
    { headerName: "Hash", valueGetter: (p) => p.data!.e.hash.slice(0, 10), minWidth: 105, maxWidth: 115, cellClass: "font-mono text-[11px] text-slate-400" },
  ];
  if (!rows.length) return <p className="text-sm text-slate-500">No ledger entries yet.</p>;
  return <Grid rows={rows} cols={cols} height={520} />;
}
