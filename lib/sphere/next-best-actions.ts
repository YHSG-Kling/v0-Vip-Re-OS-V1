/**
 * lib/sphere/next-best-actions.ts
 *
 * THE RANKED SPHERE LIST — program item #4: one evidence-backed
 * "work my sphere today" list instead of signals scattered across
 * surfaces. Every entry names WHO, WHY (the actual ledger evidence), and
 * WHAT to do — never a generic "reach out".
 *
 * Signals (all real columns, no inference):
 *   · LIFE EVENT   — contacts.last_life_event_detected in the last 14d
 *                    (the Resonance engine's detection; this list is the
 *                    human-facing view of the same ledger)
 *   · VALUE CHECK  — a home_value_estimates row generated in the last 14d
 *                    (they looked — the warmest seller signal there is)
 *   · ANNIVERSARY  — contacts.home_anniversary within the next 21 days
 *   · GONE QUIET   — a lifetime/past client with no contact in 90+ days
 *
 * Pure scorer exported for the sim; the reader composes per agent scope.
 */
import { createServiceClient } from "@/lib/supabase/service"
import { LIFETIME_CONTACT_TYPES } from "@/lib/contact-types"

type Svc = ReturnType<typeof createServiceClient>

export type SphereSignal = "life_event" | "value_check" | "anniversary" | "gone_quiet"

export interface SphereAction {
  contactId: string
  name: string
  signal: SphereSignal
  /** The evidence line the agent reads — real facts, never invented. */
  why: string
  /** The suggested move, in plain language. */
  action: string
  score: number
}

/** PURE: signal → base score. Life events and value checks outrank
 *  calendar signals; quiet is the floor (important, never urgent). */
export function scoreSignal(signal: SphereSignal, daysSince: number): number {
  const recency = Math.max(0, 14 - Math.min(daysSince, 14)) // fresher = higher
  switch (signal) {
    case "value_check": return 80 + recency
    case "life_event": return 70 + recency
    case "anniversary": return 50 + recency
    case "gone_quiet": return 20 + Math.min(Math.floor(daysSince / 30), 10) // quieter = slightly higher
  }
}

const days = (iso: string | null | undefined): number =>
  iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000) : 9999

/** Compose the ranked list for an agent (or a whole brokerage when
 *  agentId is null). Deduped per contact — the strongest signal wins. */
export async function rankSphereActions(
  svc: Svc,
  input: { brokerageId: string; agentId?: string | null; limit?: number },
): Promise<SphereAction[]> {
  const limit = input.limit ?? 8
  const byContact = new Map<string, SphereAction>()
  const consider = (a: SphereAction) => {
    const existing = byContact.get(a.contactId)
    if (!existing || a.score > existing.score) byContact.set(a.contactId, a)
  }
  const scope = <T extends { eq: any }>(q: T): T =>
    input.agentId ? q.eq("agent_id", input.agentId) : q

  // LIFE EVENTS (last 14d)
  const since14 = new Date(Date.now() - 14 * 86_400_000).toISOString()
  const { data: events } = await scope(
    svc.from("contacts")
      .select("id, first_name, last_name, last_life_event_detected, life_events")
      .eq("brokerage_id", input.brokerageId)
      .gte("last_life_event_detected", since14) as any,
  ).limit(50)
  for (const c of ((events ?? []) as any[])) {
    const d = days(c.last_life_event_detected)
    const eventName = Array.isArray(c.life_events) && c.life_events.length
      ? String(c.life_events[c.life_events.length - 1]?.type ?? c.life_events[c.life_events.length - 1] ?? "life event").replace(/_/g, " ")
      : "life event"
    consider({
      contactId: c.id,
      name: [c.first_name, c.last_name].filter(Boolean).join(" ") || "Contact",
      signal: "life_event",
      why: `A ${eventName} was detected ${d === 0 ? "today" : `${d}d ago`}.`,
      action: "A personal call beats a drip here — congratulate or check in, no pitch.",
      score: scoreSignal("life_event", d),
    })
  }

  // VALUE CHECKS (last 14d)
  const { data: checks } = await svc.from("home_value_estimates")
    .select("contact_id, generated_at, estimated_value_mid")
    .eq("brokerage_id", input.brokerageId)
    .gte("generated_at", since14)
    .not("contact_id", "is", null)
    .limit(50)
  const checkRows = (checks ?? []) as any[]
  if (checkRows.length > 0) {
    const ids = Array.from(new Set(checkRows.map((r) => r.contact_id)))
    const { data: checkContacts } = await scope(
      svc.from("contacts").select("id, first_name, last_name")
        .eq("brokerage_id", input.brokerageId).in("id", ids) as any,
    )
    const nameById = new Map(((checkContacts ?? []) as any[]).map((c) => [c.id, [c.first_name, c.last_name].filter(Boolean).join(" ") || "Contact"]))
    for (const r of checkRows) {
      if (!nameById.has(r.contact_id)) continue // out of scope
      const d = days(r.generated_at)
      consider({
        contactId: r.contact_id,
        name: nameById.get(r.contact_id) as string,
        signal: "value_check",
        why: `Checked their home's value ${d === 0 ? "today" : `${d}d ago`}${r.estimated_value_mid ? ` (est. $${Math.round(Number(r.estimated_value_mid)).toLocaleString("en-US")})` : ""}.`,
        action: "Offer the full CMA conversation — they're already curious.",
        score: scoreSignal("value_check", d),
      })
    }
  }

  // ANNIVERSARIES (next 21d — month/day match)
  const { data: annivContacts } = await scope(
    svc.from("contacts").select("id, first_name, last_name, home_anniversary")
      .eq("brokerage_id", input.brokerageId).not("home_anniversary", "is", null) as any,
  ).limit(500)
  const now = new Date()
  for (const c of ((annivContacts ?? []) as any[])) {
    const ann = new Date(c.home_anniversary)
    if (isNaN(ann.getTime())) continue
    const next = new Date(now.getFullYear(), ann.getMonth(), ann.getDate())
    if (next < now) next.setFullYear(next.getFullYear() + 1)
    const inDays = Math.floor((next.getTime() - now.getTime()) / 86_400_000)
    if (inDays > 21) continue
    const years = now.getFullYear() - ann.getFullYear() + (next.getFullYear() > now.getFullYear() ? 1 : 0)
    consider({
      contactId: c.id,
      name: [c.first_name, c.last_name].filter(Boolean).join(" ") || "Contact",
      signal: "anniversary",
      why: `${years} year${years === 1 ? "" : "s"} in their home ${inDays === 0 ? "today" : `in ${inDays}d`}.`,
      action: "The anniversary equity video + a note lands perfectly this week.",
      score: scoreSignal("anniversary", inDays),
    })
  }

  // GONE QUIET (lifetime/past clients, 90d+ silent)
  const quietCutoff = new Date(Date.now() - 90 * 86_400_000).toISOString()
  const { data: quiet } = await scope(
    svc.from("contacts").select("id, first_name, last_name, last_contacted_at")
      .eq("brokerage_id", input.brokerageId)
      .in("contact_type", [...LIFETIME_CONTACT_TYPES])
      .lt("last_contacted_at", quietCutoff) as any,
  ).limit(30)
  for (const c of ((quiet ?? []) as any[])) {
    const d = days(c.last_contacted_at)
    consider({
      contactId: c.id,
      name: [c.first_name, c.last_name].filter(Boolean).join(" ") || "Contact",
      signal: "gone_quiet",
      why: `No touch in ${d} days.`,
      action: "A light value touch — market note or neighborhood update, not a check-in that asks for something.",
      score: scoreSignal("gone_quiet", d),
    })
  }

  return [...byContact.values()].sort((a, b) => b.score - a.score).slice(0, limit)
}
