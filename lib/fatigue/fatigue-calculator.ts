// NOT a server-action module (2026-09-03, integrator, lane R3-A's sweep — this
// file was held back because lane H2 was converting its lifecycle_events
// insert at the same time). The module-level "use server" that stood here
// made calculateFatigue(contactId, brokerageId) and calculateAllBuyerFatigue
// public HTTP doors onto a service client with the tenant taken from the
// PARAMETER — CLAUDE.md §4's IDOR shape. Every caller is in-process server
// code: app/actions/buyer-fatigue.ts (session-gated actions) and
// app/api/fatigue/cron/route.ts (verifyCronAuth before calling). The sweep takes
// a declared TenantScope (lane 86G2); calculateFatigue's brokerageId is an
// in-process contract, not a public one.
// `server-only` makes a future client import fail at build time.
import "server-only"

import { createServiceClient } from "@/lib/supabase/service"
// agents.id → { users.id, users.brokerage_id }. The ONE crossing helper: both
// `fatigue_alerts.agent_user_id` (a users FK) and the tenant this file's
// smart_assistant_suggestions row must carry come from it.
import { resolveAgentRecipient } from "@/lib/notifications/recipient-tenant"
import { BUYER_CONCLUDED_STAGES } from "@/lib/contacts/buyer-stage"
import { generateTextRouted }  from "@/lib/ai/models"
import { KernelEvent }         from "@/lib/kernel/events"
import { deriveRiskLevel, type FatigueRiskLevel } from "./fatigue-display"
import { generateRecoveryPlan } from "./recovery-generator"
import { applyTenantScope, describeTenantScope, type TenantScope } from "@/lib/kernel/tenant-scope"

type Svc = ReturnType<typeof createServiceClient>

// ─── TYPES ───────────────────────────────────────────────────────────────────

/** ONE vocabulary (§6): the same literal union the display module speaks. */
export type RiskLevel = FatigueRiskLevel

export interface FatigueFactors {
  total_showings:            number
  total_tour_days:           number
  days_searching:            number
  offers_rejected:           number
  engagement_decline_factor: number // 0 | 1 | 2
  engagement_trend:          string
}

export interface FatigueResult {
  score:       number
  risk_level:  RiskLevel
  factors:     FatigueFactors
  contact_id:  string
  brokerage_id: string
  /** TRUE only when THIS call raised a new fatigue_alerts row (no undismissed alert existed).
   *  The sweep attaches a recovery plan only then — one AI plan per alert, never per run. */
  alert_raised: boolean
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

// TOMBSTONE (§6, wave 26, lane L4): `toRiskLevel` DELETED. It was a byte-identical
// second spelling of the cut points (critical>=75 / high>=50 / moderate>=25) that
// lib/fatigue/fatigue-display.ts:deriveRiskLevel already owns — and whose header
// explicitly claims to MIRROR this file. Two copies of one threshold set is the
// defect §6 names: a change to one silently desynchronises the badge from the
// scorer. SURVIVOR: lib/fatigue/fatigue-display.ts:deriveRiskLevel (imported above).

function riskLabel(r: RiskLevel): string {
  return r.charAt(0).toUpperCase() + r.slice(1)
}

// ─── THE INPUTS — and therefore THE POPULATION (wave 87, lane 87A) ────────────
//
// Owner, verbatim: "fatigue sweeps run for the platform on tenants and brokerage
// on leads and contacts which is user run. should be run on how the fatigue
// calculation is derived."
//
// calculateFatigue derives a score from FOUR inputs and nothing else — completed
// showings (count + days searching), completed tours (distinct tour days),
// rejected offers, and the buyer_behavior_log engagement trend. So the people a
// sweep scores are exactly the people who HAVE at least one of those inputs; a
// stage list is not the definition (lane 86G2's BUYER_ACTIVE_STAGES population
// skipped BUYER_DISENGAGED and BUYER_ON_HOLD — the two states fatigue exists to
// catch — and scored ladder members with no input at all, each to a flat 40
// "no recent activity").
//
// ONE place names the inputs, and BOTH the calculator and the population loader
// read through it (fatigueInput below), so the population can never drift from
// the formula. The CHECK literals stay inline in each `.from(...)` chain so the
// check-vocabulary guard still sees them.
//
// LEADS. Every input FKs contacts.id (live FK map: showings / tours / offers /
// buyer_behavior_log .contact_id → contacts.id). A lead reaches the calculation
// only through its conversion contact (leads.contact_id — the ONE conversion
// marker, lib/contact-promotion/conversion-finality.ts); an unconverted lead
// cannot have a single input row, so it is COUNTED (`leadsWithoutInputs`), never
// scored and never faked. After conversion the owner's ruling applies ("once a
// lead converts … only contacts get the actions") — the score lands on the contact.

/** The four sources calculateFatigue derives from, in formula order. */
export const FATIGUE_INPUT_SOURCES = ["showings", "tours", "offers", "buyer_behavior_log"] as const
export type FatigueInputSource = (typeof FATIGUE_INPUT_SOURCES)[number]

/** THE one reader of a fatigue input: the source's table + the row filter the formula counts.
 *  Keyed on the person (contacts.id) by every caller. */
function fatigueInput(supabase: Svc, source: FatigueInputSource, columns: string, count?: "exact") {
  const opts = count ? { count } : undefined
  switch (source) {
    case "showings":           return supabase.from("showings").select(columns, opts).eq("status", "completed")
    case "tours":              return supabase.from("tours").select(columns, opts).eq("status", "completed")
    case "offers":             return supabase.from("offers").select(columns, opts).eq("status", "rejected")
    case "buyer_behavior_log": return supabase.from("buyer_behavior_log").select(columns, opts)
  }
}

// ─── MAIN CALCULATOR ─────────────────────────────────────────────────────────

export async function calculateFatigue(
  contactId:   string,
  brokerageId: string,
): Promise<FatigueResult> {
  const supabase = createServiceClient()

  // ── 0. The person, pinned to THIS tenant (§4 — fail closed) ───────────────
  // Every write below stamps brokerageId; a contact that is not this tenant's
  // (or is soft-deleted) is refused BEFORE any read or write, never scored
  // under the wrong tenant.
  const { data: contact, error: contactErr } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, agent_id")
    .eq("id", contactId)
    .eq("brokerage_id", brokerageId)
    .is("deleted_at", null)
    .maybeSingle()
  if (contactErr) throw new Error(`[fatigue] contact read refused: ${contactErr.message}`)
  if (!contact) throw new Error(`[fatigue] contact ${contactId} is not a live contact of brokerage ${brokerageId}`)

  // ── 1. Load all raw stats ──────────────────────────────────────────────────

  const [showingsRes, toursRes, offersRes, signalsRes] = await Promise.all([
    // Total completed showings for this buyer
    fatigueInput(supabase, "showings", "id, scheduled_at", "exact").eq("contact_id", contactId),
    // Distinct tour days
    fatigueInput(supabase, "tours", "tour_date").eq("contact_id", contactId),
    // Rejected offers
    fatigueInput(supabase, "offers", "id, created_at", "exact").eq("contact_id", contactId),
    // Behavior log signals with timestamps for engagement trend
    fatigueInput(supabase, "buyer_behavior_log", "created_at, signal_value")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(200),
  ])

  // supabase-js RESOLVES a refusal (§3). A refused input used to read as ZERO —
  // a lower score than the truth, and a "fresh" badge nobody earned. Now the
  // person is not scored and the sweep counts the error.
  for (const [source, res] of [["showings", showingsRes], ["tours", toursRes], ["offers", offersRes], ["buyer_behavior_log", signalsRes]] as const) {
    if (res.error) throw new Error(`[fatigue] ${source} read refused for ${contactId}: ${res.error.message}`)
  }

  const showingRows = (showingsRes.data ?? []) as unknown as Array<{ id: string; scheduled_at: string }>
  const tourRows    = (toursRes.data ?? []) as unknown as Array<{ tour_date: string | null }>
  const signals     = (signalsRes.data ?? []) as unknown as Array<{ created_at: string; signal_value: number | null }>

  const totalShowings  = showingsRes.count ?? 0
  const tourDates      = new Set(tourRows.map(t => t.tour_date).filter(Boolean))
  const totalTourDays  = tourDates.size
  const offersRejected = offersRes.count ?? 0

  // Days searching = days since earliest showing or first offer attempt
  let daysSearching = 0
  if (showingRows.length > 0) {
    const earliest = showingRows.reduce((min, s) =>
      s.scheduled_at < min ? s.scheduled_at : min,
      showingRows[0].scheduled_at
    )
    daysSearching = Math.floor(
      (Date.now() - new Date(earliest).getTime()) / (1000 * 60 * 60 * 24)
    )
  }

  // Engagement decline factor from behavior log
  const now = Date.now()
  const ms14d = 14 * 24 * 60 * 60 * 1000
  const ms7d  =  7 * 24 * 60 * 60 * 1000

  const recent14Sum = signals
    .filter(s => now - new Date(s.created_at).getTime() <= ms14d)
    .reduce((acc, s) => acc + Number(s.signal_value ?? 1), 0)

  const prior14Sum = signals
    .filter(s => {
      const age = now - new Date(s.created_at).getTime()
      return age > ms14d && age <= ms14d * 2
    })
    .reduce((acc, s) => acc + Number(s.signal_value ?? 1), 0)

  const noSignals7d = !signals.some(
    s => now - new Date(s.created_at).getTime() <= ms7d
  )

  let engagementDeclineFactor = 0
  let engagementTrend = "stable"

  if (noSignals7d || (prior14Sum > 0 && recent14Sum / prior14Sum <= 0.4)) {
    engagementDeclineFactor = 2
    engagementTrend = noSignals7d ? "no recent activity" : "sharp decline"
  } else if (prior14Sum > 0 && recent14Sum / prior14Sum <= 0.7) {
    engagementDeclineFactor = 1
    engagementTrend = "declining"
  } else if (recent14Sum >= prior14Sum) {
    engagementTrend = "increasing"
  }

  // ── 2. Apply formula ───────────────────────────────────────────────────────

  const rawScore =
    (totalShowings   * 3) +
    (totalTourDays   * 8) +
    (daysSearching   / 10) +
    (offersRejected  * 15) +
    (engagementDeclineFactor * 20)

  const score     = Math.min(100, Math.round(rawScore))
  const riskLevel = deriveRiskLevel(score)

  const factors: FatigueFactors = {
    total_showings:            totalShowings,
    total_tour_days:           totalTourDays,
    days_searching:            daysSearching,
    offers_rejected:           offersRejected,
    engagement_decline_factor: engagementDeclineFactor,
    engagement_trend:          engagementTrend,
  }

  // ── 3. Upsert buyer_fatigue_scores — COUNTED (§3) ──────────────────────────
  // The upsert's result was never read, so a refused write reported a score that
  // had never persisted. Now: read the error AND count the row that came back.

  const { data: written, error: writeErr } = await supabase
    .from("buyer_fatigue_scores")
    .upsert(
      {
        contact_id:           contactId,
        brokerage_id:         brokerageId,
        fatigue_score:        score,
        risk_level:           riskLevel,
        total_showings:       totalShowings,
        total_tour_days:      totalTourDays,
        days_searching:       daysSearching,
        offers_rejected:      offersRejected,
        engagement_trend:     engagementTrend,
        contributing_factors: factors,
        last_calculated_at:   new Date().toISOString(),
      },
      { onConflict: "contact_id" }
    )
    .select("contact_id")
  if (writeErr) throw new Error(`[fatigue] score write refused for ${contactId}: ${writeErr.message}`)
  if ((written ?? []).length !== 1) throw new Error(`[fatigue] score write for ${contactId} landed ${(written ?? []).length} rows, expected 1`)

  // ── 4. Alert logic for high/critical ──────────────────────────────────────

  let alertRaised = false
  if (riskLevel === "high" || riskLevel === "critical") {
    // Check for existing unresolved fatigue alert (tenant-pinned; a refused read
    // is NOT "no alert" — raising a duplicate alert + AI note is the cost we avoid).
    const { data: existingAlert, error: existingErr } = await supabase
      .from("fatigue_alerts")
      .select("id")
      .eq("contact_id", contactId)
      .eq("brokerage_id", brokerageId)
      .eq("dismissed", false)
      .limit(1)
      .maybeSingle()
    if (existingErr) throw new Error(`[fatigue] open-alert read refused for ${contactId}: ${existingErr.message}`)

    if (!existingAlert) {
      const buyerName = `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || "This buyer"

      // AI-generated reinvigoration message (non-blocking on failure)
      let alertMessage = `${buyerName} has a fatigue score of ${score} (${riskLabel(riskLevel)}). ` +
        `${totalShowings} showings, ${totalTourDays} tour days, ` +
        `${daysSearching} days searching, ${offersRejected} rejected offers. ` +
        `Engagement trend: ${engagementTrend}.`

      // Routed + booked (§5: ai_tool_usage is the cost ledger). Was a raw
      // generateText pinned to claude-opus-4-5 with no ledger row — the most
      // expensive model for a two-sentence internal note, billed to nobody.
      try {
        const { text } = await generateTextRouted({
          feature: "buyer_fatigue_coaching",
          brokerageId,
          system:
            "You are a real estate agent coach. Write a single concise action recommendation (2 sentences max) for an agent whose buyer is showing signs of fatigue. Be specific and actionable.",
          prompt:
            `Buyer: ${buyerName}. Score: ${score}/100 (${riskLevel}). ` +
            `${totalShowings} showings, ${totalTourDays} tour days, ` +
            `${daysSearching} days searching, ${offersRejected} rejected offers. ` +
            `Engagement: ${engagementTrend}. What should the agent do?`,
          maxTokens: 120,
        })
        if (text.trim()) alertMessage = text.trim()
      } catch {
        // Keep fallback message
      }

      // Insert fatigue_alert. pass 13: fatigue_alerts.agent_user_id FKs users(id)
      // but contacts.agent_id is agents.id — the raw stamp FK-threw and every
      // fatigue alert died unnoticed. Resolve to the owning agent's auth user id.
      //
      // ONE RESOLVER, TWO ANSWERS, RESOLVED ONCE. The ad-hoc `agents.select
      // ("user_id")` this replaced destructured no `error`, so a refused lookup
      // arrived as "this agent has no user" and was indistinguishable from it.
      // The shared resolver returns the crossing (`agents.id` → `users.id`) AND
      // that user's `users.brokerage_id`, which is the value the suggestion below
      // has to carry.
      const owningAgent = await resolveAgentRecipient(supabase, contact.agent_id ?? null)
      const fatigueAgentUserId: string | null = owningAgent.ok ? owningAgent.userId : null
      const { data: alert, error: alertErr } = await supabase
        .from("fatigue_alerts")
        .insert({
          contact_id:               contactId,
          brokerage_id:             brokerageId,
          agent_user_id:            fatigueAgentUserId,
          alert_type:               "fatigue_threshold_crossed",
          fatigue_score_at_trigger: score,
          risk_level:               riskLevel,
          message:                  alertMessage,
          dismissed:                false,
        })
        .select("id")
        .single()
      if (alertErr) {
        // Counted by the caller as a scored person whose alert did not land —
        // the score row above is real; the alert is reported, never assumed.
        console.error(`[fatigue] fatigue_alerts insert refused for ${contactId}:`, alertErr.message)
      } else {
        alertRaised = true
      }

      // Insert smart_assistant_suggestion.
      //
      // TENANT: the OWNING AGENT'S `users.brokerage_id` — deliberately not this
      // function's `brokerageId` argument, even though the two agree on every
      // live row today. `getContactCopilotSuggestions` reads this table
      // `.eq("agent_id", ctx.agentId).eq("brokerage_id", ctx.brokerageId)` with
      // both halves from one `getAgentContext()`, and that context's brokerage IS
      // `users.brokerage_id`. Stamping the anchor's brokerage instead would be
      // stamping a value the reader does not compute — wave 23's badge-count
      // lesson, which is that a wrong tenant hides the row exactly as NULL does.
      //
      // NO AGENT (or an unreadable one) → NO ROW. Both readers filter `agent_id`,
      // so an unattributed suggestion is invisible whatever it is stamped with.
      // An AGENT only ever receives this for a CONTACT on their own book — the
      // person is a contacts row by construction (every input FKs contacts.id).
      if (!owningAgent.ok) {
        console.error(`[fatigue] suggestion skipped — agent tenant unresolved: ${owningAgent.reason}`)
      } else if (!contact.agent_id || !owningAgent.brokerageId) {
        console.error(
          `[fatigue] suggestion skipped for contact ${contactId} — ` +
          "the contact has no agent, or that agent has no users.brokerage_id; a suggestion nobody can read was not written",
        )
      } else {
        const { error: suggestionError } = await supabase.from("smart_assistant_suggestions").insert({
          agent_id:           contact.agent_id,
          brokerage_id:       owningAgent.brokerageId,
          title:              `${buyerName} showing signs of search fatigue`,
          description:        alertMessage,
          context_type:       "buyer_fatigue",
          action_type:        "view_buyer",
          action_payload_json: JSON.stringify({ contact_id: contactId }),
          priority:           riskLevel === "critical" ? "high" : "medium",
          status:             "pending",
        })
        if (suggestionError) {
          console.error("[fatigue] smart_assistant_suggestions insert refused:", suggestionError.message)
        }
      }

      // Kernel sub-event — audit row + reactor (the bare insert reached nothing).
      const { emitKernelEvent } = await import("@/lib/kernel/emit")
      await emitKernelEvent({
        brokerageId,
        entityType:   "buyer_lifecycle",
        entityId:     contactId,
        event:        KernelEvent.BUYER_FATIGUE_DETECTED,
        contactId,
        // lifecycle_events.actor_user_id FKs users(id) — contact.agent_id is an
        // agents.id, so the raw stamp FK-threw and the sub-event was lost even
        // though the alert beside it landed. Reuse the id already resolved above.
        actorUserId:  fatigueAgentUserId,
        metadata: {
          fatigue_score:   score,
          risk_level:      riskLevel,
          alert_id:        alert?.id ?? null,
        },
      })
    }
  }

  return { score, risk_level: riskLevel, factors, contact_id: contactId, brokerage_id: brokerageId, alert_raised: alertRaised }
}

// ─── THE POPULATION ──────────────────────────────────────────────────────────

/** Rows per page when collecting the people an input names (PostgREST max-rows default). */
const INPUT_PAGE_SIZE = 1000
/** Hard page cap PER SOURCE per run — a runaway table is reported (`inputsCapped`), never silently truncated. */
const INPUT_MAX_PAGES = 200
/** Ids per `.in()` when anchoring people to contacts / leads / prior scores (URL-length safe). */
const ANCHOR_CHUNK = 200
/** Default per-run cap on people scored — stalest first; the remainder is counted `deferred`
 *  and goes first next run (never-scored, then oldest last_calculated_at). */
export const FATIGUE_SWEEP_DEFAULT_MAX_PERSONS = 2000
/** Default people scored in parallel — each is 5 reads + 1 counted write; AI only on a NEW alert. */
const DEFAULT_CONCURRENCY = 4

function chunk<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

export interface FatigueSweepPerson {
  contactId:   string
  brokerageId: string
  /** The contact is the conversion of a lead in scope (leads.contact_id). */
  fromLead:    boolean
  /** Prior buyer_fatigue_scores.last_calculated_at — null when never scored. */
  lastCalculatedAt: string | null
}

export interface FatigueSweepPopulation {
  persons: FatigueSweepPerson[]
  /** Distinct people with ≥1 input row, before anchoring. */
  withInputs: number
  /** Dropped by the anchor: soft-deleted, tenantless, outside the scope, or search concluded. */
  excluded: number
  /** Leads in scope with NO contact — no input can exist for them (every input FKs contacts.id). */
  leadsWithoutInputs: number
  /** A source hit INPUT_MAX_PAGES — the population may be incomplete (reported, not hidden). */
  inputsCapped: FatigueInputSource[]
}

/**
 * WHO the calculation can score, derived from its inputs (see FATIGUE_INPUT_SOURCES).
 *
 *   1. every person named by ≥1 input row (paged; tenant scope narrows each source
 *      by its own brokerage_id — a source row stamped NULL is seen only by the
 *      platform sweep, which scores it under the CONTACT's tenant);
 *   2. anchored on contacts — live (deleted_at IS NULL), tenanted, inside the
 *      scope, and not past a concluded search (BUYER_CLOSED / BUYER_LIFETIME:
 *      "days searching" means nothing after the close). NULL buyer_stage stays IN;
 *   3. tagged when the contact is a lead's conversion, and the scope's unconverted
 *      leads counted — they have nothing the formula derives from.
 *
 * Every read is error-checked; a refusal throws (the run fails, never "nobody to score").
 */
export async function loadFatigueSweepPopulation(scope: TenantScope, client?: Svc): Promise<FatigueSweepPopulation> {
  const supabase = client ?? createServiceClient()
  const where = describeTenantScope(scope)

  // ── 1. people named by an input ──
  const named = new Set<string>()
  const inputsCapped: FatigueInputSource[] = []
  for (const source of FATIGUE_INPUT_SOURCES) {
    for (let page = 0; ; page++) {
      if (page >= INPUT_MAX_PAGES) { inputsCapped.push(source); break }
      const q = fatigueInput(supabase, source, "contact_id")
        .not("contact_id", "is", null)
        .order("id", { ascending: true })
        .range(page * INPUT_PAGE_SIZE, page * INPUT_PAGE_SIZE + INPUT_PAGE_SIZE - 1)
      applyTenantScope(q, scope)
      const { data, error } = await q
      if (error) throw new Error(`[fatigue-sweep] ${source} read refused (${where}): ${error.message}`)
      const rows = (data ?? []) as unknown as Array<{ contact_id: string | null }>
      for (const r of rows) if (r.contact_id) named.add(r.contact_id)
      if (rows.length < INPUT_PAGE_SIZE) break
    }
  }

  // ── 2. anchor on contacts (tenant-pinned) ──
  const concluded = BUYER_CONCLUDED_STAGES as readonly string[]
  const anchored = new Map<string, FatigueSweepPerson>()
  for (const ids of chunk([...named], ANCHOR_CHUNK)) {
    const q = supabase
      .from("contacts")
      .select("id, brokerage_id, buyer_stage")
      .in("id", ids)
      .is("deleted_at", null)
      .not("brokerage_id", "is", null)
    // Mutates the builder in place (the lib/property-alerts/alert-engine.ts shape —
    // the generic return form instantiates too deeply here, TS2589).
    applyTenantScope(q, scope)
    const { data, error } = await q
    if (error) throw new Error(`[fatigue-sweep] contact anchor read refused (${where}): ${error.message}`)
    for (const c of (data ?? []) as Array<{ id: string; brokerage_id: string; buyer_stage: string | null }>) {
      if (c.buyer_stage && concluded.includes(c.buyer_stage)) continue
      anchored.set(c.id, { contactId: c.id, brokerageId: c.brokerage_id, fromLead: false, lastCalculatedAt: null })
    }
  }

  // ── 3a. leads: which anchored contacts are a lead's conversion ──
  for (const ids of chunk([...anchored.keys()], ANCHOR_CHUNK)) {
    const q = supabase.from("leads").select("contact_id").in("contact_id", ids)
    applyTenantScope(q, scope)
    const { data, error } = await q
    if (error) throw new Error(`[fatigue-sweep] lead link read refused (${where}): ${error.message}`)
    for (const l of (data ?? []) as Array<{ contact_id: string | null }>) {
      const p = l.contact_id ? anchored.get(l.contact_id) : undefined
      if (p) p.fromLead = true
    }
  }

  // ── 3b. leads with nothing to derive from (unconverted) — counted, not scored ──
  const lq = supabase.from("leads").select("id", { count: "exact", head: true }).is("contact_id", null)
  applyTenantScope(lq, scope)
  const { count: leadsWithoutInputs, error: leadsErr } = await lq
  if (leadsErr) throw new Error(`[fatigue-sweep] unconverted-lead count refused (${where}): ${leadsErr.message}`)

  // ── 4. staleness, for the per-run cap (never-scored first, then oldest) ──
  for (const ids of chunk([...anchored.keys()], ANCHOR_CHUNK)) {
    const q = supabase.from("buyer_fatigue_scores").select("contact_id, last_calculated_at").in("contact_id", ids)
    applyTenantScope(q, scope)
    const { data, error } = await q
    if (error) throw new Error(`[fatigue-sweep] prior-score read refused (${where}): ${error.message}`)
    for (const s of (data ?? []) as Array<{ contact_id: string; last_calculated_at: string | null }>) {
      const p = anchored.get(s.contact_id)
      if (p) p.lastCalculatedAt = s.last_calculated_at
    }
  }

  const persons = [...anchored.values()].sort((a, b) => {
    if (a.lastCalculatedAt === b.lastCalculatedAt) return a.contactId < b.contactId ? -1 : 1
    if (a.lastCalculatedAt === null) return -1
    if (b.lastCalculatedAt === null) return 1
    return a.lastCalculatedAt < b.lastCalculatedAt ? -1 : 1
  })

  return {
    persons,
    withInputs: named.size,
    excluded: named.size - anchored.size,
    leadsWithoutInputs: leadsWithoutInputs ?? 0,
    inputsCapped,
  }
}

// ─── THE SWEEP ───────────────────────────────────────────────────────────────

/** What one sweep did — counted, so a caller can tell "scored nobody" from "refused". */
export interface FatigueSweepResult {
  /** "platform" (the cron, every tenant) or "tenant" (a brokerage's Recalculate). */
  scope: TenantScope["kind"]
  /** Distinct people with ≥1 calculation input, before anchoring. */
  withInputs: number
  /** Dropped by the anchor (deleted / tenantless / outside scope / search concluded). */
  excluded: number
  /** People eligible this run (after anchoring). */
  total: number
  /** Of `total`: contacts that are a lead's conversion. */
  fromLeads: number
  /** Leads in scope with no contact — nothing to derive from; counted, never scored. */
  leadsWithoutInputs: number
  /** calculateFatigue completed (score written AND counted). */
  scored: number
  /** Eligible but past the per-run cap — scored first next run (stalest-first). */
  deferred: number
  /** New high/critical alerts raised this run. */
  alertsRaised: number
  /** New alerts that got a recovery plan attached (one plan per NEW alert, never per run). */
  recovered: number
  /** People whose score threw — counted, never swallowed silently. */
  errors: number
  /** Sources that hit the page cap — the population may be incomplete. */
  inputsCapped: FatigueInputSource[]
}

/** TOMBSTONE (lane 87A) — the name `BuyerFatigueSweepResult` (lane 86G2) is retired with
 *  calculateAllBuyerFatigue; survivor: FatigueSweepResult above (a superset — total /
 *  scored / recovered / errors keep their meaning). */

export interface FatigueSweepOptions {
  /** Max people scored this run (default FATIGUE_SWEEP_DEFAULT_MAX_PERSONS). */
  maxPersons?: number
  /** People scored in parallel (default 4). */
  concurrency?: number
}

/**
 * THE fatigue sweep — ONE core, TWO scopes (wave 87, lane 87A):
 *   · PLATFORM — app/api/fatigue/cron (CRON_SECRET-verified, every 12h through
 *     lib/kernel/cron-dispatch.ts) passes platformScope(reason): every tenant;
 *   · BROKERAGE — app/actions/buyer-fatigue.ts recalculateBrokerageFatigue (a
 *     tenant admin's "Recalculate") passes tenantScope(SESSION brokerage).
 * The population is loadFatigueSweepPopulation — the people the formula's inputs
 * name — never a stage list.
 *
 * TOMBSTONE (lane 87A): `calculateAllBuyerFatigue` (lane 86G2) — its population was
 * the shared active-buyer ladder BUYER_ACTIVE_STAGES, i.e. not derived from the
 * calculation, and it regenerated an AI recovery plan for EVERY high/critical buyer
 * on EVERY 12h run (overwriting the last one). Survivor: runFatigueSweep (here),
 * which carries its tenant scope, its thrown read refusal, deleted_at IS NULL and
 * brokerage_id NOT NULL, and attaches a plan once per NEW alert.
 *
 * COST-AWARE: people are scored stalest-first up to `maxPersons` (the rest are
 * counted `deferred`) with bounded concurrency; each person is 5 reads + 1 counted
 * write; the only model calls happen when a NEW alert is raised (the alert note and
 * its recovery plan, both routed + booked under `buyer_fatigue_coaching`).
 */
export async function runFatigueSweep(scope: TenantScope, opts: FatigueSweepOptions = {}): Promise<FatigueSweepResult> {
  const maxPersons = Math.max(0, Math.floor(opts.maxPersons ?? FATIGUE_SWEEP_DEFAULT_MAX_PERSONS))
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_CONCURRENCY))

  const pop = await loadFatigueSweepPopulation(scope)
  const batch = pop.persons.slice(0, maxPersons)

  const result: FatigueSweepResult = {
    scope: scope.kind,
    withInputs: pop.withInputs,
    excluded: pop.excluded,
    total: pop.persons.length,
    fromLeads: pop.persons.filter((p) => p.fromLead).length,
    leadsWithoutInputs: pop.leadsWithoutInputs,
    scored: 0,
    deferred: pop.persons.length - batch.length,
    alertsRaised: 0,
    recovered: 0,
    errors: 0,
    inputsCapped: pop.inputsCapped,
  }

  for (const slice of chunk(batch, concurrency)) {
    const settled = await Promise.allSettled(slice.map(async (person) => {
      // calculateFatigue re-pins the contact to person.brokerageId (read from the
      // tenant-scoped anchor, never from a caller) before any write.
      const scored = await calculateFatigue(person.contactId, person.brokerageId)
      let recovered = false
      if (scored.alert_raised) {
        // Best-effort: a plan failure never un-counts the score.
        try {
          const recovery = await generateRecoveryPlan(scored)
          recovered = recovery.success
        } catch (planErr) {
          console.warn("[fatigue-sweep] recovery plan failed for", person.contactId, planErr)
        }
      }
      return { scored, recovered }
    }))
    settled.forEach((s, i) => {
      if (s.status === "rejected") {
        console.error("[fatigue-sweep] score failed for", slice[i].contactId, s.reason)
        result.errors++
        return
      }
      result.scored++
      if (s.value.scored.alert_raised) result.alertsRaised++
      if (s.value.recovered) result.recovered++
    })
  }

  return result
}
