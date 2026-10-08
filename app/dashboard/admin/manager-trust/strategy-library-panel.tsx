/**
 * STRATEGY LIBRARY — the platform library card on the Manager Trust governance page (wave 107, lane 107E; m725).
 * Server component: the read is app/actions/admin/strategy-library.ts listStrategyLibraryAction (tenant admin,
 * session tenant). Each card shows the versioned platform strategy (audience, market suitability, average cost,
 * the conversion benchmark from 107F's seam — "unlearned" when none is registered, never a fake number — and the
 * recommended authority), the managers + capabilities it composes, its named gaps, and this brokerage's
 * activation with the RECORDED local adaptation. "Activate" adopts the version; the platform version never changes.
 */
import { activateLibraryStrategyFormAction, listStrategyLibraryAction } from "@/app/actions/admin/strategy-library"
import { AUTHORITY_LEVEL_LABELS } from "@/lib/ai-isa/persona-tool-policy"
import { MANAGERS } from "@/lib/kernel/manager-registry"

export async function StrategyLibraryPanel() {
  const res = await listStrategyLibraryAction()
  if (!res.ok) {
    return <section id="strategy-library" className="mx-6 mb-8 rounded-lg border border-red-200 p-4 text-sm text-red-700">Strategy library unavailable: {res.error}</section>
  }
  return (
    <section id="strategy-library" className="mx-6 mb-8 rounded-lg border p-4">
      <h2 className="text-lg font-semibold">Strategy library{"edition" in res ? ` · edition ${res.edition}` : ""}</h2>
      <p className="mb-3 text-sm text-muted-foreground">
        Reusable plans your managers select instead of inventing one. Benchmarks: {res.learning === "learned" ? "learned (network, privacy-safe)" : `${res.learning}${res.learningReason ? ` — ${res.learningReason}` : ""}`}.
        {res.readRefused ? ` Activations unreadable: ${res.readRefused}.` : ""}
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        {res.entries.map((e) => (
          <article key={`${e.key}@${e.version}`} className="rounded border p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-medium">{e.label}</h3>
              {e.activation ? <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800">Active v{e.activation.version}</span> : null}
            </div>
            <p className="text-muted-foreground">{e.objective}</p>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <dt>Audience</dt><dd>{e.audience}</dd>
              <dt>Domains</dt><dd>{e.domains.length ? e.domains.map((d) => d.replace(/_/g, " ")).join(", ") : "untagged"}</dd>
              <dt>Markets</dt><dd>{e.marketSuitability.join(", ")}</dd>
              <dt>Average cost</dt><dd>${e.averageCostUsd}</dd>
              <dt>Benchmark</dt><dd>{e.benchmark && e.benchmark.conversionRate !== null ? `${(e.benchmark.conversionRate * 100).toFixed(1)}% (n=${e.benchmark.sample})` : "no benchmark yet"}</dd>
              <dt>Authority</dt><dd>{AUTHORITY_LEVEL_LABELS[e.recommendedAuthority]}{e.approval === "always" ? " · always approved by a human" : ""}</dd>
              <dt>Managers</dt><dd>{e.managers.map((m) => MANAGERS[m].label).join(" → ")}</dd>
            </dl>
            {e.gaps.length ? <p className="mt-2 text-xs text-amber-700">Gaps: {e.gaps.map((g) => `${MANAGERS[g.manager].label} — ${g.gap}`).join("; ")}</p> : null}
            {e.activation && e.activation.changes.length ? (
              <ul className="mt-2 list-disc pl-4 text-xs">
                {e.activation.changes.map((c, i) => <li key={i}>{c.field}: {String(c.from)} → {String(c.to)} ({c.source}: {c.reason})</li>)}
              </ul>
            ) : null}
            {e.latest && e.activation?.version !== e.version ? (
              <form action={activateLibraryStrategyFormAction} className="mt-2">
                <input type="hidden" name="key" value={e.key} />
                <input type="hidden" name="version" value={e.version} />
                <button type="submit" className="rounded border px-2 py-1 text-xs">{e.activation ? `Move to v${e.version}` : "Activate"}</button>
              </form>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  )
}
