// lib/compliance/vendor-respa.ts
//
// THE VENDOR RESPA COMPLIANCE LAYER — the marketplace's answer to the single biggest legal
// exposure of surfacing settlement-service vendors (lenders, title, attorneys, inspectors,
// appraisers, surveyors) to clients. RESPA (12 U.S.C. § 2601) prohibits kickbacks/unearned
// fees for referring settlement services and requires an affirmative disclosure whenever a
// brokerage steers a client toward a business it has a relationship with. Today the app shows a
// "Preferred" lender card to a buyer with ZERO disclosure and lets an agent record a flat
// referral fee against a title company — both real RESPA violations. This closes that.
//
// CONSOLIDATION (no new tables):
//   · Disclosure TEXT is versioned in the canonical `required_disclosures` table (disclosure_type
//     'respa_preferred_vendor' | 'respa_afba' | 'respa_kickback_notice'); the pure fallbacks below
//     guarantee real language even before a brokerage customizes it.
//   · Disclosure SHOWN / ACKNOWLEDGED events + REFERRAL-FEE BLOCKS land on the immutable
//     `compliance_events` ledger the Compliance Officer already owns (INSERT-only = the spec's
//     "disclosure records are immutable"). Same shape as lib/kernel/compliance-ledger.ts.
//   · AfBA (Affiliated Business Arrangement) config rides `brokerage_settings.settings` jsonb
//     (like staging_enabled) keyed by vendor — super-admin-set, no new table.
//
// NOT server-only — the simulator drives the pure layer directly; the service-layer functions take
// an injectable Supabase client so tests spend no tokens and clean up their own rows.

import type { createServiceClient } from "@/lib/supabase/service"
import { bestEffort } from "@/lib/db/best-effort"

type Svc = ReturnType<typeof createServiceClient>

// ─── Gate names on the compliance_events ledger ───────────────────────────────
export const RESPA_DISCLOSURE_GATE = "respa_vendor_disclosure"
export const RESPA_REFERRAL_GATE = "respa_referral_fee"

// ─── Settlement-service categories (RESPA-regulated) ──────────────────────────
// The app stores vendor categories in many spellings across `vendors` (CHECK: Lender|Inspector|
// Title Company|Contractor|Stager|Other) and `vendor_directory` / `referral_partners`
// (free-text: lender, title, attorney, home_inspector, …). We normalize then match, so a
// settlement vendor is caught regardless of which surface named it.
const SETTLEMENT_TOKENS: readonly string[] = [
  "mortgagelender", "lender", "mortgagebroker", "mortgage", "loanofficer",
  "titlecompany", "title", "titleinsurance", "escrow", "escrowofficer",
  "realestateattorney", "attorney", "lawyer", "closingattorney",
  "appraiser", "appraisal",
  "homeinspector", "inspector", "inspection",
  "surveyor", "survey",
]

/** Normalize any category / partner-type spelling to a comparable token. */
export function normalizeVendorCategory(raw: string | null | undefined): string {
  return (raw ?? "").toLowerCase().replace(/[^a-z]/g, "")
}

/**
 * PURE: is this vendor category a RESPA-regulated settlement service? Movers, photographers,
 * stagers, cleaners, landscapers, handymen, contractors, designers = NOT regulated (return false).
 */
export function isRespaRegulatedCategory(category: string | null | undefined): boolean {
  const n = normalizeVendorCategory(category)
  if (!n) return false
  // Exact-token or contains-token match (e.g. "titlecompany" contains "title";
  // "realestateattorney" contains "attorney"). Guard against false hits on non-settlement
  // words by requiring the token to be a whole-ish segment: contains is safe here because the
  // settlement tokens are distinctive ("title", "lender", "appraiser"…) and non-settlement
  // categories ("landscaper", "photographer", "stager", "cleaner") share none of them.
  return SETTLEMENT_TOKENS.some((t) => n === t || n.includes(t))
}

// ─── Fee types (the referral-fee guard) ───────────────────────────────────────
/** Fee arrangements that, against a settlement-service vendor, are prohibited kickbacks. */
const REFERRAL_FEE_TYPES: readonly string[] = ["flat_referral_fee", "commission_split", "referral_fee", "per_referral"]

export interface ReferralFeeVerdict {
  allowed: boolean
  /** Machine reason code — RESPA_VIOLATION_SETTLEMENT_REFERRAL when blocked. */
  code: string | null
  reason: string | null
}

/**
 * PURE: may this agent record a referral fee against this vendor category? The platform structurally
 * blocks any referral/kickback fee arrangement with a settlement-service (RESPA-regulated) vendor —
 * this is not policy text, it's a hard gate. Non-settlement (mover/cleaner/landscaper) fees are
 * ALLOWED (disclosure handled elsewhere). A vendor with NO fee arrangement is always allowed.
 */
export function evaluateReferralFee(input: {
  category: string | null | undefined
  /** Any positive flat fee or commission split constitutes a fee arrangement. */
  hasFee: boolean
  feeType?: string | null
}): ReferralFeeVerdict {
  if (!input.hasFee) return { allowed: true, code: null, reason: null }
  const regulated = isRespaRegulatedCategory(input.category)
  const feeType = (input.feeType ?? "flat_referral_fee").toLowerCase()
  const isReferralFee = REFERRAL_FEE_TYPES.includes(feeType) || input.hasFee
  if (regulated && isReferralFee) {
    return {
      allowed: false,
      code: "RESPA_VIOLATION_SETTLEMENT_REFERRAL",
      reason:
        "RESPA (12 U.S.C. § 2601) prohibits paying or receiving a fee for referring a settlement " +
        "service (lender, title, attorney, appraiser, inspector, surveyor). This fee arrangement is blocked.",
    }
  }
  return { allowed: true, code: null, reason: null }
}

// ─── Disclosure resolution ─────────────────────────────────────────────────────
export type VendorDisclosureType = "afba" | "preferred_settlement" | "preferred_general" | null

export interface VendorRespaDisclosure {
  type: Exclude<VendorDisclosureType, null>
  text: string
  /** AfBA requires the client to acknowledge BEFORE vendor contact info is revealed. */
  acknowledgmentRequired: boolean
  regulated: boolean
}

export interface DisclosureTextOverrides {
  preferred?: string | null
  afba?: string | null
  kickbackNotice?: string | null
}

/** PURE fallback: the standard preferred-vendor RESPA disclosure (shown inline on every preferred card). */
export function standardPreferredDisclosure(args: { brokerageName?: string | null; vendorName?: string | null }): string {
  const b = (args.brokerageName?.trim() || "This brokerage")
  const v = (args.vendorName?.trim() || "this vendor")
  return (
    `${b} has a business relationship with ${v}. You are not required to use ${v} as a condition of ` +
    `your home purchase, sale, or listing. There are often other settlement service providers available ` +
    `with similar services. You are free to shop around to determine that you are receiving the best ` +
    `services and the best rate for these services.`
  )
}

/** PURE fallback: the RESPA kickback notice shown to an agent who tries to add a settlement referral fee. */
export function respaKickbackNotice(): string {
  return (
    `This platform does not facilitate referral fees or kickbacks for settlement service providers ` +
    `(mortgage lenders, title companies, attorneys, inspectors, appraisers, surveyors) as required by ` +
    `RESPA (12 U.S.C. § 2601). If you have been offered a fee for referring a client to a settlement ` +
    `service provider, do not accept it and report it to your broker immediately.`
  )
}

/** PURE fallback: the full AfBA disclosure (must be acknowledged before contact info is revealed). */
export function afbaDisclosure(args: { brokerageName?: string | null; vendorName?: string | null; relationship?: string | null }): string {
  const b = (args.brokerageName?.trim() || "This brokerage")
  const v = (args.vendorName?.trim() || "this vendor")
  const rel = (args.relationship?.trim() || "has a business arrangement with")
  return (
    `IMPORTANT NOTICE: ${b} ${rel} ${v}. This business arrangement may create a conflict of interest. ` +
    `Because of this relationship, this referral may provide ${b} with a financial or other benefit. ` +
    `YOU ARE NOT REQUIRED TO USE ${v} AS A CONDITION OF YOUR HOME PURCHASE OR SALE. THERE ARE FREQUENTLY ` +
    `OTHER SETTLEMENT SERVICE PROVIDERS AVAILABLE WITH SIMILAR SERVICES. YOU ARE FREE TO SHOP AROUND TO ` +
    `DETERMINE THAT YOU ARE RECEIVING THE BEST SERVICES AND THE BEST RATE FOR THESE SERVICES.`
  )
}

/**
 * PURE: which RESPA disclosure (if any) must be shown when THIS vendor is surfaced to a CLIENT?
 *   · AfBA-configured vendor → the full AfBA disclosure, acknowledgment required before contact reveal.
 *   · preferred + settlement-regulated → the standard preferred disclosure (display inline; no gate).
 *   · preferred + non-regulated → a lighter general preferred note (business relationship transparency).
 *   · non-preferred, non-regulated, non-AfBA → null (nothing required).
 * A non-preferred but REGULATED vendor shown to a client still gets the standard disclosure (the app
 * is steering — the disclosure attaches to the surfacing, not only to the "preferred" flag).
 */
export function resolveVendorDisclosure(input: {
  category: string | null | undefined
  preferred: boolean
  afbaConfigured?: boolean
  brokerageName?: string | null
  vendorName?: string | null
  overrides?: DisclosureTextOverrides
}): VendorRespaDisclosure | null {
  const regulated = isRespaRegulatedCategory(input.category)
  const nameArgs = { brokerageName: input.brokerageName, vendorName: input.vendorName }

  if (input.afbaConfigured) {
    return {
      type: "afba",
      text: fill(input.overrides?.afba, afbaDisclosure(nameArgs), nameArgs),
      acknowledgmentRequired: true,
      regulated,
    }
  }
  if (regulated) {
    return {
      type: "preferred_settlement",
      text: fill(input.overrides?.preferred, standardPreferredDisclosure(nameArgs), nameArgs),
      acknowledgmentRequired: false,
      regulated: true,
    }
  }
  if (input.preferred) {
    return {
      type: "preferred_general",
      text: fill(input.overrides?.preferred, standardPreferredDisclosure(nameArgs), nameArgs),
      acknowledgmentRequired: false,
      regulated: false,
    }
  }
  return null
}

/** Interpolate {brokerage}/{vendor} tokens in a stored disclosure override; else use the fallback. */
function fill(
  override: string | null | undefined,
  fallback: string,
  args: { brokerageName?: string | null; vendorName?: string | null },
): string {
  if (!override || !override.trim()) return fallback
  return override
    .replace(/\{brokerage(?:_name)?\}|\[Brokerage Name\]/gi, args.brokerageName?.trim() || "This brokerage")
    .replace(/\{vendor(?:_name)?\}|\[Vendor Name\]/gi, args.vendorName?.trim() || "this vendor")
}

// ─── The immutable event row (mirrors lib/kernel/compliance-ledger.ts) ─────────
export interface RespaEventRow {
  brokerage_id: string | null
  gate_name: string
  entity_type: string
  entity_id: string | null
  actor_user_id: string | null
  actor_role: string
  message_type: string
  allowed: boolean
  severity: "clear" | "advisory" | "blocked"
  blocked_reason: string | null
  violations: string[]
  details: Record<string, unknown>
  created_at: string
}

/** PURE: build a disclosure SHOWN / ACKNOWLEDGED event (allowed=true; the audit trail of steering). */
export function buildDisclosureEvent(input: {
  brokerageId: string
  vendorId: string
  actorUserId: string | null
  actorRole: string
  disclosureType: Exclude<VendorDisclosureType, null>
  action: "shown" | "acknowledged"
  contactId?: string | null
  now?: Date
}): RespaEventRow {
  return {
    brokerage_id: input.brokerageId,
    gate_name: RESPA_DISCLOSURE_GATE,
    entity_type: "vendor",
    entity_id: input.vendorId,
    actor_user_id: input.actorUserId,
    actor_role: input.actorRole,
    message_type: input.action,
    allowed: true,
    severity: "clear",
    blocked_reason: null,
    violations: [],
    details: { disclosure_type: input.disclosureType, action: input.action, contact_id: input.contactId ?? null },
    created_at: (input.now ?? new Date()).toISOString(),
  }
}

/** PURE: build a referral-fee BLOCK event (allowed=false; the defensible record that a kickback was refused). */
export function buildReferralBlockEvent(input: {
  brokerageId: string | null
  actorUserId: string | null
  actorRole: string
  vendorCategory: string | null | undefined
  partnerName?: string | null
  verdict: ReferralFeeVerdict
  now?: Date
}): RespaEventRow {
  return {
    brokerage_id: input.brokerageId,
    gate_name: RESPA_REFERRAL_GATE,
    entity_type: "referral_partner",
    // No partner row exists yet (we block BEFORE the insert) — entity_id is a nullable uuid, so the
    // blocked category/partner live in details, not entity_id (a category string is not a uuid).
    entity_id: null,
    actor_user_id: input.actorUserId,
    actor_role: input.actorRole,
    message_type: "blocked",
    allowed: false,
    severity: "blocked",
    blocked_reason: input.verdict.reason,
    violations: input.verdict.code ? [input.verdict.code] : [],
    details: { category: input.vendorCategory ?? null, partner_name: input.partnerName ?? null },
    created_at: (input.now ?? new Date()).toISOString(),
  }
}

// ─── Service layer (injectable client; best-effort audit never blocks the caller) ──

/** Load a brokerage's customized RESPA disclosure text (canonical `required_disclosures`); pure fallbacks fill gaps. */
export async function loadRespaDisclosureOverrides(svc: Svc): Promise<DisclosureTextOverrides> {
  try {
    const { data } = await svc
      .from("required_disclosures")
      .select("disclosure_type, disclosure_text, is_active")
      .in("disclosure_type", ["respa_preferred_vendor", "respa_afba", "respa_kickback_notice"])
      .eq("is_active", true)
    const rows = (data ?? []) as Array<{ disclosure_type: string; disclosure_text: string }>
    const byType = new Map(rows.map((r) => [r.disclosure_type, r.disclosure_text]))
    return {
      preferred: byType.get("respa_preferred_vendor") ?? null,
      afba: byType.get("respa_afba") ?? null,
      kickbackNotice: byType.get("respa_kickback_notice") ?? null,
    }
  } catch {
    return {}
  }
}

/**
 * Read the brokerage's AfBA configuration for a vendor (super-admin-set, on brokerage_settings.settings
 * jsonb → 'vendor_afba' keyed by vendor id or normalized name). Default: not configured.
 */
export async function loadAfbaConfig(
  svc: Svc,
  brokerageId: string,
): Promise<{ isConfigured: (vendor: { id?: string | null; name?: string | null }) => { configured: boolean; relationship?: string | null } }> {
  let bag: Record<string, unknown> = {}
  try {
    const { data } = await svc.from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle()
    bag = (((data as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as any).vendor_afba ?? {}
  } catch { bag = {} }
  return {
    isConfigured: (vendor) => {
      const keys = [vendor.id, vendor.name ? `name:${normalizeVendorCategory(vendor.name)}` : null].filter(Boolean) as string[]
      for (const k of keys) {
        const entry = (bag as any)[k]
        if (entry) return { configured: true, relationship: typeof entry === "object" ? (entry.relationship ?? null) : null }
      }
      return { configured: false }
    },
  }
}

/** Record a disclosure SHOWN event, deduped per (brokerage, vendor, contact, day). Best-effort. */
export async function logVendorDisclosureShown(
  svc: Svc,
  input: { brokerageId: string; vendorId: string; contactId: string | null; actorUserId: string | null; actorRole: string; disclosureType: Exclude<VendorDisclosureType, null> },
): Promise<{ recorded: boolean }> {
  try {
    const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0)
    const { data: existing } = await svc
      .from("compliance_events")
      .select("id")
      .eq("gate_name", RESPA_DISCLOSURE_GATE)
      .eq("entity_id", input.vendorId)
      .eq("message_type", "shown")
      .gte("created_at", dayStart.toISOString())
      .contains("details", { contact_id: input.contactId })
      .limit(1)
      .maybeSingle()
    if (existing) return { recorded: false }
    const row = buildDisclosureEvent({
      brokerageId: input.brokerageId, vendorId: input.vendorId, actorUserId: input.actorUserId,
      actorRole: input.actorRole, disclosureType: input.disclosureType, action: "shown", contactId: input.contactId,
    })
    const { error } = await svc.from("compliance_events").insert(row)
    return { recorded: !error }
  } catch {
    return { recorded: false }
  }
}

/** Record an immutable disclosure ACKNOWLEDGMENT (AfBA gate / explicit client ack). Best-effort. */
export async function recordVendorDisclosureAcknowledgment(
  svc: Svc,
  input: { brokerageId: string; vendorId: string; contactId: string | null; actorUserId: string | null; actorRole: string; disclosureType: Exclude<VendorDisclosureType, null> },
): Promise<{ recorded: boolean }> {
  try {
    const row = buildDisclosureEvent({
      brokerageId: input.brokerageId, vendorId: input.vendorId, actorUserId: input.actorUserId,
      actorRole: input.actorRole, disclosureType: input.disclosureType, action: "acknowledged", contactId: input.contactId,
    })
    const { error } = await svc.from("compliance_events").insert(row)
    return { recorded: !error }
  } catch {
    return { recorded: false }
  }
}

/**
 * THE REFERRAL-FEE GATE — evaluate whether a referral fee against this vendor is RESPA-permitted;
 * on a block, record the immutable refusal on the ledger. Returns the verdict so the caller can
 * throw / surface the kickback notice. Never throws (audit failure must not mask the block decision).
 */
export async function guardVendorReferralFee(
  svc: Svc,
  input: {
    brokerageId: string | null
    actorUserId: string | null
    actorRole: string
    category: string | null | undefined
    partnerName?: string | null
    hasFee: boolean
    feeType?: string | null
  },
): Promise<ReferralFeeVerdict> {
  const verdict = evaluateReferralFee({ category: input.category, hasFee: input.hasFee, feeType: input.feeType })
  if (!verdict.allowed) {
    try {
      const row = buildReferralBlockEvent({
        brokerageId: input.brokerageId, actorUserId: input.actorUserId, actorRole: input.actorRole,
        vendorCategory: input.category, partnerName: input.partnerName, verdict,
      })
      await bestEffort(
        svc.from("compliance_events").insert(row),
        "the RESPA referral-fee BLOCK must stand even when its ledger row cannot be written — the verdict returned below is what refuses the kickback, and making the audit echo able to throw here would turn a ledger outage into a gate that stops refusing",
      )
    } catch { /* audit best-effort; the block still stands */ }
  }
  return verdict
}
