// lib/platform/subscriber-door.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE SUBSCRIBER DOOR — what both entrances share (lane 79D, owner verbatim:
// "when a real estate subscriber wants to purchase the platform subscription
// there needs to be an easy way to convert a prospect to a subscriber or a new
// subscriber that isn't a prospect … agenticos using autonomous ai methodology
// with humans when warranted").
//
// The door itself already existed and is NOT restated here:
//   · the tenant is minted by lib/kernel/tenant-creation.ts::createTenantCore
//   · money is collected by lib/billing/subscription-activation.ts::
//     createActivationCheckout (trial = no card; paid = hosted checkout for the
//     plan + the tier's setup fee) and activated by app/api/billing/webhook
//     (checkout.session.completed → upsertBrokerageSubscription)
//   · a prospect converts through lib/platform/prospect-conversion.ts::
//     convertProspectToSubscriber (idempotent on converted_brokerage_id)
//   · the two entrances are app/actions/auth/signup-brokerage.ts (public,
//     self-serve, never-a-prospect OR a prospect who signs up on their own —
//     the core's stamp links them by email) and app/actions/superadmin/
//     platform-growth.ts::convertProspectToSubscriberAction + the prospect
//     tool bundle's start_subscription (sales-assisted: staff or the platform
//     AI sales rep, prefilled from the platform_prospects row).
//
// What was MISSING, and lives here so the two entrances cannot drift apart:
//
//   1. planSubscriberEntrance — the PURE routing rule for the self-serve
//      entrance. The seat count picks the band (tierForSeatCount over
//      TIER_SEAT_BANDS — lane 79A's ONE derivation; the numbers are never
//      restated here), and the humans-when-warranted rule is the SAME
//      conversionHumanReasons the prospect conversion uses. On the web form a
//      warranted reason splits two ways: enterprise size / custom pricing is
//      a COMMERCIAL decision (multi-location is custom-priced per seat — owner
//      2026-09-23), so the signer is routed to the SALES-ASSISTED path and no
//      tenant is minted until a person prices it; a CRM migration is white-
//      glove SERVICE, so the tenant is minted autonomously and the staff task
//      rides along (the same task the staff conversion raises).
//
//   2. salesAssistedIntake — the sales-assisted path for a self-serve signer
//      whose plan needs a person: the SAME prospect row every other surface
//      writes (upsertPlatformProspect, idempotent by email), the SAME open
//      handoff stamp (markProspectHandoff — silences the cold ladder while a
//      person works it), the SAME platform-staff bell, and the demo survivor
//      (/demo, requestPlatformDemoAction) offered as the "book a call" step.
//      From there the growth board's Convert-to-subscriber button is the
//      other entrance, prefilled from this row.
//
//   3. sendActivationCheckoutEmail — the ONE paid-activation checkout email.
//      It stood inline in lib/platform/prospect-agent-tools.ts::
//      start_subscription only; the self-serve door relied on a browser
//      redirect (blocked → "your account is reserved" and nothing in the
//      inbox, while the welcome bell promised "the checkout in your email")
//      and the staff convert door told the staffer to copy the URL by hand.
//      Merged here; every entrance sends it (TOMBSTONE in prospect-agent-tools).
//
//   4. SUBSCRIBER_ACTIVATED_PATH — the post-checkout landing every success
//      URL and email points at (/login?activated=1 — the notice itself is
//      lane 79A's).
//
// TENANT (CLAUDE.md §4): nothing here takes a brokerage id from a request.
// The tenant comes back from the core; the prospect id is the only id a
// sales-assisted intake returns. IDENTITY: a platform_prospects.id never
// flows into a contactId/leadId slot — dispatchEmail is called with neither.

import { tierForSeatCount, TIER_SEAT_BANDS, type CanonicalTierName } from "@/lib/billing/plan-catalog"
import { conversionHumanReasons, HUMAN_REASON_LABEL, type ConversionHumanReason } from "@/lib/platform/prospect-conversion"
import type { TenantBilling } from "@/lib/kernel/tenant-creation"

/** Where a paid activation lands after Stripe — lane 79A renders the notice. */
export const SUBSCRIBER_ACTIVATED_PATH = "/login?activated=1"
export const SUBSCRIBER_ACTIVATION_CANCELLED_PATH = "/login?activation=cancelled"

/** The public page where a sales-assisted signer books the call (the demo
 *  survivor: app/demo → requestPlatformDemoAction → the same prospect row). */
export const SALES_ASSISTED_BOOKING_PATH = "/demo"

/** Warranted reasons that mean "a person PRICES this before any tenant exists"
 *  (commercial). Every other reason is service the tenant gets AFTER it exists. */
export const COMMERCIAL_HUMAN_REASONS: readonly ConversionHumanReason[] = ["enterprise_size", "custom_pricing"]

export type SubscriberEntranceRoute = "self_serve" | "sales_assisted"

export interface SubscriberEntranceInput {
  /** The plan the signer picked, or null/'fit' to derive it from their seat count. */
  declaredTier?: string | null
  /** Producing (licensed) seats they run — staff never count (tier-role-matrix). */
  producerSeats?: number | null
  activation?: "trial" | "paid" | null
  billingCycle?: "monthly" | "annual" | null
  customPricingRequested?: boolean
  /** What they use today — a real CRM means a white-glove import. */
  currentTools?: string | null
  /** Honeypot field: a human never fills it. */
  honeypot?: string | null
}

export interface SubscriberEntrancePlan {
  route: SubscriberEntranceRoute
  tier: CanonicalTierName
  /** The band the tier carries (null = custom / unlimited) — from lane 79A's table. */
  seatBand: number | null
  producerSeats: number | null
  billing: TenantBilling
  humanReasons: ConversionHumanReason[]
  /** Reasons that forced the sales-assisted route (subset of humanReasons). */
  commercialReasons: ConversionHumanReason[]
  /** Why a person is involved, in the words the growth board uses. */
  humanReasonLabels: string[]
  /** True when the honeypot was filled — the caller refuses without provisioning or capturing. */
  bot: boolean
}

const CANONICAL: ReadonlySet<string> = new Set(Object.keys(TIER_SEAT_BANDS))

/** PURE: a seat count a human typed → a positive integer or null. */
export function normalizeProducerSeats(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null
  return Math.min(Math.round(n), 100_000)
}

/** PURE: the honeypot rule — any non-empty value is a bot. */
export function isHoneypotTripped(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0
}

/**
 * PURE: route a self-serve signer. The tier is the declared plan when it is
 * canonical, else the cheapest band that fits their producer seats (a
 * multi_location tier is reached only by declaration — it is a SHAPE, never a
 * count). The billing shape is the core's own TenantBilling; a self-serve
 * signer can never carry a setup-fee waiver (no field exists to pass one).
 */
export function planSubscriberEntrance(input: SubscriberEntranceInput): SubscriberEntrancePlan {
  const producerSeats = normalizeProducerSeats(input.producerSeats)
  const declared = (input.declaredTier ?? "").trim()
  const tier: CanonicalTierName = CANONICAL.has(declared) ? (declared as CanonicalTierName) : tierForSeatCount(producerSeats)
  const seatBand = TIER_SEAT_BANDS[tier]
  const humanReasons = conversionHumanReasons({
    tier, sizeSeats: producerSeats, currentTools: input.currentTools ?? null,
    customPricingRequested: input.customPricingRequested === true,
  })
  const commercialReasons = humanReasons.filter((r) => COMMERCIAL_HUMAN_REASONS.includes(r))
  const billing: TenantBilling = input.activation === "paid"
    ? { mode: "paid", billingCycle: input.billingCycle === "annual" ? "annual" : "monthly" }
    : { mode: "trial" }
  return {
    route: commercialReasons.length > 0 ? "sales_assisted" : "self_serve",
    tier, seatBand, producerSeats, billing,
    humanReasons, commercialReasons,
    humanReasonLabels: humanReasons.map((r) => HUMAN_REASON_LABEL[r]),
    bot: isHoneypotTripped(input.honeypot),
  }
}

// ── Sales-assisted intake (the self-serve form's human handoff) ──────────────

export interface SalesAssistedIntakeInput {
  email: string
  name: string
  company: string | null
  phone?: string | null
  tier: CanonicalTierName
  producerSeats: number | null
  currentTools?: string | null
  territory?: string | null
  activation: "trial" | "paid"
  humanReasons: ConversionHumanReason[]
  /** Channel attribution — 'get_started:sales_assisted' for the web form. */
  source: string
}

export type SalesAssistedIntakeResult =
  | { ok: true; prospectId: string; created: boolean; staffNotified: number; alreadySubscriber: false; bookingPath: string }
  | { ok: true; alreadySubscriber: true; prospectId: null }
  | { ok: false; error: string }

/** @proofSeam — production callers never pass this. */
export interface SalesAssistedDeps {
  upsertProspect?: (svc: any, input: Record<string, unknown>) => Promise<{ id: string; created: boolean } | null>
  markHandoff?: (svc: any, input: Record<string, unknown>) => Promise<boolean>
  notifyStaff?: (svc: any, n: { type: string; title: string; body: string; entityType?: string | null; entityId?: string | null; priority?: "low" | "medium" | "high" }) => Promise<number>
}

/**
 * A self-serve signer whose plan needs a person: capture them on the ONE
 * prospect rail, open the handoff, ring platform staff, and hand back the
 * booking path. IDEMPOTENT — upsertPlatformProspect keys on the email, so a
 * second submit merges onto the same row and a re-ring is the only side
 * effect. DEDUPE against tenants: an email that already owns a tenant is told
 * to sign in (the same rule the core enforces) — no prospect row is opened
 * for a live customer.
 */
export async function salesAssistedIntake(svc: any, input: SalesAssistedIntakeInput, deps: SalesAssistedDeps = {}): Promise<SalesAssistedIntakeResult> {
  const email = (input.email ?? "").trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "A valid work email is required — a person needs somewhere to reply." }
  if (!(input.name ?? "").trim()) return { ok: false, error: "Your name is required." }

  const { data: existingUser, error: existingErr } = await svc.from("users").select("id, brokerage_id").eq("email", email).maybeSingle()
  if (existingErr) return { ok: false, error: `Could not verify the email: ${existingErr.message}` }
  if ((existingUser as { brokerage_id?: string | null } | null)?.brokerage_id) return { ok: true, alreadySubscriber: true, prospectId: null }

  const labels = input.humanReasons.map((r) => HUMAN_REASON_LABEL[r])
  const reason = `Self-serve signup routed to sales: ${labels.join("; ") || "custom pricing"} — wanted ${input.tier.replace(/_/g, " ")}, ${input.activation === "paid" ? "ready to pay now" : "trial"}`

  const upsert = deps.upsertProspect ?? (async (client: any, i: Record<string, unknown>) => {
    const { upsertPlatformProspect } = await import("@/lib/platform/prospect-capture")
    return upsertPlatformProspect(client, i as never)
  })
  const saved = await upsert(svc, {
    email, phone: input.phone ?? null, name: input.name.trim(), company: input.company,
    roleInterest: input.tier, source: input.source, note: reason.slice(0, 600),
    qualification: {
      brokerage_name: input.company, size_seats: input.producerSeats,
      current_tools: input.currentTools ?? null, territory: input.territory ?? null,
    },
    detailsPatch: { sales_assisted: { requested_at: new Date().toISOString(), tier: input.tier, activation: input.activation, producer_seats: input.producerSeats, reasons: input.humanReasons } },
  })
  if (!saved) return { ok: false, error: "Could not save your details — please try again or book a call." }

  const notify = deps.notifyStaff ?? (async (client: any, n: Parameters<NonNullable<SalesAssistedDeps["notifyStaff"]>>[1]) => {
    const { notifyPlatformStaff } = await import("@/lib/notifications/platform-staff")
    return notifyPlatformStaff(client as never, n)
  })
  const staffNotified = await notify(svc, {
    type: "platform_prospect_handoff",
    title: "A signup needs a person to price it",
    body: `${input.name.trim()}${input.company ? ` (${input.company})` : ""} <${email}> tried to sign up for ${input.tier.replace(/_/g, " ")}${input.producerSeats ? ` with ${input.producerSeats} producing seats` : ""} and is ${input.activation === "paid" ? "ready to pay now" : "asking for a trial"}: ${labels.join("; ")}. Quote them, then Convert to subscriber from the growth board.`,
    entityType: "platform_prospect", entityId: saved.id, priority: "high",
  }).catch((e: unknown) => { console.warn("[subscriber-door] staff bell failed:", (e as Error)?.message); return 0 })

  const handoff = deps.markHandoff ?? (async (client: any, i: Record<string, unknown>) => {
    const { markProspectHandoff } = await import("@/lib/platform/prospect-capture")
    return markProspectHandoff(client, i as never)
  })
  await handoff(svc, { prospectId: saved.id, reason, bestTime: null, channel: input.source, staffNotified })

  return { ok: true, prospectId: saved.id, created: saved.created, staffNotified, alreadySubscriber: false, bookingPath: SALES_ASSISTED_BOOKING_PATH }
}

// ── The ONE paid-activation checkout email ───────────────────────────────────

export interface ActivationCheckoutEmailInput {
  to: string
  firstName: string
  brandName: string
  tier: string
  billingCycle: "monthly" | "annual"
  checkoutUrl: string
  setupFeeCents: number | null
  setupFeeWaived?: boolean
}

export type ActivationCheckoutEmailResult = { sent: true } | { sent: false; error: string }

/** @proofSeam — production callers never pass this. */
export interface ActivationEmailDeps {
  resolveRep?: (svc: any) => Promise<{ userId: string; brokerageId: string } | null>
  dispatch?: (params: Record<string, unknown>) => Promise<{ success: boolean; error?: string }>
}

/** PURE: the email copy — plan, cycle, the exact fee the checkout carries
 *  (never an invented number), the URL, and what happens after it clears. */
export function composeActivationCheckoutEmail(i: Omit<ActivationCheckoutEmailInput, "to">): { subject: string; html: string; text: string } {
  const fee = i.setupFeeWaived ? "the setup fee is waived" : (i.setupFeeCents && i.setupFeeCents > 0 ? `plus a one-time $${(i.setupFeeCents / 100).toLocaleString("en-US")} setup fee` : "this plan lists no setup fee")
  const plan = `${i.tier.replace(/_/g, " ")} plan, billed ${i.billingCycle}`
  return {
    subject: `Activate your ${i.brandName} ${i.tier.replace(/_/g, " ")} plan`,
    html: `<p>Hi ${i.firstName},</p><p>Your ${i.brandName} account is reserved. Complete your activation here — the ${plan} (${fee}): <a href="${i.checkoutUrl}">${i.checkoutUrl}</a></p><p>Your sign-in link arrives separately. When the checkout clears you land on your sign-in page and your workspace opens; your AI managers start onboarding you from there — a real person steps in only if you ask, or if you stall.</p>`,
    text: `Complete your ${i.brandName} activation — ${plan} (${fee}): ${i.checkoutUrl}\nYour sign-in link arrives separately; your workspace opens the moment the checkout clears.`,
  }
}

/**
 * Send the hosted checkout through the ONE egress survivor
 * (lib/providers/dispatch.ts::dispatchEmail). The sender identity is the
 * platform sales rep — the platform has no tenant of its own, so the rep's
 * users.brokerage_id is the delivery key (lib/platform/sales-rep.ts). No rep
 * → fail closed with a reason; the checkout URL still exists for the surface
 * to show. Never a contactId/leadId — the recipient is a prospect or a brand
 * new owner, not a CRM record.
 */
export async function sendActivationCheckoutEmail(svc: any, input: ActivationCheckoutEmailInput, deps: ActivationEmailDeps = {}): Promise<ActivationCheckoutEmailResult> {
  if (!input.checkoutUrl) return { sent: false, error: "No checkout URL to send." }
  const resolveRep = deps.resolveRep ?? (async (client: any) => {
    const { resolvePlatformSalesRep } = await import("@/lib/platform/sales-rep")
    return resolvePlatformSalesRep(client)
  })
  const rep = await resolveRep(svc)
  if (!rep) return { sent: false, error: "The platform has no staff account to send from." }
  const copy = composeActivationCheckoutEmail(input)
  const dispatch = deps.dispatch ?? (async (params: Record<string, unknown>) => {
    const { dispatchEmail } = await import("@/lib/providers/dispatch")
    return dispatchEmail(params as never)
  })
  const sent = await dispatch({
    to: input.to, brokerageId: rep.brokerageId, userId: rep.userId,
    subject: copy.subject, html: copy.html, text: copy.text,
    channelPurpose: "transactional", systemSource: "platform_prospect_activation_checkout",
  })
  return sent.success ? { sent: true } : { sent: false, error: sent.error ?? "Checkout email could not be sent." }
}
