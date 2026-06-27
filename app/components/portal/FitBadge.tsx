// app/components/portal/FitBadge.tsx
// ─────────────────────────────────────────────────────────────────────────────
// THE FIT BADGE — the buyer's personal compatibility score, surfaced WHILE BROWSING (not just on
// the detail page). RealScout's signature is the match %; ours is warmer — a "fit" chip the buyer's
// own AI computed from what they've loved/saved. Client-safe: a low score is never a scary red
// number, it's "Worth a look" — we never tell a buyer a home is bad, we let them explore.
//
// PURE presentational. Renders nothing when there's no real score (honest — no fabricated fit).

import { Sparkles } from "lucide-react"

/** Warm, never-scary framing for a 0–100 buyer-fit score. Low scores stay inviting, never red. */
export function fitBadgeStyle(score: number): { label: string; cls: string } {
  if (score >= 80) return { label: "Great fit", cls: "bg-emerald-100 text-emerald-800 border-emerald-200" }
  if (score >= 60) return { label: "Good fit", cls: "bg-blue-100 text-blue-800 border-blue-200" }
  if (score >= 40) return { label: "Worth a look", cls: "bg-amber-100 text-amber-800 border-amber-200" }
  // Never alarm — a low fit is an invitation to explore, framed neutrally (no red).
  return { label: "Some tradeoffs", cls: "bg-slate-100 text-slate-700 border-slate-200" }
}

/** Normalize a score that may arrive 0–1 or 0–100 into 0–100. */
function normalize(score: number): number {
  const n = score <= 1 ? score * 100 : score
  return Math.round(Math.max(0, Math.min(100, n)))
}

export function FitBadge({
  score,
  size = "sm",
  showNumber = true,
}: {
  score: number | null | undefined
  size?: "sm" | "xs"
  showNumber?: boolean
}) {
  if (score === null || score === undefined || Number.isNaN(score)) return null
  const pct = normalize(score)
  const { label, cls } = fitBadgeStyle(pct)
  const pad = size === "xs" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-xs"
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border font-medium ${cls} ${pad}`}
      title="Your personal fit — how well this home matches what you've loved so far"
    >
      <Sparkles className={size === "xs" ? "h-2.5 w-2.5" : "h-3 w-3"} />
      {showNumber ? `${pct} · ${label}` : label}
    </span>
  )
}
