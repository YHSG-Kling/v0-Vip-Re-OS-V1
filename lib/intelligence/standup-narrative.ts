// ─── MANAGER STANDUP NARRATIVE ───────────────────────────────────────────────
// Pure, import-free composer that turns the per-manager standup lines into a
// short, spoken, broker-facing script — "what your AI team did overnight, what it
// caught, and what needs you." Read aloud by the existing ElevenLabs TTS path
// (app/actions/standup-audio.ts), so the broker can HEAR their brokerage's status.
//
// Pure (hour is an input) → unit-testable (scripts/standup-narrative-simulator.ts).
// This is INTERNAL/staff-facing copy, not a client message — no gateway needed,
// though standup-audio may optionally polish it through the internal AI feature.

import type { ManagerStandupLine } from "./manager-standup"

export interface StandupScriptOptions {
  /** 0–23 local hour for the greeting; omit to skip the time-based greeting. */
  hour?: number
  /** Brokerage display name, woven into the open if provided. */
  brokerageName?: string | null
  /** How many managers to name before summarizing the rest (keeps it ~45s). */
  maxNamed?: number
}

function greetingFor(hour: number | undefined): string {
  if (hour === undefined) return "Here's your team standup."
  if (hour < 12) return "Good morning."
  if (hour < 17) return "Good afternoon."
  return "Good evening."
}

const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? "" : "s"}`

export function composeStandupScript(
  lines: ManagerStandupLine[],
  opts: StandupScriptOptions = {},
): string {
  const parts: string[] = []
  const maxNamed = opts.maxNamed ?? 4

  const open = opts.brokerageName
    ? `${greetingFor(opts.hour)} Here's the standup for ${opts.brokerageName}.`
    : `${greetingFor(opts.hour)} Here's your team standup.`
  parts.push(open)

  if (lines.length === 0) {
    parts.push("Quiet shift — every manager is clear and nothing needs you right now.")
    return parts.join(" ")
  }

  const totalNeedsHuman = lines.reduce((s, l) => s + l.needs_human, 0)
  const totalCaught = lines.reduce((s, l) => s + l.reaped_24h, 0)
  const totalActions = lines.reduce((s, l) => s + l.activity_24h, 0)

  parts.push(`Across your team, ${plural(totalActions, "governed action")} in the last day.`)

  if (totalCaught > 0) {
    parts.push(`Your reapers caught ${plural(totalCaught, "stuck item")} before ${totalCaught === 1 ? "it" : "they"} could slip through the cracks.`)
  }

  // RECEIPTS, spoken. `touches` is absent both when a manager sent nothing and when the
  // provenance read was refused (manager-standup.ts), so an absent field says nothing out
  // loud — the brief never claims "zero touches" on a ledger it could not read.
  const totalTouches = lines.reduce((s, l) => s + (l.touches?.count ?? 0), 0)
  if (totalTouches > 0) {
    const channels = [...new Set(lines.flatMap((l) => l.touches?.channels ?? []))].sort()
    const fromSequences = lines.reduce((s, l) => s + (l.touches?.sequenceCount ?? 0), 0)
    parts.push(
      `They sent ${totalTouches} ${totalTouches === 1 ? "touch" : "touches"}`
      + (channels.length > 0 ? ` across ${channels.join(", ")}` : "")
      + (fromSequences > 0 ? `, ${fromSequences} of ${totalTouches === 1 ? "it" : "them"} driven by an active sequence` : "")
      + ".",
    )
  }

  // Name the managers that most need attention first, then the busiest.
  const ranked = [...lines].sort(
    (a, b) => (b.needs_human + b.reaped_24h) - (a.needs_human + a.reaped_24h) || b.activity_24h - a.activity_24h,
  )
  const named = ranked.slice(0, maxNamed)
  for (const l of named) {
    parts.push(`${l.label}: ${l.headline}.`)
  }
  const remaining = ranked.length - named.length
  if (remaining > 0) {
    parts.push(`Plus ${plural(remaining, "other manager")} reporting in.`)
  }

  if (totalNeedsHuman > 0) {
    parts.push(`Bottom line — ${plural(totalNeedsHuman, "item")} ${totalNeedsHuman === 1 ? "needs" : "need"} your decision. Open the command center to act.`)
  } else {
    parts.push("Nothing is blocked on you right now. Your team has it handled.")
  }

  return parts.join(" ")
}
