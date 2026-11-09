"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import type { ContractSummary } from "@/server/state";
import { useApi, useSelection } from "./hooks";
import { Badge } from "./ui";

const TABS = [
  { path: "/contract", label: "1 · Contract & rules" },
  { path: "/simulate", label: "2 · Simulate" },
  { path: "/approve", label: "3 · Approve & pay" },
  { path: "/reconcile", label: "4 · Reconcile & ledger" },
];

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { key, period, href, set } = useSelection();
  const meta = useApi<{ contracts: ContractSummary[]; demoMode: boolean; model: string | null }>("/api/contracts");
  const contracts = meta.data?.contracts ?? [];

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
          <Link href={href("/contract")} className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-emerald-600 text-sm font-bold text-white">§</span>
            <span className="font-semibold tracking-tight text-slate-900">Clause-to-Cash</span>
          </Link>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <select aria-label="Contract" className="max-w-[18rem] rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm" value={key} onChange={(e) => set({ c: e.target.value })}>
              {!contracts.some((c) => c.key === key) && <option value={key}>{key}</option>}
              {contracts.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.source === "upload" ? "Uploaded: " : ""}
                  {c.contractId}
                </option>
              ))}
            </select>
            <input aria-label="Period" type="month" className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm" value={period} onChange={(e) => e.target.value && set({ p: e.target.value })} />
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Badge tone="blue" title="All PayPal calls go to api-m.sandbox.paypal.com">PayPal sandbox</Badge>
            {meta.data?.demoMode && <Badge tone="violet" title="Fixtures only: no PayPal or Gemini calls">Demo mode</Badge>}
          </div>
        </div>
        <nav className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 sm:px-6">
          {TABS.map((t) => {
            const active = pathname.startsWith(t.path);
            return (
              <Link key={t.path} href={href(t.path)} className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition ${active ? "border-emerald-600 text-emerald-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}>
                {t.label}
              </Link>
            );
          })}
        </nav>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">{children}</main>
    </div>
  );
}
