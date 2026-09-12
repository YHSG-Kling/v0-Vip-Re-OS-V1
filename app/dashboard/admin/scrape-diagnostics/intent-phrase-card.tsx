// app/dashboard/admin/scrape-diagnostics/intent-phrase-card.tsx
// ─── WHICH SCRAPE PHRASES ACTUALLY PRODUCE CLIENTS ───────────────────────────
//
// The reverse-cohort view: for every `intent.matched` phrase that fired on a
// raw scraped record, how often that record became a lead and then a contact.
// lib/analytics/intent-phrase-rollup.ts documents itself as "call from a
// dashboard widget or the daily scraping cron" and had NEITHER — so the
// feedback loop it exists for (weight the next pull's query bank toward the
// phrases that convert) was never closed, and nobody could see which of the
// scraper's intent phrases were earning their keep.
//
// Server component, read-only, styled to the dark diagnostics theme it sits on.
// Scope is the caller's: the page passes its own brokerage id for a tenant
// admin and omits it only for platform staff.

import type { IntentPhraseStat } from "@/lib/analytics/intent-phrase-rollup"

const pct = (r: number) => `${Math.round(r * 100)}%`

export function IntentPhraseCard({
  stats,
  error,
  scopeLabel,
  sinceDays,
}: {
  stats: IntentPhraseStat[]
  error: string | null
  scopeLabel: string
  sinceDays: number
}) {
  return (
    <section className="mx-auto max-w-7xl px-4 pb-10">
      <div className="rounded-lg border border-white/10 bg-white/5 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-white">Intent phrase performance</h2>
          <p className="text-xs text-white/50">
            {scopeLabel} · last {sinceDays} days · ranked by conversion to contact
          </p>
        </div>
        <p className="mt-1 text-xs text-white/60">
          Every phrase the scraper&apos;s intent matcher fired on, and what became of the records it
          fired on. High conversion = worth weighting the next pull toward.
        </p>

        {error ? (
          <p className="mt-4 text-sm text-red-300">
            The phrase rollup could not be read, so nothing below is a reading of it: {error}
          </p>
        ) : stats.length === 0 ? (
          <p className="mt-4 text-sm text-white/50">
            No phrase fired often enough in this window to be worth ranking.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-white/50">
                  <th className="py-1.5 pr-3">Phrase</th>
                  <th className="py-1.5 px-3 text-right">Raw records</th>
                  <th className="py-1.5 px-3 text-right">→ Lead</th>
                  <th className="py-1.5 px-3 text-right">→ Contact</th>
                  <th className="py-1.5 px-3 text-right">Conversion</th>
                  <th className="py-1.5 pl-3 text-right">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((s) => (
                  <tr key={s.phrase} className="border-t border-white/10 text-white/90">
                    <td className="py-1.5 pr-3 font-mono text-xs">{s.phrase}</td>
                    <td className="py-1.5 px-3 text-right">{s.totalRawRecords}</td>
                    <td className="py-1.5 px-3 text-right">{s.promotedToLead}</td>
                    <td className="py-1.5 px-3 text-right">{s.becameContact}</td>
                    <td className="py-1.5 px-3 text-right">{pct(s.conversionRate)}</td>
                    <td className="py-1.5 pl-3 text-right text-white/50">
                      {s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleDateString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}
