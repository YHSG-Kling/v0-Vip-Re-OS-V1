/**
 * lib/listings/listing-compliance-loop.ts
 *
 * THE COMPLIANCE GATE'S TWO ARMS, CLOSED INTO A LOOP THE OS RUNS ON ITS OWN.
 *
 * Owner's ruling, verbatim (2026-09-05):
 *
 *   "after compliance gate, it either passes or fails and if fails, the
 *    compliance officer, tc or agent goes and gets the missing document and/or
 *    initials/signatures to upload so compliance can run again. if the
 *    compliance passes, then the listing is marked coming soon with coming
 *    soon/prelisting prep"
 *
 * Together with the two rulings before it — "the listing signed is part of the
 * gate to start compliance" and "if passed then the status is coming soon prep"
 * — that is a loop with a start, two arms, and a re-entry:
 *
 *      executed listing agreement  →  listing_signed   (compliance STARTS)
 *                │
 *                ▼
 *      assertListingActivationAllowed  (the ONE gate — never re-derived here)
 *                │
 *        ┌───────┴────────┐
 *      FAIL              PASS
 *        │                │
 *   name what is       walk the stage machine one hop at a time to
 *   missing — docs,    COMING_SOON_PREP, whose gated status is
 *   signatures,        coming_soon (listing-status-sync.ts)
 *   initials, apart —
 *   to tc + compliance
 *   officer + agent
 *        │
 *   they upload  →  scanUploadedDocument  →  RE-ENTER HERE  ─┘
 *
 * ── WHAT EXISTED, AND WHY THIS IS A BUILD RATHER THAN A MERGE (§1.2) ─────────
 *
 * Every piece of the loop existed as a PART, and nothing joined them:
 *   · the gate: lib/listings/listing-activation-gate.ts (four obligations,
 *     refusals that name documents, signatures and initials separately);
 *   · the fail-arm audience: notifyComplianceFlag already fans out to every
 *     `tc` and `compliance_officer` in the brokerage plus the acting agent —
 *     exactly the three roles the owner names;
 *   · the re-run trigger: scanUploadedDocument already re-runs the DOCUMENT gate
 *     (runListingAgreementGate) on every upload and records blockers on the
 *     document — and then stopped, never asking the listing gate and never
 *     moving the listing;
 *   · the pass arm: the gated map already hands `coming_soon` to
 *     COMING_SOON_PREP — but nothing ever transitioned a listing there on a
 *     pass; the only two writers of that stage are HUMAN actions in the
 *     execution engine, entered from REPAIRS_IN_PROGRESS and MEDIA_APPROVED.
 *   · the refusal at the MLS door (activateMLS, launchListing) returned its
 *     reason to the CALLER and told nobody else.
 * So: one gate, one audience helper, one re-run seam, one status map — and this
 * module is the wire between them. It spells NO predicate of its own.
 *
 * ── THE STAGE MACHINE IS RESPECTED, ONE HOP AT A TIME ────────────────────────
 *
 * lib/kernel/lifecycle.ts::transitionLifecycle is the raw kernel write and does
 * NOT check allowedFrom. lifecycle-definitions.ts says COMING_SOON_PREP is
 * entered only from MLS_DATE_CONFIRMED, which is entered only from
 * LISTING_AGREEMENT_SIGNED. A pass therefore advances
 *   LISTING_AGREEMENT_SIGNED → MLS_DATE_CONFIRMED → COMING_SOON_PREP
 * and each hop is checked against getStageDefinition(target).allowedFrom before
 * it is written. The middle stage records a FACT — the MLS start date — so the
 * first hop is taken only when listings.go_live_date is already on the row
 * (markAgreementSigned computes it at signature). Without it the pass is
 * recorded and the agent is told what is left, and the loop does not invent a
 * date to satisfy a stage.
 *
 * The loop NEVER REGRESSES a listing. It only acts inside the window between
 * the executed agreement and coming-soon; any listing already past that window
 * is left exactly where it is, and says so.
 *
 * ── FAIL CLOSED, AND UNKNOWN IS NOT A FAILURE (§3, §4) ───────────────────────
 *
 * supabase-js RESOLVES refusals, so a gate that could not run
 * (detail.complianceState === "unknown", or a refused listing read) produces NO
 * status change, NO stage change, and NO "compliance failed" notification —
 * telling a TC to chase paperwork because a read timed out is the misdirecting
 * message §2 calls the most expensive pattern in this codebase. It is logged as
 * unknown and left for the next trigger.
 *
 * ── IDEMPOTENT ON THE FAIL ARM ───────────────────────────────────────────────
 *
 * Every upload re-enters the loop. Without dedupe, a listing missing three
 * documents would page the compliance officer on every unrelated upload for
 * weeks. The blocker set is hashed and kept on listings.metadata.compliance_gate;
 * the audience is notified only when the set CHANGES — a new blocker, or one
 * cleared. The current blockers are always written back, so the surface a human
 * opens shows the live list even when nobody was paged.
 */
import type { SupabaseClient } from "@supabase/supabase-js"
import { createHash } from "node:crypto"
import { getStageDefinition, type ListingStage } from "@/lib/listing-lifecycle/lifecycle-definitions"
import type { UnexecutedDocument } from "@/lib/listings/listing-activation-gate"

type ListingComplianceTrigger =
  | "agreement_executed"   // the executed agreement just landed — the loop's first run
  | "document_uploaded"    // a remediation upload — the loop's re-entry
  | "activation_refused"   // a human/autonomous MLS door was refused — tell the roles

type ListingComplianceOutcome =
  | "advanced"              // gate passed and the listing moved to COMING_SOON_PREP
  | "passed_awaiting_date"  // gate passed; MLS start date not on the row, so no stage hop
  | "blocked"               // gate refused; blockers recorded, audience told if the set changed
  | "outside_window"        // listing is not between agreement-signed and coming-soon; untouched
  | "unknown"               // the gate could not run; nothing changed, nothing claimed

interface ListingComplianceLoopResult {
  outcome:  ListingComplianceOutcome
  stage:    string | null
  /** What a TC/agent has to do. Empty on a pass. */
  blockers: string[]
  /** True only when notifyComplianceFlag was actually sent this run. */
  notified: boolean
  reason:   string | null
}

/** The window the loop governs. Derived from the stage machine, not typed twice. */
const WINDOW_START: ListingStage = "LISTING_AGREEMENT_SIGNED"
const WINDOW_MID:   ListingStage = "MLS_DATE_CONFIRMED"
const WINDOW_END:   ListingStage = "COMING_SOON_PREP"

function blockerHash(blockers: string[]): string {
  return createHash("sha256").update([...blockers].sort().join("\n")).digest("hex").slice(0, 16)
}

function allowedHop(from: string, to: ListingStage): boolean {
  const def = getStageDefinition(to)
  return !!def && (def.allowedFrom as readonly string[]).includes(from)
}

/**
 * Run one turn of the loop for a listing. Safe to call from any trigger, as often
 * as uploads arrive; it decides for itself whether anything should happen.
 */
export async function runListingComplianceLoop(
  supabase: SupabaseClient,
  params: {
    brokerageId: string
    listingId:   string
    trigger:     ListingComplianceTrigger
    /** users.id of the human who caused this run, or null for an autonomous one. */
    actorUserId?: string | null
  },
): Promise<ListingComplianceLoopResult> {
  const { brokerageId, listingId, trigger } = params

  // ── 1 · The listing, inside the tenant. A refused read is UNKNOWN, not "no listing". ──
  const { data: row, error: rowErr } = await supabase
    .from("listings")
    .select("id, lifecycle_stage, go_live_date, agent_id, metadata")
    .eq("id", listingId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (rowErr) {
    console.error(`[listing-compliance-loop] listing ${listingId} could not be read (${rowErr.message}); nothing changed`)
    return { outcome: "unknown", stage: null, blockers: [], notified: false, reason: `listing read refused: ${rowErr.message}` }
  }
  if (!row) return { outcome: "unknown", stage: null, blockers: [], notified: false, reason: "no such listing in this brokerage" }

  const stage = (row as { lifecycle_stage?: string | null }).lifecycle_stage ?? null
  const inWindow = stage === WINDOW_START || stage === WINDOW_MID
  // An MLS door refused OUTSIDE the window (activateMLS at MLS_READY, launchListing) still
  // owes the three roles the list of what is missing — that refusal used to reach only the
  // caller. So the fail arm runs for that trigger at any stage; the PASS arm never advances
  // from outside the window, because a listing at MLS_READY has already been through here.
  if (!inWindow && trigger !== "activation_refused") {
    return { outcome: "outside_window", stage, blockers: [], notified: false, reason: `stage ${stage ?? "(none)"} is not between ${WINDOW_START} and ${WINDOW_END}` }
  }

  // ── 2 · THE gate. Imported dynamically for the same reason lib/kernel/listings.ts does:
  //        it reaches a `server-only` module that the tsx guards cannot load.
  const { assertListingActivationAllowed } = await import("@/lib/listings/listing-activation-gate")
  const gate = await assertListingActivationAllowed(supabase, { brokerageId, listingId, door: `compliance loop (${trigger})` })

  const meta = ((row as { metadata?: Record<string, unknown> | null }).metadata ?? {}) as Record<string, unknown>
  const prior = (meta.compliance_gate ?? {}) as { blockers_hash?: string }

  // ── 3 · UNKNOWN: the gate could not run. Say so; change nothing; page nobody. ──
  if (gate.detail.complianceState === "unknown" && !gate.allowed) {
    console.error(`[listing-compliance-loop] listing ${listingId}: the gate could NOT run (${gate.reason}). This is not "compliance failed" and nobody is being asked to chase paperwork for it`)
    return { outcome: "unknown", stage, blockers: [], notified: false, reason: gate.reason }
  }

  // ── 4 · FAIL arm: name the work, tell the three roles, but only when the work changed. ──
  if (!gate.allowed) {
    const blockers: string[] = [
      ...gate.detail.missingRequired.map((d: string) => `missing document: ${d}`),
      ...gate.detail.unexecuted.flatMap((u: UnexecutedDocument) => [
        ...u.missingSignatures.map((s: string) => `${u.label}: ${s} not signed`),
        ...u.missingInitials.map((i: string) => `${u.label}: ${i} not initialed`),
      ]),
    ]
    if (blockers.length === 0) blockers.push(...gate.refusals.map((r: { message: string }) => r.message))
    const hash = blockerHash(blockers)
    const changed = prior.blockers_hash !== hash

    let notified = false
    if (changed) {
      const listingAgentUserId = await resolveListingAgentUserId(supabase, (row as { agent_id?: string | null }).agent_id ?? null)
      const { notifyComplianceFlag } = await import("@/lib/notifications/notify-helpers")
      const sent = await notifyComplianceFlag(supabase, {
        brokerageId,
        agentUserId: params.actorUserId ?? listingAgentUserId,
        alsoNotifyUserIds: [listingAgentUserId],
        flag: {
          type:       "compliance.listing_gate_blocked",
          severity:   "high",
          title:      `Listing compliance blocked — ${blockers.length} item${blockers.length === 1 ? "" : "s"} to fix, then it re-runs on upload`,
          body:       blockers.join("\n"),
          // ComplianceFlag.entityType admits offer | transaction | document, not listing.
          // "document" + the listing id is the spelling markAgreementSigned already uses
          // for this exact flag family, so the bell deep-links the same way. Recorded as
          // a vocabulary gap rather than widened here.
          entityType: "document",
          entityId:   listingId,
        },
      })
      notified = sent.notified_count > 0
    }

    await writeGateState(supabase, listingId, brokerageId, meta, {
      state: "blocked", blockers, blockers_hash: hash, checked_at: new Date().toISOString(), trigger,
    })
    return { outcome: "blocked", stage, blockers, notified, reason: gate.reason }
  }

  // ── 5 · PASS arm: walk to COMING_SOON_PREP, one allowed hop at a time. ──
  if (!inWindow) {
    return { outcome: "outside_window", stage, blockers: [], notified: false, reason: `gate passed at ${stage}, which is past the window this loop advances` }
  }
  const { transitionLifecycle } = await import("@/lib/kernel/lifecycle")
  const { KernelEvent } = await import("@/lib/kernel/events")
  // inWindow === true above means stage is one of the two window stages, never null.
  let current: string = stage as string
  const hops: string[] = []

  if (current === WINDOW_START) {
    const goLive = (row as { go_live_date?: string | null }).go_live_date ?? null
    if (!goLive) {
      await writeGateState(supabase, listingId, brokerageId, meta, {
        state: "passed_awaiting_date", blockers: [], blockers_hash: blockerHash([]), checked_at: new Date().toISOString(), trigger,
      })
      return {
        outcome: "passed_awaiting_date", stage, blockers: [], notified: false,
        reason: "compliance passed; the MLS start date is not on the listing, so it stays at LISTING_AGREEMENT_SIGNED until one is set",
      }
    }
    if (!allowedHop(current, WINDOW_MID)) {
      return { outcome: "unknown", stage, blockers: [], notified: false, reason: `stage machine refuses ${current} → ${WINDOW_MID}` }
    }
    const r1 = await transitionLifecycle({
      brokerageId, entityType: "listing_stage_machine", entityId: listingId,
      fromState: current, toState: WINDOW_MID, actorUserId: params.actorUserId ?? null,
      eventType: KernelEvent.LISTING_STAGE_CHANGED,
      metadata: { source: "listing-compliance-loop", trigger, mls_start_date: goLive },
    }, supabase as any)
    if (!r1.success) {
      return { outcome: "unknown", stage, blockers: [], notified: false, reason: `transition to ${WINDOW_MID} refused: ${r1.error ?? "no reason"}` }
    }
    hops.push(WINDOW_MID); current = WINDOW_MID
  }

  if (!allowedHop(current, WINDOW_END)) {
    return { outcome: "unknown", stage: current, blockers: [], notified: false, reason: `stage machine refuses ${current} → ${WINDOW_END}` }
  }
  // transitionLifecycle resolves the gate VERDICT itself for the gated stage and stamps
  // `coming_soon` through the shared map — one authority, asked one more time rather
  // than trusted from a variable this function holds (§6).
  const r2 = await transitionLifecycle({
    brokerageId, entityType: "listing_stage_machine", entityId: listingId,
    fromState: current, toState: WINDOW_END, actorUserId: params.actorUserId ?? null,
    eventType: KernelEvent.LISTING_STAGE_CHANGED,
    metadata: { source: "listing-compliance-loop", trigger, compliance_evidence: gate.detail.complianceEvidence },
  }, supabase as any)
  if (!r2.success) {
    return { outcome: "unknown", stage: current, blockers: [], notified: false, reason: `transition to ${WINDOW_END} refused: ${r2.error ?? "no reason"}` }
  }
  hops.push(WINDOW_END)

  await writeGateState(supabase, listingId, brokerageId, meta, {
    state: "passed", blockers: [], blockers_hash: blockerHash([]), checked_at: new Date().toISOString(), trigger, advanced: hops,
  })
  return { outcome: "advanced", stage: WINDOW_END, blockers: [], notified: false, reason: null }
}

/** listings.agent_id is an agents.id; notifications want users.id. The two are DISJOINT (§3). */
async function resolveListingAgentUserId(supabase: SupabaseClient, agentId: string | null): Promise<string | null> {
  if (!agentId) return null
  const { data, error } = await supabase.from("agents").select("user_id").eq("id", agentId).maybeSingle()
  if (error) {
    console.error(`[listing-compliance-loop] agent ${agentId} user_id could not be read (${error.message}); the listing agent will not be on this notification`)
    return null
  }
  return (data as { user_id?: string | null } | null)?.user_id ?? null
}

async function writeGateState(
  supabase: SupabaseClient,
  listingId: string,
  brokerageId: string,
  meta: Record<string, unknown>,
  gateState: Record<string, unknown>,
): Promise<void> {
  // An UPDATE matching nothing also resolves (§3) — the tenant filter is on the write,
  // and the returned rows are counted so a refused or unmatched write is not silence.
  const { data, error } = await supabase
    .from("listings")
    .update({ metadata: { ...meta, compliance_gate: gateState }, updated_at: new Date().toISOString() })
    .eq("id", listingId)
    .eq("brokerage_id", brokerageId)
    .select("id")
  if (error) console.error(`[listing-compliance-loop] gate state for listing ${listingId} not recorded: ${error.message}`)
  else if (!data || data.length === 0) console.error(`[listing-compliance-loop] gate state for listing ${listingId} matched no row (wrong tenant?)`)
}
