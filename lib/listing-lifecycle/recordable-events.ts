/**
 * lib/listing-lifecycle/recordable-events.ts
 *
 * WHAT THE AGENT CAN RECORD, AT THE STAGE THEY ARE STANDING IN.
 *
 * app/actions/seller-listing/execution-engine.ts is the seller listing lifecycle:
 * twenty-three governed recorders that drive the kernel stage machine, write the
 * `activities` history the AI reads back as the relationship, and emit
 * lifecycle_events. Twelve of them had NO CALLER ANYWHERE — the repair loop, the
 * media capture, the showing feedback, the drip completion, the seller's decision,
 * the listing agreement kick-off, MLS readiness, and all three termination paths
 * (under contract, cancelled, expired). Several of the wired ones were reachable
 * ONLY by speaking to the voice assistant, never from a screen.
 *
 * Meanwhile the Pre-Listing Workflow panel showed the agent a progress bar it
 * GUESSED at: photography counted as done if some vendor booking's service_type
 * string contained "photo", and a step counted as done if some task title
 * contained a keyword. So the screen asserted things that had never been recorded,
 * and the recorders that would have made them true could not be reached.
 *
 * This module is the pure half: which events are recordable from a given stage,
 * what they are called in the agent's language, and what each one needs from them.
 * Pure so the mapping is testable without a database, and DERIVED FROM THE STAGE
 * so a new stage cannot quietly inherit the wrong controls.
 */

import type { ListingStage } from "./lifecycle-definitions"

/** The recorder each control invokes. Matches the export name in the engine. */
export type RecordableAction =
  | "recordSellerDecision"
  | "initiateListingAgreement"
  | "markAgreementSigned"
  | "markDripCompleted"
  | "recordPreListingRepair"
  | "markRepairCompleted"
  | "markRepairFailed"
  | "markMediaCaptured"
  | "markMLSReady"
  | "recordShowingCompleted"
  | "markUnderContract"
  | "cancelListing"
  | "markListingExpired"

export type RecordableFieldType = "text" | "number" | "boolean" | "longtext" | "choice"

export interface RecordableField {
  key: string
  label: string
  type: RecordableFieldType
  required: boolean
  /** For "choice" — the exact values the recorder accepts. */
  options?: string[]
  help?: string
}

export interface RecordableEvent {
  action: RecordableAction
  /** What the agent calls this, not what the function is called. */
  label: string
  /** One line saying what recording it actually does. */
  effect: string
  fields: RecordableField[]
  /**
   * TERMINAL events end the seller listing lifecycle (or hand it off). They are
   * separated in the UI and confirmed, because they are not undoable from here.
   */
  terminal?: boolean
}

/**
 * Every recordable event, keyed by action. The `fields` mirror the recorder's
 * required parameters — a control that collects the wrong shape produces a call
 * the server rejects, and supabase-js resolves rejections, so it would look like
 * it worked.
 */
export const RECORDABLE_EVENTS: Record<RecordableAction, RecordableEvent> = {
  recordSellerDecision: {
    action: "recordSellerDecision",
    label: "Seller gave their decision",
    effect: "Records whether the seller is listing with you, and moves the listing on that answer.",
    fields: [
      // The values are the RECORDER's vocabulary, not a friendlier one invented
      // here — a label the server does not accept is a write that fails silently.
      { key: "decision", label: "Decision", type: "choice", required: true, options: ["accepted", "declined"] },
      { key: "reason", label: "What they said", type: "longtext", required: false, help: "Their own words help the AI pick up the thread later." },
    ],
  },
  initiateListingAgreement: {
    action: "initiateListingAgreement",
    label: "Send the listing agreement",
    effect: "Starts the listing agreement for signature and records that it went out.",
    fields: [
    ],
  },
  /**
   * WAVE 14 — THE ORPHAN THAT HELD THE SELLER'S FEE.
   *
   * `markAgreementSigned` (app/actions/seller-listing/execution-engine.ts:536) is
   * the ONLY INSERT into `listing_agreements` anywhere in the tree — the dotloop
   * webhook and the e-sign finalizer only UPDATE rows it must already have
   * created — and it had NO CALLER. Its sibling `initiateListingAgreement` was
   * wired into this dispatcher and it was not, so the stage where an agreement is
   * out for signature (LISTING_AGREEMENT_INITIATED) offered nothing but
   * "cancelListing": an agent could send the agreement and had no way to record
   * that it came back signed.
   *
   * That orphan is why `listing_agreements.seller_transaction_fee` had six
   * readers and zero writers. The verdict under the orphan doctrine is BUILD, not
   * delete: nothing else creates a listing agreement, the recorder carries the
   * full compliance gate (auditListingDocuments + scanListingPacketCompleteness),
   * and deleting it would delete the only path onto the table.
   *
   * The seller fee is collected HERE because here is where it is agreed. It is
   * OPTIONAL and must stay optional — blank means no fee was negotiated, which is
   * written as NULL. A required box would push every brokerage that charges
   * nothing into typing 0, and 0 asserts a negotiated zero.
   */
  markAgreementSigned: {
    action: "markAgreementSigned",
    label: "Listing agreement came back signed",
    effect:
      "Files the executed listing agreement with its commission terms, runs the document + packet compliance gate, and moves the listing to go-live prep.",
    fields: [
      {
        key: "uploadMode", label: "How you have it", type: "choice", required: true,
        // The RECORDER's vocabulary, not a friendlier one — a value the server
        // does not accept is a write that fails while looking like it worked.
        options: ["manual_upload", "provider_pull"],
        help: "manual_upload = you have the signed PDF; provider_pull = it is in DocuSign/dotloop.",
      },
      { key: "documentUrl", label: "Signed document URL", type: "text", required: false, help: "For manual_upload." },
      { key: "providerRef", label: "Provider reference", type: "text", required: false, help: "For provider_pull — the envelope / loop id." },
      { key: "listingRate", label: "Listing side commission %", type: "number", required: false },
      { key: "buyerRate", label: "Buyer side commission %", type: "number", required: false },
      // Owner ruling (2026-08-27): "listing agreement total commission rate is
      // part of the agreement which is a state form and/or seller agreement" —
      // so the total is captured HERE, where the agreement's terms are filed.
      // OPTIONAL on purpose, in the shape the seven total_commission_rate
      // readers already speak (lib/commission/agreement-total-rate.ts): a
      // total-only agreement is entered with the side lines blank; when both
      // sides are entered the total is derived as their sum, and an entered
      // total that disagrees with the sides is REFUSED by the recorder.
      {
        key: "totalRate",
        label: "Total commission % (per the agreement)",
        type: "number",
        required: false,
        help: "The agreement's total line. Leave blank when you entered both sides — it is derived as their sum. Enter it alone for a total-only agreement.",
      },
      {
        key: "sellerTransactionFee",
        label: "Seller transaction fee ($)",
        type: "number",
        required: false,
        help: "Flat brokerage fee the SELLER pays at closing. Leave blank if none was agreed — every net sheet subtracts this from their proceeds.",
      },
    ],
  },
  markDripCompleted: {
    action: "markDripCompleted",
    label: "Pre-appointment drip finished",
    effect: "Records that the pre-listing drip ran its course before the appointment.",
    fields: [],
  },
  recordPreListingRepair: {
    action: "recordPreListingRepair",
    label: "Repair scheduled",
    effect: "Logs a pre-listing repair against the listing so the go-live gate knows it is outstanding.",
    fields: [
      { key: "repairType", label: "Repair", type: "text", required: true, help: "e.g. roof patch, interior paint" },
      { key: "description", label: "What needs doing", type: "longtext", required: true },
      { key: "vendorId", label: "Vendor", type: "text", required: false },
    ],
  },
  markRepairCompleted: {
    action: "markRepairCompleted",
    label: "Repair completed",
    effect: "Closes the repair out and clears it from the readiness gate.",
    fields: [
      { key: "repairId", label: "Repair", type: "text", required: true },
    ],
  },
  markRepairFailed: {
    action: "markRepairFailed",
    label: "Repair fell through",
    effect: "Records that a repair did not happen, and why — the listing stays blocked rather than quietly passing.",
    fields: [
      { key: "repairId", label: "Repair", type: "text", required: true },
      { key: "reason", label: "What happened", type: "longtext", required: true },
    ],
  },
  markMediaCaptured: {
    action: "markMediaCaptured",
    label: "Photos / video shot",
    effect: "Records the shoot actually happened and how much came back, and advances to media capture.",
    fields: [
      { key: "photoCount", label: "Photos delivered", type: "number", required: true },
      { key: "hasVideo", label: "Video included", type: "boolean", required: false },
    ],
  },
  markMLSReady: {
    action: "markMLSReady",
    label: "Ready for MLS",
    effect: "Records that the listing packet is complete and it can go to the MLS admin.",
    fields: [],
  },
  recordShowingCompleted: {
    action: "recordShowingCompleted",
    label: "Showing happened",
    effect: "Records the showing and the buyer-side feedback against the listing.",
    fields: [
      { key: "showingId", label: "Showing", type: "text", required: true },
      { key: "feedback", label: "Feedback", type: "longtext", required: false, help: "What the buyer's agent said — this feeds the seller's report." },
    ],
  },
  markUnderContract: {
    action: "markUnderContract",
    label: "Under contract",
    effect: "Ends the listing lifecycle and hands the deal to the transaction system.",
    fields: [],
    terminal: true,
  },
  cancelListing: {
    action: "cancelListing",
    label: "Listing cancelled",
    effect: "Closes the listing out as cancelled, with the reason on record.",
    fields: [
      { key: "reason", label: "Reason", type: "longtext", required: true },
    ],
    terminal: true,
  },
  markListingExpired: {
    action: "markListingExpired",
    label: "Listing expired",
    effect: "Records that the agreement ran out without a sale.",
    fields: [],
    terminal: true,
  },
}

/**
 * Stage → the events that can honestly be recorded from it.
 *
 * Read this as "what could have just happened, given where the listing is". A
 * showing cannot be recorded before the listing is exposed; a repair cannot be
 * completed before one was logged; the seller's decision belongs to the window
 * around the presentation, not after the agreement is signed.
 */
const STAGE_EVENTS: Partial<Record<ListingStage, RecordableAction[]>> = {
  PRESENTATION_DRIP_PREP:        ["markDripCompleted", "recordSellerDecision"],
  LISTING_PRESENTATION_CREATED:  ["recordSellerDecision"],
  PRESENTATION_VIDEO_GENERATED:  ["recordSellerDecision"],
  SELLER_DECISION:               ["recordSellerDecision", "initiateListingAgreement"],
  // The agreement is OUT for signature here, so "it came back signed" is exactly
  // what could have just happened — and until wave 14 this stage offered only
  // "cancel", which is why the sole writer of listing_agreements had no caller.
  LISTING_AGREEMENT_INITIATED:   ["markAgreementSigned", "cancelListing"],
  LISTING_AGREEMENT_SIGNED:      ["recordPreListingRepair", "cancelListing"],
  MLS_DATE_CONFIRMED:            ["recordPreListingRepair", "cancelListing"],
  COMING_SOON_PREP:              ["recordPreListingRepair", "markMediaCaptured", "cancelListing"],
  REPAIRS_IN_PROGRESS:           ["markRepairCompleted", "markRepairFailed", "recordPreListingRepair", "cancelListing"],
  COMING_SOON_ACTIVE:            ["markMediaCaptured", "recordShowingCompleted", "cancelListing"],
  MEDIA_CAPTURE:                 ["markMediaCaptured", "cancelListing"],
  MEDIA_APPROVED:                ["markMLSReady", "cancelListing"],
  MLS_READY:                     ["cancelListing"],
  OPEN_HOUSE_MARKETING:          ["recordShowingCompleted", "cancelListing"],
  MLS_ACTIVE:                    ["recordShowingCompleted", "markUnderContract", "cancelListing", "markListingExpired"],
  OPEN_HOUSE_EVENT:              ["recordShowingCompleted", "markUnderContract", "cancelListing", "markListingExpired"],
  SHOWINGS_ACTIVE:               ["recordShowingCompleted", "markUnderContract", "cancelListing", "markListingExpired"],
  OFFERS_RECEIVED:               ["recordShowingCompleted", "markUnderContract", "cancelListing", "markListingExpired"],
  NEGOTIATION:                   ["markUnderContract", "cancelListing", "markListingExpired"],
}

/** Events recordable from this stage, in display order (terminal ones last). */
export function recordableEventsForStage(stage: ListingStage | string): RecordableEvent[] {
  const actions = STAGE_EVENTS[stage as ListingStage] ?? []
  return actions
    .map((a) => RECORDABLE_EVENTS[a])
    .filter(Boolean)
    .sort((a, b) => Number(!!a.terminal) - Number(!!b.terminal))
}

/** Is this action honestly recordable from this stage? The server is still the authority. */
export function isRecordableFromStage(stage: ListingStage | string, action: RecordableAction): boolean {
  return (STAGE_EVENTS[stage as ListingStage] ?? []).includes(action)
}

/** Every action that appears somewhere in the stage map — used to prove none is stranded. */
export function allMappedActions(): RecordableAction[] {
  const seen = new Set<RecordableAction>()
  for (const list of Object.values(STAGE_EVENTS)) for (const a of list ?? []) seen.add(a)
  return Array.from(seen)
}
