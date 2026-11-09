// lib/acquisition-plays/runner.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE EARLY-OPPORTUNITY RUNNER (wave 151, lane 151D) — one call runs a territory's plays, from a hunt or from a
// monitor's pushed delta, in the order of earliest VERIFIED assistance (PLAY_CARDS.earliestAssistanceRank):
//
//   1. contact_second_window     — the tenant's own Contacts (first-party rows; no Exa, no spend)
//   2. negative_evidence_saver   — contradictions the hunt surfaced against open theories (closes / holds; never adds)
//   3. public_request_assist     — people who asked for an agent (Exa)
//   4. property_candidate_queue  — FSBO / notices / business moves (Exa)
//   5. moving_corridor_radar     — employer announcements × coverage × inventory (Exa)
//
// The Exa client is resolved by NAME (EXA_API_KEY) when the caller does not inject one; absent, the Exa plays
// report provider_unconfigured and invent nothing. `results` (a Search Monitor's delta) skips every hunt — the
// monitored-delta path that replaces repeated searches. `monitors.register` (opt-in; default off — creating a
// monitor is provider spend) ensures one monitor per Exa play per territory.
//
// CALLERS: app/api/webhooks/exa/route.ts (through lib/providers/exa/monitors.ts handleExaWebhookDelivery) and the
// lead-scraping cron's Exa step (lane 151C's file — Outside-lane request in the lane notes).

import { productionExaHuntClient, type ExaHuntClient, type ExaHuntResult } from "@/lib/providers/exa/hunting"
import { EXA_HUNTED_PLAYS, PLAY_CARDS, PLAY_KEYS, type PlayKey, type PlayResult } from "./contract"
import { runMovingCorridorPlay, type CorridorDeps, type PlayMarket } from "./moving-corridor"
import { runPublicRequestPlay, type PublicRequestDeps } from "./public-request"
import { runPropertyCandidatePlay, type PropertyCandidateDeps, type PropertyContradiction } from "./property-candidates"
import { runContactSecondWindow, sweepContactSecondWindows, type SecondWindowDeps } from "./contact-second-window"
import { applyNegativeEvidence, assessNegativeEvidence, type LeadTheory, type NegativeEvidenceDeps } from "./negative-evidence"

type Svc = { from: (t: string) => any }

export interface RunnerDeps {
  corridor?: CorridorDeps
  request?: PublicRequestDeps
  property?: PropertyCandidateDeps
  secondWindow?: SecondWindowDeps
  negative?: NegativeEvidenceDeps
  /** Monitor registration (default lib/providers/exa/monitors.ts ensureExaMonitors). */
  ensureMonitors?: (svc: Svc, a: { brokerageId: string; market: PlayMarket; plays: readonly PlayKey[]; webhookUrl: string; period?: string }) => Promise<unknown>
}

export interface RunEarlyOpportunityInput {
  market: PlayMarket
  /** undefined = resolve the live client by name (EXA_API_KEY); null = hunt nothing; a client = use it. */
  hunt?: ExaHuntClient | null
  /** A monitor's pushed results — the plays read these and never hunt. */
  results?: ExaHuntResult[] | null
  plays?: readonly PlayKey[]
  now?: Date
  /** Corridor activation (the local guide + the draft magnet through the existing producers). */
  activate?: boolean
  secondWindowDays?: number
  /** ONE Contact's second window (a portal / first-party event for that person) instead of the territory sweep. */
  contactId?: string | null
  monitors?: { register: boolean; webhookUrl: string | null; period?: string }
}

export interface RunEarlyOpportunityResult {
  status: "ok" | "provider_unconfigured"
  marketId: string
  results: PlayResult[]
  costUsd: number
  /** The monitor registrations this run made (null = not asked). */
  monitors: unknown | null
  notes: string[]
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()

/** PURE — the hunt's contradictions × the tenant's OPEN theories on the same address → the theories to assess. */
function contradictedTheories(contradictions: readonly PropertyContradiction[], open: ReadonlyArray<Record<string, unknown>>, now: Date): Array<{ theory: LeadTheory; evidence: Parameters<typeof assessNegativeEvidence>[1] }> {
  const out: Array<{ theory: LeadTheory; evidence: Parameters<typeof assessNegativeEvidence>[1] }> = []
  for (const c of contradictions) {
    const key = norm(c.address)
    if (!key) continue
    for (const row of open) {
      const addr = typeof row.property_address === "string" ? norm(row.property_address) : ""
      if (!addr || addr !== key) continue
      const subjectType = row.contact_id ? "contact" : row.lead_id ? "lead" : row.raw_lead_id ? "raw_lead" : "property"
      const subjectId = String(row.contact_id ?? row.lead_id ?? row.raw_lead_id ?? row.property_address_key ?? row.id)
      out.push({
        theory: {
          subject: { type: subjectType, id: subjectId }, side: (row.side === "buyer" || row.side === "seller" ? row.side : "unknown"), latestPositiveAt: String(row.observed_at ?? now.toISOString()),
          propertyAddress: String(row.property_address), movementSignalId: String(row.id), leadId: typeof row.lead_id === "string" ? row.lead_id : null, rawLeadId: typeof row.raw_lead_id === "string" ? row.raw_lead_id : null,
        },
        // A public page is REPORTED evidence (the MLS would be verified) — it holds / asks for verification, never stops by itself.
        evidence: [{ kind: c.kind, at: c.evidence.publishedAt ?? c.evidence.retrievedAt, confidence: "reported", source: `exa:${c.evidence.publisher ?? "page"}`, detail: c.listingBrokerage ?? null, reference: { kind: "public_page", id: c.evidence.resultId, url: c.evidence.sourceUrl } }],
      })
    }
  }
  return out
}

/** Run a territory's plays. Never throws: a play that fails is a refused result with its reason. */
export async function runEarlyOpportunityPlays(svc: Svc, a: RunEarlyOpportunityInput, deps: RunnerDeps = {}): Promise<RunEarlyOpportunityResult> {
  const now = a.now ?? new Date()
  const hunt = a.hunt === undefined ? productionExaHuntClient() : a.hunt
  const requested = a.plays ?? PLAY_KEYS
  const ordered = [...requested].sort((x, y) => PLAY_CARDS[x].earliestAssistanceRank - PLAY_CARDS[y].earliestAssistanceRank)
  const results: PlayResult[] = []
  const notes: string[] = []
  let costUsd = 0
  const exaPlays = ordered.filter((p) => EXA_HUNTED_PLAYS.includes(p))
  if (exaPlays.length && !hunt && !a.results) notes.push("EXA_API_KEY is not configured — the Exa plays hunted nothing and invented nothing (WAITING_EXTERNAL by name)")

  const guarded = async (play: PlayKey, run: () => Promise<PlayResult>) => {
    try { const r = await run(); results.push(r); costUsd += r.costUsd; return r }
    catch (e) { const r: PlayResult = { play, status: "refused", evidence: [], actions: [], refused: [{ what: play, why: e instanceof Error ? e.message : String(e) }], blindSpots: [], costUsd: 0 }; results.push(r); return r }
  }

  let contradictions: PropertyContradiction[] = []
  for (const play of ordered) {
    if (play === "contact_second_window") {
      if (!a.market.brokerage_id) { notes.push("contact_second_window skipped: a platform-pool territory has no Contacts"); continue }
      const brokerageId = a.market.brokerage_id
      await guarded(play, async () => {
        if (a.contactId) {
          const one = await runContactSecondWindow(svc, { brokerageId, contactId: a.contactId, now, windowDays: a.secondWindowDays }, deps.secondWindow)
          return { play, status: one.status, evidence: [], actions: one.actions, refused: one.refused, blindSpots: [...one.blindSpots, `one contact (${one.changes.length} change(s))`], costUsd: 0 }
        }
        const sweep = await sweepContactSecondWindows(svc, { brokerageId, now, windowDays: a.secondWindowDays }, deps.secondWindow)
        const acted = sweep.results.filter((r) => r.status === "acted")
        return { play, status: acted.length ? "acted" : "nothing_found", evidence: [], actions: acted.flatMap((r) => r.actions), refused: sweep.results.flatMap((r) => r.refused).concat(sweep.errors.map((e) => ({ what: "sweep read", why: e }))), blindSpots: [`${sweep.contacts} contact(s) with first-party changes inside the window`], costUsd: 0 }
      })
    } else if (play === "public_request_assist") {
      await guarded(play, () => runPublicRequestPlay(svc, { market: a.market, hunt, results: a.results ?? null, now }, deps.request))
    } else if (play === "property_candidate_queue") {
      const r = await guarded(play, () => runPropertyCandidatePlay(svc, { market: a.market, hunt, results: a.results ?? null, now }, deps.property))
      contradictions = (r as { contradictions?: PropertyContradiction[] }).contradictions ?? []
    } else if (play === "moving_corridor_radar") {
      await guarded(play, () => runMovingCorridorPlay(svc, { market: a.market, hunt, results: a.results ?? null, now, activate: a.activate }, deps.corridor))
    } else if (play === "negative_evidence_saver") {
      // Runs AFTER the property play surfaced its contradictions (the loop is rank-ordered: 2 before 4 — so defer to the end).
      continue
    }
  }
  if (ordered.includes("negative_evidence_saver")) {
    if (!a.market.brokerage_id) notes.push("negative_evidence_saver skipped: a platform-pool territory holds no theories")
    else if (contradictions.length === 0) results.push({ play: "negative_evidence_saver", status: "nothing_found", evidence: [], actions: [], refused: [], blindSpots: ["no contradiction surfaced by this run's hunt (the reconciler closes theories from our own listings / transactions)"], costUsd: 0 })
    else {
      const brokerageId = a.market.brokerage_id
      await guarded("negative_evidence_saver", async () => {
        const { data, error } = await svc.from("movement_signals").select("id, subject_type, contact_id, lead_id, raw_lead_id, property_address, side, observed_at").eq("brokerage_id", brokerageId).is("outcome", null).not("property_address", "is", null).limit(500)
        if (error) return { play: "negative_evidence_saver", status: "refused", evidence: [], actions: [], refused: [{ what: "open theories read", why: error.message }], blindSpots: [], costUsd: 0 }
        const pairs = contradictedTheories(contradictions, (data ?? []) as Array<Record<string, unknown>>, now)
        const actions: PlayResult["actions"] = []
        const refused: PlayResult["refused"] = []
        for (const p of pairs) {
          const assessment = assessNegativeEvidence(p.theory, p.evidence, now)
          const applied = await applyNegativeEvidence(svc, { brokerageId, theory: p.theory, assessment, now }, deps.negative)
          actions.push(...applied.actions)
          refused.push(...applied.refused)
        }
        return { play: "negative_evidence_saver", status: actions.length ? "acted" : "nothing_found", evidence: contradictions.map((c) => c.evidence), actions, refused, blindSpots: [`${contradictions.length} contradiction page(s) × ${pairs.length} open theory match(es)`], costUsd: 0 }
      })
    }
  }

  let monitors: unknown | null = null
  if (a.monitors?.register) {
    if (!hunt) notes.push("monitors not registered: EXA_API_KEY is not configured")
    else if (!a.market.brokerage_id) notes.push("monitors not registered: a platform-pool territory has no tenant to own them")
    else if (!a.monitors.webhookUrl) notes.push("monitors not registered: no webhook URL")
    else {
      const ensure = deps.ensureMonitors ?? (async (s, x) => (await import("@/lib/providers/exa/monitors")).ensureExaMonitors(s, x))
      monitors = await ensure(svc, { brokerageId: a.market.brokerage_id, market: a.market, plays: exaPlays, webhookUrl: a.monitors.webhookUrl, period: a.monitors.period })
    }
  }
  const status: RunEarlyOpportunityResult["status"] = exaPlays.length && !hunt && !a.results ? "provider_unconfigured" : "ok"
  return { status, marketId: a.market.id, results, costUsd, monitors, notes }
}
