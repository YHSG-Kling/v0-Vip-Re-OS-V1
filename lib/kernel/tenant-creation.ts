// lib/kernel/tenant-creation.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE TENANT-CREATION CORE (lane 77B, owner verbatim: "when a real estate
// subscriber wants to purchase the platform subscription there needs to be an
// easy way to convert a prospect to a subscriber or a new subscriber that isn't
// a prospect").
//
// Before this lane the brokerage row, the trial/active subscription row, the
// config snapshot, the prospect stamp and the day-one extras were spelled
// TWICE — once in app/actions/auth/signup-brokerage.ts (self-serve trial) and
// once in app/actions/admin/create-subscriber.ts (staff-provisioned active
// subscription) — and the two had drifted: only the self-serve door
// provisioned the tenant's AI-ISA actor, seeded the starter assistant, emitted
// SUBSCRIPTION_CREATED and assigned the onboarding library; only the staff
// door accepted a staff-picked snapshot. A third caller (the prospect →
// subscriber conversion, lib/platform/prospect-conversion.ts) would have been a
// third spelling. CLAUDE.md §1: merge what each survivor was missing onto ONE
// survivor, then make every door delegate. This module is that survivor; the
// two actions keep only what is genuinely theirs (the public throttle, input
// validation and the coupon/affiliate/territory extras for self-serve; the
// staff gate and the Stripe customer for the staff door).
//
// WHAT EVERY DOOR NOW GETS, in order:
//   1. tier row resolved from subscription_tiers (never a dangling tier_id)
//   2. duplicate-owner guard — an email that already owns a tenant is refused
//      (provisionTenantOwner re-pins an existing auth user, so without this a
//      staff-provisioned tenant could MOVE a live owner out of their brokerage)
//      — unless that tenant's provisioning RECORD is incomplete, in which case
//      the same call RESUMES it (wave 140C, below) instead of refusing.
//   3. brokerages row — slug'd (day-one /site/[slug]), plan_tier set so
//      fair-use caps apply on day one, trial window for the trial mode
//   4. provisionTenantOwner (lib/kernel/users.ts — auth user FIRST, id pinned,
//      tier-aware agents/teams/onboarding rows, magic-link invite) with the
//      counted rollback (lib/kernel/tenant-creation-rollback.ts) on failure
//   5. the subscription row — 'trialing' with trial_end written (the paywall
//      reads that column) or 'active' with the billing-cycle period end
//   6. config snapshot at creation — staff-picked id or the tier's live funnel
//      snapshot (snapshotForTier), applied through applySnapshotPayload only
//   7. PROSPECT LINK-BACK — stampProspectConversion by email / phone / id, so a
//      prospect who signs up on their own and a prospect converted by the
//      assistant or the growth board land on the SAME converted_brokerage_id
//   8. the tenant's AI-ISA actor, the starter assistant identity, the
//      SUBSCRIPTION_CREATED lifecycle event (the onboarding-curriculum hook)
//      and the onboarding library assignment + welcome bell
//
// Steps 6-8 are best-effort and reported per part — a branding, education or
// stamping problem must never cost a tenant that already exists, but nothing
// is swallowed silently (CLAUDE.md §3: supabase-js RESOLVES refusals; every
// write here reads its error).
//
// ── SUBSCRIBER CONVERGENCE (wave 140, lane 140C — owner: "self enrollment,
//    direct paid, free trial, platform-staff creation, sales-assisted and every
//    other legitimate door converge on the ONE canonical provisioner … Trial is
//    a subscription STATE, never a provisioning architecture; trial is never
//    required … Provisioning is idempotent, resumable, retry-safe, evidenced,
//    tenant-scoped; a duplicate Stripe event never duplicates anything.") ──
//
//   · THE DOORS, audited at 9bb0208ce: self-serve trial + self-serve direct
//     paid (app/actions/auth/signup-brokerage.ts), platform-staff creation
//     (app/actions/superadmin/manual-subscriber.ts → app/actions/admin/
//     create-subscriber.ts), sales-assisted (lib/platform/prospect-conversion.ts
//     convertProspectToSubscriber, from the growth board and the AI sales rep's
//     start_subscription) and the demo tenant (lib/platform/demo-tenant.ts →
//     signupBrokerageAction) ALL delegated here already. The brokerage-of-one
//     self-heal (app/actions/onboarding/ensure-agent-brokerage.ts) was the
//     FOURTH spelling — its own insert, an unchecked slug, a subscription row
//     with NO trial_end, no ISA actor, no assistant, no SUBSCRIPTION_CREATED, no
//     evidence — and now delegates here too through `adoptExistingOwner`.
//     app/actions/superadmin/brokerage-management.ts is LIFECYCLE (tier /
//     suspend / cancel / refund), not a creation door. The Stripe webhook
//     (app/api/billing/webhook/route.ts) never creates a tenant: it links the
//     existing subscription row and, on checkout.session.completed, RESUMES an
//     incomplete provisioning record through resumeTenantProvisioning below.
//   · TRIAL AND PAID ARE SUBSCRIPTION STATES: TenantBilling decides ONLY the
//     subscriptions row (buildSubscriptionRow) and whether a hosted checkout is
//     minted; every other step runs identically for trial, paid and active.
//   · THE PROVISIONING RECORD: brokerages.billing_metadata.provisioning — key
//     (tenant:<owner email>, or a caller's stronger key), door, owner user id,
//     attempts, and one status per step (done / failed / skipped). It is
//     written after the brokerage exists and after EVERY step, so a resume
//     (same email through any door, the webhook, or the self-healing engine)
//     re-runs only what did not finish — never a second brokerage, website,
//     owner, subscription row, actor, assistant or event. The bag is the right
//     home (lane 92A: it carries only what has no other home), and the record
//     never names a status/trial key.
//   · EVIDENCE (LAW 5): one agent_action_ledger row per provisioning attempt
//     (withActionLedger, action saas.tenant.provision, subject the minted
//     brokerage, idempotency key per attempt) settled with the step outcomes,
//     plus the SUBSCRIPTION_CREATED kernel event. A claim the ledger refuses
//     abandons the half-built tenant (counted rollback) — no evidence, no tenant.
//   · TENANT-SCOPED: the brokerage id is MINTED here; every step writes under
//     it; a resume takes the id from the owner's own users row or from a
//     verified caller (the webhook's platform-signed event, the self-healing
//     engine) — never from a request body.
//
// TENANT (CLAUDE.md §4): the new brokerage's id is MINTED here and returned —
// it never arrives in a request body. The actor is the staff caller
// (callerUserId) or null for the self-serve signer.

import type { ProspectConversionResult } from "@/lib/platform/prospect-conversion"
import type { TenantOwnerParams, TenantOwnerResult, UserProvisioningParams, ProvisioningResult } from "@/lib/kernel/users"
import type { ActivationCheckoutInput, ActivationCheckoutResult } from "@/lib/billing/subscription-activation"
import type { DeclaredAffiliationInput } from "@/lib/kernel/brokerage-identity"
import { invitationLandingUrl } from "@/lib/platform/site-url"

export type CanonicalTier = "solo_agent" | "team" | "brokerage" | "multi_location"
export const CANONICAL_TIERS: readonly CanonicalTier[] = ["solo_agent", "team", "brokerage", "multi_location"]

export function isCanonicalTier(v: unknown): v is CanonicalTier {
  return typeof v === "string" && (CANONICAL_TIERS as readonly string[]).includes(v)
}

/** brokerages.signup_source — the live CHECK vocabulary (scripts/check-vocabularies.ts:
 *  import | partner | self_serve | superadmin). A prospect converted by the
 *  assistant signed THEMSELVES up (self_serve); a staff conversion is
 *  superadmin — no new spelling is minted (CLAUDE.md §6). */
export type TenantSignupSource = "self_serve" | "superadmin"

/** A platform-staff waiver of the tier's one-time setup fee. Audited by the
 *  core (superadmin_audit_log + brokerages.billing_metadata.setup_fee_waiver)
 *  and REFUSED without a staff caller — a prospect cannot waive their own fee. */
export interface SetupFeeWaiver { reason: string }

export type TenantBilling =
  /** Self-serve shape: no card, trial_end written, the paywall collects later. */
  | { mode: "trial"; trialDays?: number }
  /** PAID ACTIVATION (wave 78A — owner: "not all converts or tenant creations
   *  are going to enroll in the trial. there is a setup fee."). The tenant is
   *  created, a HOSTED checkout for the plan + the tier's setup fee is minted
   *  (lib/billing/subscription-activation.ts::createActivationCheckout) and
   *  returned as `checkoutUrl`; the subscription row is 'trialing' with
   *  trial_end = now, so the paywall holds the door until the webhook's
   *  checkout.session.completed flips it 'active'. No new status is invented —
   *  subscriptions.status admits active|cancelled|past_due|paused|trialing. */
  | { mode: "paid"; billingCycle: "monthly" | "annual"; setupFeeWaiver?: SetupFeeWaiver | null }
  /** Staff-provisioned shape: an active subscription for the chosen cycle,
   *  invoiced outside checkout (enterprise / contract). */
  | { mode: "active"; billingCycle: "monthly" | "annual"; stripeCustomerId?: string | null }

export interface TenantCreationInput {
  brokerageName: string
  adminEmail: string
  adminFirstName: string
  adminLastName: string
  tier: CanonicalTier
  /** brokerages.email — defaults to the admin email (the self-serve shape). */
  brokerageEmail?: string | null
  brokeragePhone?: string | null
  city?: string | null
  state?: string | null
  signupSource: TenantSignupSource
  billing: TenantBilling
  /** subscription_tiers.id when the caller already resolved it; else resolved from `tier`. */
  tierId?: string | null
  /** Solo-agent only: is their managing brokerage / team also on the platform? */
  brokerageOnPlatform?: boolean
  teamOnPlatform?: boolean
  /** BROKERAGE IDENTITY (wave 141A): the affiliated brokerage a solo/team subscriber DECLARES —
   *  a name (+ optional licence / location / reference) stored on THEIR OWN tenant for business
   *  context. CONTEXT ONLY: it never selects, merges or routes to another tenant (lib/kernel/
   *  brokerage-identity.ts). Written AFTER the brokerage row exists, best-effort and reported
   *  (extrasSkipped) — creation never fails on it, and a PGRST204 before m765 is applied is
   *  reported, never swallowed. Ignored for an org tier (it IS the brokerage). */
  declaredAffiliation?: DeclaredAffiliationInput | null
  /** Staff-picked platform_config_snapshots.id; null/omitted → the tier's live funnel snapshot. */
  snapshotId?: string | null
  /** The staff actor (users.id) or null for the self-serve signer. */
  callerUserId: string | null
  /** Prospect link-back keys beyond the admin/brokerage email + brokerage phone. */
  prospect?: { emails?: Array<string | null | undefined>; phone?: string | null; prospectIds?: string[] }
  /** Post-invite landing; defaults to the onboarding wizard. */
  redirectTo?: string
  /** BROKERAGE-OF-ONE ADOPTION (wave 140C): a SIGNED-IN agent / team_lead who
   *  holds no tenant (app/actions/onboarding/ensure-agent-brokerage.ts) gets
   *  their own solo tenant through this SAME sequence. The caller has verified
   *  the user is the session's own and tenant-less; the core anchors that users
   *  row to the minted tenant and provisions tier-aware domain records with the
   *  user's REAL type — never re-typed admin, never re-invited. */
  adoptExistingOwner?: { userId: string; userType: string } | null
  /** Provisioning idempotency key. Defaults to tenant:<admin email> — the same
   *  key the prospect rail uses. A caller holding a stronger key (a prospect
   *  id, a Stripe event) passes it; a resume checks the stored key matches. */
  provisioningKey?: string | null
}

/** One provisioning step's recorded outcome. `skipped` = legitimately not
 *  applicable to this tenant (a trial has no checkout); `failed` = re-run on resume. */
interface ProvisioningStepState { status: "done" | "failed" | "skipped"; at: string; error?: string; detail?: string }

/** THE ORDERED STEP VOCABULARY — one spelling, read by the proof and the readiness contract. */
export const TENANT_PROVISIONING_STEPS = [
  "tenant_core", "admin_user", "subscription", "activation_checkout", "snapshot", "prospect_stamp",
  "isa_actor", "starter_assistant", "subscription_created_event", "onboarding_education",
  "onboarding_curriculum", "operating_baseline",
] as const
type TenantProvisioningStep = (typeof TENANT_PROVISIONING_STEPS)[number]

/** brokerages.billing_metadata.provisioning — the resumable provisioning record. */
export interface TenantProvisioningRecord {
  version: 1
  key: string
  door: TenantSignupSource
  billing_mode: TenantBilling["mode"]
  tier: CanonicalTier
  owner_user_id: string
  started_at: string
  completed_at: string | null
  attempts: number
  steps: Partial<Record<TenantProvisioningStep, ProvisioningStepState>>
  /** THE VERDICT (wave 140): evaluateTenantReadiness run once every step is terminal —
   *  READY / NOT READY with the blockers, so the record itself says whether this
   *  tenant can work. Unknown (the evaluation threw) is recorded as NOT ready. */
  readiness?: TenantReadinessVerdict
}

export interface TenantReadinessVerdict { ready: boolean; blockers: string[]; checkedAt: string }

export interface TenantCreationResult {
  ok: boolean
  error?: string
  brokerageId?: string
  userId?: string
  subscriptionId?: string | null
  /** READ (§3) and reported — the tenant exists even when this row was refused. */
  subscriptionError?: string
  slug?: string
  /** THE TENANT WEBSITE (wave 81D): `/site/<slug>` — served by app/site/[slug]
   *  from live tables the moment the brokerage row exists (brand cascade,
   *  listings, agents, blog, recruiting). Present on every ok result. */
  websitePath?: string
  /** READY / NOT READY for this tenant at the end of provisioning (also persisted on the provisioning record). */
  readiness?: TenantReadinessVerdict
  trialEndsAt?: string | null
  inviteSent?: boolean
  inviteError?: string
  snapshotApplied?: string[]
  snapshotName?: string | null
  snapshotError?: string
  prospectStamp?: ProspectConversionResult
  /** Paid activation only: the hosted checkout (plan + setup fee) to send or redirect to. */
  checkoutUrl?: string | null
  /** Paid activation only: READ and reported — the tenant exists even when Stripe refused. */
  checkoutError?: string
  /** Paid activation only: what the checkout will charge once, 0 when waived or the tier has none. */
  setupFeeCents?: number
  setupFeeWaived?: boolean
  /** Best-effort day-one extras that did not land, named — never swallowed. */
  extrasSkipped: string[]
  /** Wave 140C — true when this call found the owner's tenant half-provisioned and finished it. */
  resumed?: boolean
  /** Wave 140C — the provisioning record as persisted (steps + completion). */
  provisioning?: TenantProvisioningRecord
  /** Wave 140C — the agent_action_ledger evidence row for this attempt. */
  ledger?: { claimed: boolean; id?: string | null; error?: string }
}

/** @proofSeam — production callers never pass this; scripts/subscriber-convergence-guard.ts
 *  injects the env-bound executors (auth invite, ISA actor, image-gen assistant seed,
 *  kernel event bus, curriculum authoring, Stripe checkout, login-time repair) so the ONE
 *  sequence is proven in memory, door by door, with every table write visible. */
export interface TenantCreationDeps {
  provisionOwner?: (params: TenantOwnerParams) => Promise<TenantOwnerResult>
  domainRecords?: (params: UserProvisioningParams) => Promise<ProvisioningResult>
  isaActor?: (args: { brokerageId: string; brokerageName?: string; brokerageSlug?: string | null }) => Promise<unknown>
  starterAssistant?: (svc: any, brokerageId: string) => Promise<unknown>
  emitEvent?: (input: Record<string, unknown>) => Promise<unknown>
  curriculum?: (svc: any, params: { brokerageId: string; tier: CanonicalTier }) => Promise<{ authored: number; topics: number }>
  checkout?: (svc: any, input: ActivationCheckoutInput) => Promise<ActivationCheckoutResult>
  accountRepair?: (userId: string) => Promise<{ success: boolean; repaired: string[]; error?: string }>
  /** The readiness contract (lib/kernel/tenant-readiness.ts evaluateTenantReadiness) — evaluated, never repaired, at the end of provisioning. */
  readiness?: (svc: any, brokerageId: string) => Promise<TenantReadinessVerdict>
  /** Lane 140D/E's operating-baseline initializer (lib/kernel/tenant-operating-baseline.ts). */
  operatingBaseline?: (svc: any, brokerageId: string, opts: { actorUserId?: string | null }) => Promise<{ ok: boolean; websitePath: string | null; snapshotVersion: string | null; items: Array<{ key: string; status: string; detail?: string | null }>; refused: string[]; preserved: string[] }>
  /** Wave 141B — the immediate-operations reporter (lib/kernel/immediate-operations.ts reportOperationOutcome):
   *  the tenant_creation + website_creation post-condition verdicts, evidenced and routed. */
  reportOutcome?: (svc: any, input: Record<string, unknown>) => Promise<unknown>
}

const DEFAULT_TRIAL_DAYS = 14


/** PURE: the tenant's public slug — kebab of the name + a short suffix so a
 *  collision can never 500 a signup. */
export function buildTenantSlug(brokerageName: string, suffix: string = Math.random().toString(36).slice(2, 6)): string {
  const base = brokerageName.trim().toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "brokerage"
  return `${base}-${suffix}`
}

/** The storefront path a slug serves (app/site/[slug]) — ONE spelling. */
export function tenantWebsitePath(slug: string): string { return `/site/${slug}` }

/**
 * A tenant LANDING PAGE's path INSIDE its website (app/site/[slug]/lm/[formSlug]) — ONE spelling (wave 143G; owner:
 * "landing pages live inside the tenant website created automatically when the tenant subscribes"). The page is the
 * lead-magnet survivor (app/lm/[slug]) rendered under the tenant's storefront after the form is proven to belong to
 * THIS site's brokerage (lib/tenant-site/landing-page.ts resolveTenantLandingForm); on a connected custom domain the
 * proxy serves it at /lm/<formSlug>. The bare platform-origin /lm/<slug> stays — links already printed, sent and
 * scanned keep resolving.
 */
export function tenantLandingPagePath(siteSlug: string, formSlug: string): string { return `${tenantWebsitePath(siteSlug)}/lm/${encodeURIComponent(formSlug)}` }

/** PURE: the default provisioning idempotency key — the owner email, lowercased
 *  (the same key lib/platform/prospect-capture.ts::upsertPlatformProspect uses). */
function tenantProvisioningKey(adminEmail: string): string { return `tenant:${adminEmail.trim().toLowerCase()}` }

/** PURE: a record is complete when every step has a terminal non-failed state.
 *  @proofSeam scripts/subscriber-convergence-guard.ts asserts it directly on every door's record. */
export function provisioningComplete(record: Pick<TenantProvisioningRecord, "steps">): boolean {
  return TENANT_PROVISIONING_STEPS.every((s) => { const st = record.steps[s]?.status; return st === "done" || st === "skipped" })
}

/** PURE: the steps a resume must (re)run — missing or failed.
 *  @proofSeam scripts/subscriber-convergence-guard.ts asserts the pending set after a failed step. */
export function provisioningStepsPending(record: Pick<TenantProvisioningRecord, "steps">): TenantProvisioningStep[] {
  return TENANT_PROVISIONING_STEPS.filter((s) => { const st = record.steps[s]?.status; return st !== "done" && st !== "skipped" })
}

/**
 * THE WEBSITE IS PROVISIONED BY THE SLUG (wave 81D, owner: "when a tenant is
 * created, we also coded an automatic website is created"). app/site/[slug]
 * resolves `brokerages.slug` and assembles the storefront from live tables, so
 * the slug IS the provisioning step — and it must be UNIQUE or two tenants
 * share one storefront. Live: brokerages.slug carries no unique index, so the
 * check happens here, BEFORE the insert: a collision re-suffixes (bounded), a
 * REFUSED read fails the creation loudly (never "probably unique"), and the
 * caller reports the path it provisioned.
 */
export async function resolveUniqueTenantSlug(service: any, brokerageName: string, opts: { attempts?: number; suffixes?: string[] } = {}): Promise<{ ok: true; slug: string; retried: number } | { ok: false; error: string }> {
  const attempts = Math.max(1, opts.attempts ?? 4)
  for (let i = 0; i < attempts; i++) {
    const slug = buildTenantSlug(brokerageName, opts.suffixes?.[i])
    const { data, error } = await service.from("brokerages").select("id").eq("slug", slug).limit(1)
    if (error) return { ok: false, error: `Website slug check refused (${error.message}) — tenant NOT created: a storefront must be provably its own.` }
    if (!(data ?? []).length) return { ok: true, slug, retried: i }
  }
  return { ok: false, error: `Could not provision a unique website slug for "${brokerageName}" after ${attempts} attempts — tenant NOT created.` }
}

/** PURE: platform-membership flags — for a SOLO agent the broker-side steps
 *  (CDA signature, compliance) route to their external form platform unless
 *  their brokerage/team is also on the platform; any org tier IS the customer. */
export function platformMembershipFlags(input: Pick<TenantCreationInput, "tier" | "brokerageOnPlatform" | "teamOnPlatform">): { brokerage_on_platform: boolean; team_on_platform: boolean } {
  return {
    brokerage_on_platform: input.tier === "solo_agent" ? (input.brokerageOnPlatform ?? false) : true,
    team_on_platform: input.tier === "solo_agent" ? (input.teamOnPlatform ?? false) : true,
  }
}

/** PURE: the subscription row for the chosen billing mode. */
export function buildSubscriptionRow(input: { brokerageId: string; tierId: string; billing: TenantBilling; now?: Date }): Record<string, unknown> & { status: "trialing" | "active"; current_period_end: string } {
  const now = input.now ?? new Date()
  const nowIso = now.toISOString()
  if (input.billing.mode === "trial") {
    const end = new Date(now.getTime() + (input.billing.trialDays ?? DEFAULT_TRIAL_DAYS) * 24 * 60 * 60 * 1000).toISOString()
    return {
      brokerage_id: input.brokerageId, tier_id: input.tierId, status: "trialing",
      current_period_start: nowIso, current_period_end: end,
      // trial_end IS WRITTEN — lib/billing/billing-access.ts reads exactly this
      // column to decide whether the trial ran out; NULL was a trial that never ended.
      trial_end: end,
      created_at: nowIso, updated_at: nowIso,
    }
  }
  if (input.billing.mode === "paid") {
    // ACTIVATION PENDING PAYMENT: 'trialing' with trial_end = now. lib/billing/
    // billing-access.ts reads exactly this as "expired → blocked → paywall", so
    // the door is held until checkout.session.completed links the Stripe
    // subscription and writes 'active' (upsertBrokerageSubscription). The
    // vocabulary has no pending state and none is minted (CLAUDE.md §6).
    return {
      brokerage_id: input.brokerageId, tier_id: input.tierId, status: "trialing",
      current_period_start: nowIso, current_period_end: nowIso,
      trial_end: nowIso,
      created_at: nowIso, updated_at: nowIso,
    }
  }
  const days = input.billing.billingCycle === "annual" ? 365 : 30
  return {
    brokerage_id: input.brokerageId, tier_id: input.tierId, status: "active",
    stripe_customer_id: input.billing.stripeCustomerId ?? null,
    current_period_start: nowIso,
    current_period_end: new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString(),
    created_at: nowIso, updated_at: nowIso,
  }
}

function isValidEmail(e: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)
}

/**
 * Create a tenant end to end. `service` is the service client (RLS bypass —
 * the caller has already gated: a platform-staff capability, or the public
 * throttle on the self-serve door).
 */
export async function createTenantCore(service: any, input: TenantCreationInput, deps: TenantCreationDeps = {}): Promise<TenantCreationResult> {
  const extrasSkipped: string[] = []
  const brokerageName = (input.brokerageName ?? "").trim()
  const adminEmail = (input.adminEmail ?? "").trim().toLowerCase()
  const firstName = (input.adminFirstName ?? "").trim()
  const lastName = (input.adminLastName ?? "").trim()
  if (brokerageName.length < 2) return { ok: false, error: "Brokerage name is required (2+ chars).", extrasSkipped }
  if (!firstName) return { ok: false, error: "Admin first name is required.", extrasSkipped }
  if (!isValidEmail(adminEmail)) return { ok: false, error: "Valid admin email required.", extrasSkipped }
  if (!isCanonicalTier(input.tier)) return { ok: false, error: "Invalid tier — choose Solo Agent, Team, Brokerage, or Multi-Location.", extrasSkipped }
  // A setup-fee waiver is a PLATFORM STAFF decision (CLAUDE.md §4: gate first).
  // Fail closed: no staff caller, no waiver — a self-serve signer or a prospect
  // on a chat surface cannot waive their own fee by asking for it.
  const waiver = input.billing.mode === "paid" ? (input.billing.setupFeeWaiver ?? null) : null
  if (waiver && !input.callerUserId) return { ok: false, error: "A setup-fee waiver requires a platform staff actor — it cannot be self-granted.", extrasSkipped }
  if (waiver && !(waiver.reason ?? "").trim()) return { ok: false, error: "A setup-fee waiver requires a reason — it is audited.", extrasSkipped }
  const provisioningKey = (input.provisioningKey ?? "").trim() || tenantProvisioningKey(adminEmail)

  // 1. The tier row — the subscription links to a real subscription_tiers record
  //    (billing + v_platform_margin key on it).
  let tierId = input.tierId ?? null
  if (!tierId) {
    const { data: tierRow, error: tierErr } = await service
      .from("subscription_tiers").select("id").eq("tier_name", input.tier).eq("is_active", true).maybeSingle()
    if (tierErr || !tierRow) return { ok: false, error: `Plan tier not found: ${input.tier}`, extrasSkipped }
    tierId = (tierRow as { id: string }).id
  }

  // 2. Duplicate-owner guard. users is the authoritative tenant link; an email
  //    that already owns a tenant must sign in, not be re-pinned to a new one —
  //    UNLESS that tenant is this same provisioning, half finished: then the
  //    retry RESUMES it (idempotent re-entry, wave 140C) and nothing is minted twice.
  const { data: existingUser, error: existingErr } = await service
    .from("users").select("id, brokerage_id").eq("email", adminEmail).maybeSingle()
  if (existingErr) return { ok: false, error: `Could not verify the owner email: ${existingErr.message}`, extrasSkipped }
  const ownedBrokerageId = (existingUser as { brokerage_id?: string | null } | null)?.brokerage_id ?? null
  if (ownedBrokerageId) {
    const resumed = await resumeTenantProvisioning(service, ownedBrokerageId, { expectKey: provisioningKey, deps, snapshotId: input.snapshotId ?? null, redirectTo: input.redirectTo })
    if (resumed.resumable) return resumed.result
    return { ok: false, error: "An account with this email already exists. Sign in instead.", extrasSkipped }
  }

  // 3. The brokerage row.
  const nowIso = new Date().toISOString()
  const trialEndsAt = input.billing.mode === "trial"
    ? new Date(Date.now() + (input.billing.trialDays ?? DEFAULT_TRIAL_DAYS) * 24 * 60 * 60 * 1000).toISOString()
    : null
  // THE WEBSITE: the slug is checked against live rows first — a collision
  // re-suffixes, a refused read FAILS the creation (two tenants on one
  // storefront is worse than no tenant). app/site/[slug] serves it from here on.
  const slugRes = await resolveUniqueTenantSlug(service, brokerageName)
  if (!slugRes.ok) return { ok: false, error: slugRes.error, extrasSkipped }
  const slug = slugRes.slug
  const { data: brokerage, error: bErr } = await service
    .from("brokerages")
    .insert({
      name: brokerageName,
      slug,
      email: (input.brokerageEmail ?? "").trim().toLowerCase() || adminEmail,
      phone: (input.brokeragePhone ?? "").trim() || null,
      city: input.city ?? null,
      state: input.state ?? null,
      plan_tier: input.tier,
      ...platformMembershipFlags(input),
      trial_ends_at: trialEndsAt,
      // ONE SOURCE FOR STATUS AND TRIAL END (lane 92A, §6). Left to the column DEFAULT
      // (scripts/120-create-usage-tracking-billing.sql), the bag was born saying
      // `subscription_status: "active"`, `trial_ends_at: null` on a tenant whose
      // subscriptions row (step 5) says 'trialing' with a trial_end — two answers to
      // "is this account paying, and until when?", and the bag's was wrong for every
      // trial and every paid-pending activation. Nothing reads those two bag keys; the
      // truth is subscriptions.status / trial_end (lib/billing/billing-access.ts) and
      // brokerages.trial_ends_at above. So the bag is written explicitly WITHOUT them —
      // it carries only what has no other home (coupon, signup_intent, seat_override,
      // non_producing_user_ids, setup_fee_waiver, subscriber_stall, and — wave 140C —
      // the `provisioning` record), merged in later.
      // m679 (applied live 2026-10-01) dropped the two keys from the column DEFAULT
      // and from every existing row, so no brokerage carries a second status.
      billing_metadata: {},
      signup_source: input.signupSource,
      onboarding_status: "pending",
      created_at: nowIso,
      updated_at: nowIso,
    })
    .select("id")
    .single()
  if (bErr || !brokerage) return { ok: false, error: `Brokerage creation failed: ${bErr?.message ?? "unknown"}`, extrasSkipped }
  const brokerageId = (brokerage as { id: string }).id

  // 3b. EVIDENCE FIRST (LAW 5, wave 140C): the attempt is claimed on the action
  //     ledger under the minted tenant BEFORE the owner is invited, and settled
  //     with the step outcomes below. The key is per attempt (a resume is its
  //     own attempt with its own row); a ledger that refuses the claim means
  //     the half-built tenant is abandoned, counted — no evidence, no tenant.
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const attempt = 1
  const ledgerCtx = {
    brokerageId, action: "saas.tenant.provision",
    actor: input.callerUserId ? { type: "user" as const, userId: input.callerUserId } : { type: "system" as const },
    subject: { type: "brokerage", id: brokerageId, ref: provisioningKey },
    reasonCode: "SUBSCRIPTION_LIFECYCLE", idempotencyKey: `${provisioningKey}:${brokerageId}:attempt:${attempt}`,
    riskClass: input.billing.mode === "trial" ? "LOW_RISK_WRITE" : "FINANCIAL", systemSource: "tenant_creation",
    detail: { door: input.signupSource, tier: input.tier, billing_mode: input.billing.mode, attempt, adoption: !!input.adoptExistingOwner },
  }
  const ledgered = await withActionLedger<TenantCreationResult>(ledgerCtx, async () => {
    // 4. The owner — the canonical identity path, with the counted rollback.
    //    ADOPTION (ensure-agent-brokerage): the signed-in, tenant-less user is
    //    anchored and gets tier-aware domain records with their real type.
    let owner: TenantOwnerResult
    if (input.adoptExistingOwner) {
      owner = await adoptExistingOwnerIntoTenant(service, { brokerageId, tier: input.tier, email: adminEmail, firstName, lastName, ...input.adoptExistingOwner }, deps)
    } else {
      const { provisionTenantOwner } = deps.provisionOwner ? { provisionTenantOwner: deps.provisionOwner } : await import("@/lib/kernel/users")
      owner = await provisionTenantOwner({
        email: adminEmail, firstName, lastName, brokerageId, brokerageName, tier: input.tier,
        redirectTo: input.redirectTo ?? invitationLandingUrl(),
        callerUserId: input.callerUserId,
      })
    }
    if (!owner.success || !owner.userId) {
      return await abandonHalfBuiltTenant(service, brokerageId, `Owner provisioning failed: ${owner.error ?? "unknown"}`, extrasSkipped)
    }
    const userId = owner.userId

    // THE PROVISIONING RECORD — tenant_core + admin_user are done the moment the
    // owner is pinned; every later step records itself as it lands.
    const record: TenantProvisioningRecord = {
      version: 1, key: provisioningKey, door: input.signupSource, billing_mode: input.billing.mode, tier: input.tier,
      owner_user_id: userId, started_at: nowIso, completed_at: null, attempts: attempt,
      steps: { tenant_core: { status: "done", at: nowIso, detail: slug }, admin_user: { status: "done", at: nowIso, detail: input.adoptExistingOwner ? "adopted" : (owner.inviteSent ? "invited" : "pinned") } },
    }
    await persistProvisioningRecord(service, brokerageId, record)

    // THE DECLARED AFFILIATION (wave 141A) — on the subscriber's OWN row, context only, never a
    // tenant link; an org tier has nothing to declare. Reported by name when refused.
    if (input.declaredAffiliation && (input.tier === "solo_agent" || input.tier === "team")) {
      const { declareBrokerageAffiliation } = await import("@/lib/kernel/brokerage-identity")
      const declared = await declareBrokerageAffiliation(service, brokerageId, input.declaredAffiliation as DeclaredAffiliationInput & Record<string, unknown>, { userId, source: "signup" })
      if (!declared.ok) { extrasSkipped.push("declared_affiliation"); console.warn("[tenant-creation] declared affiliation not stored (non-fatal):", declared.error, { brokerageId }) }
    }

    const out = await runProvisioningSteps({ service, input, deps, brokerageId, userId, slug, brokerageName, adminEmail, tierId: tierId as string, waiver, record, extrasSkipped })
    return {
      ok: true,
      brokerageId, userId, slug, websitePath: tenantWebsitePath(slug), trialEndsAt,
      inviteSent: owner.inviteSent, inviteError: owner.inviteError,
      ...out,
      extrasSkipped,
      resumed: false,
      provisioning: record,
    }
  }, {
    settle: (r) => r.ok
      ? { status: "executed", outcome: provisioningComplete(r.provisioning!) ? "provisioned" : "provisioned_with_gaps", providerRef: r.brokerageId ?? null, error: r.provisioning && !provisioningComplete(r.provisioning) ? `pending: ${provisioningStepsPending(r.provisioning).join(",")}` : null }
      : { status: "failed", outcome: "provisioning_failed", error: r.error ?? null },
    replay: (claim) => ({ ok: false, error: `Tenant provisioning evidence could not be recorded (${claim.kind === "refused" ? claim.error : claim.kind}) — the tenant is NOT provisioned.`, extrasSkipped, ledger: { claimed: false, error: claim.kind === "refused" ? claim.error : claim.kind } }),
  }, { client: service })
  if (!ledgered.ok && ledgered.ledger && !ledgered.ledger.claimed) {
    // The claim never opened: nothing below the brokerage row ran. Remove the row, counted.
    return await abandonHalfBuiltTenant(service, brokerageId, ledgered.error ?? "evidence refused", extrasSkipped, ledgered.ledger)
  }
  return { ...ledgered, ledger: ledgered.ledger ?? { claimed: true } }
}

/** A brokerage row that could not be finished is removed with the counted rollback
 *  (lib/kernel/tenant-creation-rollback.ts); the outcome rides the error text. */
async function abandonHalfBuiltTenant(service: any, brokerageId: string, reason: string, extrasSkipped: string[], ledger?: TenantCreationResult["ledger"]): Promise<TenantCreationResult> {
  const { rollbackTenantCreation } = await import("@/lib/kernel/tenant-creation-rollback")
  const rollback = await rollbackTenantCreation(service, brokerageId)
  if (!rollback.ok) {
    console.error("[tenant-creation] tenant rollback incomplete:", rollback.error)
    return { ok: false, error: `${reason}. ${rollback.error}`, extrasSkipped, ledger }
  }
  return { ok: false, error: reason, extrasSkipped, ledger }
}

/** ADOPTION: anchor a signed-in, tenant-less agent / team_lead to the minted
 *  tenant (counted) and provision their tier-aware domain records through the
 *  ONE provisioning brain (createOrRepairUserDomainRecords) with their REAL
 *  user_type — exactly what the brokerage-of-one self-heal used to spell itself. */
async function adoptExistingOwnerIntoTenant(
  service: any,
  p: { brokerageId: string; tier: CanonicalTier; email: string; firstName: string; lastName: string; userId: string; userType: string },
  deps: TenantCreationDeps,
): Promise<TenantOwnerResult> {
  const { data: anchored, error: anchorErr } = await service
    .from("users").update({ brokerage_id: p.brokerageId, updated_at: new Date().toISOString() })
    .eq("id", p.userId).is("brokerage_id", null).select("id")
  if (anchorErr) return { success: false, userId: null, agentId: null, teamId: null, inviteSent: false, error: `Your account could not be anchored to the new workspace: ${anchorErr.message}` }
  if ((anchored ?? []).length !== 1) return { success: false, userId: null, agentId: null, teamId: null, inviteSent: false, error: "Your account could not be anchored to the new workspace: it already belongs to a workspace or was not found." }
  const domainRecords = deps.domainRecords ?? (await import("@/lib/kernel/users")).createOrRepairUserDomainRecords
  const domain = await domainRecords({
    userId: p.userId, email: p.email, firstName: p.firstName, lastName: p.lastName,
    userType: p.userType as UserProvisioningParams["userType"], brokerageId: p.brokerageId, teamId: null, tier: p.tier, callerUserId: p.userId,
  })
  if (!domain.success) return { success: false, userId: p.userId, agentId: domain.agentId, teamId: null, inviteSent: false, error: domain.error ?? "domain records refused" }
  return { success: true, userId: p.userId, agentId: domain.agentId, teamId: null, inviteSent: false }
}

/** The record lives in brokerages.billing_metadata.provisioning — merged, never
 *  replacing the bag's other keys; the write is COUNTED (an update matching
 *  nothing resolves too, CLAUDE.md §3). */
async function persistProvisioningRecord(service: any, brokerageId: string, record: TenantProvisioningRecord): Promise<void> {
  const { data: bmRow, error: bmErr } = await service.from("brokerages").select("billing_metadata").eq("id", brokerageId).maybeSingle()
  if (bmErr) { console.error("[tenant-creation] provisioning record: bag read refused:", bmErr.message); return }
  const existing = (bmRow as { billing_metadata?: unknown } | null)?.billing_metadata
  const bm = existing && typeof existing === "object" ? (existing as Record<string, unknown>) : {}
  const { data: rows, error } = await service.from("brokerages")
    .update({ billing_metadata: { ...bm, provisioning: record }, updated_at: new Date().toISOString() })
    .eq("id", brokerageId).select("id")
  if (error) console.error("[tenant-creation] provisioning record write refused:", error.message, { brokerageId })
  else if ((rows ?? []).length !== 1) console.error("[tenant-creation] provisioning record matched no brokerage row:", brokerageId)
}

interface ProvisioningCtx {
  service: any
  input: TenantCreationInput
  deps: TenantCreationDeps
  brokerageId: string
  userId: string
  slug: string
  brokerageName: string
  adminEmail: string
  tierId: string
  waiver: SetupFeeWaiver | null
  record: TenantProvisioningRecord
  extrasSkipped: string[]
}

type StepOutputs = Pick<TenantCreationResult, "subscriptionId" | "subscriptionError" | "checkoutUrl" | "checkoutError" | "setupFeeCents" | "setupFeeWaived" | "snapshotApplied" | "snapshotName" | "snapshotError" | "prospectStamp" | "readiness">

/**
 * STEPS 5-8 + THE OPERATING BASELINE, each recorded. A step already `done` or
 * `skipped` on the record is NOT re-run (that is what makes a resume safe); a
 * step that throws or reports a refusal is recorded `failed` with its reason
 * and the sequence continues — creation never fails on a day-one extra, but
 * the record says exactly what did not land, and the next resume runs it.
 */
async function runProvisioningSteps(ctx: ProvisioningCtx): Promise<StepOutputs> {
  const { service, input, deps, brokerageId, userId, slug, brokerageName, adminEmail, tierId, waiver, record, extrasSkipped } = ctx
  const out: StepOutputs = {}
  const nowIso = () => new Date().toISOString()
  const step = async (key: TenantProvisioningStep, run: () => Promise<{ error?: string | null; skipped?: string | null; detail?: string | null } | void>, extraName?: string): Promise<void> => {
    const prior = record.steps[key]?.status
    if (prior === "done" || prior === "skipped") return
    try {
      const r = (await run()) ?? {}
      if (r.skipped) record.steps[key] = { status: "skipped", at: nowIso(), detail: r.skipped }
      else if (r.error) { record.steps[key] = { status: "failed", at: nowIso(), error: r.error.slice(0, 500) }; if (extraName) extrasSkipped.push(extraName) }
      else record.steps[key] = { status: "done", at: nowIso(), ...(r.detail ? { detail: r.detail } : {}) }
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err)
      record.steps[key] = { status: "failed", at: nowIso(), error: msg.slice(0, 500) }
      if (extraName) extrasSkipped.push(extraName)
      console.warn(`[tenant-creation] step ${key} failed (non-fatal, recorded for resume):`, msg)
    }
    await persistProvisioningRecord(service, brokerageId, record)
  }

  // 5. The subscription row — the error is READ; a refused row is reported,
  //    never mistaken for a tenant with a trial. On a resume the brokerage's
  //    existing row is reused — ONE subscription row per tenant, always.
  await step("subscription", async () => {
    const { data: existingSub, error: exErr } = await service.from("subscriptions").select("id").eq("brokerage_id", brokerageId).order("created_at", { ascending: false }).limit(1).maybeSingle()
    if (exErr) return { error: `subscription read refused: ${exErr.message}` }
    if (existingSub) { out.subscriptionId = (existingSub as { id: string }).id; return { detail: "existing row reused" } }
    const subscriptionRow = buildSubscriptionRow({ brokerageId, tierId, billing: input.billing })
    const { data: subscription, error: subErr } = await service
      .from("subscriptions").insert(subscriptionRow).select("id").single()
    if (subErr || !subscription) {
      out.subscriptionError = subErr?.message ?? "subscription insert returned no row"
      console.error("[tenant-creation] subscription INSERT rejected — this tenant has no subscription row:", out.subscriptionError, { brokerageId, tierId })
      return { error: out.subscriptionError }
    }
    out.subscriptionId = (subscription as { id: string }).id
    return { detail: subscriptionRow.status }
  })

  // 5b. PAID ACTIVATION — the audited waiver, then the hosted checkout (plan +
  //     setup fee) through the ONE activation survivor. The checkout is
  //     best-effort AFTER the tenant exists: a Stripe refusal is reported as
  //     checkoutError (the in-app paywall still collects after sign-in), never
  //     swallowed and never a reason to roll the tenant back. Trial and active
  //     tenants record the step as not applicable — the ONLY door-shaped step.
  await step("activation_checkout", async () => {
    let checkoutError: string | undefined
    if (input.billing.mode === "paid") {
    if (waiver) {
      const at = nowIso()
      const waiverRecord = { reason: waiver.reason.trim().slice(0, 500), waived_by_user_id: input.callerUserId, waived_at: at }
      const { data: bmRow, error: bmErr } = await service.from("brokerages").select("billing_metadata").eq("id", brokerageId).maybeSingle()
      const bm = bmErr ? {} : (((bmRow as { billing_metadata?: unknown } | null)?.billing_metadata ?? {}) as Record<string, unknown>)
      const { data: waived, error: wErr } = await service.from("brokerages")
        .update({ billing_metadata: { ...(bm && typeof bm === "object" ? bm : {}), setup_fee_waiver: waiverRecord }, updated_at: at })
        .eq("id", brokerageId).select("id")
      if (wErr || (waived ?? []).length !== 1) {
        checkoutError = `Setup-fee waiver could not be recorded${wErr ? ` (${wErr.message})` : ""} — the fee was NOT waived.`
      }
      const { error: auditErr } = await service.from("superadmin_audit_log").insert({
        actor_user_id: input.callerUserId, actor_email: null,
        action: "subscription.setup_fee_waived", target_type: "brokerage", target_id: brokerageId,
        details: { ...waiverRecord, tier: input.tier, billing_cycle: input.billing.billingCycle },
      })
      if (auditErr) console.warn("[tenant-creation] setup-fee waiver audit refused:", auditErr.message)
    }
    try {
      const { createActivationCheckout } = deps.checkout ? { createActivationCheckout: deps.checkout } : await import("@/lib/billing/subscription-activation")
      // ONE spelling of the landing (lane 79D): the success URL, the checkout
      // email and lane 79A's /login?activated=1 notice all read it.
      const { SUBSCRIBER_ACTIVATED_PATH, SUBSCRIBER_ACTIVATION_CANCELLED_PATH } = await import("@/lib/platform/subscriber-door")
      const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "")
      const checkout = await createActivationCheckout(service, {
        brokerageId, tierId, billingCycle: input.billing.billingCycle,
        customerEmail: adminEmail,
        waiveSetupFee: !!waiver && !checkoutError,
        // /login is the REAL sign-in page (app/login/page.tsx, which reads
        // ?activated=1 and ?activation=cancelled). It used to point at
        // /auth/login — the DEMO sign-in surface, flag-gated off in production
        // (MAINTENANCE_DOMAINS.demo_login_hard_gate) — so a paying subscriber
        // landed on a demo page, or nothing, after checkout (wave 79A). The
        // spelling lives ONCE in lib/platform/subscriber-door.ts (wave 79D).
        successUrl: `${appUrl}${SUBSCRIBER_ACTIVATED_PATH}`,
        cancelUrl: `${appUrl}${SUBSCRIBER_ACTIVATION_CANCELLED_PATH}`,
      })
      if (checkout.ok) { out.checkoutUrl = checkout.url; out.setupFeeCents = checkout.setupFeeCents; out.setupFeeWaived = checkout.setupFeeWaived }
      else { checkoutError = [checkoutError, checkout.error].filter(Boolean).join(" "); console.error("[tenant-creation] activation checkout not created:", checkout.error, { brokerageId, tierId }) }
    } catch (err) {
      checkoutError = [checkoutError, (err as Error)?.message ?? "activation checkout failed"].filter(Boolean).join(" ")
      console.error("[tenant-creation] activation checkout threw:", (err as Error)?.message, { brokerageId, tierId })
    }
    out.checkoutError = checkoutError
    out.checkoutUrl = out.checkoutUrl ?? null
    return checkoutError ? { error: checkoutError } : { detail: "hosted checkout minted" }
    }
    return { skipped: `no checkout for billing mode ${input.billing.mode}` }
  })

  // 6. Config snapshot at creation — ONE apply path for every door.
  await step("snapshot", async () => {
    const { applySnapshotPayload } = await import("@/lib/platform/config-snapshots")
    const { snapshotForTier } = await import("@/lib/platform/trial-funnel")
    let payload: Record<string, unknown> | null = null
    let snapshotError: string | undefined
    if (input.snapshotId) {
      const { data: snap, error: snapErr } = await service
        .from("platform_config_snapshots").select("name, payload").eq("id", input.snapshotId).maybeSingle()
      if (snapErr) snapshotError = `Snapshot read failed: ${snapErr.message}`
      else if (!snap) snapshotError = "Config snapshot not found — tenant provisioned from platform defaults."
      else { out.snapshotName = (snap as { name: string }).name; payload = ((snap as { payload?: Record<string, unknown> }).payload ?? {}) }
    } else {
      const snap = await snapshotForTier(input.tier, service)
      if (snap) { out.snapshotName = snap.name; payload = snap.payload as Record<string, unknown> }
    }
    if (!payload) { out.snapshotError = snapshotError; return snapshotError ? { error: snapshotError } : { skipped: "no live snapshot for this tier — platform defaults" } }
    const { applied, refused } = await applySnapshotPayload(payload as never, brokerageId, userId, service)
    out.snapshotApplied = applied
    // Best-effort by ruling (creation never fails on the snapshot), but a refused
    // layer is reported on the result, not read as applied.
    if (refused.length > 0) { out.snapshotError = `snapshot layers refused: ${refused.join("; ")}`; return { error: out.snapshotError } }
    return { detail: applied.join(",") }
  })

  // 7. PROSPECT LINK-BACK — counted + idempotent + never-clobber.
  await step("prospect_stamp", async () => {
    const { stampProspectConversion } = await import("@/lib/platform/prospect-conversion")
    const prospectStamp = await stampProspectConversion(service, {
      brokerageId,
      emails: [adminEmail, input.brokerageEmail, ...(input.prospect?.emails ?? [])],
      phone: input.brokeragePhone ?? input.prospect?.phone ?? null,
      prospectIds: input.prospect?.prospectIds ?? [],
      // 'converted' means money moved or staff vouched for it (mode active). A
      // trial AND a paid activation awaiting its checkout are both 'trial'; the
      // webhook's checkout.session.completed advances the row to 'converted'
      // the moment the first invoice is paid (app/api/billing/webhook/route.ts).
      outcome: input.billing.mode === "active" ? "converted" : "trial",
    })
    out.prospectStamp = prospectStamp
    if (prospectStamp.errors.length > 0) {
      console.warn("[tenant-creation] prospect conversion stamp incomplete:", prospectStamp.errors.join("; "), { matched: prospectStamp.matched, linked: prospectStamp.linked })
      return { error: prospectStamp.errors.join("; ") }
    }
    return { detail: `linked ${prospectStamp.linked}` }
  }, "prospect_stamp")

  // 8a. The tenant's AI-ISA actor — idempotent; without it every ISA audit write
  //     falls back to the admin's user_id forever.
  await step("isa_actor", async () => {
    const { provisionIsaActorForBrokerage } = deps.isaActor ? { provisionIsaActorForBrokerage: deps.isaActor } : await import("@/lib/auth/provision-isa-actor")
    await provisionIsaActorForBrokerage({ brokerageId, brokerageName, brokerageSlug: slug })
  }, "isa_actor")

  // 8b. Day-one assistant identity (name + headshot + narration voice).
  await step("starter_assistant", async () => {
    const { seedStarterAssistant } = deps.starterAssistant ? { seedStarterAssistant: deps.starterAssistant } : await import("@/lib/kernel/assistant-starter")
    await seedStarterAssistant(service, brokerageId)
  }, "starter_assistant")

  // 8c. SUBSCRIPTION_CREATED — the lifecycle hook the onboarding curriculum and
  //     every downstream reactor key on; the weekly cron is the idempotent net.
  await step("subscription_created_event", async () => {
    const { KernelEvent } = await import("@/lib/kernel/events")
    const emit = deps.emitEvent ?? (await import("@/lib/kernel/emit")).emitKernelEvent
    await emit({
      event: KernelEvent.SUBSCRIPTION_CREATED, brokerageId,
      entityType: "brokerage", entityId: brokerageId,
      metadata: { tier: input.tier, billing_mode: input.billing.mode, signup_source: input.signupSource, provisioning_key: record.key },
      client: service,
    })
  }, "subscription_created_event")

  // 8d. Onboarding library + welcome bell — the day-one learning path.
  await step("onboarding_education", async () => {
    const { sentinelWrite } = await import("@/lib/kernel/write-sentinel")
    const { data: mods } = await service
      .from("learning_modules").select("id")
      .is("brokerage_id", null).eq("status", "published")
      .overlaps("audience_roles", ["agent", "broker"])
      .order("display_priority", { ascending: false }).limit(3)
    let assigned = 0
    for (const m of (mods ?? []) as Array<{ id: string }>) {
      const { error } = await service.from("learning_assignments").upsert({
        brokerage_id: brokerageId, module_id: m.id, agent_user_id: userId,
        status: "open", signal_source: "subscriber_onboarding",
      }, { onConflict: "agent_user_id,module_id", ignoreDuplicates: true })
      if (!error) assigned += 1
    }
    const planLabel = input.tier.replace(/_/g, " ")
    const pendingPayment = input.billing.mode === "paid"
    const belled = await sentinelWrite(service, service.from("notifications").insert({
      user_id: userId, brokerage_id: brokerageId, type: "agent_onboarding",
      title: pendingPayment ? "Welcome — finish activating your plan" : "Welcome — meet your AI team",
      body: `${pendingPayment
        ? `Your ${planLabel} plan is reserved. Complete the checkout in your email (plan + one-time setup) and your eleven AI managers go on duty the moment it clears.`
        : assigned > 0
        ? `Your ${planLabel} plan is live. Start with your ${assigned}-lesson onboarding path — your eleven AI managers are already on duty.`
        : `Your ${planLabel} plan is live — your eleven AI managers are already on duty. Your onboarding wizard is ready.`} Your website is already up at ${tenantWebsitePath(slug)}.`,
      priority: "high", is_read: false,
    }), { table: "notifications", flow: "tenant_creation_welcome", brokerageId, reason: "in-app notification — a lost row is a missed bell, never the business write it follows" })
    return belled ? { detail: `assigned ${assigned}` } : { error: "welcome bell refused (ledgered by the write sentinel)" }
  }, "onboarding_education")

  // 8e. THE TIER'S ONBOARDING CURRICULUM, KICKED OFF INLINE (lane 78D, blind
  //     spot 7 — lane 77B recorded runOnboardingCurriculum as "not invoked
  //     inline at conversion; the weekly cron authors any missing path").
  //     Owner: autonomous onboarding kickoff. The curriculum is authored by a
  //     model per topic (cost + latency), so it is fire-and-forget AFTER the
  //     tenant exists — never awaited inside the caller's tool round — and it
  //     is IDEMPOTENT on the `onboarding:<tier>:<topic>` gap tag, so the weekly
  //     recruit-outreach cron (runOnboardingCurriculumAll) remains the net for
  //     anything this kickoff could not finish. The promise is NOT dropped on
  //     the floor: a refusal is logged with the tenant it belonged to.
  await step("onboarding_curriculum", async () => {
    const { runOnboardingCurriculum } = deps.curriculum ? { runOnboardingCurriculum: deps.curriculum } : await import("@/lib/education/onboarding-curriculum")
    void runOnboardingCurriculum(service, { brokerageId, tier: input.tier })
      .then((r) => { if (r.authored > 0) console.log(`[tenant-creation] onboarding curriculum kicked off for ${brokerageId}: ${r.authored}/${r.topics} modules authored`) })
      .catch((err: unknown) => console.warn(`[tenant-creation] onboarding curriculum kickoff failed for ${brokerageId} (the weekly cron is the net):`, (err as Error)?.message))
    return { detail: "kicked off (idempotent on the gap tag; weekly cron is the net)" }
  }, "onboarding_curriculum")

  // 9. THE OPERATING BASELINE — "first login is never a hidden repair" (wave
  //    140): the login-time account repair (lib/kernel/users.ts
  //    repairIncompleteAccountSetup — the same path the Stripe webhook's safety
  //    net and /dashboard use) runs HERE, at creation, so the owner's first
  //    sign-in finds nothing to mend.
  //    READINESS HOOK (integrator): this is THE convergence point every door
  //    reaches — trial, paid, staff-created, converted and adopted tenants all
  //    pass through it, and evaluateTenantReadiness (lib/kernel/tenant-readiness.ts)
  //    is run right after it to stamp the verdict on the record; a REPAIRABLE gap
  //    found later routes through the self-healing engine (os-health detector
  //    tenant_readiness) back to the owning rails. The settings / policy /
  //    entitlement / feature-flag / manager / communications-defaults
  //    initializers run INSIDE this step (after the account repair) — initializeTenantOperatingBaseline
  //    (lib/kernel/tenant-operating-baseline.ts) is that initializer: website
  //    slug, tier snapshot (fill-absent), settings, policies, entitlements,
  //    feature flags, managers and communications defaults, with evidence in
  //    brokerage_settings.settings.operating_baseline. Dynamic import: that
  //    module imports tenantWebsitePath/resolveUniqueTenantSlug from here.
  let websiteItem: { status: string; detail?: string | null } | null = null
  await step("operating_baseline", async () => {
    const repair = deps.accountRepair ?? (await import("@/lib/kernel/users")).repairIncompleteAccountSetup
    const r = await repair(userId)
    if (!r.success) return { error: r.error ?? "account repair refused" }
    const baselineMod = await import("@/lib/kernel/tenant-operating-baseline")
    const baseline = deps.operatingBaseline ?? baselineMod.initializeTenantOperatingBaseline
    const base = await baseline(service, brokerageId, { actorUserId: input.callerUserId ?? userId })
    // The WEBSITE item is the website_creation post-condition (reported below, after the verdict).
    websiteItem = base.items.find((i) => i.key === "website") ?? null
    // The items the tenant cannot WORK without fail the step (resume re-runs it); a
    // best-effort item (isa_actor, starter assistant, comms defaults — the same class
    // steps 8a/8b already treat as non-fatal) is recorded, and the readiness
    // reconciliation (os-health detector tenant_readiness) carries it.
    const hard = baselineMod.baselineHardRefusals(base)
    if (hard.length) return { error: `operating baseline refused: ${base.refused.join("; ") || hard.join(",")}` }
    const created = base.items.filter((i) => i.status === "created").map((i) => i.key)
    const soft = base.items.filter((i) => i.status === "refused").map((i) => i.key)
    return { detail: [r.repaired.length ? `repaired: ${r.repaired.join(",")}` : "account complete", `baseline ${base.websitePath ?? "(no site)"} snapshot=${base.snapshotVersion ?? "none"}`, created.length ? `created: ${created.join(",")}` : "baseline present", base.preserved.length ? `preserved ${base.preserved.length}` : "", soft.length ? `refused (non-blocking): ${soft.join(",")}` : ""].filter(Boolean).join(" | ") }
  }, "operating_baseline")

  // 10. THE VERDICT — evaluate (never repair: every step above just ran; what is
  //     still open is a blocker a human or the scheduled reconciliation owns) and
  //     stamp it on the record, so "is this tenant ready to work" is answered by
  //     the tenant's own row. A thrown evaluation is NOT READY (fail closed).
  try {
    const evaluate = deps.readiness ?? (async (svc: any, id: string) => { const r = await (await import("@/lib/kernel/tenant-readiness")).evaluateTenantReadiness(svc, id); return { ready: r.ready, blockers: r.blockers, checkedAt: r.checkedAt } })
    record.readiness = await evaluate(service, brokerageId)
  } catch (e) {
    record.readiness = { ready: false, blockers: [`readiness evaluation threw: ${(e as Error).message}`], checkedAt: nowIso() }
  }
  out.readiness = record.readiness
  if (provisioningComplete(record)) record.completed_at = nowIso()
  await persistProvisioningRecord(service, brokerageId, record)

  // 11. IMMEDIATE OPERATION OUTCOME (wave 141B). The verdict above IS the post-condition re-read (every
  //     readiness check re-reads the owning service's rows). Evidenced on lifecycle_events (success AND
  //     failure) and, on failure, routed NOW to the owning manager — the 30-minute os-health sweep stays
  //     the safety net. A thrown reporter never fails provisioning (the record already holds the truth).
  try {
    const report = deps.reportOutcome ?? (await import("@/lib/kernel/immediate-operations")).reportOperationOutcome
    const pendingSteps = provisioningStepsPending(record)
    const failedSteps = TENANT_PROVISIONING_STEPS.filter((s) => record.steps[s]?.status === "failed").map((s) => `${s}: ${record.steps[s]?.error ?? "refused"}`)
    const ready = !!record.readiness?.ready
    await report(service, {
      operation: "tenant_creation", brokerageId, ok: pendingSteps.length === 0 && ready,
      subjectType: "brokerage", subjectId: brokerageId, actorUserId: input.callerUserId ?? null, source: "system", platformVisible: true,
      evidence: { provisioning_key: record.key, door: record.door, attempt: record.attempts, pending_steps: pendingSteps, failed_steps: failedSteps, readiness: record.readiness ?? null },
      error: pendingSteps.length || !ready ? [failedSteps.join("; "), ...(record.readiness?.blockers ?? [])].filter(Boolean).join(" | ").slice(0, 500) || "not ready" : null,
      tenantFacing: pendingSteps.length ? `workspace setup is still finishing (${pendingSteps.join(", ")}) — the OS is completing it` : ready ? null : "workspace setup needs a check before it is fully ready",
    })
    if (websiteItem) {
      const w = websiteItem as { status: string; detail?: string | null }
      await report(service, {
        operation: "website_creation", brokerageId, ok: w.status !== "refused",
        subjectType: "brokerage", subjectId: brokerageId, actorUserId: input.callerUserId ?? null, source: "system", platformVisible: true,
        evidence: { website: w, website_path: tenantWebsitePath(slug) },
        error: w.status === "refused" ? w.detail ?? "website slug refused" : null,
        tenantFacing: w.status === "refused" ? "your website address could not be minted yet — the OS is retrying" : null,
      })
    }
  } catch (err) {
    console.warn("[tenant-creation] immediate operation outcome not reported:", (err as Error)?.message)
  }
  return out
}

/** What the record-reading resume needs from the tenant (never a request body). */
interface ResumeOptions {
  /** A caller that derived the key from the owner email checks it matches the stored key. */
  expectKey?: string | null
  deps?: TenantCreationDeps
  snapshotId?: string | null
  redirectTo?: string
}

type ResumeTenantProvisioningResult =
  | { resumable: true; result: TenantCreationResult }
  | { resumable: false; reason: "no_record" | "complete" | "key_mismatch" | "no_owner" | "read_refused"; detail?: string }

/**
 * RESUME an incomplete provisioning: re-run only the steps the record marks
 * missing or failed, under a fresh ledger attempt. Callers: the core's own
 * idempotent re-entry (same owner email through any door), the Stripe
 * webhook's checkout.session.completed safety net, and the self-healing
 * engine (lane 140K) for a REPAIRABLE readiness gap. The brokerage id comes
 * from the owner's users row or a verified caller — never a request body.
 * A complete record is a no-op that says so (`complete`).
 */
export async function resumeTenantProvisioning(service: any, brokerageId: string, opts: ResumeOptions = {}): Promise<ResumeTenantProvisioningResult> {
  const deps = opts.deps ?? {}
  const { data: brk, error: brkErr } = await service
    .from("brokerages").select("id, name, slug, email, phone, plan_tier, signup_source, trial_ends_at, billing_metadata")
    .eq("id", brokerageId).maybeSingle()
  if (brkErr) return { resumable: false, reason: "read_refused", detail: brkErr.message }
  const row = brk as { id: string; name: string; slug: string | null; email: string | null; phone: string | null; plan_tier: string | null; signup_source: string | null; trial_ends_at: string | null; billing_metadata?: Record<string, unknown> | null } | null
  const record = (row?.billing_metadata as { provisioning?: TenantProvisioningRecord } | null | undefined)?.provisioning ?? null
  if (!row || !record || record.version !== 1) return { resumable: false, reason: "no_record" }
  if (opts.expectKey && opts.expectKey !== record.key) return { resumable: false, reason: "key_mismatch" }
  if (record.completed_at || provisioningComplete(record)) return { resumable: false, reason: "complete" }

  const { data: ownerRow, error: ownerErr } = await service
    .from("users").select("id, email, first_name, last_name, user_type").eq("id", record.owner_user_id).eq("brokerage_id", brokerageId).maybeSingle()
  if (ownerErr) return { resumable: false, reason: "read_refused", detail: ownerErr.message }
  const owner = ownerRow as { id: string; email: string | null; first_name: string | null; last_name: string | null } | null
  if (!owner) return { resumable: false, reason: "no_owner" }

  let tierId: string | null = null
  const { data: tierRow, error: tierErr } = await service
    .from("subscription_tiers").select("id").eq("tier_name", record.tier).eq("is_active", true).maybeSingle()
  if (!tierErr && tierRow) tierId = (tierRow as { id: string }).id
  if (!tierId) return { resumable: false, reason: "read_refused", detail: `Plan tier not found: ${record.tier}` }

  const slug = row.slug ?? buildTenantSlug(row.name)
  const adminEmail = (owner.email ?? row.email ?? "").toLowerCase()
  const billing: TenantBilling = record.billing_mode === "trial" ? { mode: "trial" } : record.billing_mode === "paid" ? { mode: "paid", billingCycle: "monthly" } : { mode: "active", billingCycle: "monthly" }
  const input: TenantCreationInput = {
    brokerageName: row.name, adminEmail, adminFirstName: owner.first_name ?? "", adminLastName: owner.last_name ?? "",
    tier: record.tier, brokerageEmail: row.email, brokeragePhone: row.phone, signupSource: record.door, billing,
    tierId, snapshotId: opts.snapshotId ?? null, callerUserId: null, redirectTo: opts.redirectTo, provisioningKey: record.key,
  }
  record.attempts = (record.attempts ?? 1) + 1
  const extrasSkipped: string[] = []
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const ledgered = await withActionLedger<TenantCreationResult>({
    brokerageId, action: "saas.tenant.provision", actor: { type: "system" },
    subject: { type: "brokerage", id: brokerageId, ref: record.key },
    reasonCode: "SUBSCRIPTION_LIFECYCLE", idempotencyKey: `${record.key}:${brokerageId}:attempt:${record.attempts}`,
    riskClass: record.billing_mode === "trial" ? "LOW_RISK_WRITE" : "FINANCIAL", systemSource: "tenant_creation",
    detail: { door: record.door, tier: record.tier, billing_mode: record.billing_mode, attempt: record.attempts, resume: true, pending: provisioningStepsPending(record) },
  }, async () => {
    await persistProvisioningRecord(service, brokerageId, record)
    const out = await runProvisioningSteps({ service, input, deps, brokerageId, userId: owner.id, slug, brokerageName: row.name, adminEmail, tierId: tierId as string, waiver: null, record, extrasSkipped })
    return { ok: true, brokerageId, userId: owner.id, slug, websitePath: tenantWebsitePath(slug), trialEndsAt: row.trial_ends_at, ...out, extrasSkipped, resumed: true, provisioning: record }
  }, {
    settle: (r) => ({ status: "executed", outcome: provisioningComplete(record) ? "provisioned" : "provisioned_with_gaps", providerRef: brokerageId, error: provisioningComplete(record) ? null : `pending: ${provisioningStepsPending(record).join(",")}` }),
    replay: (claim) => ({ ok: false, error: `Provisioning resume evidence could not be recorded (${claim.kind === "refused" ? claim.error : claim.kind})`, extrasSkipped, ledger: { claimed: false, error: claim.kind === "refused" ? claim.error : claim.kind } }),
  }, { client: service })
  return { resumable: true, result: { ...ledgered, ledger: ledgered.ledger ?? { claimed: true } } }
}
