// lib/vendors/appraiser-independence.ts
//
// ═══════════════════════════════════════════════════════════════════════════
// NOTHING MODEL-AUTHORED MAY REACH A LICENSED APPRAISER
// ═══════════════════════════════════════════════════════════════════════════
//
// OWNER RULING that created the need for this module, verbatim:
//
//   "an appraiser can be another vendor type and is state licensed."
//
// m554 obeyed it: `appraiser` is now a value of `vendors.category` and of
// `vendor_service_areas.trade_category`, and `vendor_trade_requires_state_license`
// gates it, so an appraiser cannot be booked in a state where they hold no
// current licence.
//
// THAT WIDENING HAS A COST AND THIS MODULE IS WHERE IT IS PAID. Until m554 an
// appraiser could only be reached through lib/kernel/appraiser-packet.ts, one
// module that enforces the rule below by construction. Benching appraisers
// created NEW routes to one — vendor messaging, vendor communications, vendor
// jobs, the vendor portal — and CLAUDE.md §5 governs every one of them:
//
//   "Anything reaching a licensed appraiser must not be model-authored."
//
// ── WHY THIS IS A REGULATORY CONSTRAINT AND NOT A STYLE PREFERENCE ───────────
//
// Appraiser independence rules exist to stop an interested party — a brokerage,
// a lender, an agent whose commission depends on the number — from communicating
// with an appraiser in a way that could influence the opinion of value. A model
// writing "a friendly note to the appraiser about 123 Main St", given a prompt
// that contains the listing and the deal, is exactly the pressure those rules
// forbid, and it is worse than a human doing it because nobody chose the words.
// lib/kernel/appraiser-packet.ts already reasons this way in its own header:
// it sources comparables from a provider rather than from an AI web search, and
// deliberately withholds our own value opinion from the packet, "because the
// appraiser independently forms the opinion of value under USPAP".
//
// ── THE ROUTE INVENTORY ──────────────────────────────────────────────────────
//
// Every path by which platform-originated content can reach a bench vendor was
// walked before m554 was applied. `APPRAISER_REACH_ROUTES` below is that walk,
// AS DATA, so the next reader inherits the finding instead of redoing it and so
// the guard can assert each named file still exists and still carries what the
// entry claims. Exactly one route was found to be model-authored and addressed
// to the vendor; it is gated by `modelAuthoredToVendorVerdict`, wired at
// app/actions/ai-vendor-management.ts :: coordinateVendors.
//
// ── WHAT THIS MODULE IS NOT ──────────────────────────────────────────────────
//
// It is not a content scanner. It does not read model output looking for
// influence; a scanner that passes 99 of 100 nudges is worse than no scanner
// because it licenses the practice. It decides ONE thing, before any model call:
// is an appraiser among the recipients of the thing about to be written? If so,
// the OS does not write it and says why, and a human writes it themselves.
//
// FAIL CLOSED (CLAUDE.md §4): a verdict that cannot be computed — because the
// vendor read was refused, so we do not know what trades are in the room —
// REFUSES. "Nobody checked" must never render as "checked and fine".

import {
  VENDOR_CATEGORY_APPRAISER,
  toVendorCategory,
  type VendorCategory,
} from "@/lib/kernel/vendor-categories"

// ─── The rule, spelled once ──────────────────────────────────────────────────

/** CLAUDE.md §5, in the words the refusals and the guard both read. */
export const APPRAISER_INDEPENDENCE_RULE =
  "Anything reaching a licensed appraiser must not be model-authored."

/** The category value, re-exported so a caller never hand-types the token. */
export const APPRAISER_VENDOR_CATEGORY: VendorCategory = VENDOR_CATEGORY_APPRAISER

/** PURE — is this trade the one §5 governs? Tolerant of the loose spellings
 *  `toVendorCategory` already normalises ("Appraiser", "appraiser"), because a
 *  gate that only recognises one casing is a gate that stops biting. */
export function isAppraiserTrade(category: string | null | undefined): boolean {
  return toVendorCategory(category) === APPRAISER_VENDOR_CATEGORY
}

/**
 * PURE — does this free-text label describe appraisal work?
 *
 * Needed because a coordination request can name a SERVICE ("appraisal") without
 * naming a vendor row, and the model would then write to an appraiser who has no
 * id here to check. Matching the word is coarse on purpose: over-refusing a
 * coordination plan costs an agent one manual message, while under-refusing puts
 * model-authored text in front of a licensed appraiser.
 *
 * Word-boundary anchored so "appraisal" matches and "reappraisalXYZ" does not
 * accidentally widen into unrelated tokens; case-insensitive because this is
 * free text a human typed into a form.
 */
export function labelNamesAppraisal(label: string | null | undefined): boolean {
  if (typeof label !== "string") return false
  return /\bapprais(al|als|er|ers|e|ed|ing)\b/i.test(label)
}

// ─── The verdict ─────────────────────────────────────────────────────────────

export type AppraiserReachRefusal =
  /** The vendor read was refused, so we cannot tell who is in the room. */
  | "vendor_read_refused"
  /** A named bench vendor in this request is an appraiser. */
  | "appraiser_named"
  /** No vendor named, but the request asks for appraisal work. */
  | "appraisal_service_named"

export interface ModelAuthoredToVendorFacts {
  /**
   * FALSE when the bench read that would say which trades are involved was
   * REFUSED or could not run. Distinct from "no vendors": a refused read must
   * never be scored as "no appraiser here", because the two have opposite fixes
   * and only one of them is safe.
   */
  resolved: boolean
  /** `vendors.category` for every bench row this request names. */
  vendorCategories: ReadonlyArray<string | null | undefined>
  /** Free-text service labels on the request — checked when no row is named. */
  serviceLabels?: ReadonlyArray<string | null | undefined>
}

export type AppraiserReachVerdict =
  | { ok: true }
  | { ok: false; reason: AppraiserReachRefusal; message: string }

const REFUSAL_TEXT: Record<AppraiserReachRefusal, string> = {
  vendor_read_refused:
    "Could not read which vendors this request involves, so it is refused rather than assumed appraiser-free. Please retry.",
  appraiser_named:
    "This request involves an appraiser. " +
    APPRAISER_INDEPENDENCE_RULE +
    " Remove the appraiser and write to them yourself — appraiser independence rules make a drafted-for-you message to an appraiser a compliance risk, not a convenience.",
  appraisal_service_named:
    "This request asks for appraisal work. " +
    APPRAISER_INDEPENDENCE_RULE +
    " Remove the appraisal line and arrange it directly — appraiser independence rules make a drafted-for-you message to an appraiser a compliance risk, not a convenience.",
}

/**
 * PURE — may the OS ask a model to write something addressed to these vendors?
 *
 * The order is deliberate: the thing that makes the question UNANSWERABLE is
 * checked before the things that answer it "no", so an operator is told "we could
 * not read your bench" rather than "there is an appraiser here".
 */
export function modelAuthoredToVendorVerdict(
  facts: ModelAuthoredToVendorFacts,
): AppraiserReachVerdict {
  if (!facts.resolved) return refuse("vendor_read_refused")
  if (facts.vendorCategories.some(isAppraiserTrade)) return refuse("appraiser_named")
  if ((facts.serviceLabels ?? []).some(labelNamesAppraisal)) {
    return refuse("appraisal_service_named")
  }
  return { ok: true }
}

function refuse(reason: AppraiserReachRefusal): AppraiserReachVerdict {
  return { ok: false, reason, message: REFUSAL_TEXT[reason] }
}

// ─── The walk, as data ───────────────────────────────────────────────────────

/** What a route carries by the time it lands in front of a vendor. */
export type ReachAuthorship =
  /** Fixed template + human-typed or enum-constrained fields. Safe under §5. */
  | "deterministic"
  /** A model wrote it. Unsafe under §5 the moment an appraiser can receive it. */
  | "model_authored"
  /** The vendor themselves wrote it; the platform originates nothing. */
  | "vendor_authored"

export interface AppraiserReachRoute {
  /** Where the content is produced. */
  file: string
  /** What it is, in one line. */
  what: string
  /** Does it actually put content in front of the vendor? */
  reachesVendor: boolean
  authorship: ReachAuthorship
  /** What was found, and — where it is gated — what gates it. */
  finding: string
}

/**
 * EVERY ROUTE WALKED, and what each was found to carry (2026-08-25, before m554
 * was applied). Recorded as data rather than prose so scripts/appraiser-bench-simulator.ts
 * can assert the named files still exist — a route inventory whose files have
 * moved is a stale audit that reads like a current one.
 *
 * DENOMINATOR AND METHOD, so the number means something (CLAUDE.md §2): the
 * candidate set was every module under app/ and lib/ that touches `vendors`,
 * `vendor_messages`, `vendor_jobs`, `vendor_bookings` or `vendor_requests`,
 * intersected with every module importing a model-call helper
 * (@/lib/ai/generate, @/lib/ai/models, generateText from "ai"), UNION every
 * module that emails or messages a vendor. Seven modules matched the
 * intersection; three of those never put their output in front of a vendor at
 * all and are recorded below as such rather than silently dropped.
 *
 * BLIND SPOTS, published beside the finding:
 *   · A human can paste anything into a free-text field. `vendor_assignments.notes`
 *     and `vendor_bookings.request_message` reach the vendor and are typed by a
 *     person; if that person pastes model output, no gate here sees it. That is a
 *     policy question, not a code one, and it is NOT claimed as covered.
 *   · This walk covers the platform's own surfaces. An integration or a webhook
 *     added later that writes a vendor-facing field is not covered until it is
 *     added here.
 */
export const APPRAISER_REACH_ROUTES: readonly AppraiserReachRoute[] = [
  {
    file: "app/actions/ai-vendor-management.ts",
    what: "coordinateVendors → communicationPlan.vendorMessages[] — messages a model writes ADDRESSED TO a named vendor, rendered with a Copy button in app/components/dashboard/listings/lifecycle/vendor-coordination-panel.tsx",
    reachesVendor: true,
    authorship: "model_authored",
    finding:
      "THE ONE VIOLATION FOUND. The prompt carries the listing address and the deal's services, and the model is asked for per-vendor messages — a model nudging an appraiser about a specific property is precisely what appraiser-independence rules forbid. GATED: the action now calls modelAuthoredToVendorVerdict BEFORE the model call and refuses, so no such text is ever produced (and no model spend is incurred producing it).",
  },
  {
    file: "app/actions/vendor-marketplace.ts",
    what: "assignVendorToTransaction → the auto-email to vendors.email announcing a new job",
    reachesVendor: true,
    authorship: "deterministic",
    finding:
      "SAFE, UNCHANGED. A literal HTML template; every interpolated value is a database fact (property address, close date, scheduled date) or the agent's own typed `notes`. The module imports no model-call helper on this path.",
  },
  {
    file: "lib/communications/vendor-communications.tsx",
    what: "sendVendorBookingConfirmation / sendVendorServiceReminder — the two functions that actually email a vendor",
    reachesVendor: true,
    authorship: "deterministic",
    finding:
      "SAFE, UNCHANGED. The module imports nothing from @/lib/ai and calls no model. Fixed templates over booking facts.",
  },
  {
    file: "lib/agents/vendor-loop-producer.ts",
    what: "buildVendorIntro / buildVendorReviewRequest — the vendor intro and review-request copy",
    reachesVendor: false,
    authorship: "deterministic",
    finding:
      "SAFE. Pure string builders, no model, and the recipient is the CLIENT (the copy reads 'I've arranged X for your Y'), not the vendor. Proposed into the human approval gate before it sends.",
  },
  {
    file: "app/actions/vendor-messages.ts",
    what: "sendVendorMessage — the vendor_messages lane",
    reachesVendor: false,
    authorship: "vendor_authored",
    finding:
      "SAFE. Direction is vendor → contact, body typed by the vendor. Nothing originates with the platform, so there is nothing for §5 to govern.",
  },
  {
    file: "app/actions/vendor-portal.ts",
    what: "sendVendorMessageToAgent, updateVendorJobStatus, addVendorJobNote — what the vendor writes from their own portal",
    reachesVendor: false,
    authorship: "vendor_authored",
    finding:
      "SAFE. Direction is vendor → agent. The portal's READ side shows vendor_jobs.job_title and agent_notes, whose writers (lib/kernel/vendors.ts and app/actions/vendor-marketplace.ts) build them from an assignment_type enum plus the agent's typed notes — no model output on either.",
  },
  {
    file: "app/api/internal/ai-note/route.ts",
    what: "save_note appends a model-POLISHED note onto vendor_bookings.notes when the caller's own role is 'vendor'",
    reachesVendor: true,
    authorship: "model_authored",
    finding:
      "EXAMINED, NOT GATED, and the reason is the direction. The vendor_id is taken from the CALLER'S OWN role grants (selectVendorId), so the only person who can write this field through this route is the appraiser themselves, about their own booking, from text they supplied. §5 governs what the brokerage sends TO an appraiser; it does not forbid an appraiser using an editor on their own note. IF THIS EVER BECOMES AGENT-TARGETABLE the ruling flips — the guard asserts the write stays keyed to the caller's own grant, so re-pointing it goes red.",
  },
  {
    file: "app/actions/ai-vendor-management.ts",
    what: "getVendorRecommendations / analyzeVendorPerformance — model output ABOUT vendors",
    reachesVendor: false,
    authorship: "model_authored",
    finding:
      "SAFE as written. Both return to the AGENT's screen and neither is addressed to, or delivered to, a vendor. Recorded rather than dropped so a later change that starts sending them is recognisable as a change of class.",
  },
  {
    file: "app/actions/ai-vendor-management.ts",
    what: "requestVendorReview — a model-drafted request for feedback on a completed job",
    reachesVendor: false,
    authorship: "model_authored",
    finding:
      "EXAMINED, NOT GATED. The recipient is the CLIENT, not the vendor: its deterministic sibling in lib/agents/vendor-loop-producer.ts spells the same message ('Now that your service with X is complete, I'd love a quick rating'), and the surface in app/components/transactions/VendorBookingSection.tsx renders it as a draft the agent copies. Gating a client-facing message would be over-gating, and m551 already records why an over-wide gate is not a safe gate: it is one that gets switched off.",
  },
] as const

/** The routes this walk found to be BOTH model-authored AND vendor-facing — the
 *  set that must be gated or explicitly ruled on. Derived, never hand-counted, so
 *  adding a route to the inventory cannot leave the number behind (CLAUDE.md §2:
 *  assert the rule and derive the number). */
export const MODEL_AUTHORED_VENDOR_FACING_ROUTES: readonly AppraiserReachRoute[] =
  APPRAISER_REACH_ROUTES.filter((r) => r.reachesVendor && r.authorship === "model_authored")
