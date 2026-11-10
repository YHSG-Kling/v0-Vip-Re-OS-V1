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
   *  a name (+ optional license / location / reference) stored on THEIR OWN tenant for business
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
  /** THE TENANT HIERARCHY (wave 150, lane 150C — C34): offices (each its own legal identity, territories, brand
   *  overrides, seat ownership), their teams, and the initial agents with EXPLICIT office / team memberships.
   *  Provisioned by provisionTenantStructure (below) right after the owner is pinned, for EVERY
   *  door and billing mode (trial, paid, active — not every subscription is a trial). A brokerage with no offices given
   *  gets its head office; a solo / team tenant carries none. Initial agents are invited IMMEDIATELY; a gap is recorded
   *  on the provisioning record (structure.complete=false), routed to the Recruiting Manager + the right office head,
   *  and finished by resumeTenantProvisioning — the tenant is never rolled back for it. */
  structure?: TenantStructureInput | null
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
  /** Wave 150 (C34): the hierarchy provisioned for this tenant — offices / teams / memberships / initial agents.
   *  Not a step (the step vocabulary is the readiness contract's); a resume re-runs it while `complete` is false. */
  structure?: TenantStructureRecord
  /** What the structure was asked to provision, kept only while it is incomplete so a resume finishes the SAME
   *  request (initial agents' names and emails are the tenant's own staff, on the tenant's own row). */
  structure_input?: TenantStructureInput | null
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
  /** Wave 150 (C34) — the offices / teams / memberships / initial agents this call provisioned or finished. */
  structure?: TenantStructureRecord
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
  /** Wave 150 (C34) — the env-bound member invite + reporter of provisionTenantStructure (below). */
  structure?: StructureDeps
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

    // THE HIERARCHY (C34) — offices, teams, explicit memberships, initial agents invited NOW. Recorded, never fatal.
    await runTenantStructure(service, { brokerageId, tier: input.tier, ownerUserId: userId, brokerageName, actorUserId: input.callerUserId ?? userId }, input.structure ?? null, record, deps, extrasSkipped)

    const out = await runProvisioningSteps({ service, input, deps, brokerageId, userId, slug, brokerageName, adminEmail, tierId: tierId as string, waiver, record, extrasSkipped })
    return {
      ok: true,
      brokerageId, userId, slug, websitePath: tenantWebsitePath(slug), trialEndsAt,
      inviteSent: owner.inviteSent, inviteError: owner.inviteError,
      structure: record.structure,
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

/** Run (or finish) the tenant's structure and keep it on the provisioning record. A structure gap never fails the
 *  tenant: it is named in extrasSkipped ("org_structure"), kept on the record for the resume, and already routed to
 *  its manager by provisionTenantStructure. */
async function runTenantStructure(
  service: any,
  p: { brokerageId: string; tier: CanonicalTier; ownerUserId: string; brokerageName: string; actorUserId: string | null },
  structureInput: TenantStructureInput | null,
  record: TenantProvisioningRecord,
  deps: TenantCreationDeps,
  extrasSkipped: string[],
): Promise<void> {
  try {
    const structure = await provisionTenantStructure(service, { ...p, source: "provisioning", input: structureInput, prior: record.structure ?? null }, deps.structure ?? {})
    record.structure = structure
    record.structure_input = structure.complete ? null : structureInput
    if (!structure.complete) extrasSkipped.push("org_structure")
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e)
    const prior = record.structure
    record.structure = { version: 1, complete: false, offices: prior?.offices ?? [], teams: prior?.teams ?? [], memberships: prior?.memberships ?? 0, members: prior?.members ?? [], errors: [`structure threw: ${msg.slice(0, 300)}`], notes: [], at: new Date().toISOString() }
    record.structure_input = structureInput
    extrasSkipped.push("org_structure")
    console.warn("[tenant-creation] tenant structure threw (recorded for resume):", msg)
  }
  await persistProvisioningRecord(service, p.brokerageId, record)
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
      // THE ONE PUBLIC-ORIGIN RESOLVER (wave 148, lane 148A): this read a bare NEXT_PUBLIC_APP_URL, so every
      // deployment without it (each preview; production before the owner sets it) built a RELATIVE success_url.
      // siteUrl() falls back to the deployment's own VERCEL_URL; with no origin at all the URLs stay relative
      // and createActivationCheckout (the Stripe-facing survivor) refuses them BEFORE Stripe with the variable
      // named — reported on the step, never an opaque provider error.
      const { siteUrl } = await import("@/lib/platform/site-url")
      const appUrl = siteUrl()
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
  const structurePending = !!record.structure && !record.structure.complete
  if ((record.completed_at || provisioningComplete(record)) && !structurePending) return { resumable: false, reason: "complete" }

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
    // C34: a structure gap (an initial agent's invite, an office seat refusal) is finished from the SAME request it was made with.
    if (structurePending) await runTenantStructure(service, { brokerageId, tier: record.tier, ownerUserId: owner.id, brokerageName: row.name, actorUserId: owner.id }, record.structure_input ?? null, record, deps, extrasSkipped)
    const out = await runProvisioningSteps({ service, input, deps, brokerageId, userId: owner.id, slug, brokerageName: row.name, adminEmail, tierId: tierId as string, waiver: null, record, extrasSkipped })
    return { ok: true, brokerageId, userId: owner.id, slug, websitePath: tenantWebsitePath(slug), trialEndsAt: row.trial_ends_at, ...out, extrasSkipped, resumed: true, provisioning: record, structure: record.structure }
  }, {
    settle: (r) => ({ status: "executed", outcome: provisioningComplete(record) ? "provisioned" : "provisioned_with_gaps", providerRef: brokerageId, error: provisioningComplete(record) ? null : `pending: ${provisioningStepsPending(record).join(",")}` }),
    replay: (claim) => ({ ok: false, error: `Provisioning resume evidence could not be recorded (${claim.kind === "refused" ? claim.error : claim.kind})`, extrasSkipped, ledger: { claimed: false, error: claim.kind === "refused" ? claim.error : claim.kind } }),
  }, { client: service })
  return { resumable: true, result: { ...ledgered, ledger: ledgered.ledger ?? { claimed: true } } }
}

// ═════════════════════════════════════════════════════════════════════════════
// ── THE TENANT STRUCTURE (wave 150, lane 150C — C34). Folded into the ONE provisioning core rather than a new module:
//    every app entry that reaches createTenantCore already reaches this file (test:proxy-graph-budget — app/crm/page.tsx
//    sits at the 1300 ceiling), and the structure IS a provisioning part.
// ═════════════════════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────────────────────
// THE TENANT HIERARCHY (wave 150, lane 150C — contract C34). Platform → subscriber tenant (`brokerages` row for a
// solo agent, a team, a brokerage or a brokerage with several locations) → optional legal brokerage relationship
// (lib/kernel/brokerage-identity.ts — a DECLARED label, never membership) → brokerage LOCATION / office
// (`locations`, m957: own legal identity, settings, territories, brand overrides, seat ownership) → team
// (`teams.location_id`, m957) → EXPLICIT seat memberships (`organization_members`, m958 — possibly several).
//
// SURVIVORS REUSED, never re-spelled (audited at ccccb2db):
//   · lib/kernel/tenant-creation.ts createTenantCore — the ONE provisioning core; this section is its structure part
//     (offices / teams / memberships / initial agents), run inside the core and re-run by resumeTenantProvisioning.
//   · lib/kernel/users.ts inviteTenantMember — the ONE member invite (auth user first, id pinned, domain records).
//   · lib/kernel/seat-usage.ts seatGate (inside the invite) + locationSeatGate (the office's own seat ownership).
//   · lib/kernel/immediate-operations.ts reportOperationOutcome — a failed placement reaches its manager IN THE REQUEST.
//   · lib/kernel/brokerage-transfer.ts — the consented transfer rail. It moves the people; THIS module places them in
//     the target OFFICE / team with source 'transfer' (provisionTenantStructure with existing user ids).
//   · teams.team_lead_id — the leadership FACT (m473); locations.managing_broker_user_id — the office head FACT (m661).
//
// THE RULES THIS FILE HOLDS (directive "Canonical topology" 1–2):
//   1. A NAME IS A LABEL. Offices are keyed by `office_code`, teams by the ids this record minted; no read here filters
//      a tenant, an office or a team by name (scripts/multi-location-tenancy-guard.ts holds the census). Two offices
//      of one brokerage may share a name and remain two offices with distinct teams.
//   2. AGGREGATION NEEDS A GRANT. In a multi-location tenant only an active `leadership` membership at scope 'tenant'
//      opens the all-office view; an office head sees their office (leadership membership or the managing-broker
//      fact), a team lead their team (the team_lead_id fact or a team leadership grant), everyone else their own work.
//      `users.user_type` never widens a multi-location row; `superadmin` / `platform_role` never widen any row here.
//      A single-office tenant keeps the CLAUDE.md §4 roster rule (its tenant admins administer the tenant).
//   3. FAIL CLOSED. A refused read is a refusal, never "no restriction".
//   4. A placement of an EXISTING user is refused unless that user already sits in this tenant — so a solo agent
//      whose declared affiliation spells this brokerage's name is never captured; only the consented transfer rail
//      moves a person between tenants.
//   5. SEVERAL MEMBERSHIPS PER PERSON, ONE PER SCOPE (wave 151, lane 151A). Owner SQL L1 (OWNER-SQL.md §L1) dropped the
//      legacy `organization_members_brokerage_id_user_id_key`; the live rule is `organization_members_active_scope_key`
//      — one ACTIVE row per (tenant, user, scope_kind, office, team). A person may be placed in two offices (an add),
//      or MOVED (`reassign`, which revokes the other office placements); a revocation is a stamped row, never a delete
//      (revokeScopeMemberships). No reader of this table may assume one row per person per tenant
//      (scripts/multi-location-tenancy-guard.ts T6 / T8 hold this).

type Svc = any

// ── Vocabulary (ONE spelling; m958 CHECKs mirror these) ───────────────────────────────────────────────────────
// scripts/multi-location-tenancy-guard.ts T6 holds this list equal to the m958 CHECK (one vocabulary, read from source).
const MEMBERSHIP_SCOPE_KINDS = ["tenant", "location", "team"] as const
type MembershipScopeKind = (typeof MEMBERSHIP_SCOPE_KINDS)[number]
// scripts/multi-location-tenancy-guard.ts T6 holds this list equal to the m958 CHECK (one vocabulary, read from source).
export const MEMBERSHIP_ACCESS_LEVELS = ["member", "leadership"] as const
export type MembershipAccessLevel = (typeof MEMBERSHIP_ACCESS_LEVELS)[number]
// scripts/multi-location-tenancy-guard.ts T6 holds this list equal to the m958 CHECK (one vocabulary, read from source).
const MEMBERSHIP_SOURCES = ["provisioning", "invite", "transfer", "admin_grant"] as const
type MembershipSource = (typeof MEMBERSHIP_SOURCES)[number]

/** The tiers that carry offices. A solo agent and a team carry none (a team IS a mini brokerage, m473). */
const OFFICE_TIERS = new Set(["brokerage", "multi_location"])

export interface OfficeInput {
  /** The office's idempotency key inside the tenant. Default `office-<n>` by position — never the name. */
  officeCode?: string | null
  name: string
  legalName?: string | null
  dba?: string | null
  licenseNumber?: string | null
  /** Two-letter USPS code. */
  licenseState?: string | null
  address?: string | null
  city?: string | null
  state?: string | null
  territories?: string[] | null
  /** The office layer of the brand cascade (office → team → user). */
  brandOverrides?: Record<string, unknown> | null
  /** Location-scoped settings; permissions under `permissions`. */
  settings?: Record<string, unknown> | null
  /** Seats this office owns; null = the tenant band alone. */
  seatCap?: number | null
  teams?: Array<{ name: string }> | null
}

export interface StructureMemberInput {
  /** New person (invited now) … */
  email?: string | null
  firstName?: string | null
  lastName?: string | null
  userType: string
  /** … or a person ALREADY in this tenant (the consented-transfer placement). Never another tenant's user. */
  existingUserId?: string | null
  /** The office: a code from this structure's offices, or a verified location id of this tenant. */
  officeCode?: string | null
  locationId?: string | null
  /** The team: a name from THIS input's office team list (input-local, never a database name lookup), or a verified team id. */
  teamName?: string | null
  teamId?: string | null
  /** Office leadership (an office head). Never tenant leadership — that is the owner's, or an explicit admin grant. */
  officeLeadership?: boolean
  /** Lead the team: anchors teams.team_lead_id when the team has no lead, and records a team leadership grant. */
  leadsTeam?: boolean
  /**
   * SEAT REASSIGNMENT (wave 151, lane 151A — owner: "seat reassignment, revocation and membership changes must work").
   * A placement ADDS a membership by default — a person may hold several (owner: "a user may hold several memberships
   * without global promotion"). `reassign: true` is a MOVE: the person's other active office placements in this tenant
   * (and the team placements that sit inside those other offices) are revoked, stamped with the actor and the move as
   * evidence, before the new office is pinned. Before owner SQL L1 dropped the legacy one-row-per-tenant UNIQUE a
   * second office placement was refused 23505, so a "move" silently failed; after it, a move without this flag would
   * silently leave the stale placement active. Neither is what an admin moving a person means.
   */
  reassign?: boolean
}

export interface TenantStructureInput {
  offices?: OfficeInput[] | null
  members?: StructureMemberInput[] | null
}

export interface TenantStructureRecord {
  version: 1
  complete: boolean
  offices: Array<{ code: string; id: string; name: string }>
  teams: Array<{ key: string; id: string; name: string; locationId: string | null }>
  memberships: number
  /** Memberships REVOKED by a `reassign` move in this run (wave 151, lane 151A). Optional: records written before it carry none. */
  revoked?: number
  members: Array<{ key: string; status: "placed" | "failed"; userId?: string | null; locationId?: string | null; teamId?: string | null; error?: string }>
  errors: string[]
  notes: string[]
  at: string
}

export interface ProvisionStructureParams {
  brokerageId: string
  tier: string
  ownerUserId: string
  brokerageName: string
  /** The staff actor, the self-serve owner, or the approving admin of a transfer. */
  actorUserId: string | null
  source: MembershipSource
  input: TenantStructureInput | null | undefined
  /** The record of an earlier attempt — its minted ids are REUSED (a resume never mints a second office or team). */
  prior?: TenantStructureRecord | null
  /** Transfer request id / consent evidence carried on every membership it writes. */
  evidence?: Record<string, unknown> | null
}

/** @proofSeam scripts/multi-location-tenancy-guard.ts + scripts/subscriber-provisioning-guard.ts inject the env-bound
 *  invite (Supabase Auth) and observe the reporter; production passes nothing. */
export interface StructureDeps {
  invite?: (params: { brokerageId: string; teamId: string | null; email: string; firstName: string; lastName: string; userType: string; callerUserId: string; client: Svc }) => Promise<{ success: boolean; userId: string | null; error?: string }>
  report?: (svc: Svc, input: Record<string, unknown>) => Promise<unknown>
}

const trimOrNull = (v: unknown, max = 160): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null)

function officeCodeFor(o: OfficeInput, i: number): string {
  const raw = trimOrNull(o.officeCode, 48)
  return (raw ?? `office-${i + 1}`).toLowerCase().replace(/[^a-z0-9-]+/g, "-")
}

/** PURE: the offices this tier provisions — or the refusal. A brokerage gets one head office (default: the tenant's
 *  own name and identity); a brokerage with several locations gets the ones staff / the signer named; solo and team
 *  tenants carry none. Same-name offices are allowed: identity is the office code. */
/** Consumers: createTenantCore (via provisionTenantStructure) and app/actions/auth/signup-brokerage.ts (validates the head office before any write). */
export function planTenantOffices(tier: string, brokerageName: string, offices: OfficeInput[] | null | undefined): { ok: true; offices: Array<OfficeInput & { code: string }>; note: string | null } | { ok: false; error: string } {
  const given = (offices ?? []).filter((o) => o && trimOrNull(o.name))
  if (!OFFICE_TIERS.has(tier)) {
    if (given.length) return { ok: false, error: `A ${tier.replace(/_/g, " ")} workspace has no offices — choose Brokerage or Multi-Location to add one.` }
    return { ok: true, offices: [], note: null }
  }
  if (tier === "brokerage" && given.length > 1) return { ok: false, error: "A Brokerage workspace runs one office — choose Multi-Location for several independently operated locations." }
  const list = given.length ? given : tier === "brokerage" ? [{ name: brokerageName, officeCode: "main" }] : []
  const coded = list.map((o, i) => ({ ...o, code: officeCodeFor(o, i) }))
  const dup = coded.find((o, i) => coded.findIndex((x) => x.code === o.code) !== i)
  if (dup) return { ok: false, error: `Two offices share the office code "${dup.code}" — every office needs its own code (names may repeat; codes may not).` }
  const badState = coded.find((o) => o.licenseState && !/^[A-Z]{2}$/.test(String(o.licenseState).trim().toUpperCase()))
  if (badState) return { ok: false, error: `Office "${badState.name}": license state must be a two-letter US state code.` }
  const badCap = coded.find((o) => o.seatCap !== undefined && o.seatCap !== null && (!Number.isInteger(o.seatCap) || o.seatCap < 0))
  if (badCap) return { ok: false, error: `Office "${badCap.name}": seat ownership must be a whole number of seats (0 or more).` }
  return { ok: true, offices: coded, note: tier === "multi_location" && coded.length === 0 ? "multi-location tenant created without offices — staff add each location (Settings → Offices)" : null }
}

// ── Memberships ───────────────────────────────────────────────────────────────────────────────────────────────

async function grantMembership(svc: Svc, row: { brokerageId: string; userId: string; scope: MembershipScopeKind; locationId?: string | null; teamId?: string | null; access: MembershipAccessLevel; source: MembershipSource; grantedBy: string | null; evidence?: Record<string, unknown> | null; role?: string | null }): Promise<{ ok: true; created: boolean } | { ok: false; error: string }> {
  const locationId = row.scope === "location" ? row.locationId ?? null : null
  const teamId = row.scope === "team" ? row.teamId ?? null : null
  // A FRESH builder per read (a consumed builder is not re-awaited): the ACTIVE row of exactly this scope key.
  const readActive = () => {
    let q = svc.from("organization_members").select("id, access_level").eq("brokerage_id", row.brokerageId).eq("user_id", row.userId).eq("scope_kind", row.scope).is("revoked_at", null)
    q = locationId ? q.eq("location_id", locationId) : q.is("location_id", null)
    q = teamId ? q.eq("team_id", teamId) : q.is("team_id", null)
    return q.limit(1)
  }
  const { data: existing, error: readErr } = await readActive()
  if (readErr) return { ok: false, error: `membership read refused: ${readErr.message}` }
  const hit = (existing ?? [])[0] as { id: string; access_level: string } | undefined
  if (hit) {
    if (hit.access_level === row.access || row.access === "member") return { ok: true, created: false }
    const { data: up, error: upErr } = await svc.from("organization_members").update({ access_level: row.access, updated_at: new Date().toISOString() }).eq("id", hit.id).eq("brokerage_id", row.brokerageId).select("id")
    if (upErr) return { ok: false, error: `membership upgrade refused: ${upErr.message}` }
    if ((up ?? []).length !== 1) return { ok: false, error: "membership upgrade matched no row" }
    return { ok: true, created: false }
  }
  const { error } = await svc.from("organization_members").insert({
    brokerage_id: row.brokerageId, user_id: row.userId, scope_kind: row.scope, location_id: locationId, team_id: teamId,
    access_level: row.access, source: row.source, role: row.role ?? (row.access === "leadership" ? "leadership" : "member"),
    granted_by_user_id: row.grantedBy, evidence: row.evidence ?? {}, joined_at: new Date().toISOString(),
  })
  if (error) {
    // 23505 (wave 151, lane 151A): owner SQL L1 dropped the legacy one-row-per-tenant UNIQUE (applied live; the live
    // catalogue holds ONLY organization_members_active_scope_key — one ACTIVE row per (tenant, user, scope, office, team)).
    // So a duplicate key here can only be THIS SAME active scope row, written between the read above and this insert: the
    // grant already exists, which is the idempotent outcome, not a refusal. The winner is re-read and reported as such;
    // if nothing is found the refusal is reported by name — never "pending owner SQL" (a waypoint, CLAUDE.md §2) and never
    // success over a row that is not there.
    if (error.code === "23505") {
      const { data: winner, error: reErr } = await readActive()
      if (!reErr && (winner ?? []).length) return { ok: true, created: false }
      return { ok: false, error: `membership write refused as a duplicate, yet no active ${row.scope} row was found to reuse (${error.message})` }
    }
    return { ok: false, error: `membership write refused: ${error.message}` }
  }
  return { ok: true, created: true }
}

/**
 * REVOKE a person's active scope memberships in ONE tenant (wave 151, lane 151A — owner: "seat reassignment, revocation
 * and membership changes must work"). The row is never deleted: revoked_at / revoked_by_user_id are stamped and the
 * evidence is merged (the audit stays; lib/kernel/resolve-user-office.ts reads only active rows). Every update is
 * COUNTED (CLAUDE.md §3 — an UPDATE matching nothing also resolves) and every read's error is read.
 *
 * `keep` names the office / team the person is being placed in: that office's row and the team rows INSIDE it stay;
 * a team row whose team works out of another office (teams.location_id) goes with the old office. A team not placed
 * in any office is kept — it is not the old office's.
 *
 * Consumers: placeSeat below (a `reassign` move), app/actions/admin/locations.ts assignUserToLocationAction (unpin),
 * lib/kernel/brokerage-transfer.ts runBrokerageTransferMigration (the SOURCE tenant's memberships of an adopted seat).
 */
export async function revokeScopeMemberships(svc: Svc, p: {
  brokerageId: string
  userId: string
  actorUserId: string | null
  scopes: readonly MembershipScopeKind[]
  keep?: { locationId?: string | null; teamId?: string | null } | null
  evidence?: Record<string, unknown> | null
}): Promise<{ ok: true; revoked: number; ids: string[] } | { ok: false; error: string }> {
  if (!p.scopes.length) return { ok: true, revoked: 0, ids: [] }
  const { data, error } = await svc.from("organization_members").select("id, scope_kind, location_id, team_id, evidence")
    .eq("brokerage_id", p.brokerageId).eq("user_id", p.userId).in("scope_kind", [...p.scopes]).is("revoked_at", null)
  if (error) return { ok: false, error: `memberships read refused: ${error.message}` }
  const rows = (data ?? []) as Array<{ id: string; scope_kind: string; location_id: string | null; team_id: string | null; evidence: Record<string, unknown> | null }>
  const keepLocation = p.keep?.locationId ?? null
  const keepTeam = p.keep?.teamId ?? null
  // The office of every team row, read once — a team row goes with the office its team works out of.
  const teamIds = rows.filter((r) => r.scope_kind === "team" && r.team_id).map((r) => r.team_id as string)
  const teamOffice = new Map<string, string | null>()
  if (teamIds.length && keepLocation) {
    const { data: teams, error: tErr } = await svc.from("teams").select("id, location_id").eq("brokerage_id", p.brokerageId).in("id", teamIds)
    if (tErr) return { ok: false, error: `teams read refused: ${tErr.message}` }
    for (const t of (teams ?? []) as Array<{ id: string; location_id: string | null }>) teamOffice.set(t.id, t.location_id ?? null)
  }
  const doomed = rows.filter((r) => {
    if (r.scope_kind === "location") return !(keepLocation && r.location_id === keepLocation)
    if (r.scope_kind === "team") {
      if (keepTeam && r.team_id === keepTeam) return false
      if (!keepLocation) return true
      const office = r.team_id ? teamOffice.get(r.team_id) ?? null : null
      return office !== null && office !== keepLocation
    }
    return true
  })
  const nowIso = new Date().toISOString()
  const ids: string[] = []
  for (const r of doomed) {
    const evidence = { ...(r.evidence ?? {}), revoked: { ...(p.evidence ?? {}), kept_location_id: keepLocation, kept_team_id: keepTeam } }
    const { data: up, error: upErr } = await svc.from("organization_members")
      .update({ revoked_at: nowIso, revoked_by_user_id: p.actorUserId, evidence, updated_at: nowIso })
      .eq("id", r.id).eq("brokerage_id", p.brokerageId).is("revoked_at", null).select("id")
    if (upErr) return { ok: false, error: `membership revocation refused: ${upErr.message}` }
    if ((up ?? []).length !== 1) return { ok: false, error: `membership revocation matched ${(up ?? []).length} rows for ${r.id} (expected 1)` }
    ids.push(r.id)
  }
  return { ok: true, revoked: ids.length, ids }
}

// ── Provisioning ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Provision (or finish provisioning) a tenant's structure. Idempotent: offices by office_code, teams by the ids the
 * prior record minted (or the owner's team by the team_lead_id fact), memberships by their active scope key. Every
 * write reads its error; every update is counted. Failures are recorded on the returned record (complete:false —
 * resumeTenantProvisioning re-runs it) and routed to the right manager immediately; the tenant is never rolled back
 * for a structure gap ("invite immediately, repair asynchronously, notify the right manager").
 */
/** Consumers: createTenantCore / resumeTenantProvisioning (provisioning), app/dashboard/settings/offices/actions.ts grantOfficeMembershipAction (admin_grant) and lib/kernel/brokerage-transfer.ts runBrokerageTransferMigration membership step (transfer; wave 150 lane 150Z). */
export async function provisionTenantStructure(svc: Svc, p: ProvisionStructureParams, deps: StructureDeps = {}): Promise<TenantStructureRecord> {
  const rec: TenantStructureRecord = { version: 1, complete: false, offices: [], teams: [], memberships: 0, members: [], errors: [], notes: [], at: new Date().toISOString() }
  const prior = p.prior ?? null
  const grant = async (g: Omit<Parameters<typeof grantMembership>[1], "brokerageId" | "source" | "grantedBy" | "evidence">, label: string) => {
    const r = await grantMembership(svc, { ...g, brokerageId: p.brokerageId, source: p.source, grantedBy: p.actorUserId, evidence: p.evidence ?? null })
    if (!r.ok) { rec.errors.push(`${label}: ${r.error}`); return false }
    if (r.created) rec.memberships += 1
    return true
  }

  // 1. The owner holds TENANT LEADERSHIP — the explicit grant that makes their aggregated view a fact, not a user_type.
  if (p.source === "provisioning") await grant({ userId: p.ownerUserId, scope: "tenant", access: "leadership" }, "owner tenant leadership")

  // 2. Offices.
  const plan = planTenantOffices(p.tier, p.brokerageName, p.input?.offices)
  if (!plan.ok) { rec.errors.push(plan.error) }
  else {
    if (plan.note) rec.notes.push(plan.note)
    for (const o of plan.offices) {
      const { data: found, error: findErr } = await svc.from("locations").select("id, name").eq("brokerage_id", p.brokerageId).eq("office_code", o.code).limit(1)
      if (findErr) { rec.errors.push(`office ${o.code}: read refused (${findErr.message})`); continue }
      let officeId = ((found ?? [])[0] as { id: string } | undefined)?.id ?? null
      if (!officeId) {
        const { data: made, error: insErr } = await svc.from("locations").insert({
          brokerage_id: p.brokerageId, office_code: o.code, name: o.name.trim().slice(0, 160),
          legal_name: trimOrNull(o.legalName), dba: trimOrNull(o.dba), license_number: trimOrNull(o.licenseNumber, 64),
          license_state: trimOrNull(o.licenseState, 2)?.toUpperCase() ?? null,
          address: trimOrNull(o.address, 240), city: trimOrNull(o.city, 120), state: trimOrNull(o.state, 2)?.toUpperCase() ?? null,
          territories: (o.territories ?? []).map((t) => String(t).trim()).filter(Boolean).slice(0, 200),
          brand_overrides: o.brandOverrides ?? {}, settings: o.settings ?? {}, seat_cap: o.seatCap ?? null,
          status: "active", created_by_user_id: p.actorUserId ?? p.ownerUserId,
        }).select("id").single()
        if (insErr || !made) { rec.errors.push(`office ${o.code}: create refused (${insErr?.message ?? "no row"})`); continue }
        officeId = (made as { id: string }).id
      }
      rec.offices.push({ code: o.code, id: officeId, name: o.name })
      // 3. The office's teams — reused from the prior record by key, never looked up by name.
      for (const [ti, t] of (o.teams ?? []).entries()) {
        const name = trimOrNull(t?.name)
        if (!name) continue
        const key = `${o.code}#${ti}`
        const reused = prior?.teams.find((x) => x.key === key && x.locationId === officeId)
        if (reused) { rec.teams.push(reused); continue }
        const { data: team, error: tErr } = await svc.from("teams").insert({ brokerage_id: p.brokerageId, name, location_id: officeId }).select("id").single()
        if (tErr || !team) { rec.errors.push(`team ${key}: create refused (${tErr?.message ?? "no row"})`); continue }
        rec.teams.push({ key, id: (team as { id: string }).id, name, locationId: officeId })
      }
    }
  }

  // 3b. TEAM TIER: the team is the tenant's own — anchored on the team_lead_id FACT (provisionTenantOwner creates it on
  //     the live path); a missing one is created here, and the owner holds team leadership on it.
  if (p.tier === "team" && p.source === "provisioning") {
    const { data: led, error: ledErr } = await svc.from("teams").select("id, name, location_id").eq("brokerage_id", p.brokerageId).eq("team_lead_id", p.ownerUserId).is("deleted_at", null).limit(1)
    if (ledErr) rec.errors.push(`owner team read refused (${ledErr.message})`)
    else {
      let teamId = ((led ?? [])[0] as { id: string } | undefined)?.id ?? null
      if (!teamId) {
        const { data: made, error: mErr } = await svc.from("teams").insert({ brokerage_id: p.brokerageId, name: p.brokerageName, team_lead_id: p.ownerUserId }).select("id").single()
        if (mErr || !made) rec.errors.push(`owner team create refused (${mErr?.message ?? "no row"})`)
        else teamId = (made as { id: string }).id
      }
      if (teamId) {
        rec.teams.push({ key: "owner#0", id: teamId, name: p.brokerageName, locationId: null })
        await grant({ userId: p.ownerUserId, scope: "team", teamId, access: "leadership" }, "owner team leadership")
      }
    }
  }

  // 4. Members: invite NOW (or place an existing same-tenant user), then pin the office and record the memberships.
  for (const [mi, m] of (p.input?.members ?? []).entries()) {
    const key = m.existingUserId ? `user:${m.existingUserId}` : `email:${String(m.email ?? "").trim().toLowerCase() || mi}`
    const prev = prior?.members.find((x) => x.key === key && x.status === "placed")
    if (prev) { rec.members.push(prev); continue }
    const placed = await placeSeat(svc, p, m, rec, deps)
    rec.members.push({ key, ...placed })
    if (placed.status === "failed") rec.errors.push(`${key}: ${placed.error}`)
  }

  rec.complete = rec.errors.length === 0
  rec.at = new Date().toISOString()
  await routeStructureOutcome(svc, p, rec, deps)
  return rec
}

async function placeSeat(svc: Svc, p: ProvisionStructureParams, m: StructureMemberInput, rec: TenantStructureRecord, deps: StructureDeps): Promise<Omit<TenantStructureRecord["members"][number], "key">> {
  // Resolve the office + team INSIDE this tenant (by code / input-local team name / verified id).
  let locationId: string | null = null
  if (m.officeCode) {
    locationId = rec.offices.find((o) => o.code === String(m.officeCode).toLowerCase())?.id ?? null
    if (!locationId) return { status: "failed", error: `office code "${m.officeCode}" is not one of this workspace's offices` }
  } else if (m.locationId) {
    const { data, error } = await svc.from("locations").select("id").eq("id", m.locationId).eq("brokerage_id", p.brokerageId).limit(1)
    if (error) return { status: "failed", error: `office read refused (${error.message})` }
    if (!(data ?? []).length) return { status: "failed", error: "that office is not one of this workspace's offices" }
    locationId = m.locationId
  }
  let teamId: string | null = null
  if (m.teamName) {
    const t = rec.teams.find((x) => x.name === m.teamName && (locationId ? x.locationId === locationId : true))
    if (!t) return { status: "failed", error: `team "${m.teamName}" is not a team of ${locationId ? "that office" : "this workspace"} in this structure` }
    teamId = t.id
  } else if (m.teamId) {
    const { data, error } = await svc.from("teams").select("id, location_id").eq("id", m.teamId).eq("brokerage_id", p.brokerageId).is("deleted_at", null).limit(1)
    if (error) return { status: "failed", error: `team read refused (${error.message})` }
    const row = (data ?? [])[0] as { id: string; location_id: string | null } | undefined
    if (!row) return { status: "failed", error: "that team is not a team of this workspace" }
    if (locationId && row.location_id && row.location_id !== locationId) return { status: "failed", error: "that team works out of another office" }
    teamId = row.id
    locationId = locationId ?? row.location_id ?? null
  }

  // The person: an EXISTING user must already sit in THIS tenant (never captured by a name or an email typed here).
  let userId: string | null = null
  if (m.existingUserId) {
    const { data, error } = await svc.from("users").select("id, brokerage_id").eq("id", m.existingUserId).maybeSingle()
    if (error) return { status: "failed", error: `user read refused (${error.message})` }
    const row = data as { id: string; brokerage_id: string | null } | null
    if (!row || row.brokerage_id !== p.brokerageId) return { status: "failed", error: "that person is not a member of this workspace — only the consented transfer rail moves a person between workspaces" }
    userId = row.id
  }

  if (locationId) {
    const { locationSeatGate } = await import("@/lib/kernel/seat-usage")
    const seat = await locationSeatGate(svc, p.brokerageId, locationId, { subjectUserId: userId })
    if (!seat.allowed) return { status: "failed", locationId, teamId, error: seat.message ?? seat.reason }
  }

  if (!userId) {
    const email = String(m.email ?? "").trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { status: "failed", error: "a valid email is required to invite a new member" }
    const invite = deps.invite ?? (async (a: Parameters<NonNullable<StructureDeps["invite"]>>[0]) => {
      const { inviteTenantMember } = await import("@/lib/kernel/users")
      return inviteTenantMember({ brokerageId: a.brokerageId, teamId: a.teamId, email: a.email, firstName: a.firstName, lastName: a.lastName, userType: a.userType as never, callerUserId: a.callerUserId, client: a.client as never })
    })
    const r = await invite({ brokerageId: p.brokerageId, teamId, email, firstName: trimOrNull(m.firstName) ?? "", lastName: trimOrNull(m.lastName) ?? "", userType: m.userType, callerUserId: p.actorUserId ?? p.ownerUserId, client: svc })
    if (!r.success || !r.userId) return { status: "failed", locationId, teamId, error: `invite refused: ${r.error ?? "unknown"}` }
    userId = r.userId
  }

  // A MOVE (reassign): end the person's other office placements in this tenant first — stamped with the actor and the
  // move as evidence, counted. Only for an existing user (a new invitee holds nothing to move).
  if (m.reassign && locationId && m.existingUserId) {
    const rv = await revokeScopeMemberships(svc, {
      brokerageId: p.brokerageId, userId, actorUserId: p.actorUserId, scopes: ["location", "team"], keep: { locationId, teamId },
      evidence: { ...(p.evidence ?? {}), reason: "reassigned", reassigned_to_location_id: locationId, reassigned_to_team_id: teamId, source: p.source },
    })
    if (!rv.ok) return { status: "failed", userId, locationId, teamId, error: `reassignment refused: ${rv.error}` }
    rec.revoked = (rec.revoked ?? 0) + rv.revoked
  }

  // Pin the office (the person's office of record, users.location_id m423) — COUNTED, pinned to this tenant.
  if (locationId) {
    const { data: pinned, error: pinErr } = await svc.from("users").update({ location_id: locationId, updated_at: new Date().toISOString() }).eq("id", userId).eq("brokerage_id", p.brokerageId).select("id")
    if (pinErr) return { status: "failed", userId, locationId, teamId, error: `office pin refused (${pinErr.message})` }
    if ((pinned ?? []).length !== 1) return { status: "failed", userId, locationId, teamId, error: "office pin matched no user row in this workspace" }
  }
  if (teamId && m.leadsTeam) {
    const { error: leadErr } = await svc.from("teams").update({ team_lead_id: userId, updated_at: new Date().toISOString() }).eq("id", teamId).eq("brokerage_id", p.brokerageId).is("team_lead_id", null).select("id")
    if (leadErr) return { status: "failed", userId, locationId, teamId, error: `team lead anchor refused (${leadErr.message})` }
  }

  const label = `member ${userId}`
  if (locationId && !(await grantFor(svc, p, rec, { userId, scope: "location", locationId, access: m.officeLeadership ? "leadership" : "member" }, `${label} office`))) return { status: "failed", userId, locationId, teamId, error: rec.errors[rec.errors.length - 1] }
  if (teamId && !(await grantFor(svc, p, rec, { userId, scope: "team", teamId, access: m.leadsTeam ? "leadership" : "member" }, `${label} team`))) return { status: "failed", userId, locationId, teamId, error: rec.errors[rec.errors.length - 1] }
  if (!locationId && !teamId && !(await grantFor(svc, p, rec, { userId, scope: "tenant", access: "member" }, `${label} tenant`))) return { status: "failed", userId, error: rec.errors[rec.errors.length - 1] }
  return { status: "placed", userId, locationId, teamId }
}

async function grantFor(svc: Svc, p: ProvisionStructureParams, rec: TenantStructureRecord, g: { userId: string; scope: MembershipScopeKind; locationId?: string | null; teamId?: string | null; access: MembershipAccessLevel }, label: string): Promise<boolean> {
  const r = await grantMembership(svc, { ...g, brokerageId: p.brokerageId, source: p.source === "provisioning" ? "invite" : p.source, grantedBy: p.actorUserId, evidence: p.evidence ?? null })
  if (!r.ok) { rec.errors.push(`${label}: ${r.error}`); return false }
  if (r.created) rec.memberships += 1
  return true
}

/** IMMEDIATE outcome: a gap is evidenced and routed to the Recruiting Manager (the roster's owner) and the RIGHT human is
 *  told — the office's managing broker when the failure belongs to one office, else the tenant owner. A clean run with
 *  members is evidenced as succeeded. Reporter failures never fail provisioning (the record holds the truth). */
async function routeStructureOutcome(svc: Svc, p: ProvisionStructureParams, rec: TenantStructureRecord, deps: StructureDeps): Promise<void> {
  if (rec.complete && rec.members.length === 0) return
  try {
    const report = deps.report ?? (await import("@/lib/kernel/immediate-operations")).reportOperationOutcome
    await report(svc, {
      operation: "seat_provisioning", brokerageId: p.brokerageId, ok: rec.complete, owner: "recruiting_manager",
      subjectType: "brokerage", subjectId: p.brokerageId, actorUserId: p.actorUserId, source: "system", platformVisible: p.source === "provisioning",
      evidence: { structure: { offices: rec.offices.length, teams: rec.teams.length, memberships: rec.memberships, placed: rec.members.filter((m) => m.status === "placed").length, failed: rec.members.filter((m) => m.status === "failed").length }, errors: rec.errors.slice(0, 10), source: p.source },
      error: rec.complete ? null : rec.errors.join(" | ").slice(0, 500),
      tenantFacing: rec.complete ? null : "some offices, teams or seats are still being set up — the OS is finishing them and your office manager has been told",
    })
  } catch (e) { console.warn("[tenant-structure] outcome not reported:", (e as Error)?.message) }
  if (rec.complete) return
  const failedOffice = rec.members.find((m) => m.status === "failed" && m.locationId)?.locationId ?? null
  let notifyUserId = p.ownerUserId
  if (failedOffice) {
    const { data, error } = await svc.from("locations").select("managing_broker_user_id").eq("id", failedOffice).eq("brokerage_id", p.brokerageId).maybeSingle()
    if (error) console.warn("[tenant-structure] office head read refused — the owner is told instead:", error.message)
    notifyUserId = (data as { managing_broker_user_id?: string | null } | null)?.managing_broker_user_id ?? p.ownerUserId
  }
  const { error: nErr } = await svc.from("notifications").insert({
    user_id: notifyUserId, brokerage_id: p.brokerageId, type: "seat_provisioning",
    title: "A seat or office still needs a hand",
    body: `Setting up your workspace left ${rec.errors.length} item${rec.errors.length === 1 ? "" : "s"} open: ${rec.errors.slice(0, 3).join("; ").slice(0, 400)}. Invitations that could go out already went out; the rest is retried automatically.`,
    priority: "high", is_read: false,
  })
  if (nErr) console.warn("[tenant-structure] manager notification refused:", nErr.message)
}
