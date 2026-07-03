// lib/kernel/vendor-orchestration.ts
//
// DEAL-STAGE VENDOR ORCHESTRATION — the Deal Coordinator (with the Asset Manager for
// listing-time media vendors) treats the brokerage's vendor bench as a TEAM, not a
// rolodex. As a transaction crosses a milestone, the coordinator looks at what the deal
// already has on it (an inspector booked? a title company? a lender?) and, for the FIRST
// uncovered vendor category the stage needs, PROPOSES the right vendor from the bench
// with a persona-aware quote-request draft. Nothing auto-books: the proposal is an
// internal draft to the agent (agent_client_messages, audience 'agent', status
// 'proposed'). The agent picks/approves; the existing booking mechanics (vendor-quote-
// workflow, ai-vendor-management) take it from there.
//
// OWNER CORRECTIONS honored here:
//  · STAGING IS OPTIONAL — a Stager is only proposed when the brokerage has staging
//    enabled in its settings (brokerage_settings.settings ->> 'staging_enabled'). Default
//    OFF when the flag is absent.
//  · PREFERENCE-FIRST RANKING — the bench is `vendors` (category CHECK Lender|Inspector|
//    Title Company|Contractor|Stager|Other), which has NO preferred flag (only rating). The
//    broker's `preferred` choices live in the SEPARATE `vendor_directory` table. These two
//    tables have no FK, so resolvePreferredVendorIds bridges them by (brokerage, name,
//    category); the resolved set feeds rankVendors so preference-first is REAL (previously the
//    orchestrator read only `vendors` and the promise was inert — a real drift, now closed).
//
// NOT server-only — the simulator drives the pure layer directly; runVendorOrchestration
// takes an injectable Supabase client + copyGenerator seam so tests spend no tokens.

import { createServiceClient } from "@/lib/supabase/service"
import type { CopyGenerator } from "@/lib/kernel/ai-copy"

type Svc = ReturnType<typeof createServiceClient>

/** The vendor categories on the bench (vendors.category CHECK). */
export type VendorCategory = "Lender" | "Inspector" | "Title Company" | "Contractor" | "Stager" | "Other"

/** Live transaction stages (transactions.stage CHECK). */
export type DealStage =
  | "UNDER_CONTRACT" | "INSPECTION" | "APPRAISAL" | "FINANCING_PENDING" | "CLOSING_PREP" | "CLOSED" | "LOST"

/** What the deal already has covered — used to find the FIRST uncovered gap for a stage. */
export interface DealCoverage {
  hasInspection: boolean
  hasLender: boolean
  hasTitle: boolean
  hasStager: boolean
  /** Is staging enabled for this brokerage/agent? (settings-gated; default false.) */
  stagingEnabled: boolean
}

/** A single vendor row off the bench (the subset orchestration ranks/proposes). */
export interface BenchVendor {
  id: string
  name: string
  category: VendorCategory | string | null
  email: string | null
  rating: number | null
  /** Forward-compatible: present only if the bench schema gains a preferred flag. */
  preferred?: boolean | null
}

/** A brokerage's vendor_directory row — the SINGLE SOURCE OF TRUTH for the `preferred` signal. The
 *  operational bench (`vendors`, FK target of vendor_bookings) has no preferred flag; the broker marks
 *  preference in the directory. These two tables have no FK, so we bridge by (brokerage, name, category). */
export interface DirectoryPref {
  name: string | null
  category: string | null
  preferred: boolean | null
}

const normVendorKey = (name: string | null | undefined, category: string | null | undefined) =>
  `${(name ?? "").trim().toLowerCase()}|${(category ?? "").trim().toLowerCase()}`

/**
 * PURE: resolve which BENCH vendor ids are PREFERRED, using vendor_directory as the source of truth.
 * A directory row with preferred=true is matched to a bench vendor by normalized (name, category);
 * name-only is a fallback when categories differ in spelling. Returns the set of bench vendor ids to
 * feed rankVendors — so the orchestrator's documented "preference-first" promise is finally REAL,
 * without duplicating the flag onto `vendors`.
 */
export function resolvePreferredVendorIds(bench: BenchVendor[], directory: DirectoryPref[]): Set<string> {
  const preferredKeys = new Set<string>()
  const preferredNames = new Set<string>()
  for (const d of directory) {
    if (d.preferred !== true) continue
    preferredKeys.add(normVendorKey(d.name, d.category))
    if (d.name) preferredNames.add(d.name.trim().toLowerCase())
  }
  const ids = new Set<string>()
  for (const v of bench) {
    if (preferredKeys.has(normVendorKey(v.name, v.category)) || (v.name && preferredNames.has(v.name.trim().toLowerCase()))) {
      ids.add(v.id)
    }
  }
  return ids
}

/** A stage gap: the vendor category the stage needs + the service_type + a human label. */
export interface VendorGap {
  category: VendorCategory
  /** service_type written onto the proposal (matches existing vendor_bookings vocabulary). */
  serviceType: string
  /** plain label for the agent ("home inspection", "title & escrow", …). */
  label: string
}

/**
 * Pure: which vendor category does THIS stage need that the deal does not yet cover?
 * Returns the FIRST uncovered gap (one proposal per run per transaction), or null when
 * the stage is fully covered / has no vendor need. Staging is settings-gated: a Stager
 * gap is only emitted at listing time (UNDER_CONTRACT is post-listing here, so staging is
 * surfaced at CLOSING_PREP for the next listing cycle only when enabled) — see notes.
 *
 * Stage → needed coverage:
 *  · UNDER_CONTRACT → an inspector (book the inspection while the option period is live)
 *  · INSPECTION     → an inspector (same gap if still unbooked)
 *  · APPRAISAL / FINANCING_PENDING → a lender on the deal (financing team)
 *  · CLOSING_PREP   → title & escrow company
 * Staging: only when stagingEnabled AND the deal has no stager yet — surfaced as a
 * secondary gap (lowest priority) so it never blocks the deal-critical vendor.
 */
export function vendorGapForStage(stage: DealStage | string | null, coverage: DealCoverage): VendorGap | null {
  switch (stage) {
    case "UNDER_CONTRACT":
    case "INSPECTION":
      if (!coverage.hasInspection) {
        return { category: "Inspector", serviceType: "inspection", label: "home inspection" }
      }
      // inspection covered → if staging is on and no stager, propose the stager next.
      return stagerGap(coverage)
    case "APPRAISAL":
    case "FINANCING_PENDING":
      if (!coverage.hasLender) {
        return { category: "Lender", serviceType: "lending", label: "financing / lender" }
      }
      return stagerGap(coverage)
    case "CLOSING_PREP":
      if (!coverage.hasTitle) {
        return { category: "Title Company", serviceType: "title_escrow", label: "title & escrow" }
      }
      return stagerGap(coverage)
    default:
      return null
  }
}

/** Staging gap — ONLY when enabled in settings and not already covered. Default OFF. */
function stagerGap(coverage: DealCoverage): VendorGap | null {
  if (coverage.stagingEnabled && !coverage.hasStager) {
    return { category: "Stager", serviceType: "staging", label: "home staging" }
  }
  return null
}

/** Below this many outcomes (completed + no-show), SLA is too thin to demote a vendor on — honest. */
export const SLA_MIN_SAMPLE = 3
/** On-time % below which a vendor with enough sample is an SLA breach (mirrors lib/kernel/vendor-sla). */
export const SLA_BREACH_PCT = 75

/** Ranking preference inputs (forward-compatible; the bench may grow a preference table). */
export interface VendorPrefs {
  /** vendor ids explicitly preferred for this agent/team/brokerage (highest priority). */
  preferredVendorIds?: ReadonlySet<string> | string[]
  /** Per-vendor SLA (on-time % + sample) from computeVendorSla — a proven breacher is auto-demoted. */
  slaByVendor?: Record<string, { slaPct: number; total: number }>
}

/**
 * Pure: rank bench vendors — OUTCOME-AWARE, PREFERENCE-FIRST. A vendor that is a PROVEN SLA breacher
 * (on-time < SLA_BREACH_PCT with at least SLA_MIN_SAMPLE outcomes, including no-shows) is demoted to the
 * bottom regardless of preference — the marketplace stops auto-picking someone who keeps failing.
 * Among non-breachers, the broker's preferred wins over rating; within a tier higher rating then higher
 * SLA then name break ties. A thin-sample or unknown-SLA vendor is NOT demoted (unproven ≠ bad).
 */
export function rankVendors(vendors: BenchVendor[], prefs: VendorPrefs = {}): BenchVendor[] {
  const preferredSet = prefs.preferredVendorIds
    ? (prefs.preferredVendorIds instanceof Set ? prefs.preferredVendorIds : new Set(prefs.preferredVendorIds))
    : new Set<string>()
  const sla = prefs.slaByVendor ?? {}
  const isPreferred = (v: BenchVendor) => preferredSet.has(v.id) || v.preferred === true
  const isBreacher = (v: BenchVendor) => {
    const s = sla[v.id]
    return !!s && s.total >= SLA_MIN_SAMPLE && s.slaPct < SLA_BREACH_PCT
  }
  const slaPct = (v: BenchVendor) => sla[v.id]?.slaPct ?? -1
  return [...vendors].sort((a, b) => {
    const ba = isBreacher(a) ? 1 : 0
    const bb = isBreacher(b) ? 1 : 0
    if (ba !== bb) return ba - bb                        // proven breachers LAST
    const pa = isPreferred(a) ? 1 : 0
    const pb = isPreferred(b) ? 1 : 0
    if (pa !== pb) return pb - pa                        // preferred first
    const ra = a.rating ?? -1
    const rb = b.rating ?? -1
    if (ra !== rb) return rb - ra                        // higher rating first
    const sa = slaPct(a), sbv = slaPct(b)
    if (sa !== sbv) return sbv - sa                      // higher on-time first
    return (a.name ?? "").localeCompare(b.name ?? "")    // deterministic tie-break
  })
}

/** Pick the single best vendor for a gap, or null when the bench has none in that category. */
export function pickVendorForGap(
  vendors: BenchVendor[], gap: VendorGap, prefs: VendorPrefs = {},
): BenchVendor | null {
  const inCategory = vendors.filter((v) => v.category === gap.category)
  if (inCategory.length === 0) return null
  return rankVendors(inCategory, prefs)[0] ?? null
}

/** Pure deterministic FALLBACK quote-request copy (the AI generator personalizes this). */
export function composeQuoteRequestFallback(args: {
  vendorName: string
  gap: VendorGap
  propertyAddress: string | null
  dealName: string | null
}): { subject: string; body: string } {
  const where = args.propertyAddress ? ` at ${args.propertyAddress}` : ""
  const deal = args.dealName ? ` (${args.dealName})` : ""
  const subject = `Quote request: ${args.gap.label} — ${args.vendorName}`
  const body = [
    `Hi ${args.vendorName},`,
    `We have a transaction${deal} moving forward and would like to request a quote and availability for ${args.gap.label}${where}.`,
    `Could you share your earliest availability and an estimated cost? We coordinate the booking on your confirmation.`,
    `Thank you.`,
  ].join("\n\n")
  return { subject, body }
}

export interface VendorOrchestrationResult {
  /** transactions scanned. */
  scanned: number
  /** vendor proposals drafted (agent_client_messages). */
  proposed: number
  /** gaps found but skipped because the bench had no vendor in that category. */
  benchMisses: number
  /** stager gaps suppressed because staging was disabled in settings. */
  stagingSkipped: number
  errors: string[]
}

/** Active stages we orchestrate (CLOSED/LOST have no vendor need). */
const ACTIVE_STAGES: DealStage[] = ["UNDER_CONTRACT", "INSPECTION", "APPRAISAL", "FINANCING_PENDING", "CLOSING_PREP"]

/**
 * Run vendor orchestration for one brokerage: for each active in-flight transaction, find
 * the first uncovered vendor gap for its stage, pick the preference-first vendor off the
 * bench, and PROPOSE a persona-aware quote-request draft to the agent (gated, idempotent).
 *
 * Idempotency: one proposal per (transaction, service_type) — keyed on the proposal's
 * rationale prefix `VENDOR ORCH — <service_type>` against agent_client_messages for the
 * transaction. Nothing books; nothing sends.
 */
export async function runVendorOrchestration(
  brokerageId: string,
  opts: { now?: Date; copyGenerator?: CopyGenerator } = {},
  client?: Svc,
): Promise<VendorOrchestrationResult> {
  const supabase = client ?? createServiceClient()
  const result: VendorOrchestrationResult = { scanned: 0, proposed: 0, benchMisses: 0, stagingSkipped: 0, errors: [] }

  // Settings-gated staging flag (default OFF when the row/flag is absent).
  const stagingEnabled = await readStagingEnabled(supabase, brokerageId)

  // The bench for this brokerage (vendors table — the canonical bench per the FK
  // vendor_bookings.vendor_id → vendors.id).
  // APPROVAL GATE — only approved (active) vendors are auto-proposed. A pending/inactive/archived vendor
  // (awaiting or denied verification) is never put in front of an agent. Legacy null-status rows are
  // treated as active for backward-compatibility (they predate the verification gate).
  const { data: benchRows } = await supabase.from("vendors")
    .select("id, name, category, email, rating, estimated_turnaround_days")
    .eq("brokerage_id", brokerageId)
    .not("status", "in", "(pending,inactive,archived)").limit(500)
  const bench: BenchVendor[] = (benchRows ?? []) as BenchVendor[]

  // PREFERENCE SOURCE OF TRUTH — the broker's `preferred` choices live in vendor_directory, not on the
  // `vendors` bench. Resolve them to bench ids so ranking is genuinely preference-first (closes the
  // drift where the orchestrator's documented promise was inert because it read the wrong table).
  const { data: dirRows } = await supabase.from("vendor_directory")
    .select("name, category, preferred")
    .eq("brokerage_id", brokerageId).eq("preferred", true).limit(500)
  const preferredVendorIds = resolvePreferredVendorIds(bench, (dirRows ?? []) as DirectoryPref[])

  // OUTCOME AWARENESS — a proven SLA breacher (repeatedly late or a no-show) is auto-demoted so the
  // orchestrator stops auto-picking someone who keeps failing. Reliability = on-time completions +
  // no-shows over the last 180 days, via the shared computeVendorSla (same math as the SLA panel).
  const slaSince = new Date((opts.now ?? new Date()).getTime() - 180 * 86_400_000).toISOString()
  const { data: slaBookings } = await supabase.from("vendor_bookings")
    .select("vendor_id, scheduled_date, completed_at, status")
    .eq("brokerage_id", brokerageId)
    .or("completed_at.not.is.null,status.eq.no_show")
    .gte("created_at", slaSince).limit(2000)
  const turnaround: Record<string, number> = {}
  for (const v of (benchRows ?? []) as Array<{ id: string; estimated_turnaround_days?: number | null }>) turnaround[v.id] = v.estimated_turnaround_days ?? 1
  const { computeVendorSla } = await import("@/lib/kernel/vendor-sla")
  const slaByVendor = computeVendorSla((slaBookings ?? []) as any[], turnaround)

  // QUALITY GATE — a vendor whose ratings have dropped below the floor is SUPPRESSED: never auto-proposed
  // to an agent (who would put them in front of a client). Fail-open (an empty set) if ratings can't load.
  const { loadSuppressedVendorIds } = await import("@/lib/kernel/vendor-rating-governance")
  const suppressedVendorIds = await loadSuppressedVendorIds(supabase, brokerageId)
  const eligibleBench = suppressedVendorIds.size > 0 ? bench.filter((v) => !suppressedVendorIds.has(v.id)) : bench

  const { data: txns } = await supabase.from("transactions")
    .select("id, deal_name, property_address, stage, agent_id, buyer_contact_id, contact_id")
    .eq("brokerage_id", brokerageId).in("stage", ACTIVE_STAGES).limit(200)

  for (const t of (txns ?? []) as any[]) {
    result.scanned += 1
    try {
      const coverage = await loadCoverage(supabase, t.id, stagingEnabled)
      const gap = vendorGapForStage(t.stage, coverage)
      if (!gap) {
        // Report metric: a stager WOULD have been the gap had staging been enabled — i.e.
        // the deal's deal-critical vendors are covered and staging is off + uncovered.
        if (!stagingEnabled && !coverage.hasStager && vendorGapForStage(t.stage, { ...coverage, stagingEnabled: true })?.category === "Stager") {
          result.stagingSkipped += 1
        }
        continue
      }

      // Idempotency — one proposal per (transaction, service_type).
      const ratPrefix = `VENDOR ORCH — ${gap.serviceType}`
      const { data: existing } = await supabase.from("agent_client_messages").select("id")
        .eq("brokerage_id", brokerageId).eq("entity_type", "transaction").eq("entity_id", t.id)
        .ilike("rationale", `${ratPrefix}%`).limit(1).maybeSingle()
      if (existing) continue

      // OUTCOME-AWARE, PREFERENCE-FIRST pick — the broker's preferred vendors win over a higher-rated
      // non-preferred one, but a PROVEN SLA breacher is demoted below reliable vendors regardless.
      const vendor = pickVendorForGap(eligibleBench, gap, { preferredVendorIds, slaByVendor })
      if (!vendor) { result.benchMisses += 1; continue }

      // PERSONA-AWARE COPY — the quote-request body is generated to the vendor persona,
      // with the deterministic fallback guaranteeing real copy.
      const fallback = composeQuoteRequestFallback({
        vendorName: vendor.name, gap, propertyAddress: t.property_address ?? null, dealName: t.deal_name ?? null,
      })
      const { generatePersonaCopy } = await import("@/lib/kernel/ai-copy")
      const facts = [
        `Vendor: ${vendor.name}`,
        `Service needed: ${gap.label}`,
        t.property_address ? `Property: ${t.property_address}` : "Property address on file",
        t.deal_name ? `Deal: ${t.deal_name}` : "An active transaction",
        "We are requesting a quote and availability; booking happens on confirmation",
      ]
      const copy = await generatePersonaCopy(
        {
          goal: `a quote-and-availability request to a ${gap.category} vendor for ${gap.label}`,
          facts, channel: "email",
          persona: { name: vendor.name, audience: "vendor", situation: `${gap.category} on a real-estate deal`, tone: "professional, concise, courteous" },
          words: 70,
        },
        fallback,
        { generator: opts.copyGenerator },
      )

      // GATED PROPOSAL — internal draft to the agent. Nothing auto-books (vendor_bookings
      // has no pending state; agent_client_messages is the canonical gated rail). The
      // approved draft becomes the quote-request the agent sends, then the existing
      // booking mechanics (vendor-quote-workflow / ai-vendor-management) take over.
      const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
      const res = await proposeClientMessage({
        brokerageId,
        agentKind: "deal_coordinator",
        entityType: "transaction",
        entityId: t.id,
        audience: "agent",
        subject: `Book ${gap.label} — ${vendor.name} for ${t.deal_name ?? "this deal"} (${stageLabel(t.stage)})`,
        body: copy.body,
        rationale: `${ratPrefix} — bench pick ${vendor.name}${vendor.rating != null ? ` (rating ${vendor.rating})` : ""} for the ${gap.label} gap at stage ${t.stage}; preference-first ranked; staging is settings-optional. Approve to send the quote request; nothing auto-books.`,
        channel: "portal",
      }, supabase)
      if (res.ok) result.proposed += 1
      else if (res.error) result.errors.push(`${t.id}: ${res.error}`)
    } catch (e: any) {
      result.errors.push(`${t.id}: ${e?.message ?? String(e)}`)
    }
  }

  return result
}

function stageLabel(stage: string | null): string {
  return (stage ?? "ACTIVE").replace(/_/g, " ").toLowerCase()
}

/**
 * Read the brokerage's staging-enabled setting. Investigated the live schema: there is NO
 * dedicated "staging enabled" column anywhere. brokerage_settings.settings is a jsonb bag
 * (default '{}') — the canonical place for such a flag. We read settings->>'staging_enabled'
 * (also accepting 'staging' for forward-compat). DEFAULT OFF when the row or flag is absent.
 */
export async function readStagingEnabled(supabase: Svc, brokerageId: string): Promise<boolean> {
  try {
    const { data } = await supabase.from("brokerage_settings")
      .select("settings").eq("brokerage_id", brokerageId).maybeSingle()
    const s = (data as { settings?: Record<string, unknown> } | null)?.settings ?? {}
    const flag = (s as any).staging_enabled ?? (s as any).staging
    return flag === true || flag === "true" || flag === 1
  } catch {
    return false
  }
}

/**
 * Load what the deal already has covered. Inspector → transaction_inspections (or a
 * vendor_booking with an inspection service_type); Lender → transaction_lenders;
 * Title/Stager → vendor_bookings by service_type (the canonical booking rail).
 */
export async function loadCoverage(supabase: Svc, transactionId: string, stagingEnabled: boolean): Promise<DealCoverage> {
  const [insp, lend, bookings] = await Promise.all([
    supabase.from("transaction_inspections").select("id").eq("transaction_id", transactionId)
      .neq("status", "cancelled").limit(1).maybeSingle(),
    supabase.from("transaction_lenders").select("id").eq("transaction_id", transactionId).limit(1).maybeSingle(),
    supabase.from("vendor_bookings").select("service_type, status").eq("transaction_id", transactionId)
      .neq("status", "cancelled").limit(100),
  ])
  const svc = new Set(((bookings.data ?? []) as Array<{ service_type: string }>).map((b) => (b.service_type ?? "").toLowerCase()))
  const hasService = (...keys: string[]) => keys.some((k) => svc.has(k))
  return {
    hasInspection: !!insp.data || hasService("inspection", "home_inspection"),
    hasLender: !!lend.data || hasService("lending", "lender"),
    hasTitle: hasService("title_escrow", "title", "escrow"),
    hasStager: hasService("staging", "stager"),
    stagingEnabled,
  }
}
