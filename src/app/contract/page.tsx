"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, useApi, useSelection } from "@/components/hooks";
import { Badge, Button, Card, ConfidenceBadge, ErrorBox, FixtureBadge, Loading, PageTitle } from "@/components/ui";
import { RULE_LABEL, describeRule } from "@/engine/describe";
import type { Rule } from "@/engine/schema";
import type { LoadedContract } from "@/server/state";

export default function ContractPage() {
  const { key, href } = useSelection();
  const { data, error, loading, reload } = useApi<LoadedContract>(`/api/contracts/${encodeURIComponent(key)}`);
  const meta = useApi<{ demoMode: boolean }>("/api/contracts");
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const markRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setSelected(null);
  }, [key]);
  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollIntoView.
    markRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [selected]);

  const parties = useMemo(() => Object.fromEntries((data?.contract.parties ?? []).map((p) => [p.id, p])), [data]);
  const flagsByRule = useMemo(() => {
    const m: Record<string, { code: string; message: string }[]> = {};
    for (const f of data?.extraction.flags ?? []) if (f.ruleId) (m[f.ruleId] ??= []).push(f);
    return m;
  }, [data]);

  async function review(rule: Rule, status: Rule["status"]) {
    setBusy(rule.id);
    setActionError(null);
    try {
      await api(`/api/contracts/${encodeURIComponent(key)}/review`, { ruleId: rule.id, status });
      reload();
    } catch (e) {
      setActionError(String((e as Error).message));
    } finally {
      setBusy(null);
    }
  }

  async function reextract() {
    setBusy("extract");
    setActionError(null);
    try {
      await api(`/api/contracts/${encodeURIComponent(key)}?force=1`);
      reload();
    } catch (e) {
      setActionError(String((e as Error).message));
    } finally {
      setBusy(null);
    }
  }

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading label={loading ? "Reading contract and extracting rules…" : "Loading…"} />;

  const x = data.extraction;
  const range = selected ? data.ranges[selected] : null;
  const text = data.text;
  const confirmed = data.contract.rules.filter((r) => r.status === "confirmed").length;
  const rejected = data.contract.rules.filter((r) => r.status === "rejected").length;

  return (
    <>
      <PageTitle
        title={data.contract.title || data.contract.contractId}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span>
              Payer: <b className="font-medium text-slate-700">{data.contract.payer}</b> · {data.contract.rules.length} rules · {confirmed} confirmed · {rejected} rejected
            </span>
            {data.fromCache ? <Badge tone="slate" title={`Extracted ${new Date(x.extractedAt).toLocaleString()}`}>Cached extraction</Badge> : <Badge tone="green">Live extraction</Badge>}
            {meta.data?.demoMode && <FixtureBadge />}
            <Badge tone="blue">{x.model}</Badge>
          </span>
        }
        actions={
          <>
            <Button onClick={() => setShowUpload(true)}>Upload contract</Button>
            <Button onClick={reextract} disabled={busy === "extract" || meta.data?.demoMode} title={meta.data?.demoMode ? "Disabled in demo mode" : "Run Gemini again on this contract"}>
              {busy === "extract" ? "Extracting…" : "Re-extract with AI"}
            </Button>
          </>
        }
      />
      <ErrorBox error={actionError} />
      {showUpload && <UploadDialog onClose={() => setShowUpload(false)} demoMode={!!meta.data?.demoMode} hrefFor={(c) => href("/contract", { c })} />}

      <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <Card title="Contract text" actions={<span className="text-xs text-slate-500">Click a rule to highlight its clause</span>} className="lg:sticky lg:top-28 lg:self-start">
          <div className="max-h-[70vh] overflow-auto rounded-lg bg-slate-50 p-4">
            <pre className="whitespace-pre-wrap font-mono text-[12.5px] leading-6 text-slate-700">
              {range ? (
                <>
                  <PagedText text={text.slice(0, range[0])} />
                  <mark ref={markRef} className="clause">{text.slice(range[0], range[1])}</mark>
                  <PagedText text={text.slice(range[1])} />
                </>
              ) : (
                <PagedText text={text} />
              )}
            </pre>
          </div>
          {selected && !range && <p className="mt-2 text-sm text-rose-700">This rule&apos;s quote was not found in the contract, so there is nothing to highlight.</p>}
        </Card>

        <div className="space-y-3">
          {data.contract.rules.map((r) => {
            const party = parties[r.party];
            const flags = flagsByRule[r.id] ?? [];
            const isSel = selected === r.id;
            return (
              <div
                key={r.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelected(isSel ? null : r.id)}
                onKeyDown={(e) => e.key === "Enter" && setSelected(isSel ? null : r.id)}
                className={`cursor-pointer rounded-xl border bg-white p-4 shadow-sm transition ${isSel ? "border-amber-400 ring-2 ring-amber-200" : "border-slate-200 hover:border-slate-300"} ${r.status === "rejected" ? "opacity-60" : ""}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-slate-400">{r.id}</span>
                  <span className="text-sm font-semibold text-slate-800">{RULE_LABEL[r.type]}</span>
                  <span className="text-sm text-slate-500">→ {party ? party.name : r.party}</span>
                  <span className="ml-auto flex items-center gap-1.5">
                    <ConfidenceBadge value={r.confidence} />
                    {r.status === "confirmed" && <Badge tone="green">Confirmed</Badge>}
                    {r.status === "rejected" && <Badge tone="red">Rejected</Badge>}
                    {r.status === "proposed" && <Badge>Proposed</Badge>}
                  </span>
                </div>
                <p className="mt-2 text-[15px] text-slate-900">{describeRule(r)}</p>
                <blockquote className="mt-2 border-l-2 border-slate-200 pl-3 text-sm italic text-slate-500">
                  “{r.source.quote}” <span className="not-italic text-slate-400">· p.{r.source.page}</span>
                </blockquote>
                {flags.map((f) => (
                  <p key={f.code} className={`mt-2 text-xs ${f.code === "QUOTE_NOT_FOUND" ? "text-rose-700" : "text-amber-700"}`}>
                    ⚠ {f.code}: {f.message}
                  </p>
                ))}
                {party && <p className="mt-2 text-xs text-slate-400">Pays to {party.paypalEmail ?? "no PayPal email in contract"}</p>}
                <div className="mt-3 flex gap-2" onClick={(e) => e.stopPropagation()}>
                  <Button variant="primary" disabled={busy === r.id || r.status === "confirmed"} onClick={() => review(r, "confirmed")}>Confirm</Button>
                  <Button variant="danger" disabled={busy === r.id || r.status === "rejected"} onClick={() => review(r, "rejected")}>Reject</Button>
                  {r.status !== "proposed" && <Button variant="ghost" disabled={busy === r.id} onClick={() => review(r, "proposed")}>Undo</Button>}
                </div>
              </div>
            );
          })}
          {data.unmodeled.length > 0 && (
            <div className="rounded-xl border border-amber-300 bg-amber-50/60 p-4">
              <h3 className="text-sm font-semibold text-amber-900">Clauses the rules can&apos;t express ({data.unmodeled.length})</h3>
              <p className="mt-1 text-xs text-amber-800">Gemini found these money-affecting clauses outside the 5 rule types. Payouts to the affected party go to the approval inbox so a person decides.</p>
              <ul className="mt-3 space-y-2">
                {data.unmodeled.map((u) => (
                  <li
                    key={u.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelected(selected === u.id ? null : u.id)}
                    onKeyDown={(e) => e.key === "Enter" && setSelected(selected === u.id ? null : u.id)}
                    className={`cursor-pointer rounded-lg border bg-white p-3 text-sm ${selected === u.id ? "border-amber-400 ring-2 ring-amber-200" : "border-amber-200"}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-slate-400">{u.id}</span>
                      <span className="font-medium">Affects {u.party ? (parties[u.party]?.name ?? u.party) : "every payee"}</span>
                      {!u.verified && <Badge tone="red">Quote not found</Badge>}
                    </div>
                    <p className="mt-1 text-slate-700">{u.reason}</p>
                    <blockquote className="mt-1 border-l-2 border-amber-200 pl-3 text-xs italic text-slate-500">“{u.quote}” <span className="not-italic">· p.{u.page}</span></blockquote>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {data.extraction.flags.filter((f) => !f.ruleId || (!data.contract.rules.some((r) => r.id === f.ruleId) && !data.unmodeled.some((u) => u.id === f.ruleId))).map((f, i) => (
            <p key={i} className="text-xs text-amber-700">⚠ {f.code} {f.ruleId}: {f.message}</p>
          ))}
        </div>
      </div>
    </>
  );
}

/** Renders "=== Page N ===" markers as subtle dividers. */
function PagedText({ text }: { text: string }) {
  const parts = text.split(/(=== Page \d+ ===)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^=== Page \d+ ===$/.test(p) ? (
          <span key={i} className="my-1 inline-block select-none rounded bg-slate-200 px-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            {p.replace(/=/g, "").trim()}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

function UploadDialog({ onClose, demoMode, hrefFor }: { onClose: () => void; demoMode: boolean; hrefFor: (key: string) => string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const { key } = await api<{ key: string }>("/api/contracts", { text });
      onClose();
      router.push(hrefFor(key));
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold">Upload a contract</h2>
        <p className="mt-1 text-sm text-slate-500">
          Plain text (.txt) only. Mark pages with lines like <code className="rounded bg-slate-100 px-1">=== Page 2 ===</code> to get page citations. Use only sample contracts you wrote; text is sent to Gemini.
        </p>
        {demoMode && <p className="mt-2 rounded-lg bg-violet-50 px-3 py-2 text-sm text-violet-800">Demo mode: live AI is off, so only the cached sample contracts can be extracted.</p>}
        <input
          type="file"
          accept=".txt,text/plain"
          className="mt-3 block text-sm"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) setText(await f.text());
          }}
        />
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={12} placeholder="…or paste contract text here" className="mt-3 w-full rounded-lg border border-slate-300 p-3 font-mono text-xs" />
        <ErrorBox error={err} />
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={busy || text.trim().length < 50}>{busy ? "Extracting with Gemini (10–20s)…" : "Extract rules"}</Button>
        </div>
      </div>
    </div>
  );
}
