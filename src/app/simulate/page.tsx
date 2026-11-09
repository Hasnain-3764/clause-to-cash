"use client";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { useMemo, useState } from "react";
import { Grid } from "@/components/Grid";
import { api, useApi, useSelection } from "@/components/hooks";
import { Badge, Card, DecisionBadge, ErrorBox, FixtureBadge, Loading, Money, PageTitle, Stat } from "@/components/ui";
import { formatUSD, valueToCents } from "@/engine/money";
import type { PlanView } from "@/server/state";

interface Row {
  party: string;
  name: string;
  receiver: string;
  contractCents: number;
  grossCents: number;
  reserveCents: number;
  recoupedCents: number;
  naiveCents: number;
  diffCents: number;
  decision: string;
  approved: boolean;
  how: string;
}

const money = (field: keyof Row): ColDef<Row> => ({
  field,
  type: "rightAligned",
  valueFormatter: (p) => formatUSD(p.value as number),
  comparator: (a: number, b: number) => a - b,
});

export default function SimulatePage() {
  const { key, period } = useSelection();
  const [unselected, setUnselected] = useState<Record<string, boolean>>({});
  const [whatIf, setWhatIf] = useState<string>("");
  const [whatIfOn, setWhatIfOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  let whatIfCents: number | undefined;
  try {
    whatIfCents = whatIfOn && whatIf ? valueToCents(whatIf) : undefined;
  } catch {
    whatIfCents = undefined;
  }
  // Fetch once without a capture filter to learn what is available, then apply the user's unticks.
  const base = useApi<PlanView>("/api/plan", { key, period });
  const captureIds = base.data?.captures.filter((c) => !unselected[c.captureId]).map((c) => c.captureId);
  const { data, error, reload } = useApi<PlanView>(base.data ? "/api/plan" : null, { key, period, captureIds, whatIfCents });

  const rows: Row[] = useMemo(() => {
    if (!data) return [];
    const lineByParty = new Map(data.plan.rows.map((r) => [r.line.party, r]));
    // Every payee party appears, even if the contract pays them nothing this period.
    return data.contract.parties.map((p) => {
      const r = lineByParty.get(p.id);
      const contractCents = r?.line.amountCents ?? 0;
      const naive = data.naive[p.id] ?? 0;
      return {
        party: p.id,
        name: p.name,
        receiver: p.paypalEmail ?? "(none)",
        contractCents,
        grossCents: r?.line.grossCents ?? 0,
        reserveCents: r?.line.reserveCents ?? 0,
        recoupedCents: r?.line.recoupedCents ?? 0,
        naiveCents: naive,
        diffCents: contractCents - naive,
        decision: r ? r.policy.decision : "—",
        approved: !!r?.approved,
        how: r ? r.line.breakdown.map((b) => `${b.note} (${b.deltaCents >= 0 ? "+" : ""}${formatUSD(b.deltaCents)})`).join(" · ") : "Nothing due",
      };
    });
  }, [data]);

  const cols: ColDef<Row>[] = useMemo(
    () => [
      {
        field: "name",
        headerName: "Party",
        minWidth: 230,
        flex: 2,
        autoHeight: true,
        cellRenderer: (p: ICellRendererParams<Row>) => (
          <div className="py-2 leading-5">
            <div className="font-medium">{p.data!.name} <span className="font-normal text-slate-400">· {p.data!.party}</span></div>
            <div className="truncate font-mono text-[11px] text-slate-500">{p.data!.receiver}</div>
          </div>
        ),
      },
      { ...money("naiveCents"), headerName: "Equal split", minWidth: 115, headerTooltip: "Same total, divided equally between payees" },
      { ...money("contractCents"), headerName: "Per contract", minWidth: 120, cellClass: "font-semibold" },
      {
        ...money("diffCents"),
        headerName: "Difference",
        minWidth: 115,
        cellRenderer: (p: ICellRendererParams<Row>) => {
          const v = p.value as number;
          return <span className={`tabular-nums font-medium ${v > 0 ? "text-emerald-700" : v < 0 ? "text-rose-700" : "text-slate-400"}`}>{v > 0 ? "+" : ""}{formatUSD(v)}</span>;
        },
      },
      {
        field: "reserveCents",
        headerName: "Held back",
        type: "rightAligned",
        minWidth: 105,
        headerTooltip: "Reserve held + advance recouped",
        valueGetter: (p) => p.data!.reserveCents + p.data!.recoupedCents,
        valueFormatter: (p) => formatUSD(p.value as number),
      },
      { field: "decision", headerName: "Policy", minWidth: 130, cellRenderer: (p: ICellRendererParams<Row>) => (p.value === "—" ? "—" : <DecisionBadge decision={p.value} approved={p.data!.approved} />) },
    ],
    [],
  );

  async function toggleMilestone(name: string, accepted: boolean) {
    setBusy(true);
    setErr(null);
    try {
      await api("/api/milestone", { key, period, milestone: name, accepted });
      base.reload();
      reload();
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  if (base.error || error) return <ErrorBox error={base.error ?? error} />;
  if (!data || !base.data) return <Loading label="Simulating…" />;
  const s = data.plan.simulation;
  const paid = data.plan.rows.reduce((a, r) => a + r.line.amountCents, 0);
  const naiveTotalDiff = rows.reduce((a, r) => a + Math.abs(r.diffCents), 0);

  return (
    <>
      <PageTitle
        title="Simulate payouts"
        subtitle={<>Who gets what from {data.revenueSource === "simulated" ? "a what-if revenue figure" : "captured sandbox revenue"} for {data.contract.contractId}, {period}.</>}
      />
      <div className="grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card title="Revenue" actions={data.demoMode ? <FixtureBadge /> : <Badge tone="blue">Sandbox</Badge>}>
            {base.data.captures.length === 0 && <p className="text-sm text-slate-500">No captured sandbox orders for this contract in {period}. Use a what-if figure, or capture orders with <code className="rounded bg-slate-100 px-1 text-xs">npm run revenue</code>.</p>}
            <ul className="space-y-2">
              {base.data.captures.map((c) => (
                <li key={c.captureId}>
                  <label className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2 text-sm ${whatIfOn ? "opacity-50" : ""} ${!unselected[c.captureId] ? "border-emerald-200 bg-emerald-50/50" : "border-slate-200"}`}>
                    <input type="checkbox" className="mt-1 accent-emerald-600" disabled={whatIfOn} checked={!unselected[c.captureId]} onChange={(e) => setUnselected({ ...unselected, [c.captureId]: !e.target.checked })} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <Money cents={c.amountCents} className="font-semibold" />
                        {c.fixture && <FixtureBadge />}
                      </span>
                      <span className="block truncate font-mono text-[11px] text-slate-500">order {c.orderId}</span>
                      <span className="block truncate font-mono text-[11px] text-slate-500">capture {c.captureId}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <label className="mt-4 flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" className="accent-amber-600" checked={whatIfOn} onChange={(e) => setWhatIfOn(e.target.checked)} />
              What-if revenue
            </label>
            {whatIfOn && (
              <div className="mt-2">
                <div className="flex items-center rounded-lg border border-amber-300 bg-amber-50 px-2">
                  <span className="text-slate-500">$</span>
                  <input inputMode="decimal" placeholder="8000.00" value={whatIf} onChange={(e) => setWhatIf(e.target.value)} className="w-full bg-transparent px-1 py-1.5 text-sm outline-none" />
                </div>
                <p className="mt-1 text-xs text-amber-700">Simulated only. What-if figures can never be paid out.</p>
              </div>
            )}
          </Card>

          {data.milestones.length > 0 && (
            <Card title="Milestones accepted this period">
              <ul className="space-y-2">
                {data.milestones.map((m) => (
                  <li key={m.name}>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" className="accent-emerald-600" disabled={busy} checked={m.accepted} onChange={(e) => toggleMilestone(m.name, e.target.checked)} />
                      {m.name}
                    </label>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-slate-500">Recorded in the ledger as an acceptance event.</p>
              <ErrorBox error={err} />
            </Card>
          )}
        </div>

        <div className="min-w-0 space-y-4">
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label={data.revenueSource === "simulated" ? "Revenue (what-if)" : "Revenue (captured)"} cents={data.plan.revenueCents} tone={data.revenueSource === "simulated" ? "amber" : undefined} />
            <Stat label="Paid to parties" cents={paid} tone="green" />
            <Stat label="Held in reserve" cents={s.reserveCents} hint={s.recoupedCents ? `+ ${formatUSD(s.recoupedCents)} advance recouped` : undefined} />
            <Stat label={`Kept by ${data.contract.payer}`} cents={s.retainedCents} />
          </div>
          <Card
            title="Who gets what"
            actions={
              naiveTotalDiff > 0 ? (
                <span className="text-xs text-slate-500">
                  An equal split would send <b className="text-rose-700">{formatUSD(naiveTotalDiff / 2)}</b> to the wrong people
                </span>
              ) : null
            }
          >
            <Grid rows={rows} cols={cols} />
            <div className="mt-4 space-y-1.5">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">How each amount was computed</h3>
              {data.plan.rows.map((r) => (
                <div key={r.line.party} className="flex flex-wrap items-baseline gap-x-2 text-xs text-slate-600">
                  <b className="font-medium text-slate-800">{data.partyNames[r.line.party] ?? r.line.party}:</b>
                  {r.line.breakdown.map((b, i) => (
                    <span key={i} className="whitespace-nowrap">
                      {i > 0 && <span className="mr-2 text-slate-300">→</span>}
                      {b.note} <span className={`tabular-nums ${b.deltaCents < 0 ? "text-rose-700" : "text-emerald-700"}`}>{b.deltaCents >= 0 ? "+" : ""}{formatUSD(b.deltaCents)}</span>
                      <span className="ml-1 font-mono text-slate-400">{b.ruleId}</span>
                    </span>
                  ))}
                  <span className="whitespace-nowrap"><span className="mr-2 text-slate-300">=</span><b className="tabular-nums">{formatUSD(r.line.amountCents)}</b></span>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-slate-500">
              Naive equal split takes the same total the contract pays out and divides it equally among the {data.contract.parties.length} payees, ignoring who the contract says earned what. Rounding uses largest-remainder, so every column sums to the cent.
            </p>
          </Card>
          {s.warnings.length > 0 && (
            <Card title="Engine notes">
              <ul className="space-y-1 text-sm">
                {s.warnings.map((w, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <Badge tone={w.severity === "conflict" ? "red" : w.severity === "warning" ? "amber" : "slate"}>{w.code}</Badge>
                    <span className="text-slate-600">{w.party ? `${data.partyNames[w.party] ?? w.party}: ` : ""}{w.message}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
