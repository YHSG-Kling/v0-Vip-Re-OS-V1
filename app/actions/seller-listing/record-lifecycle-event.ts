"use server"

/**
 * app/actions/seller-listing/record-lifecycle-event.ts
 *
 * THE ONE DOOR the recording UI goes through.
 *
 * The twelve orphaned recorders in execution-engine.ts each take a different
 * shape. Rather than give the card twelve imports and twelve call signatures to
 * keep in step — the drift that put a hand-copied vocabulary in the required-docs
 * picker — the card sends {listingId, action, values} and this dispatches.
 *
 * It does NOT re-implement anything. Every branch calls the existing recorder,
 * which does its own kernel stage transition, activity write and lifecycle_event.
 * The tenant gate lives inside those recorders (identity from the session, the
 * listing must belong to it), so this file cannot widen scope either — it does
 * not accept a brokerageId at all.
 *
 * Two things it adds on top of dispatch, both about honesty:
 *   · the stage check, so a control that should not exist at this stage is
 *     refused server-side and not merely hidden client-side; and
 *   · required-field validation, because a recorder called with a missing field
 *     writes a row that says something happened without saying what.
 */

import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"
import {
  RECORDABLE_EVENTS,
  isRecordableFromStage,
  type RecordableAction,
} from "@/lib/listing-lifecycle/recordable-events"
import {
  recordSellerDecision,
  initiateListingAgreement,
  markAgreementSigned,
  markDripCompleted,
  recordPreListingRepair,
  markRepairCompleted,
  markRepairFailed,
  markMediaCaptured,
  markMLSReady,
  recordShowingCompleted,
  markUnderContract,
  cancelListing,
  markListingExpired,
} from "./execution-engine"

export interface RecordLifecycleEventResult {
  success: boolean
  error?: string
  /** Which required fields were missing, when that is why it was refused. */
  missing?: string[]
}

export async function recordLifecycleEventAction(input: {
  listingId: string
  action: RecordableAction
  values: Record<string, string | number | boolean | null | undefined>
}): Promise<RecordLifecycleEventResult> {
  const { listingId, action, values } = input
  if (!isValidUUID(listingId)) return { success: false, error: "invalid_listing_id" }

  const def = RECORDABLE_EVENTS[action]
  if (!def) return { success: false, error: "unknown_action" }

  // STAGE CHECK, SERVER SIDE. Hiding a control is a courtesy; refusing the call
  // is the rule. Read through the request-scoped client so RLS applies — a
  // listing the caller cannot see has no stage to check and is refused.
  const supabase = await createClient()
  const { data: listing } = await supabase
    .from("listings")
    .select("lifecycle_stage")
    .eq("id", listingId)
    .maybeSingle()
  if (!listing) return { success: false, error: "listing_not_found" }
  const stage = (listing.lifecycle_stage ?? "LEAD") as string
  if (!isRecordableFromStage(stage, action)) {
    return { success: false, error: `not_recordable_from_stage:${stage}` }
  }

  // REQUIRED FIELDS. A recorder called without them writes a row asserting that
  // something happened while omitting what — worse than no row at all.
  const missing = def.fields
    .filter((f) => f.required)
    .filter((f) => {
      const v = values?.[f.key]
      return v === undefined || v === null || (typeof v === "string" && v.trim() === "")
    })
    .map((f) => f.key)
  if (missing.length > 0) return { success: false, error: "missing_required_fields", missing }

  // Choice fields must hold a value the recorder actually accepts.
  for (const f of def.fields) {
    if (f.type !== "choice" || !f.options) continue
    const v = values?.[f.key]
    if (v == null || v === "") continue
    if (!f.options.includes(String(v))) {
      return { success: false, error: `invalid_value:${f.key}` }
    }
  }

  const str = (k: string) => (values?.[k] == null ? undefined : String(values[k]))
  const num = (k: string) => {
    const v = values?.[k]
    if (v == null || v === "") return undefined
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  const bool = (k: string) => values?.[k] === true || values?.[k] === "true"

  // Identity is deliberately NOT passed. Each recorder resolves it from the
  // session; supplying one here would reintroduce the caller-chosen tenant.
  switch (action) {
    case "recordSellerDecision":
      return recordSellerDecision({
        listingId,
        decision: str("decision") as "accepted" | "declined",
        reason: str("reason"),
      })
    case "initiateListingAgreement":
      return initiateListingAgreement({ listingId })
    case "markAgreementSigned":
      // Identity is NOT passed — the recorder resolves it from the session and
      // ignores any userId/brokerageId handed to it, which is what stops a caller
      // filing an agreement into someone else's brokerage.
      //
      // `sellerTransactionFee` is passed through as undefined when the agent left
      // it blank (num() returns undefined for "" and null), so the recorder writes
      // NULL — "no fee agreed" — rather than a negotiated 0.
      return markAgreementSigned({
        listingId,
        uploadMode: str("uploadMode") as "manual_upload" | "provider_pull",
        documentUrl: str("documentUrl"),
        providerRef: str("providerRef"),
        // Optional intake — blank passes undefined so the recorder writes NULL
        // ("not recorded"), never a fabricated name or date.
        documentName: str("documentName"),
        effectiveDate: str("effectiveDate"),
        commissionTerms: {
          listingRate: num("listingRate"),
          buyerRate: num("buyerRate"),
          // The state-form / seller-agreement TOTAL (owner ruling 2026-08-27).
          // Blank passes undefined, so the recorder derives it from the sides
          // (or writes NULL) — see resolveTotalCommissionRate.
          totalRate: num("totalRate"),
          sellerTransactionFee: num("sellerTransactionFee"),
        },
      })
    case "markDripCompleted":
      return markDripCompleted({ listingId })
    case "recordPreListingRepair":
      return recordPreListingRepair({
        listingId,
        repairType: str("repairType") as string,
        description: str("description") as string,
        vendorId: str("vendorId"),
      } as Parameters<typeof recordPreListingRepair>[0])
    case "markRepairCompleted":
      return markRepairCompleted({
        listingId, repairId: str("repairId") as string,
      })
    case "markRepairFailed":
      return markRepairFailed({
        listingId, repairId: str("repairId") as string, reason: str("reason") as string,
      })
    case "markMediaCaptured":
      return markMediaCaptured({
        listingId, photoCount: num("photoCount") ?? 0, hasVideo: bool("hasVideo"),
      })
    case "markMLSReady":
      return markMLSReady({ listingId })
    case "recordShowingCompleted":
      return recordShowingCompleted({
        listingId, showingId: str("showingId") as string, feedback: str("feedback"),
      })
    case "markUnderContract":
      return markUnderContract({ listingId })
    case "cancelListing":
      return cancelListing({ listingId, reason: str("reason") as string })
    case "markListingExpired":
      return markListingExpired({ listingId })
    default:
      return { success: false, error: "unhandled_action" }
  }
}
