// lib/kernel/title-closing-watchtower.ts
//
// TITLE & CLOSING WATCHTOWER — the Deal Coordinator's EARLY layer on the date chain.
//
// Every under-contract deal lives on a chain of dates: inspection → appraisal →
// loan commitment (financing) → clear-to-close → closing. The EXISTING coverage is
// reactive: calendar-deadline-watcher pings when a deadline is <24h away, and
// fire-drills convene the team when a contingency is live + the prerequisite is
// missing. What nobody watched is the date chain MOVING — "appraisal slipped 4
// days" is invisible until it becomes a 24h ping or a missed-deadline fire.
//
// The Watchtower is that missing layer. The moment a chain date MOVES it:
//   (a) proposes ONE gated agent-facing alert with the concrete impact — what
//       moved, by how many days, and the recomputed CRITICAL PATH to closing
//       (binding constraint + days of slack + severity) — audience 'agent',
//       agentKind 'deal_coordinator', proposed never auto-sent;
//   (b) pushes a read-only portal VALUE card to BOTH represented sides (buyer
//       and/or seller contact) in plain language, so clients see the change the
//       moment it happens — never wondering. Cards ride pushPortalValueCard
//       (transparency_updates, idempotent per contact/type/day).
//
// DATE-MOVE DETECTION (no new tables — the honest signal): the production edit
// path for chain dates is setMilestoneDate (lib/transactions/milestone-service.ts,
// called by app/actions/transaction-milestones.ts), which updates
// transaction_milestones.target_date AND logs a lifecycle_events row
// (event_type 'lifecycle.milestone.date_changed') whose metadata carries
// milestone_name + previous_date + new_date. That audit trail IS the move record:
// the runner sweeps lifecycle_events in the lookback window, so every detected
// move has a REAL previous value — nothing is inferred or fabricated. Idempotency
// is keyed on the move-set signature (sorted lifecycle event ids) stored in the
// gated alert's rationale, exactly like offer-net-sheet's offer-set signature.
//
// HONESTY: a deal with no recorded closing date has no computable critical path —
// it is SKIPPED (counted in skippedNoChain), never given fabricated dates.
//
// NOT server-only (simulator-driven). Pure helpers carry the math; the runner does I/O.

import type { createServiceClient } from "@/lib/supabase/service"
import type { CopyGenerator } from "@/lib/kernel/ai-copy"

type Svc = ReturnType<typeof createServiceClient>

// ─── The standard residential date chain ─────────────────────────────────────

/** Chain milestone names exactly as transaction_milestones.milestone_name stores them
 *  (ensureRequiredMilestones seeds these names; setMilestoneDate edits them). */
export const CHAIN_STEP_KEYS = [
  "inspection_deadline",
  "appraisal_deadline",
  "financing_deadline",
  "clear_to_close_received",
  "closing_date",
] as const

export type ChainStepKey = (typeof CHAIN_STEP_KEYS)[number]

/** Plain-language labels (client-safe, Fair-Housing-neutral). */
export const CHAIN_STEP_LABELS: Record<ChainStepKey, string> = {
  inspection_deadline: "Inspection",
  appraisal_deadline: "Appraisal",
  financing_deadline: "Loan commitment",
  clear_to_close_received: "Clear to close",
  closing_date: "Closing",
}

// TOMBSTONE (orphan doctrine §1.3) — these names are no longer exported: STEP_RUNWAY_DAYS, TIGHT_SLACK_DAYS.
// Nothing in the product imported them, and no simulator did either; the
// values are live and unchanged, reached through this module's own exported
// functions, which is where callers already get their effect. Same ruling and same
// reasoning as lib/vendors/appraiser-independence.ts (isAppraiserTrade,
// labelNamesAppraisal): an export with no importer is a public surface nobody
// asked for, and the wire to build is not a second copy of the module's door.
/**
 * DOCUMENTED RUNWAY MODEL: the minimum days a standard residential deal needs
 * BETWEEN each step and closing for the remaining chain to fit (inspection →
 * repairs/negotiation → appraisal → underwriting → loan commitment → CTC → close).
 * A step dated closer to closing than its runway means the chain no longer fits —
 * closing is at risk. These are documented planning constants, not predictions.
 */
const STEP_RUNWAY_DAYS: Record<ChainStepKey, number> = {
  inspection_deadline: 21,
  appraisal_deadline: 14,
  financing_deadline: 7,
  clear_to_close_received: 3,
  closing_date: 0,
}

/** Slack thresholds (days) for severity: slack < 0 → at_risk; 0..TIGHT → tight; else ok. */
const TIGHT_SLACK_DAYS = 3

export type ChainSeverity = "ok" | "tight" | "at_risk"

export interface ChainStep {
  key: ChainStepKey
  label: string
  /** YYYY-MM-DD or null when the deal has no date recorded for this step. */
  date: string | null
  completed: boolean
}

export interface ChainStepStatus extends ChainStep {
  /** Days of slack vs the documented runway (null for closing itself / undated / completed). */
  slackDays: number | null
  /** Badge severity (null when the step has no date recorded). */
  severity: ChainSeverity | null
}

export interface CriticalPath {
  /** The remaining step that is now the binding constraint on closing. */
  bindingStep: ChainStepKey | null
  bindingLabel: string | null
  /** The binding step's slack (days). Negative = the chain no longer fits. */
  slackDays: number | null
  /** Calendar days from `now` to the closing date (negative = closing date passed). */
  daysToClosing: number
  severity: ChainSeverity
  steps: ChainStepStatus[]
  closingDate: string
}

// ─── Pure date helpers ───────────────────────────────────────────────────────

function utcDay(iso: string): number {
  return Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / 86_400_000)
}

/** Whole calendar days from `a` to `b` (both YYYY-MM-DD); positive when b is later. */
export function daysBetween(a: string, b: string): number {
  return utcDay(b) - utcDay(a)
}

function todayIso(now: Date): string {
  return now.toISOString().slice(0, 10)
}

export function fmtChainDate(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`)
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
}

// ─── Pure: build the chain from real milestone rows ──────────────────────────

/** Shape the chain from transaction_milestones rows (only the chain names). Steps
 *  with no row are present with date null — the UI shows the gap honestly. */
export function buildDateChain(
  rows: Array<{ milestone_name: string; target_date: string | null; status: string | null }>,
): ChainStep[] {
  const byName = new Map(rows.map((r) => [r.milestone_name, r]))
  return CHAIN_STEP_KEYS.map((key) => {
    const row = byName.get(key)
    return {
      key,
      label: CHAIN_STEP_LABELS[key],
      date: row?.target_date ? row.target_date.slice(0, 10) : null,
      completed: row?.status === "completed",
    }
  })
}

// ─── Pure: critical path ─────────────────────────────────────────────────────

/**
 * Compute the post-move critical path: which remaining (incomplete, dated) step is
 * the binding constraint, its slack to closing, and the overall severity.
 *
 * Severity rules (documented):
 *   · at_risk — any remaining step's date already passed without completion, OR the
 *     binding step's slack < 0 (the standard chain no longer fits before closing),
 *     OR the closing date itself has passed.
 *   · tight   — binding slack between 0 and TIGHT_SLACK_DAYS (3) inclusive.
 *   · ok      — otherwise.
 *
 * Returns null when the chain has NO closing date — no fabricated critical path.
 */
export function computeCriticalPath(chain: ChainStep[], now: Date): CriticalPath | null {
  const closing = chain.find((s) => s.key === "closing_date")
  if (!closing?.date) return null
  const closingDate = closing.date
  const today = todayIso(now)
  const daysToClosing = daysBetween(today, closingDate)

  let pastDue = false
  const steps: ChainStepStatus[] = chain.map((s) => {
    if (!s.date) return { ...s, slackDays: null, severity: null }
    if (s.completed) return { ...s, slackDays: null, severity: "ok" }
    const isPast = daysBetween(today, s.date) < 0
    if (isPast) pastDue = true
    if (s.key === "closing_date") {
      return { ...s, slackDays: null, severity: isPast ? "at_risk" : "ok" }
    }
    const slack = daysBetween(s.date, closingDate) - STEP_RUNWAY_DAYS[s.key]
    const severity: ChainSeverity = isPast || slack < 0 ? "at_risk" : slack <= TIGHT_SLACK_DAYS ? "tight" : "ok"
    return { ...s, slackDays: slack, severity }
  })

  // Binding constraint: the remaining, dated, non-closing step with the least slack.
  const candidates = steps.filter((s) => s.key !== "closing_date" && !s.completed && s.slackDays !== null)
  const binding = candidates.length > 0
    ? candidates.reduce((min, s) => ((s.slackDays as number) < (min.slackDays as number) ? s : min))
    : null
  const slackDays = binding ? (binding.slackDays as number) : null

  const severity: ChainSeverity =
    pastDue || daysToClosing < 0 || (slackDays !== null && slackDays < 0)
      ? "at_risk"
      : slackDays !== null && slackDays <= TIGHT_SLACK_DAYS
        ? "tight"
        : "ok"

  return {
    bindingStep: binding ? binding.key : closing.completed ? null : "closing_date",
    bindingLabel: binding ? binding.label : closing.completed ? null : CHAIN_STEP_LABELS.closing_date,
    slackDays,
    daysToClosing,
    severity,
    steps,
    closingDate,
  }
}

// ─── Pure: describe a move ───────────────────────────────────────────────────

/** One detected date move — straight from the lifecycle_events audit row's metadata
 *  (milestone_name + previous_date + new_date). Nothing inferred. */
export interface MilestoneMove {
  eventId: string
  milestone: ChainStepKey
  previousDate: string | null
  newDate: string | null
}

export interface MoveDescription {
  /** Positive = slipped later; negative = moved earlier; null when prev/new missing. */
  deltaDays: number | null
  direction: "slipped" | "moved_up" | "set" | "cleared" | "unchanged"
  /** e.g. "Appraisal slipped 4 days (Jun 10 → Jun 14)" */
  phrase: string
}

export function describeMove(m: MilestoneMove): MoveDescription {
  const label = CHAIN_STEP_LABELS[m.milestone]
  if (m.previousDate && m.newDate) {
    const delta = daysBetween(m.previousDate, m.newDate)
    if (delta === 0) return { deltaDays: 0, direction: "unchanged", phrase: `${label} date confirmed (${fmtChainDate(m.newDate)})` }
    const dir = delta > 0 ? "slipped" : "moved_up"
    const verb = delta > 0 ? "slipped" : "moved up"
    const n = Math.abs(delta)
    return {
      deltaDays: delta,
      direction: dir,
      phrase: `${label} ${verb} ${n} day${n === 1 ? "" : "s"} (${fmtChainDate(m.previousDate)} → ${fmtChainDate(m.newDate)})`,
    }
  }
  if (m.newDate) return { deltaDays: null, direction: "set", phrase: `${label} date set to ${fmtChainDate(m.newDate)}` }
  return { deltaDays: null, direction: "cleared", phrase: `${label} date removed (was ${fmtChainDate(m.previousDate)})` }
}

// ─── Pure: idempotency signature ─────────────────────────────────────────────

/** Stable signature of the detected move-set (sorted lifecycle event ids) — a NEW
 *  move re-triggers; the same set inside the window does not. Same pattern as
 *  offer-net-sheet's offerSetSignature. */
export function moveSetSignature(eventIds: string[]): string {
  return [...eventIds].sort().join(",")
}

// ─── Pure: deterministic fallback copy ───────────────────────────────────────

function severityHeadline(severity: ChainSeverity): string {
  if (severity === "at_risk") return "closing at risk"
  if (severity === "tight") return "closing timeline is tight"
  return "closing still has slack"
}

/**
 * Deterministic FALLBACK copy. Earned lines only — every fact comes from the real
 * moves + the recomputed path. Plain-language, Fair-Housing-safe (dates and process
 * only; no people characteristics, no steering).
 */
export function composeWatchtowerFallback(args: {
  dealName: string
  moves: MilestoneMove[]
  path: CriticalPath
}): { agentSubject: string; agentSummary: string; clientBody: string } {
  const { dealName, moves, path } = args
  const described = moves.map(describeMove)
  const lead = described[0]?.phrase ?? "a key date changed"
  const more = described.length > 1 ? ` (+${described.length - 1} more date change${described.length === 2 ? "" : "s"})` : ""

  const agentSubject = `Watchtower — ${dealName}: ${lead}${more} — ${severityHeadline(path.severity)}`

  const chainLines = path.steps.map((s) => {
    const flag =
      s.key === path.bindingStep && !s.completed
        ? ` ← binding constraint${s.slackDays !== null ? ` (${s.slackDays}d slack)` : ""}`
        : s.completed
          ? " — done"
          : s.slackDays !== null
            ? ` (${s.slackDays}d slack)`
            : ""
    return `· ${s.label}: ${fmtChainDate(s.date)}${flag}`
  })

  const agentSummary = [
    `${dealName} — ${described.map((d) => d.phrase).join("; ")}.`,
    `New critical path to the ${fmtChainDate(path.closingDate)} closing (${path.daysToClosing}d out):`,
    chainLines.join("\n"),
    path.bindingLabel
      ? `Binding constraint: ${path.bindingLabel}${path.slackDays !== null ? ` with ${path.slackDays} day${Math.abs(path.slackDays) === 1 ? "" : "s"} of slack` : ""} — status ${path.severity.toUpperCase()}.`
      : `All chain steps complete — status ${path.severity.toUpperCase()}.`,
    `Both represented clients received a plain-language portal status card. This alert is for you — nothing else goes to the client without your approval.`,
  ].join("\n")

  const closingLine =
    path.severity === "at_risk"
      ? `This puts pressure on the ${fmtChainDate(path.closingDate)} closing date, and your agent is already working the new schedule.`
      : path.severity === "tight"
        ? `Closing is still set for ${fmtChainDate(path.closingDate)} — the schedule is tighter now, and your agent is watching it closely.`
        : `Closing is still on track for ${fmtChainDate(path.closingDate)}.`

  const clientBody = [
    `A date on ${dealName} just changed: ${described.map((d) => d.phrase).join("; ")}.`,
    closingLine,
    `Nothing is needed from you right now — this page updates the moment anything on your timeline moves.`,
  ].join(" ")

  return { agentSubject, agentSummary, clientBody }
}

// ─── Live runner ─────────────────────────────────────────────────────────────

export interface ClosingWatchtowerResult {
  /** Deals that had ≥1 chain-date move in the window. */
  transactionsWithMoves: number
  movesDetected: number
  alertsProposed: number
  portalCardsPushed: number
  /** Deals with moves but no recorded closing date — skipped honestly. */
  skippedNoChain: number
}

/** Lookback window for the sweep (hours). The hourly cron re-sees the last day of
 *  moves; the move-set signature + the portal card's daily dedupe keep it idempotent. */
export const WATCHTOWER_WINDOW_HOURS = 24

const LIVE_TXN_STATUSES = ["active", "under_contract", "closing"]

/** The exact event_type transitionLifecycle writes for setMilestoneDate. */
export const DATE_CHANGED_EVENT = "lifecycle.milestone.date_changed"

/**
 * Sweep the brokerage for chain-date moves (lifecycle_events audit trail), recompute
 * each affected deal's critical path, propose ONE gated Deal Coordinator alert per
 * move-set, and push a plain-language portal value card to BOTH represented sides.
 */
export async function runClosingWatchtower(
  brokerageId: string,
  opts: { now?: Date; windowHours?: number; copyGenerator?: CopyGenerator } = {},
  client?: Svc,
): Promise<ClosingWatchtowerResult> {
  const supabase = client ?? (await import("@/lib/supabase/service")).createServiceClient()
  const now = opts.now ?? new Date()
  const windowHours = opts.windowHours ?? WATCHTOWER_WINDOW_HOURS
  const sinceIso = new Date(now.getTime() - windowHours * 3_600_000).toISOString()
  const result: ClosingWatchtowerResult = {
    transactionsWithMoves: 0, movesDetected: 0, alertsProposed: 0, portalCardsPushed: 0, skippedNoChain: 0,
  }

  // ── 1. The move audit trail: lifecycle.milestone.date_changed in the window. ──
  const { data: events } = await supabase
    .from("lifecycle_events")
    .select("id, entity_id, metadata, created_at")
    .eq("brokerage_id", brokerageId)
    .eq("entity_type", "transaction")
    .eq("event_type", DATE_CHANGED_EVENT)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: true })
    .limit(500)

  const chainKeySet = new Set<string>(CHAIN_STEP_KEYS)
  const movesByTxn = new Map<string, MilestoneMove[]>()
  for (const ev of (events ?? []) as any[]) {
    const md = (ev.metadata ?? {}) as Record<string, unknown>
    const name = md.milestone_name as string | undefined
    if (!name || !chainKeySet.has(name)) continue
    const prev = (md.previous_date as string | null) ?? null
    const next = (md.new_date as string | null) ?? null
    if (prev === next) continue // not a move
    const list = movesByTxn.get(ev.entity_id) ?? []
    list.push({ eventId: ev.id, milestone: name as ChainStepKey, previousDate: prev, newDate: next })
    movesByTxn.set(ev.entity_id, list)
  }
  if (movesByTxn.size === 0) return result

  for (const [txnId, moves] of movesByTxn) {
    // ── 2. The deal — live, this brokerage, not deleted. ──
    const { data: txn } = await supabase
      .from("transactions")
      .select("id, brokerage_id, deal_name, property_address, status, deleted_at, buyer_contact_id, seller_contact_id, contact_id, listing_id")
      .eq("id", txnId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    if (!txn || (txn as any).deleted_at) continue
    if (!LIVE_TXN_STATUSES.includes((txn as any).status)) continue

    result.transactionsWithMoves += 1
    result.movesDetected += moves.length

    // ── 3. The real date chain (transaction_milestones — the table the moves edit). ──
    const { data: msRows } = await supabase
      .from("transaction_milestones")
      .select("milestone_name, target_date, status")
      .eq("transaction_id", txnId)
      .eq("brokerage_id", brokerageId)
      .in("milestone_name", [...CHAIN_STEP_KEYS])
    const chain = buildDateChain((msRows ?? []) as any[])
    const path = computeCriticalPath(chain, now)
    if (!path) {
      // No recorded closing date → no honest critical path. Skip, never fabricate.
      result.skippedNoChain += 1
      continue
    }

    // ── 4. Idempotency: one gated alert per (deal, move-set) per window. ──
    const sig = moveSetSignature(moves.map((m) => m.eventId))
    const { data: existing } = await supabase
      .from("agent_client_messages")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("entity_id", txnId)
      .ilike("rationale", `CLOSING WATCHTOWER — sig:${sig} %`)
      .gte("created_at", sinceIso)
      .limit(1)
      .maybeSingle()
    if (existing) continue

    const dealName = (txn as any).deal_name ?? (txn as any).property_address ?? "your purchase"
    const fallback = composeWatchtowerFallback({ dealName, moves, path })

    // ── 5. (a) ONE gated agent alert — proposed, audience 'agent', never auto-sent. ──
    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const proposed = await proposeClientMessage(
      {
        brokerageId,
        agentKind: "deal_coordinator",
        entityType: "transaction",
        entityId: txnId,
        recipientContactId: null, // audience 'agent' — internal gated alert
        audience: "agent",
        subject: fallback.agentSubject,
        body: fallback.agentSummary,
        rationale: `CLOSING WATCHTOWER — sig:${sig} — ${moves.length} chain-date move(s) detected from the milestone audit trail; critical path recomputed (binding: ${path.bindingLabel ?? "none"}, slack: ${path.slackDays ?? "n/a"}d, severity: ${path.severity}); portal status cards pushed to both represented sides.`,
        channel: "portal",
      },
      supabase,
    )
    if (proposed.ok) result.alertsProposed += 1

    // ── 6. (b) Portal value card to BOTH represented sides. ──
    // REUSE resolve-event-contacts (the canonical both-sides resolver). It is a
    // server-only module; outside a server context (tsx simulator) the import
    // throws, and we fall back to the SAME transactions columns it reads.
    let buyerContactId: string | undefined
    let sellerContactId: string | undefined
    try {
      const { resolveEventContacts } = await import("@/lib/kernel/resolve-event-contacts")
      const r = await resolveEventContacts(supabase, "transaction", txnId)
      buyerContactId = r.buyerContactId ?? r.contactId
      sellerContactId = r.sellerContactId
    } catch {
      buyerContactId = (txn as any).buyer_contact_id ?? (txn as any).contact_id ?? undefined
      sellerContactId = (txn as any).seller_contact_id ?? undefined
    }
    const sides: Array<{ contactId: string; audience: "buyer" | "seller" }> = []
    if (buyerContactId) sides.push({ contactId: buyerContactId, audience: "buyer" })
    if (sellerContactId && sellerContactId !== buyerContactId) sides.push({ contactId: sellerContactId, audience: "seller" })

    if (sides.length > 0) {
      const { pushPortalValueCard } = await import("@/lib/kernel/portal-value")
      const { generatePersonaCopy, loadContactPersona } = await import("@/lib/kernel/ai-copy")
      const facts = [
        ...moves.map((m) => describeMove(m).phrase),
        `Closing date on file: ${fmtChainDate(path.closingDate)} (${path.daysToClosing} days out)`,
        path.severity === "ok"
          ? "The closing timeline still has slack"
          : path.severity === "tight"
            ? "The closing timeline is tighter now and the agent is watching it"
            : "The closing timeline is under pressure and the agent is working the new schedule",
        "Nothing is needed from the client right now",
      ]
      for (const side of sides) {
        const persona = await loadContactPersona(supabase, side.contactId).catch(() => ({ audience: side.audience }))
        const body = (
          await generatePersonaCopy(
            {
              goal: "a short, calm portal update telling the client exactly which date on their deal moved and what it means for closing (plain language, no pressure, no jargon)",
              facts,
              channel: "portal",
              persona: { ...persona, audience: side.audience, situation: `home ${side.audience} under contract` },
              words: 70,
            },
            { body: fallback.clientBody },
            { generator: opts.copyGenerator },
          )
        ).body
        const pushed = await pushPortalValueCard(
          {
            brokerageId,
            contactId: side.contactId,
            listingId: (txn as any).listing_id ?? null,
            title: path.severity === "ok" ? "Your closing timeline updated" : "A date on your deal moved",
            summary: body,
            updateType: "closing_watchtower",
            metadata: {
              transaction_id: txnId,
              audience: side.audience,
              moves: moves.map((m) => ({
                milestone: m.milestone,
                previous_date: m.previousDate,
                new_date: m.newDate,
                delta_days: describeMove(m).deltaDays,
              })),
              severity: path.severity,
              binding_step: path.bindingStep,
              slack_days: path.slackDays,
              closing_date: path.closingDate,
              move_set_signature: sig,
              agent_alert_id: proposed.id ?? null,
            },
            now,
          },
          supabase,
        )
        if (pushed.pushed) result.portalCardsPushed += 1
      }
    }
  }

  return result
}
