// lib/vendors/vendor-platform-identity.ts
//
// ═══════════════════════════════════════════════════════════════════════════
// A VENDOR IS SHARED, AND A SHARED VENDOR IS CHARGED FOR PLATFORM USE ONCE
// ═══════════════════════════════════════════════════════════════════════════
//
// OWNER RULING, verbatim:
//
//   "vendors whcih include title companies and lenders can be used by other
//    brokerages so if a vendor is already on the platform, the brokerage/team/
//    agent can't charge them for platform use only access to their contacts."
//
// TWO HALVES, and the second is a MONEY rule.
//
//   (a) A VENDOR IS SHARED. A title company or a lender is used by more than one
//       brokerage. It is a PLATFORM-level company, not a tenant-owned row.
//
//   (b) A VENDOR ALREADY PAYING FOR PLATFORM USE MUST NOT BE CHARGED AGAIN.
//       The second brokerage/team/agent gets CONTACT ACCESS ONLY. A second
//       platform-use charge on the same vendor is a wrong invoice, and CLAUDE.md
//       §5 already rules that a wrong number there is a wrong invoice.
//
// ── WHAT THE TENANCY MODEL ACTUALLY IS (measured, not assumed) ──────────────
//
// `vendors.brokerage_id` is NOT a mis-named column and its rows are NOT
// duplicates to be merged. It is a TENANT BENCH ANCHOR, and it is load-bearing:
//
//   · Live RLS is  SELECT (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id())
//     / INSERT,UPDATE,DELETE (brokerage_id = current_user_brokerage_id()).
//     One tenant's bench row is INVISIBLE to another tenant. That is the boundary
//     CLAUDE.md §5 requires ("vendors see no financials — only their own"), and it
//     is why a shared vendor cannot become "any tenant reads any vendor's data".
//   · The row carries genuinely PER-TENANT facts: notes, rating, preferred,
//     display_priority, visible_in_portal, audience_tags, stage_tags,
//     access_level, access_expires_at, invited_by_user_id/team_id. It is also the
//     FK parent of that tenant's vendor_assignments, vendor_invoices,
//     vendor_bookings and vendor_subscriptions.
//
// So MERGING two brokerages' rows onto one survivor (CLAUDE.md §1.1) would fuse
// two tenants' books and two tenants' private notes into one row every tenant can
// see. §1.1 is the wrong remedy here, and saying so is the finding.
//
// WHAT IS ACTUALLY MISSING is the half that says WHICH BENCH ROWS ARE THE SAME
// REAL COMPANY. Today nothing does, and the platform therefore CANNOT EVEN ASK
// whether a vendor is already paying:
//
//   · vendors has no cross-tenant key at all (measured: no unique on name, no
//     link column; vendor-verification.ts:33 dedupes only WITHIN one brokerage,
//     so a cross-tenant duplicate of one real title company is invisible by design).
//   · The one existing join to the platform identity —
//     user_role_assignments.vendor_id — is 1:1 BY CONSTRUCTION:
//     acceptVendorInviteAction deletes any prior vendor assignment before
//     inserting (app/actions/vendor-invite.ts:322) and hard-refuses a vendor user
//     already tied to another brokerage (:296, "vendor cross-brokerage support is
//     intentionally NOT implemented here"). So it can never express half (a).
//
// CLAUDE.md §1.2 — no duplicate exists and the capability is wanted — BUILD the
// missing half. And §1.1 first: the platform-level vendor identity ALREADY EXISTS
// as the survivor, so nothing new is minted beside it. `vendor_marketplace_profiles`
// is globally unique on company_name, has NO brokerage_id (it is not a tenant row),
// and carries subscription_tier / subscription_status / stripe_* — it IS
// VENDOR_PLATFORM_TIER, the "vendor pays the platform" fact. What m549 adds is the
// LINK: vendors.platform_vendor_id → vendor_marketplace_profiles(id).
//
// The many-to-many is then the bench itself — SELECT brokerage_id FROM vendors
// WHERE platform_vendor_id = $1 — so no third spelling of "which brokerages use
// this vendor" is introduced (CLAUDE.md §6).
//
// ── THE ANSWER CROSSES THE TENANT LINE; THE DATA DOES NOT ───────────────────
//
// Deciding (b) requires looking at arrangements that belong to OTHER tenants. The
// resolver below therefore runs on a SERVICE client — and returns a BOOLEAN and a
// non-identifying reason. It never returns the other brokerage's id, name, plan or
// amount, and no caller can obtain them through it. A tenant learns "this vendor
// already pays someone for platform use", which is the fact it needs to not raise
// a second invoice, and nothing more.
//
// ── FAIL CLOSED (CLAUDE.md §4) ──────────────────────────────────────────────
//
// An unwanted charge is harder to undo than a missing one. So when the platform
// cannot DETERMINE whether a vendor already pays — a refused or errored read, or a
// bench row with no identity to resolve at all — the charge is REFUSED, not raised.
// "Nobody checked" must never render as "checked and fine".
//
// Note what is NOT undeterminable: successfully asking and finding NO platform
// profile is a determinate answer of "not paying", and the charge proceeds. That
// is why this gate does not brick the charge lane on the day it lands.

import type { createServiceClient } from "@/lib/supabase/service"
import { VENDOR_PACKAGE, VENDOR_PLATFORM_TIER } from "@/lib/vendors/vendor-money-directions"

type ServiceClient = ReturnType<typeof createServiceClient>

// ─── Vocabulary (pure) ───────────────────────────────────────────────────────

/**
 * The `vendor_marketplace_profiles.subscription_status` values that mean the
 * vendor IS currently paying the platform for platform use. Drawn from the ONE
 * vendor status vocabulary in lib/kernel/vendor-subscription.ts
 * (SubscriptionStatus = active | past_due | canceled | trialing), not retyped
 * beside it as a fourth spelling.
 *
 * `trialing` counts as paying ON PURPOSE: a trial is a live platform-use
 * arrangement the vendor is inside, and charging them for a second one during it
 * is the exact double charge. `past_due` and `canceled` do NOT count — the
 * arrangement has lapsed, so there is nothing being charged twice.
 */
export const PLATFORM_USE_PAYING_STATUSES: ReadonlySet<string> = new Set(["active", "trialing"])

/**
 * `vendor_subscriptions.status` values that mean a BROKERAGE's platform-use
 * package is live. Live CHECK is (active | paused | canceled); only `active` is a
 * running arrangement — a paused one is not currently charging.
 */
export const PLATFORM_USE_ACTIVE_ENROLMENT_STATUSES: ReadonlySet<string> = new Set(["active"])

/** Who the vendor is ALREADY paying for platform use. Never names which tenant. */
export type PlatformUsePayee = "platform" | "another_tenant"

export type PlatformUseRefusalCode =
  | "already_paying_platform"
  | "already_paying_another_tenant"
  | "undeterminable"

// ─── The facts a verdict is computed from ────────────────────────────────────

export interface PlatformUseFacts {
  /**
   * TRUE only when every question below was actually ANSWERED. False means a read
   * was refused, errored, or there was no identity to resolve — and then nothing
   * else in this object may be trusted.
   */
  resolved: boolean
  /** Why resolution failed, in a sentence a tenant can act on. Null when resolved. */
  unresolvedReason: string | null
  /** The platform vendor identity this bench row resolves to; null when the vendor has none. */
  platformVendorId: string | null
  /** vendor_marketplace_profiles.subscription_status for that identity; null when no profile. */
  platformSubscriptionStatus: string | null
  /**
   * How many OTHER tenants already hold a live platform-use enrolment with this
   * same platform vendor. A COUNT, deliberately — the identities stay on the
   * service side of the line.
   */
  otherTenantActiveEnrolments: number
  /**
   * What the resolver could NOT see, published beside the number (CLAUDE.md §2).
   * e.g. "vendors.platform_vendor_id absent (m549 not applied)".
   */
  blindSpots: string[]
}

export type PlatformUseChargeVerdict =
  | { chargeable: true; reason: string }
  | {
      chargeable: false
      refusalCode: PlatformUseRefusalCode
      /** null for `undeterminable` — we do not know who, that is the point. */
      alreadyPaying: PlatformUsePayee | null
      reason: string
    }

// ─── THE RULE (pure — this is the function the mutation test removes) ────────

/**
 * PURE. Given the facts, may a tenant raise a PLATFORM-USE charge against this
 * vendor?
 *
 * Order matters and is not cosmetic: the fail-closed leg is FIRST, so a resolver
 * that could not answer can never fall through into "nothing found, go ahead".
 * That fall-through is precisely how an absence assertion turns into a clean bill
 * of health (CLAUDE.md §2).
 */
export function platformUseChargeVerdict(facts: PlatformUseFacts): PlatformUseChargeVerdict {
  if (!facts.resolved) {
    return {
      chargeable: false,
      refusalCode: "undeterminable",
      alreadyPaying: null,
      reason:
        `Refused: we could not determine whether this vendor already pays for platform use ` +
        `(${facts.unresolvedReason ?? "resolution failed"}). An unwanted charge is harder to undo ` +
        `than a missing one, so nothing was billed.`,
    }
  }

  if (
    facts.platformSubscriptionStatus !== null &&
    PLATFORM_USE_PAYING_STATUSES.has(facts.platformSubscriptionStatus)
  ) {
    return {
      chargeable: false,
      refusalCode: "already_paying_platform",
      alreadyPaying: "platform",
      reason:
        `This vendor already pays the platform for platform use (${VENDOR_PLATFORM_TIER.id}), so it ` +
        `cannot be charged for platform use again. Grant contact access instead — that is free.`,
    }
  }

  if (facts.otherTenantActiveEnrolments > 0) {
    return {
      chargeable: false,
      refusalCode: "already_paying_another_tenant",
      alreadyPaying: "another_tenant",
      reason:
        `This vendor is already on the platform through another brokerage and pays for platform use ` +
        `there (${VENDOR_PACKAGE.id}), so it cannot be charged for platform use again. Grant contact ` +
        `access instead — that is free.`,
    }
  }

  return {
    chargeable: true,
    reason: "This vendor holds no live platform-use arrangement, so a platform-use charge is allowed.",
  }
}

// ─── Live resolution ─────────────────────────────────────────────────────────

/** A read that failed for a reason that means "the column is not there yet". */
function isMissingColumn(message: string | undefined | null): boolean {
  const m = (message ?? "").toLowerCase()
  return m.includes("does not exist") || m.includes("42703") || m.includes("could not find")
}

/**
 * LIVE. Establish the vendor's PLATFORM identity and whether it is already paying
 * for platform use, from the perspective of `brokerageId` (the tenant that wants
 * to charge).
 *
 * Service client REQUIRED and taken as a parameter (the accounting-scopes idiom,
 * so the simulator can stub it): the sibling bench rows this must count live under
 * other tenants' RLS and are invisible to the caller's own client. Gate first,
 * then call this — every caller already proved the vendor is on ITS OWN bench.
 *
 * Every `{ data, error }` is destructured and the error READ. supabase-js resolves
 * a refusal, and a swallowed refusal here would read as "found nothing" — which is
 * the answer that raises the duplicate invoice.
 */
export async function readVendorPlatformUseFacts(
  svc: ServiceClient,
  args: { vendorId: string; brokerageId: string },
): Promise<PlatformUseFacts> {
  const blindSpots: string[] = []
  const unresolved = (why: string): PlatformUseFacts => ({
    resolved: false,
    unresolvedReason: why,
    platformVendorId: null,
    platformSubscriptionStatus: null,
    otherTenantActiveEnrolments: 0,
    blindSpots,
  })

  if (!args.vendorId || !args.brokerageId) {
    return unresolved("a vendor id and a charging brokerage id are both required")
  }

  // 1. The bench row. Columns that have always existed, so this read cannot fail
  //    for a pre-migration reason and a failure here is a genuine refusal.
  const { data: vendorRow, error: vendorErr } = await svc
    .from("vendors")
    .select("id, brokerage_id, email")
    .eq("id", args.vendorId)
    .maybeSingle()
  if (vendorErr) return unresolved(`the vendor record could not be read: ${vendorErr.message}`)
  if (!vendorRow) return unresolved("that vendor record was not found")

  // 2. The explicit link (m549). Read SEPARATELY so its absence is a known
  //    pre-migration state — a published blind spot — rather than an unknown that
  //    would refuse every charge on the day before the migration lands.
  let platformVendorId: string | null = null
  {
    const { data: linkRow, error: linkErr } = await svc
      .from("vendors")
      .select("platform_vendor_id")
      .eq("id", args.vendorId)
      .maybeSingle()
    if (linkErr) {
      if (!isMissingColumn(linkErr.message)) {
        return unresolved(`the vendor's platform link could not be read: ${linkErr.message}`)
      }
      blindSpots.push(
        "vendors.platform_vendor_id absent — m549 not applied; falling back to portal-grant and email resolution",
      )
    } else {
      platformVendorId = (linkRow as { platform_vendor_id: string | null } | null)?.platform_vendor_id ?? null
    }
  }

  // 3. Fallback A — the portal grant. user_role_assignments.vendor_id is the
  //    canonical vendor-portal linkage; its user is the one whose marketplace
  //    profile carries the platform subscription.
  let identityAttempted = platformVendorId !== null
  if (!platformVendorId) {
    const { data: grants, error: grantErr } = await svc
      .from("user_role_assignments")
      .select("user_id")
      .eq("vendor_id", args.vendorId)
      .not("user_id", "is", null)
    if (grantErr) return unresolved(`the vendor's portal linkage could not be read: ${grantErr.message}`)
    const userIds = ((grants ?? []) as Array<{ user_id: string | null }>)
      .map((g) => g.user_id)
      .filter((u): u is string => !!u)
    if (userIds.length > 0) {
      identityAttempted = true
      const { data: profiles, error: profErr } = await svc
        .from("vendor_marketplace_profiles")
        .select("id")
        .in("user_id", userIds)
        .limit(1)
      if (profErr) return unresolved(`the vendor's platform account could not be read: ${profErr.message}`)
      platformVendorId = ((profiles ?? []) as Array<{ id: string }>)[0]?.id ?? null
    }
  }

  // 4. Fallback B — email. The platform-wide natural key for a vendor company;
  //    it is what vendor_invitations matches on and what the invite lane already
  //    REQUIRES before a vendor can be brought onto the platform at all.
  if (!platformVendorId && vendorRow.email) {
    identityAttempted = true
    const { data: userRows, error: userErr } = await svc
      .from("users")
      .select("id")
      .ilike("email", (vendorRow.email as string).trim())
    if (userErr) return unresolved(`the vendor's platform account could not be matched: ${userErr.message}`)
    const ids = ((userRows ?? []) as Array<{ id: string }>).map((u) => u.id)
    if (ids.length > 0) {
      const { data: profiles, error: profErr } = await svc
        .from("vendor_marketplace_profiles")
        .select("id")
        .in("user_id", ids)
        .limit(1)
      if (profErr) return unresolved(`the vendor's platform account could not be read: ${profErr.message}`)
      platformVendorId = ((profiles ?? []) as Array<{ id: string }>)[0]?.id ?? null
    }
  }

  // NO IDENTITY COULD EVEN BE ATTEMPTED. No link, no portal grant, and no email:
  // this bench row names a company the platform cannot recognise anywhere else,
  // so whether it already pays is genuinely unknowable. Fail closed — and say the
  // one thing that fixes it.
  if (!identityAttempted) {
    return unresolved(
      "this vendor record has no platform link, no portal account and no email address, so it cannot be " +
        "matched against vendors already on the platform — add an email to the vendor record first",
    )
  }

  // 5. Is that platform identity paying the PLATFORM?
  let platformSubscriptionStatus: string | null = null
  if (platformVendorId) {
    const { data: profile, error: statusErr } = await svc
      .from("vendor_marketplace_profiles")
      .select("subscription_status")
      .eq("id", platformVendorId)
      .maybeSingle()
    if (statusErr) {
      return unresolved(`the vendor's platform subscription could not be read: ${statusErr.message}`)
    }
    platformSubscriptionStatus =
      (profile as { subscription_status: string | null } | null)?.subscription_status ?? null
  }

  // 6. Is that platform identity paying ANOTHER TENANT? Only askable once the
  //    link exists — the sibling bench rows are found BY it.
  let otherTenantActiveEnrolments = 0
  if (platformVendorId) {
    const { data: siblings, error: sibErr } = await svc
      .from("vendors")
      .select("id, brokerage_id")
      .eq("platform_vendor_id", platformVendorId)
      .neq("id", args.vendorId)
    if (sibErr) {
      if (!isMissingColumn(sibErr.message)) {
        return unresolved(`the vendor's other brokerage benches could not be read: ${sibErr.message}`)
      }
      blindSpots.push(
        "vendors.platform_vendor_id absent — m549 not applied; another tenant's live enrolment cannot be seen",
      )
    } else {
      const otherIds = ((siblings ?? []) as Array<{ id: string; brokerage_id: string | null }>)
        .filter((s) => s.brokerage_id && s.brokerage_id !== args.brokerageId)
        .map((s) => s.id)
      if (otherIds.length > 0) {
        const { data: subs, error: subErr } = await svc
          .from("vendor_subscriptions")
          .select("id, status")
          .in("vendor_id", otherIds)
        if (subErr) {
          return unresolved(`another brokerage's enrolments could not be read: ${subErr.message}`)
        }
        otherTenantActiveEnrolments = ((subs ?? []) as Array<{ status: string | null }>).filter((s) =>
          PLATFORM_USE_ACTIVE_ENROLMENT_STATUSES.has(s.status ?? ""),
        ).length
      }
    }
  } else {
    blindSpots.push("no platform identity resolved — this vendor is not on the platform anywhere else")
  }

  return {
    resolved: true,
    unresolvedReason: null,
    platformVendorId,
    platformSubscriptionStatus,
    otherTenantActiveEnrolments,
    blindSpots,
  }
}

/**
 * LIVE + RULE, the ONE door every platform-use charge path goes through.
 *
 * Callers: enrolVendorInPackageAction (vendor_subscriptions),
 * offerPremiumPlacement and createVendorInvoice with billed_to='vendor'
 * (vendor_invoices — the one tenant→vendor ledger). m549's trigger stands behind
 * all three so a future writer that forgets this call is still refused by the
 * database.
 */
export async function assertVendorChargeableForPlatformUse(
  svc: ServiceClient,
  args: { vendorId: string; brokerageId: string },
): Promise<PlatformUseChargeVerdict> {
  // A thrown client (network, bad config) must REFUSE, not escape as a 500 that a
  // retry loop turns into a charge.
  let facts: PlatformUseFacts
  try {
    facts = await readVendorPlatformUseFacts(svc, args)
  } catch (err: any) {
    facts = {
      resolved: false,
      unresolvedReason: `the platform-use check itself failed: ${err?.message ?? "unknown error"}`,
      platformVendorId: null,
      platformSubscriptionStatus: null,
      otherTenantActiveEnrolments: 0,
      blindSpots: [],
    }
  }
  return platformUseChargeVerdict(facts)
}

/**
 * What the second tenant DOES get, named here so no caller has to guess and no
 * one builds a second, paid spelling of it. The ruling grants CONTACT ACCESS —
 * and grants it, rather than selling it. That capability already exists in full
 * (CLAUDE.md §1.3, functionality lives elsewhere):
 * app/actions/vendor-contact-access.ts :: assignVendorToContactAction, backed by
 * vendor_contact_assignments and public.vendor_has_contact_access().
 */
export const SHARED_VENDOR_CONTACT_ACCESS_SURFACE =
  "app/actions/vendor-contact-access.ts :: assignVendorToContactAction"

export const SHARED_VENDOR_CONTACT_ACCESS_VERDICT =
  "A vendor already paying for platform use is not charged again by a second brokerage, team or agent. " +
  "What the second tenant gets is ACCESS TO THEIR CONTACTS, granted through " +
  SHARED_VENDOR_CONTACT_ACCESS_SURFACE +
  " — and granted, not sold: the ruling names contact access as what replaces the charge, not as a " +
  "cheaper charge. Contact access carries no fee on any lane."
