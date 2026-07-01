// lib/transactions/buyer-move.ts
//
// BUYER MOVE SERVICES — the post-contract move-in concierge, folded into the Deal Coordinator.
// Once a BUYER-side deal enters CLOSING_PREP the buyer has a hidden second job: turn on utilities,
// change their address, book movers — the stuff that has nothing to do with the contract but sinks
// the move-in experience (and the referral) when it slips. This builds a real, dated move-in checklist
// on the deal and decides which of two service modes fits:
//   • contact_assisted_guided_diy — we guide the buyer through each task IN-APP (default, always on).
//   • handoff                     — hand the utility setup to the Utility Connect partner (EXTERNAL).
// The handoff RECOMMENDATION always computes, but its EXECUTION is gated behind
// FEATURES.BUYER_MOVE_UTILITY_CONNECT (off until the partner code + creds exist) — so nothing is ever
// pushed to an external partner while the flag is false. No parallel task system: the checklist lives
// on the single buyer_move_cases row (tasks jsonb); deadlines/messages reuse the existing deal infra.
//
// The planner + friction + mode decision are PURE (unit-tested); the ensure/update/get do the I/O.

import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

export type MoveTaskType =
  | "electricity" | "water" | "gas" | "internet" | "insurance"
  | "address_change" | "trash" | "security" | "hoa_contact" | "movers"

export type MoveTaskGroup = "essential" | "optional" | "admin"
export type MoveTaskStatus = "pending" | "in_progress" | "done" | "skipped"
export type ServiceMode = "contact_assisted_guided_diy" | "handoff"
export type NextBestAction = "CONTINUE_GUIDED_SUPPORT" | "OFFER_HANDOFF" | "START_HANDOFF"

export interface MoveTask {
  type: MoveTaskType
  group: MoveTaskGroup
  label: string
  description: string
  status: MoveTaskStatus
  /** Calendar day the buyer should complete this by (ISO date), derived from the closing date. */
  dueDate: string | null
}

interface MoveTaskSpec {
  type: MoveTaskType
  group: MoveTaskGroup
  label: string
  description: string
  /** Days relative to the closing date (negative = before closing). */
  offsetDays: number
}

// The move-in catalog. Essentials are the utilities a buyer cannot move in without; admin is the
// paperwork; optional is quality-of-life. Offsets are sensible defaults off the closing date — the
// agent/buyer adjust. Ordered by how early they should be handled.
const MOVE_TASK_CATALOG: MoveTaskSpec[] = [
  { type: "movers",         group: "optional",  label: "Book movers",              description: "Reserve a moving company or truck — good ones book out weeks ahead.",                 offsetDays: -21 },
  { type: "insurance",      group: "essential", label: "Homeowners insurance",     description: "Bind a homeowners policy — your lender requires proof before closing.",               offsetDays: -14 },
  { type: "electricity",    group: "essential", label: "Electricity",              description: "Set up electric service in your name, effective your move-in date.",                  offsetDays: -7 },
  { type: "water",          group: "essential", label: "Water / sewer",            description: "Transfer or start water & sewer service with the local utility.",                     offsetDays: -7 },
  { type: "gas",            group: "essential", label: "Natural gas",              description: "Start gas service if the home has gas heat, water heater, or appliances.",            offsetDays: -7 },
  { type: "hoa_contact",    group: "optional",  label: "HOA welcome / access",     description: "Contact the HOA for gate codes, amenity access, and move-in rules (if applicable).",  offsetDays: -5 },
  { type: "internet",       group: "essential", label: "Internet / cable",         description: "Schedule internet install — the earliest slots go fast around move-in weekends.",     offsetDays: -3 },
  { type: "address_change", group: "admin",     label: "Change of address",        description: "File USPS change of address and update your bank, employer, and license.",            offsetDays: 0 },
  { type: "trash",          group: "optional",  label: "Trash & recycling",        description: "Confirm trash/recycling pickup — some cities require you to register for service.",   offsetDays: 1 },
  { type: "security",       group: "optional",  label: "Home security",            description: "Set up (or transfer) a security system and re-key the exterior locks.",             offsetDays: 3 },
]

function addDays(iso: string, days: number): string {
  const base = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`)
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10)
}

/**
 * PURE: build the dated move-in checklist from the closing date. With no closing date the tasks still
 * exist (the buyer can start early) but carry no due dates — honest, not fabricated.
 */
export function buildMoveInTasks(closingDate: string | null | undefined): MoveTask[] {
  const valid = closingDate && !Number.isNaN(Date.parse(`${closingDate.slice(0, 10)}T00:00:00Z`))
  return MOVE_TASK_CATALOG.map((s) => ({
    type: s.type,
    group: s.group,
    label: s.label,
    description: s.description,
    status: "pending" as MoveTaskStatus,
    dueDate: valid ? addDays(closingDate!, s.offsetDays) : null,
  }))
}

/** Essentials the buyer genuinely can't move in without — the load-bearing subset for friction/mode. */
export function essentialTasks(tasks: MoveTask[]): MoveTask[] {
  return tasks.filter((t) => t.group === "essential")
}
const isOpen = (t: MoveTask) => t.status !== "done" && t.status !== "skipped"

/**
 * PURE: how much move-in friction this buyer faces right now, 0 (relaxed) → 1 (crunch). Friction is
 * driven by OPEN essentials, AMPLIFIED by time pressure as closing approaches — so a buyer with all
 * essentials handled has zero friction no matter how close the date is (nothing left to slip), while
 * open essentials get more urgent the nearer closing gets. Drives the mode decision + agent urgency.
 */
export function computeFriction(tasks: MoveTask[], daysToClose: number | null): number {
  const ess = essentialTasks(tasks)
  const openRatio = ess.length ? ess.filter(isOpen).length / ess.length : 0
  if (openRatio === 0) return 0 // nothing open ⇒ nothing to slip, regardless of the clock
  let timePressure = 0
  if (daysToClose !== null && Number.isFinite(daysToClose)) {
    if (daysToClose <= 0) timePressure = 1
    else if (daysToClose >= 14) timePressure = 0
    else timePressure = (14 - daysToClose) / 14
  }
  const score = openRatio * (0.4 + 0.6 * timePressure)
  return Math.round(Math.min(1, Math.max(0, score)) * 100) / 100
}

export interface BuyerModeDecision {
  recommended_mode: ServiceMode
  confidence: number
  friction_score: number
  reasons: string[]
  next_best_action: NextBestAction
}

/**
 * PURE: decide which service mode fits and what to do next.
 *   • buyer explicitly asked us to handle it ("do it for me")  → START_HANDOFF (recommend handoff).
 *   • essentials still open AND (closing ≤ 5 days OR friction ≥ 0.6) → OFFER_HANDOFF (recommend handoff
 *     but don't force it; the buyer may still want to self-serve with guidance).
 *   • otherwise → CONTINUE_GUIDED_SUPPORT (guided DIY is winning).
 * The recommendation is advice; whether a handoff can actually FIRE is gated by the feature flag at the
 * service layer — this function never blocks on that so the recommendation is always honest.
 */
export function decideBuyerMode(input: {
  tasks: MoveTask[]
  daysToClose: number | null
  buyerRequestedHelp?: boolean
}): BuyerModeDecision {
  const friction = computeFriction(input.tasks, input.daysToClose)
  const ess = essentialTasks(input.tasks)
  const openEss = ess.filter(isOpen)
  const reasons: string[] = []

  if (input.buyerRequestedHelp) {
    reasons.push("Buyer asked us to coordinate the move-in setup for them.")
    return { recommended_mode: "handoff", confidence: 0.95, friction_score: friction, reasons, next_best_action: "START_HANDOFF" }
  }

  const closeSoon = input.daysToClose !== null && input.daysToClose <= 5
  if (openEss.length > 0 && (closeSoon || friction >= 0.6)) {
    if (closeSoon) reasons.push(`Closing is ${input.daysToClose} day${input.daysToClose === 1 ? "" : "s"} out with ${openEss.length} essential utilit${openEss.length === 1 ? "y" : "ies"} still unset.`)
    if (friction >= 0.6) reasons.push(`Move-in friction is high (${friction.toFixed(2)}).`)
    reasons.push("Offer to hand the utility setup to our concierge partner so nothing slips before move-in.")
    const confidence = Math.min(0.9, 0.6 + 0.3 * friction)
    return { recommended_mode: "handoff", confidence: Math.round(confidence * 100) / 100, friction_score: friction, reasons, next_best_action: "OFFER_HANDOFF" }
  }

  if (openEss.length === 0) reasons.push("All essential utilities are handled — the buyer is on track.")
  else reasons.push(`${openEss.length} essential${openEss.length === 1 ? "" : "s"} open, but there's runway — keep guiding in-app.`)
  return { recommended_mode: "contact_assisted_guided_diy", confidence: 0.8, friction_score: friction, reasons, next_best_action: "CONTINUE_GUIDED_SUPPORT" }
}

/** Days between now and the closing date (null when unknown). `now` is injectable for pure testing. */
export function daysToClose(closingDate: string | null | undefined, now?: Date): number | null {
  if (!closingDate) return null
  const close = Date.parse(`${closingDate.slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(close)) return null
  const ref = now ? now.getTime() : Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z")
  return Math.round((close - ref) / 86_400_000)
}

// ── Service layer (I/O) ──────────────────────────────────────────────────────────────────────────

export interface BuyerMoveCase {
  id: string
  transaction_id: string
  brokerage_id: string
  buyer_contact_id: string | null
  agent_id: string | null
  service_mode: ServiceMode
  recommended_mode: ServiceMode
  case_status: string
  closing_date: string | null
  move_in_date: string | null
  friction_score: number
  buyer_preference_notes: string | null
  tasks: MoveTask[]
}

/**
 * Create-or-return the buyer's move case for a transaction. Idempotent on transaction_id (unique). Only
 * for BUYER-side deals — a listing/seller deal has no buyer to move in. Best-effort: never throws into
 * the stage-progression path. Recomputes the recommendation on every call so a re-entry reflects
 * current task progress / days-to-close, WITHOUT overwriting the buyer's own task edits.
 */
export async function ensureBuyerMoveCase(
  svc: Svc,
  params: { transactionId: string; brokerageId: string; now?: Date },
): Promise<{ created: boolean; case: BuyerMoveCase | null }> {
  const { data: txn } = await svc
    .from("transactions")
    .select("id, deal_type, buyer_contact_id, agent_id, close_date, estimated_close_date")
    .eq("id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()
  if (!txn) return { created: false, case: null }
  // Buyer-side only: a move-in concierge needs a buyer to serve. An explicit seller-side (listing) deal
  // or a deal with no buyer contact has nobody to move in — skip honestly rather than fabricate a case.
  if ((txn as any).deal_type === "listing") return { created: false, case: null }
  if (!(txn as any).buyer_contact_id) return { created: false, case: null }

  const closingDate = (txn as any).close_date ?? (txn as any).estimated_close_date ?? null
  const { data: existing } = await svc
    .from("buyer_move_cases")
    .select("*")
    .eq("transaction_id", params.transactionId)
    .maybeSingle()

  const dtc = daysToClose(closingDate, params.now)

  if (existing) {
    // Keep the buyer's task edits; just refresh the recommendation + friction from current state.
    const tasks = ((existing as any).tasks ?? []) as MoveTask[]
    const decision = decideBuyerMode({ tasks, daysToClose: dtc, buyerRequestedHelp: (existing as any).service_mode === "handoff" })
    await svc.from("buyer_move_cases").update({
      recommended_mode: decision.recommended_mode,
      friction_score: decision.friction_score,
      closing_date: closingDate,
      updated_at: new Date().toISOString(),
    }).eq("id", (existing as any).id)
    return { created: false, case: hydrate({ ...(existing as any), recommended_mode: decision.recommended_mode, friction_score: decision.friction_score, closing_date: closingDate }) }
  }

  const tasks = buildMoveInTasks(closingDate)
  const decision = decideBuyerMode({ tasks, daysToClose: dtc })
  const { data: created } = await svc
    .from("buyer_move_cases")
    .insert({
      transaction_id: params.transactionId,
      brokerage_id: params.brokerageId,
      buyer_contact_id: (txn as any).buyer_contact_id ?? null,
      agent_id: (txn as any).agent_id ?? null,
      service_mode: "contact_assisted_guided_diy",
      recommended_mode: decision.recommended_mode,
      case_status: "active",
      closing_date: closingDate,
      friction_score: decision.friction_score,
      tasks: tasks as any,
    })
    .select("*")
    .maybeSingle()
  return { created: !!created, case: created ? hydrate(created) : null }
}

/** Mark one move task's status and recompute the case's friction + recommendation. */
export async function updateMoveTask(
  svc: Svc,
  params: { transactionId: string; brokerageId: string; taskType: MoveTaskType; status: MoveTaskStatus; now?: Date },
): Promise<{ ok: boolean; case: BuyerMoveCase | null }> {
  const { data: row } = await svc
    .from("buyer_move_cases")
    .select("*")
    .eq("transaction_id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()
  if (!row) return { ok: false, case: null }

  const tasks = (((row as any).tasks ?? []) as MoveTask[]).map((t) =>
    t.type === params.taskType ? { ...t, status: params.status } : t,
  )
  const dtc = daysToClose((row as any).closing_date, params.now)
  const decision = decideBuyerMode({ tasks, daysToClose: dtc, buyerRequestedHelp: (row as any).service_mode === "handoff" })
  const allDone = tasks.every((t) => t.status === "done" || t.status === "skipped")
  const { data: updated } = await svc
    .from("buyer_move_cases")
    .update({
      tasks: tasks as any,
      friction_score: decision.friction_score,
      recommended_mode: decision.recommended_mode,
      case_status: allDone ? "completed" : (row as any).case_status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", (row as any).id)
    .select("*")
    .maybeSingle()
  return { ok: !!updated, case: updated ? hydrate(updated) : null }
}

/** Load a buyer's move case (or null). */
export async function getBuyerMoveCase(
  svc: Svc,
  params: { transactionId: string; brokerageId: string },
): Promise<BuyerMoveCase | null> {
  const { data } = await svc
    .from("buyer_move_cases")
    .select("*")
    .eq("transaction_id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()
  return data ? hydrate(data) : null
}

function hydrate(row: any): BuyerMoveCase {
  return {
    id: row.id,
    transaction_id: row.transaction_id,
    brokerage_id: row.brokerage_id,
    buyer_contact_id: row.buyer_contact_id ?? null,
    agent_id: row.agent_id ?? null,
    service_mode: row.service_mode,
    recommended_mode: row.recommended_mode,
    case_status: row.case_status,
    closing_date: row.closing_date ?? null,
    move_in_date: row.move_in_date ?? null,
    friction_score: Number(row.friction_score ?? 0),
    buyer_preference_notes: row.buyer_preference_notes ?? null,
    tasks: (row.tasks ?? []) as MoveTask[],
  }
}
