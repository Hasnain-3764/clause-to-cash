"use client";
import type { ReactNode } from "react";
import { formatUSD } from "@/engine/money";

type Tone = "slate" | "green" | "amber" | "red" | "blue" | "violet";
const TONES: Record<Tone, string> = {
  slate: "bg-slate-100 text-slate-700 ring-slate-200",
  green: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  red: "bg-rose-50 text-rose-700 ring-rose-200",
  blue: "bg-sky-50 text-sky-700 ring-sky-200",
  violet: "bg-violet-50 text-violet-700 ring-violet-200",
};

export function Badge({ tone = "slate", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ring-1 ring-inset ${TONES[tone]}`}>
      {children}
    </span>
  );
}

export const FixtureBadge = () => <Badge tone="violet" title="Recorded data replayed in DEMO_MODE, not a live call">Fixture</Badge>;

export function DecisionBadge({ decision, approved }: { decision: string; approved?: boolean }) {
  if (approved) return <Badge tone="green">Approved</Badge>;
  if (decision === "allow") return <Badge tone="green">Allow</Badge>;
  if (decision === "needs_approval") return <Badge tone="amber">Needs approval</Badge>;
  return <Badge tone="red">Deny</Badge>;
}

export function ConfidenceBadge({ value }: { value: number }) {
  const tone: Tone = value >= 0.9 ? "green" : value >= 0.7 ? "amber" : "red";
  return <Badge tone={tone} title="Model confidence; 0 when the quote could not be found in the contract">{Math.round(value * 100)}% conf</Badge>;
}

export function Card({ title, actions, children, className = "" }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Button({ children, onClick, disabled, variant = "secondary", title, type = "button" }: { children: ReactNode; onClick?: () => void; disabled?: boolean; variant?: "primary" | "secondary" | "danger" | "ghost"; title?: string; type?: "button" | "submit" }) {
  const v = {
    primary: "bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-emerald-300",
    secondary: "bg-white text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 disabled:text-slate-400",
    danger: "bg-white text-rose-700 ring-1 ring-inset ring-rose-300 hover:bg-rose-50 disabled:text-rose-300",
    ghost: "text-slate-600 hover:bg-slate-100 disabled:text-slate-300",
  }[variant];
  return (
    <button type={type} title={title} onClick={onClick} disabled={disabled} className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed ${v}`}>
      {children}
    </button>
  );
}

export const Money = ({ cents, className = "" }: { cents: number; className?: string }) => <span className={`tabular-nums ${className}`}>{formatUSD(cents)}</span>;

export function Stat({ label, cents, hint, tone }: { label: string; cents: number; hint?: ReactNode; tone?: "green" | "amber" | "slate" }) {
  const color = tone === "green" ? "text-emerald-700" : tone === "amber" ? "text-amber-700" : "text-slate-900";
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${color}`}>{formatUSD(cents)}</div>
      {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div>;
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return <div className="animate-pulse py-10 text-center text-sm text-slate-500">{label}</div>;
}

export function PageTitle({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
