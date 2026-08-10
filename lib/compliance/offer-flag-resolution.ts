// ─── OFFER COMPLIANCE-FLAG RESOLUTION — the half of the audit gate that closes ─
//
// THE OWNER'S RULING, which this module exists to finish:
//
//   "the audit gate is when the offer is accepted and all paperwork is submitted
//    to compliance to be sure all documents for the transaction are all present
//    and all signatures/initials are complete on both sides. if all are present,
//    then a transaction is created, if not, then the missing piece is sent to the
//    tc and agent to get it finished and resubmitted for approval."
//
// Step 4 was half built. `app/actions/buyer-offer/flag-compliance.ts` raised an
// `activities` row per miss with `status:'open'`, and NOTHING in `app/` or `lib/`
// ever moved that row off 'open'. So:
//   · the TC fixed the document, resubmitted, and the original flag stayed open;
//   · every resubmission minted a NEW row for the same still-missing item, so
//     duplicates stacked one per attempt;
//   · a PASSING resubmission cleared nothing, so the queue never returned to empty.
//
// ── WHICH LEDGER THIS IS (there are two, and they are not the same thing) ─────
// `compliance_flags` (the TABLE) is the content-moderation / Fair-Housing lane;
// it already has a lifecycle (flagged|reviewed|resolved|overridden), a reaper
// (lib/compliance/compliance-flag-reaper.ts) and a human resolution endpoint
// (app/api/compliance/flags/route.ts PATCH). That lane is NOT this one.
//
// THIS lane is the buyer-offer audit gate, and it lives in `activities`:
//   entity_type='offer' AND entity_id=<offers.id>
//   AND activity_type='buyer.offer.compliance.flagged'
// It had no lifecycle at all. That is the defect closed here.
//
// ── THE RESOLUTION ANCHOR, and why it is what it is ──────────────────────────
// "This same miss" is NOT any of the columns the row already carried:
//
//   · entity_id  — the OFFER. Every miss on one offer shares it, so resolving by
//                  entity_id alone closes unrelated flags. Too coarse.
//   · flagType   — six buckets. `analyzeFilledPacket` emits one
//                  `missing_signature` blocker PER unfilled signature field, so a
//                  three-form packet yields three flags of one type. Too coarse.
//   · documentId — the STAGED PACKET document. scan-offer-packet.ts resolves it
//                  with `.order("created_at",{ascending:false}).limit(1)`, i.e.
//                  the NEWEST staged doc. A resubmission that stages a fresh
//                  packet therefore gets a DIFFERENT documents.id for the SAME
//                  miss — putting it in the key would mint a new flag on every
//                  attempt, which is precisely the duplicate stacking being
//                  fixed. Deliberately excluded.
//
// What actually distinguishes one miss from another is the SUBJECT the raiser
// named, and `flagOfferCompliance` already requires it: `title`. For every shape
// `lib/workflow/intelligence/packet-analysis.ts:analyzeFilledPacket` produces,
// the title is a deterministic function of the miss's own identity:
//
//   `Form missing: ${formName}`                     → unique per form
//   `Field missing on ${formName}: ${fieldName}`    → unique per form+field
//   `Signature block missing on ${formName}`        → unique per form, and
//   `Initial block missing on ${formName}`            DELIBERATELY so: two
//       unfilled signature fields on one form are ONE piece of work for the TC
//       ("this form is not signed"), and the flag must stay open until NO
//       signature is missing on it. Collapsing them is correct, not lossy.
//
// So the anchor is:
//
//   FLAG KEY = normalize(flagType) :: "title:" normalize(title)
//
// scoped by (brokerage_id, entity_type='offer', entity_id, activity_type,
// status='open'). Normalization is lowercase + whitespace collapse ONLY — digits
// are NEVER stripped, because "page 3 initial" and "page 5 initial" are two
// different misses and merging them would close an unrelated flag.
//
// ── SOURCE, and why it is derived rather than passed ─────────────────────────
// A reconciling caller ("here is everything still outstanding — retire the rest")
// may only retire flags IT produced. A packet scan must never auto-close the
// ad-hoc flag a human typed into the offer toolbar.
//
// All three live callers of flagOfferCompliance were read to settle this:
//   · lib/workflow/intelligence/scan-offer-packet.ts:107 — passes
//     `documentId: doc.id` on EVERY dispatch, blockers and the warning summary.
//   · app/components/offer/offer-agent-actions.tsx:82   — passes no documentId.
//   · app/api/cron/em-receipt-watcher/route.ts:96       — passes no documentId.
// `documentId` present ⇔ the automated packet scan raised it. So the source is
// DERIVED, not accepted as a parameter — every export of a "use server" module is
// an RPC endpoint, and a caller-supplied source would let anyone tag their own
// manual flag as scanner-owned so the next scan silently retired it.
//
// ── RECURRENCE ───────────────────────────────────────────────────────────────
// Dedupe matches OPEN flags only. If a resolved miss comes back, a NEW flag is
// raised rather than the resolved row re-opened: the earlier resolution (who,
// when, why) is the audit trail of a fix that really happened, and overwriting it
// would erase it.
//
// PURE key/source helpers live at the top with no DB dependency, mirroring the
// split this directory already uses (compliance-flag-policy.ts pure ↔
// compliance-flag-reaper.ts live). The writer below takes an injectable client so
// scripts/offer-flag-loop-simulator.ts can drive it without credentials.

import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"

type Svc = ReturnType<typeof createServiceClient>

/** The activity_type every buyer-offer compliance flag is filed under. */
export const OFFER_COMPLIANCE_FLAG_EVENT = "buyer.offer.compliance.flagged"
/** The audit event written when one or more of those flags are cleared. */
export const OFFER_COMPLIANCE_RESOLVED_EVENT = "buyer.offer.compliance.resolved"

/** activities.status values this lane uses. The column is free-form varchar
 *  (verified against the live DB: no CHECK constraint on activities). */
export const FLAG_STATUS_OPEN = "open"
export const FLAG_STATUS_RESOLVED = "resolved"

/** Who raised it — see the SOURCE note in the header. */
export const FLAG_SOURCE_PACKET_SCAN = "packet_scan"
export const FLAG_SOURCE_MANUAL = "manual"

export interface ComplianceFlagSubject {
  /** FlagOfferComplianceParams["flagType"] — the taxonomy bucket. */
  flagType: string | null | undefined
  /** The raiser's own statement of WHICH miss this is. Required in practice. */
  title: string | null | undefined
}

/**
 * PURE — lowercase, collapse runs of whitespace, trim. Digits are preserved on
 * purpose: page numbers and field indices are part of a miss's identity.
 */
function normalizeSubjectPart(value: string | null | undefined): string {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim()
}

/**
 * PURE — the stable identity of one miss. Two raises of the same miss produce the
 * same key; two different misses never do. See the anchor note in the header for
 * why documentId and entity_id are excluded.
 */
export function complianceFlagKey(subject: ComplianceFlagSubject): string {
  const type = normalizeSubjectPart(subject.flagType) || "other"
  return `${type}::title:${normalizeSubjectPart(subject.title)}`
}

/**
 * PURE — which producer owns a flag, derived from whether the raiser named a
 * staged packet document. See the SOURCE note in the header for the call-site
 * evidence behind this. Module-private on purpose: it is DERIVED, never accepted
 * from a caller, so nothing outside this module may set it.
 */
function complianceFlagSource(documentId: string | null | undefined): string {
  return documentId ? FLAG_SOURCE_PACKET_SCAN : FLAG_SOURCE_MANUAL
}

/** An open flag row as this module reads it. */
interface OpenFlagRow {
  id: string
  brokerage_id: string | null
  title: string | null
  metadata: Record<string, any> | null
  created_at: string | null
}

/** PURE — the key of a stored row, recomputed for rows written before flag_key
 *  existed so legacy flags are still matchable. */
function keyOfRow(row: OpenFlagRow): string {
  const stored = row.metadata?.flag_key
  if (typeof stored === "string" && stored.length > 0) return stored
  return complianceFlagKey({ flagType: row.metadata?.flagType, title: row.title })
}

/** PURE — the source of a stored row, likewise recomputed for legacy rows. */
function sourceOfRow(row: OpenFlagRow): string {
  const stored = row.metadata?.source
  if (typeof stored === "string" && stored.length > 0) return stored
  return complianceFlagSource(row.metadata?.document_id)
}

// ─── THE RAISE SIDE — one row per MISS, not one per ATTEMPT ──────────────────

export interface RecordOfferComplianceFlagParams {
  /** offers.id */
  offerId: string
  /** TENANT, from the OFFER row. activities.brokerage_id is NOT NULL with no
   *  default — omitting it writes ZERO rows while reporting success. */
  brokerageId: string
  /** users.id of the raiser → activities.agent_user_id. */
  raiserUserId: string
  /** agents.id from offers.agent_id → activities.agent_id. DISJOINT id space
   *  from raiserUserId; the two are never crossed. */
  agentId: string | null
  contactId: string | null
  flagType: string
  severity: string
  title: string
  body?: string | null
  /** documents.id of the staged packet when the flag is packet-specific. Decides
   *  the flag's SOURCE and is deliberately NOT part of the flag key. */
  documentId?: string | null
  client?: Svc
}

export interface RecordOfferComplianceFlagResult {
  success: boolean
  /** The stable identity of the miss. */
  flag_key: string
  /** True when an already-open flag for the same miss was refreshed rather than
   *  a second one minted. */
  deduped: boolean
  /** How many stacked duplicates from earlier resubmissions were collapsed. */
  duplicates_collapsed: number
  error?: string
}

/**
 * Write (or refresh) the audit row for one compliance miss.
 *
 * UPSERT ON THE MISS, not append-on-attempt. Before this, every resubmission that
 * still hit the same miss inserted another `status:'open'` row and nothing could
 * ever close one, so the queue only grew.
 *
 * UPDATE rather than refuse-to-insert, decided on evidence:
 *   · a refusal would freeze the FIRST attempt's wording forever, while the
 *     scanner's body text carries the current reason a field is unfilled;
 *   · `reflag_count` / `last_reflagged_at` on the survivor is the only place the
 *     system records that a miss has now outlived N resubmissions — exactly the
 *     accountability the owner's "get it finished and resubmitted" step needs;
 *   · both options keep the queue count honest, so the audit value is the
 *     tie-break.
 *
 * SELF-HEALING: if earlier resubmissions already stacked duplicates of this miss,
 * the OLDEST is the survivor (it is the row the queue has been showing, and its
 * created_at is the true age of the outstanding work) and the rest are collapsed
 * to 'resolved' with a reason naming the survivor.
 *
 * A refused lookup is reported but does NOT suppress the write: supabase-js
 * resolves it, and a duplicate row is recoverable where a silently dropped flag
 * is not.
 */
export async function recordOfferComplianceFlag(
  params: RecordOfferComplianceFlagParams,
): Promise<RecordOfferComplianceFlagResult> {
  const {
    offerId, brokerageId, raiserUserId, agentId, contactId,
    flagType, severity, title, body, documentId,
  } = params

  const flagKey = complianceFlagKey({ flagType, title })
  const source = complianceFlagSource(documentId)
  const base = { flag_key: flagKey, deduped: false, duplicates_collapsed: 0 }

  if (!isValidUUID(offerId))     return { success: false, ...base, error: "Invalid offer ID" }
  if (!isValidUUID(brokerageId)) return { success: false, ...base, error: "Invalid brokerage ID" }

  const svc = params.client ?? createServiceClient()
  const now = new Date().toISOString()
  const priority = severity === "critical" || severity === "high" ? "high" : "medium"

  const { data: existingRows, error: existingError } = await svc
    .from("activities")
    .select("id, metadata, created_at")
    .eq("brokerage_id",  brokerageId)
    .eq("entity_type",   "offer")
    .eq("entity_id",     offerId)
    .eq("activity_type", OFFER_COMPLIANCE_FLAG_EVENT)
    .eq("status",        FLAG_STATUS_OPEN)
    .filter("metadata->>flag_key", "eq", flagKey)
    .order("created_at", { ascending: true })

  const lookupWarning = existingError
    ? `open-flag lookup failed (${existingError.message}) — fell through to insert`
    : null

  const rows = (existingRows ?? []) as Array<{ id: string; metadata: Record<string, any> | null }>
  const survivor = rows[0]

  const payloadMeta = {
    offer_id: offerId, flagType, severity,
    raised_by: raiserUserId, document_id: documentId ?? null,
    flag_key: flagKey, source,
  }

  if (survivor) {
    const priorCount = Number(survivor.metadata?.reflag_count ?? 0)
    const { error: refreshError } = await svc
      .from("activities")
      .update({
        // Refresh what the humans read. created_at is untouched, so "how long has
        // this been outstanding" stays true.
        title,
        description: body ?? title,
        priority,
        updated_at: now,
        notes: JSON.stringify({ ...payloadMeta, raised_at: now }),
        metadata: {
          ...(survivor.metadata ?? {}),
          ...payloadMeta,
          reflag_count: priorCount + 1,
          last_reflagged_at: now,
        },
      })
      .eq("id", survivor.id)
      .eq("brokerage_id", brokerageId)

    let collapsed = 0
    const failures: string[] = []
    if (refreshError) failures.push(`refresh: ${refreshError.message}`)

    for (const dup of rows.slice(1)) {
      const { error: collapseError } = await svc
        .from("activities")
        .update({
          status: FLAG_STATUS_RESOLVED,
          completed_at: now,
          updated_at: now,
          metadata: {
            ...(dup.metadata ?? {}),
            flag_key: flagKey,
            resolved_at: now,
            resolved_by: raiserUserId,
            resolution_reason: `Collapsed onto the surviving open flag ${survivor.id} — same miss, duplicate row minted by an earlier resubmission.`,
          },
        })
        .eq("id", dup.id)
        .eq("brokerage_id", brokerageId)
      if (collapseError) failures.push(`collapse ${dup.id}: ${collapseError.message}`)
      else collapsed++
    }

    return {
      success: failures.length === 0,
      flag_key: flagKey,
      deduped: true,
      duplicates_collapsed: collapsed,
      error: failures.length > 0 ? failures.join(" | ") : undefined,
    }
  }

  // THE KEY. This row already supplied the tenant but once omitted `entity_id`,
  // which is NULLABLE — so it inserted successfully and was then invisible to
  // every reader that asks "what has been flagged on THIS offer": the canonical
  // key is entity_type='offer' AND entity_id=<offers.id>.
  const { error: insertError } = await svc.from("activities").insert({
    brokerage_id:  brokerageId,
    agent_user_id: raiserUserId,
    agent_id:      agentId,
    contact_id:    contactId,
    entity_type:   "offer",
    entity_id:     offerId,
    activity_type: OFFER_COMPLIANCE_FLAG_EVENT,
    title,
    description:   body ?? title,
    notes:         JSON.stringify({ ...payloadMeta, raised_at: now }),
    metadata:      { ...payloadMeta, raised_at: now },
    status:        FLAG_STATUS_OPEN,
    priority,
  })

  if (insertError) {
    return { success: false, ...base, error: `${lookupWarning ? lookupWarning + "; " : ""}insert: ${insertError.message}` }
  }
  return { success: true, ...base, error: lookupWarning ?? undefined }
}

// ─── THE RESOLVE SIDE ────────────────────────────────────────────────────────

export interface ResolveOfferComplianceFlagsParams {
  /** offers.id — the entity_id every flag on this deal is keyed by. */
  offerId: string
  /** TENANT. Always supplied by the caller from the OFFER row, never guessed. */
  brokerageId: string
  /** users.id of whoever cleared it. Recorded on every row AND the audit event. */
  actorUserId: string
  /** Why it was cleared — recorded on every row AND the audit event. */
  reason: string
  /**
   * TARGETED mode: clear ONLY these flag keys. Anything else stays open.
   * Mutually exclusive with `retainKeys`.
   */
  flagKeys?: string[]
  /**
   * RECONCILING mode: clear every open flag EXCEPT these keys — i.e. the caller
   * passes what is STILL outstanding and everything else is, by construction, a
   * miss that has since been supplied. Mutually exclusive with `flagKeys`.
   * Pair it with `sources` so a producer only retires its own flags.
   */
  retainKeys?: string[]
  /** Restrict to flags raised by these sources (FLAG_SOURCE_*). */
  sources?: string[]
  /** Injectable for proofs. Defaults to the service client. */
  client?: Svc
}

export interface ResolveOfferComplianceFlagsResult {
  success: boolean
  /** How many open flags moved to 'resolved'. */
  resolved_count: number
  /** Their keys, so a caller can report exactly what it closed. */
  resolved_keys: string[]
  /** How many flags on this offer are STILL open afterwards. */
  still_open_count: number
  error?: string
}

/**
 * Close outstanding buyer-offer compliance flags, recording WHO and WHEN.
 *
 * Three modes, chosen by which filter is supplied:
 *   · neither `flagKeys` nor `retainKeys` — SWEEP. Every open flag on the offer
 *     is cleared. This is the passing-gate case: compliance has just verified
 *     every required document is present and every signature/initial complete, so
 *     nothing outstanding on this offer can still be true.
 *   · `flagKeys`  — TARGETED. Exactly those misses, nothing else.
 *   · `retainKeys` — RECONCILING. Everything except the misses still outstanding.
 *
 * FAILS CLOSED. supabase-js RESOLVES a refused query, so every read and every
 * write here destructures `error`. A resolution whose error was swallowed would
 * report the queue cleared while the flags were still open — the same class of
 * bug as never resolving them at all.
 *
 * Idempotent: a second call finds nothing open and returns resolved_count 0.
 */
export async function resolveOfferComplianceFlags(
  params: ResolveOfferComplianceFlagsParams,
): Promise<ResolveOfferComplianceFlagsResult> {
  const { offerId, brokerageId, actorUserId, reason, flagKeys, retainKeys, sources } = params
  const empty = { resolved_count: 0, resolved_keys: [] as string[], still_open_count: 0 }

  if (!isValidUUID(offerId)) return { success: false, ...empty, error: "Invalid offer ID" }
  if (!isValidUUID(brokerageId)) return { success: false, ...empty, error: "Invalid brokerage ID" }
  if (!isValidUUID(actorUserId)) return { success: false, ...empty, error: "Invalid actor ID" }
  if (flagKeys && retainKeys) {
    return { success: false, ...empty, error: "Pass flagKeys OR retainKeys, never both" }
  }

  const svc = params.client ?? createServiceClient()
  const now = new Date().toISOString()

  // THE ANCHOR QUERY. brokerage_id is included even though entity_id already
  // identifies the offer: a service-client write with RLS bypassed must carry its
  // own tenant scope, not inherit one.
  const { data: openRows, error: readError } = await svc
    .from("activities")
    .select("id, brokerage_id, title, metadata, created_at")
    .eq("brokerage_id", brokerageId)
    .eq("entity_type", "offer")
    .eq("entity_id", offerId)
    .eq("activity_type", OFFER_COMPLIANCE_FLAG_EVENT)
    .eq("status", FLAG_STATUS_OPEN)
    .order("created_at", { ascending: true })

  if (readError) {
    // An unreadable flag ledger is NOT an empty one. Pre-rollout these tables are
    // empty, so "nothing came back" can never be treated as health.
    return { success: false, ...empty, error: `Could not read the compliance flag ledger: ${readError.message}` }
  }

  const rows = (openRows ?? []) as OpenFlagRow[]
  const keySet = flagKeys ? new Set(flagKeys) : null
  const retainSet = retainKeys ? new Set(retainKeys) : null
  const sourceSet = sources ? new Set(sources) : null

  const targets: Array<{ row: OpenFlagRow; key: string }> = []
  for (const row of rows) {
    const key = keyOfRow(row)
    if (sourceSet && !sourceSet.has(sourceOfRow(row))) continue
    if (keySet && !keySet.has(key)) continue
    if (retainSet && retainSet.has(key)) continue
    targets.push({ row, key })
  }

  if (targets.length === 0) {
    return { success: true, ...empty, still_open_count: rows.length }
  }

  // Per-row so each carries its OWN merged metadata — the audit trail must say
  // who cleared THIS flag and when, not merely that the set shrank.
  const resolvedKeys: string[] = []
  const failures: string[] = []
  for (const { row, key } of targets) {
    const { error: updateError } = await svc
      .from("activities")
      .update({
        status: FLAG_STATUS_RESOLVED,
        completed_at: now,
        // activities has no updated_at trigger (verified live) — set it here or
        // the row's mtime lies about when it was cleared.
        updated_at: now,
        metadata: {
          ...(row.metadata ?? {}),
          flag_key: key,
          resolved_at: now,
          resolved_by: actorUserId,
          resolution_reason: reason,
        },
      })
      .eq("id", row.id)
      .eq("brokerage_id", brokerageId)

    if (updateError) failures.push(`${key}: ${updateError.message}`)
    else resolvedKeys.push(key)
  }

  // ONE audit event for the clearing itself, keyed the way every offer reader
  // requires (entity_type='offer' AND entity_id=<offers.id>). brokerage_id is NOT
  // NULL with no default — omitting it writes ZERO rows while reporting success.
  const { error: auditError } = await svc.from("activities").insert({
    brokerage_id: brokerageId,
    entity_type: "offer",
    entity_id: offerId,
    activity_type: OFFER_COMPLIANCE_RESOLVED_EVENT,
    // users-class only. activities.agent_id FKs agents(id) and is a DISJOINT id
    // space, so the actor is never crossed into it.
    agent_user_id: actorUserId,
    title: `${resolvedKeys.length} compliance flag${resolvedKeys.length === 1 ? "" : "s"} cleared`,
    description: reason,
    notes: JSON.stringify({ offer_id: offerId, resolved_keys: resolvedKeys, resolved_by: actorUserId, resolved_at: now, reason }),
    metadata: {
      offer_id: offerId,
      resolved_keys: resolvedKeys,
      resolved_count: resolvedKeys.length,
      resolved_by: actorUserId,
      resolved_at: now,
      reason,
    },
    status: "completed",
    priority: "medium",
  })
  if (auditError) failures.push(`audit event: ${auditError.message}`)

  const stillOpen = rows.length - resolvedKeys.length
  if (failures.length > 0) {
    return {
      success: false,
      resolved_count: resolvedKeys.length,
      resolved_keys: resolvedKeys,
      still_open_count: stillOpen,
      error: `Compliance flag resolution partially failed — ${failures.join(" | ")}`,
    }
  }

  return {
    success: true,
    resolved_count: resolvedKeys.length,
    resolved_keys: resolvedKeys,
    still_open_count: stillOpen,
  }
}
