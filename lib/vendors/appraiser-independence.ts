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
// current license.
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
function isAppraiserTrade(category: string | null | undefined): boolean {
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
function labelNamesAppraisal(label: string | null | undefined): boolean {
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
    // wave 155 (155B2 retired the uncalled duplicate in app/actions/vendor-marketplace.ts; survivor: lib/kernel/vendors.ts COMMAND 5,
    // reached through app/actions/vendors-kernel.ts) — repointed by lane 155K at the integrator's request.
    file: "lib/kernel/vendors.ts",
    what: "COMMAND 5 vendor assignment → the job notice to the assigned vendor",
    reachesVendor: true,
    authorship: "deterministic",
    finding:
      "SAFE, UNCHANGED CLASS. A fixed template; every interpolated value is a database fact (property address, close date, scheduled date) or the agent's own typed `notes`. No model-call helper on this path.",
  },
  {
    file: "lib/vendors/appraiser-independence.ts",
    what: "sendAppraiserPacket — the appraiser packet emailed to the appraiser the AGENT named (wave 155, lane 155K, directive K6)",
    reachesVendor: true,
    authorship: "deterministic",
    finding:
      "SAFE BY CONSTRUCTION. The email is buildAppraiserPacketEmail (a fixed template over the property label, the agent's and brokerage's names, the link's expiry and the agent's own typed note); the attachment is the packet PDF as a SHARE-GRANT link (purpose appraiser_packet, 7 days, re-read on every click) — never a stored link. appraiserPacketSendVerdict refuses a packet that carries ANY AI-web-search comparable (metadata.ai_sourced_comp_count > 0) or whose count is unknown, so no model-sourced row reaches the appraiser; the packet itself withholds our value opinion. Blind spot (published, as above): the agent's typed note could contain pasted model output.",
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
/** @proofSeam a DERIVED inventory of the routes that must be gated — the gates themselves run per route at runtime; the derivation exists so scripts/appraiser-bench-simulator.ts can assert every member is gated or explicitly ruled on (assert the rule, derive the number — §2). */
export const MODEL_AUTHORED_VENDOR_FACING_ROUTES: readonly AppraiserReachRoute[] =
  APPRAISER_REACH_ROUTES.filter((r) => r.reachesVendor && r.authorship === "model_authored")

// ═══════════════════════════════════════════════════════════════════════════
// THE GOVERNED APPRAISER-PACKET SEND (wave 155, lane 155K — directive K6)
// ═══════════════════════════════════════════════════════════════════════════
//
// MEASURED AT BASE d2d6468c: lib/kernel/appraiser-packet.ts composes the packet (generated_documents, document_type
// 'appraiser_packet', blob_url a docref:// reference) and puts it in the AGENT's task; lib/storage/signed-doc-url.ts already
// lists the share purpose `appraiser_packet` (7 days, generated_document rows) and the door honors it — but NO code minted that
// grant or sent anything: "the share link is proven at the door but has no sender" (wave 154 §14).
//
// THE SEND, end to end: the AGENT of the transaction (session seat; never under impersonation) names the recipient — a vendor on
// their bench whose category is appraiser, or an address they type AND confirm is the assigned appraiser (lender / AMC order) →
// appraiserPacketSendVerdict (PURE: tenant, type, transaction, recipient, and §5 — a packet with any AI-web-search comparable, or
// an unknown count, is REFUSED) → a share grant minted at send time (mintDocumentShareGrant, purpose appraiser_packet; the
// grant rides only in the outgoing body) → the deterministic template (buildAppraiserPacketEmail) → the ONE governed egress
// (lib/providers/dispatch.ts dispatchEmail, humanApproved, transactional) inside withActionLedger
// (transaction.appraiser_packet.send, idempotent per packet · recipient · day) → an activity on the deal (the reader).

/** The facts the PURE verdict needs; the sender reads them tenant-pinned. */
export interface AppraiserPacketSendFacts {
  packet: { brokerageId: string; transactionId: string | null; documentType: string | null; ref: string | null; aiSourcedCompCount: number | null } | null
  actor: { brokerageId: string; isTransactionAgent: boolean; impersonating: boolean }
  transactionId: string
  recipient:
    | { kind: "vendor"; email: string | null; category: string | null; status: string | null }
    | { kind: "typed"; email: string | null; confirmed: boolean }
}
export type AppraiserPacketSendVerdict = { ok: true; email: string } | { ok: false; reason: string; message: string }

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/**
 * PURE — may this packet go to this recipient now? Order: identity and scope first (who asks, which packet), then the
 * recipient, then §5. Every "no" names its fix. Never mints, never sends.
 */
export function appraiserPacketSendVerdict(f: AppraiserPacketSendFacts): AppraiserPacketSendVerdict {
  const no = (reason: string, message: string): AppraiserPacketSendVerdict => ({ ok: false, reason, message })
  if (f.actor.impersonating) return no("impersonating", "Sending to an appraiser is the agent's own act, so it cannot be done while viewing another account.")
  if (!f.actor.isTransactionAgent) return no("not_transaction_agent", "Only the agent on this transaction can send its appraiser packet.")
  const p = f.packet
  if (!p || p.brokerageId !== f.actor.brokerageId) return no("packet_not_found", "That appraiser packet is not in your brokerage.")
  if (p.documentType !== "appraiser_packet") return no("not_an_appraiser_packet", "Only an appraiser packet can be sent this way.")
  if (p.transactionId !== f.transactionId) return no("packet_other_transaction", "That packet belongs to a different transaction.")
  if (!p.ref || !p.ref.startsWith("docref://")) return no("no_private_reference", "The packet has no private document reference to share — regenerate it from the appraisal milestone.")
  const r = f.recipient
  const email = String(r.email ?? "").trim().toLowerCase()
  if (!EMAIL_SHAPE.test(email)) return no("no_recipient_email", "Enter the appraiser's email address.")
  if (r.kind === "vendor") {
    if (!isAppraiserTrade(r.category)) return no("vendor_not_appraiser", "That vendor is not an appraiser on your bench — the packet goes only to the appraiser.")
    if (r.status != null && r.status !== "active") return no("vendor_not_active", "That appraiser is not active on your bench.")
  } else if (!r.confirmed) {
    return no("recipient_unconfirmed", `Confirm that ${email} is the appraiser assigned to this order before it is sent.`)
  }
  // §5: comparables an AI web search located are model-sourced. Unknown is not zero — fail closed.
  if (p.aiSourcedCompCount == null) return no("comp_sourcing_unknown", `${APPRAISER_INDEPENDENCE_RULE} This packet does not record how its comparables were sourced — regenerate it before sending.`)
  if (p.aiSourcedCompCount > 0) return no("ai_sourced_comps", `${APPRAISER_INDEPENDENCE_RULE} ${p.aiSourcedCompCount} comparable row(s) in this packet came from an AI web search — regenerate it once a provider or IDX record covers them, or hand the appraiser your own verified comparables.`)
  return { ok: true, email }
}

/** PURE — the fixed template. Every value is a database fact or the agent's own typed note; nothing here is model-authored. */
export function buildAppraiserPacketEmail(i: { propertyLabel: string; agentName: string; brokerageName: string | null; url: string; expiresAt: string; note: string | null }): { subject: string; html: string; text: string } {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  const until = i.expiresAt.slice(0, 10)
  const from = `${i.agentName}${i.brokerageName ? `, ${i.brokerageName}` : ""}`
  const note = (i.note ?? "").trim().slice(0, 1000)
  const subject = `Appraisal information packet — ${i.propertyLabel}`
  const text = [
    `Hello,`, ``,
    `${from} has shared the property information packet for ${i.propertyLabel} for your appraisal. It contains the documents and facts on file (contract, upgrades, comparable sales with their sources); it does not contain any opinion of value.`,
    ...(note ? [``, `Note from the agent: ${note}`] : []),
    ``, `Open the packet (secure link, valid until ${until}): ${i.url}`, ``, `— ${from}`,
  ].join("\n")
  const html = `<p>Hello,</p><p>${esc(from)} has shared the property information packet for <strong>${esc(i.propertyLabel)}</strong> for your appraisal. It contains the documents and facts on file (contract, upgrades, comparable sales with their sources); it does not contain any opinion of value.</p>${note ? `<p>Note from the agent: ${esc(note)}</p>` : ""}<p><a href="${esc(i.url)}">Open the packet</a> (secure link, valid until ${esc(until)}).</p><p>— ${esc(from)}</p>`
  return { subject, html, text }
}

type SendDb = { from: (t: string) => any }
export interface AppraiserPacketSendDeps {
  /** @proofSeam the share-grant sealer — production: lib/security/secret-crypto.ts { encryptSecret, decryptSecret, isEncrypted }. */
  sealer?: { seal: (plain: string) => string; open: (sealed: string) => string | null; isSealed: (v: string) => boolean }
  /** @proofSeam the ONE governed egress — production: dispatchEmail (lib/providers/dispatch.ts). Counted by the proofs. */
  dispatch?: (a: Record<string, unknown>) => Promise<{ success: boolean; error?: string; messageId?: string | null }>
  /** @proofSeam the action ledger — production: withActionLedger (lib/kernel/action-ledger.ts). */
  ledger?: <T>(ctx: { brokerageId: string; userId: string; key: string; detail: Record<string, unknown> }, run: () => Promise<T>, replay: (refused: boolean) => T) => Promise<T>
  origin?: string
  now?: Date
}
export type AppraiserPacketSendResult = { ok: true; deliveredTo: string; expiresAt: string; messageId: string | null } | { ok: false; reason: string; message: string }

/**
 * THE SENDER. `actor` comes from the SESSION (the caller's door); nothing here takes a tenant from input. Never throws.
 */
export async function sendAppraiserPacket(db: SendDb, actor: { userId: string; brokerageId: string; impersonating: boolean }, input: { transactionId: string; documentId: string; vendorId?: string | null; recipientEmail?: string | null; confirmRecipient?: boolean; note?: string | null }, deps: AppraiserPacketSendDeps = {}): Promise<AppraiserPacketSendResult> {
  const fail = (reason: string, message: string): AppraiserPacketSendResult => ({ ok: false, reason, message })
  try {
    const now = deps.now ?? new Date()
    const { data: tx, error: txErr } = await db.from("transactions").select("id, agent_id, property_address").eq("id", input.transactionId).eq("brokerage_id", actor.brokerageId).is("deleted_at", null).maybeSingle()
    if (txErr) return fail("transaction_unreadable", "The transaction could not be read — nothing was sent.")
    if (!tx) return fail("transaction_not_found", "That transaction is not in your brokerage.")
    // agents.id and users.id are disjoint (CLAUDE.md §3): the transaction's agent row, then its user.
    const { data: ag, error: agErr } = await db.from("agents").select("id, user_id").eq("id", (tx as { agent_id: string | null }).agent_id ?? "").eq("brokerage_id", actor.brokerageId).maybeSingle()
    if (agErr) return fail("agent_unreadable", "The transaction's agent could not be read — nothing was sent.")
    const isTransactionAgent = !!ag && (ag as { user_id: string | null }).user_id === actor.userId
    const { data: doc, error: docErr } = await db.from("generated_documents").select("id, brokerage_id, transaction_id, document_type, blob_url, metadata").eq("id", input.documentId).eq("brokerage_id", actor.brokerageId).maybeSingle()
    if (docErr) return fail("packet_unreadable", "The packet could not be read — nothing was sent.")
    const d = doc as { brokerage_id: string; transaction_id: string | null; document_type: string | null; blob_url: string | null; metadata: Record<string, unknown> | null } | null
    const ai = d?.metadata?.ai_sourced_comp_count
    let recipient: AppraiserPacketSendFacts["recipient"]
    if (input.vendorId) {
      const { data: v, error: vErr } = await db.from("vendors").select("id, email, category, status").eq("id", input.vendorId).eq("brokerage_id", actor.brokerageId).maybeSingle()
      if (vErr) return fail("vendor_unreadable", "Your bench could not be read — nothing was sent.")
      if (!v) return fail("vendor_not_found", "That appraiser is not on your bench.")
      const vr = v as { email: string | null; category: string | null; status: string | null }
      recipient = { kind: "vendor", email: vr.email, category: vr.category, status: vr.status }
    } else {
      recipient = { kind: "typed", email: input.recipientEmail ?? null, confirmed: input.confirmRecipient === true }
    }
    const verdict = appraiserPacketSendVerdict({
      packet: d ? { brokerageId: d.brokerage_id, transactionId: d.transaction_id, documentType: d.document_type, ref: d.blob_url, aiSourcedCompCount: typeof ai === "number" && Number.isFinite(ai) ? ai : null } : null,
      actor: { brokerageId: actor.brokerageId, isTransactionAgent, impersonating: actor.impersonating },
      transactionId: input.transactionId, recipient,
    })
    if (!verdict.ok) return verdict
    // The grant is minted at SEND time and rides only in this outgoing body (never stored).
    const doors = await import("@/lib/storage/signed-doc-url")
    const sealer = deps.sealer ?? await (async () => { const c = await import("@/lib/security/secret-crypto"); return { seal: c.encryptSecret, open: c.decryptSecret, isSealed: c.isEncrypted } })()
    const origin = deps.origin ?? (await import("@/lib/platform/site-url")).siteUrl()
    const grant = doors.mintDocumentShareGrant(sealer, { ref: d!.blob_url!, purpose: "appraiser_packet", brokerageId: actor.brokerageId, rowId: input.documentId, now })
    if (!grant.ok) return fail("grant_not_minted", `A secure link could not be created, so nothing was sent (${grant.reason}).`)
    const url = doors.documentShareUrl(d!.blob_url!, grant.grant, origin)
    if (!url) return fail("grant_not_minted", "A secure link could not be created, so nothing was sent.")
    const [{ data: u }, { data: b }] = await Promise.all([
      db.from("users").select("first_name, last_name").eq("id", actor.userId).maybeSingle(),
      db.from("brokerages").select("name").eq("id", actor.brokerageId).maybeSingle(),
    ])
    const agentName = [(u as { first_name?: string | null } | null)?.first_name, (u as { last_name?: string | null } | null)?.last_name].filter(Boolean).join(" ") || "The listing agent"
    const email = buildAppraiserPacketEmail({ propertyLabel: (tx as { property_address: string | null }).property_address ?? "the property", agentName, brokerageName: (b as { name?: string | null } | null)?.name ?? null, url, expiresAt: grant.expiresAt, note: input.note ?? null })
    const dispatch = deps.dispatch ?? (async (a: Record<string, unknown>) => (await import("@/lib/providers/dispatch")).dispatchEmail(a as never) as never)
    const key = `appraiser_packet_send:${input.documentId}:${verdict.email}:${now.toISOString().slice(0, 10)}`
    const ledger = deps.ledger ?? (async <T,>(c: { brokerageId: string; userId: string; key: string; detail: Record<string, unknown> }, run: () => Promise<T>, replay: (refused: boolean) => T): Promise<T> => {
      const { withActionLedger } = await import("@/lib/kernel/action-ledger")
      return withActionLedger(
        { brokerageId: c.brokerageId, action: "transaction.appraiser_packet.send", actor: { type: "user", userId: c.userId }, subject: { type: "generated_document", id: input.documentId }, idempotencyKey: c.key, riskClass: "COMMUNICATION", systemSource: "appraiser_packet_send", reasonCode: "HUMAN_REQUESTED", reasonDetail: "the transaction's agent sent the appraiser packet to the appraiser they named (deterministic template + share grant)", detail: c.detail } as never,
        run,
        { settle: (r: any) => ({ status: r?.ok ? ("executed" as const) : ("failed" as const), outcome: r?.ok ? "sent" : String(r?.reason ?? "refused") }), replay: (claim: any) => replay(claim.kind === "refused") } as never,
        { client: db as never },
      )
    })
    return await ledger({ brokerageId: actor.brokerageId, userId: actor.userId, key, detail: { transaction_id: input.transactionId, document_id: input.documentId, recipient_kind: recipient.kind, vendor_id: input.vendorId ?? null, grant_expires_at: grant.expiresAt, template: "appraiser_packet_v1" } }, async (): Promise<AppraiserPacketSendResult> => {
      const sent = await dispatch({
        brokerageId: actor.brokerageId, userId: actor.userId, to: verdict.email, subject: email.subject, html: email.html, text: email.text,
        channelPurpose: "transactional", sendAsAgentUserId: actor.userId, humanApproved: true, systemSource: "appraiser_packet_send",
        ledger: { reasonCode: "HUMAN_REQUESTED", reasonDetail: "appraiser packet sent by the transaction's agent to the appraiser they named" },
        metadata: { transaction_id: input.transactionId, document_id: input.documentId },
      })
      if (!sent.success) return fail("send_refused", `The email was not sent: ${sent.error ?? "the egress refused it"}`)
      // The reader: the deal's own activity feed shows who received the packet and until when the link opens.
      const { error: actErr } = await db.from("activities").insert({ brokerage_id: actor.brokerageId, agent_id: (tx as { agent_id: string | null }).agent_id, activity_type: "appraiser_packet_sent", title: "Appraiser packet sent", description: `Emailed to ${verdict.email} (${recipient.kind === "vendor" ? "appraiser on your bench" : "address you confirmed"}); secure link valid until ${grant.expiresAt.slice(0, 10)}`, metadata: { document_id: input.documentId, message_id: sent.messageId ?? null }, status: "completed", entity_type: "transaction", entity_id: input.transactionId })
      if (actErr) console.error(`[appraiser-packet-send] sent, but the deal activity was not written: ${actErr.message}`)
      return { ok: true, deliveredTo: verdict.email, expiresAt: grant.expiresAt, messageId: sent.messageId ?? null }
    }, (refused) => refused ? fail("ledger_refused", "The send could not be recorded, so nothing was sent.") : fail("already_sent_today", "This packet was already sent to that appraiser today."))
  } catch (e) {
    return fail("threw", `The packet was not sent: ${e instanceof Error ? e.message : String(e)}`)
  }
}
