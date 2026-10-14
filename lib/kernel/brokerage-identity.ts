// lib/kernel/brokerage-identity.ts
// ─────────────────────────────────────────────────────────────────────────────
// BROKERAGE IDENTITY — THE RULE AND ITS ONE EXCEPTION (wave 141, lane 141A).
//
// OWNER, 2026-10-14 (verbatim): "a solo agent/team may subscribe independently
// and DECLARE an affiliated brokerage name for business context — the brokerage
// is not a subscriber, the location is not on the platform, another unrelated
// tenant may share the brand, another location may subscribe later. BROKERAGE
// NAME MATCH IS NEVER PROOF OF SAME TENANT; never merge by name; identity uses
// canonical IDs + verified relationships."
//
// THE RULE: a tenant is identified by `brokerages.id` and nothing else. A name is
// a label — two unrelated tenants may carry the same brand, one brokerage may run
// several locations as several tenants, and a solo subscriber may name a
// brokerage that is not on the platform at all. Therefore NOTHING in the OS may
// associate, merge, route or de-duplicate tenants by `brokerages.name` (or by
// the declared affiliation below). The ONLY way two tenants become one
// relationship is the explicit, consented, verified transfer rail
// (lib/kernel/brokerage-transfer.ts), keyed on canonical ids.
//
// AUDITED AT 01a71c3c2 — where a name could have become an identity:
//   · lib/kernel/tenant-creation.ts createTenantCore: the duplicate-owner guard
//     reads users.email; the slug check reads brokerages.slug; the brokerage row
//     is inserted whatever its name — a same-name second tenant is a second
//     tenant (test:brokerage-identity proves it in memory).
//   · lib/platform/prospect-conversion.ts + prospect-capture.ts: prospects are
//     keyed by email / phone / id; `company` is carried as a label only.
//   · app/actions/onboarding/ensure-agent-brokerage.ts (adoptExistingOwner):
//     anchors the SESSION user to a minted tenant; never looks a brokerage up.
//   · lib/kernel/tenant-readiness.ts, self-healing, superadmin brokerage
//     management: every read is by id.
//   · app/api/internal/voice-command/route.ts create_tenant_user: resolved a
//     spoken brokerage NAME with `.ilike("name", …)` to a tenant id — the one
//     name-equality router in lib/ + app/. REMOVED (tombstone there names this
//     file); a spoken name is now refused with the id-or-act-as instruction.
//
// THE EXCEPTION, DECLARED NOT INFERRED: `brokerages.declared_affiliation` (m765)
// is the affiliation a solo/team subscriber DECLARES — name, optional licence /
// location / external reference — stored on their OWN tenant for business
// context (disclosures, the external-brokerage routing the disposition rule
// already keys on the on-platform flags). It has NO tenancy effect: no reader may
// match it against another tenant. The proof's stripped-source census holds the
// line: no `.from("brokerages")` read in lib/ or app/ filters on `name` or on
// `declared_affiliation`.
//
// WRITERS of the column: the tenant-creation core (an optional signup
// declaration, best-effort after the brokerage row exists — creation never fails
// on it) and the owner's settings card (app/actions/settings/brokerage-
// affiliation.ts). READERS: the same card, the transfer rail (as context on the
// request's evidence — never as a match key), tenant-readiness evidence.
// Until m765 is applied the write is refused (PGRST204) and reported, never
// swallowed (CLAUDE.md §3).

/** The declared affiliation shape — context fields only; no id of another tenant may ever sit here. */
export interface DeclaredAffiliation {
  /** The affiliated brokerage's name as the subscriber states it — a label, never an identity. */
  name: string
  dba?: string | null
  license_number?: string | null
  /** Two-letter USPS code. */
  license_state?: string | null
  city?: string | null
  /** Two-letter USPS code. */
  state?: string | null
  /** A reference the subscriber holds (an office code, an MLS office id) — opaque context. */
  external_ref?: string | null
  declared_at: string
  declared_by_user_id: string | null
  source: AffiliationSource
}

export type AffiliationSource = "signup" | "settings" | "prospect_conversion"

export interface DeclaredAffiliationInput {
  name: string
  dba?: string | null
  licenseNumber?: string | null
  licenseState?: string | null
  city?: string | null
  state?: string | null
  externalRef?: string | null
}

/** Keys that would turn a declaration into a tenancy claim. Refused at the door, whatever the caller. */
export const AFFILIATION_FORBIDDEN_KEYS: readonly string[] = ["brokerage_id", "brokerageId", "tenant_id", "tenantId", "target_brokerage_id", "id"]

const STATE_RE = /^[A-Z]{2}$/

function trimOrNull(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t ? t.slice(0, max) : null
}

/**
 * PURE: validate + normalize a declaration. A name is required (2..160 chars);
 * states are two-letter uppercase codes; any key that names another tenant is
 * refused outright — a declaration can describe a brokerage, never point at one.
 * @proofSeam scripts/brokerage-identity-guard.ts asserts the forbidden-key refusal and the stored shape directly.
 */
export function normalizeDeclaredAffiliation(
  input: DeclaredAffiliationInput & Record<string, unknown>,
  actor: { userId: string | null; source: AffiliationSource; now?: Date },
): { ok: true; affiliation: DeclaredAffiliation } | { ok: false; error: string } {
  const smuggled = AFFILIATION_FORBIDDEN_KEYS.filter((k) => k in (input ?? {}))
  if (smuggled.length) return { ok: false, error: `A declared affiliation is business context, never a tenant link — refused keys: ${smuggled.join(", ")}.` }
  const name = trimOrNull(input?.name, 160)
  if (!name || name.length < 2) return { ok: false, error: "The affiliated brokerage's name is required (2+ characters)." }
  // Validated BEFORE any truncation: "Florida" must be refused, never silently read as "FL".
  const licenseState = trimOrNull(input.licenseState, 64)?.toUpperCase() ?? null
  if (licenseState && !STATE_RE.test(licenseState)) return { ok: false, error: "Licence state must be a two-letter US state code." }
  const state = trimOrNull(input.state, 64)?.toUpperCase() ?? null
  if (state && !STATE_RE.test(state)) return { ok: false, error: "State must be a two-letter US state code." }
  const dba = trimOrNull(input.dba, 160)
  return {
    ok: true,
    affiliation: {
      name,
      dba: dba && dba.toLowerCase() === name.toLowerCase() ? null : dba,
      license_number: trimOrNull(input.licenseNumber, 64),
      license_state: licenseState,
      city: trimOrNull(input.city, 120),
      state,
      external_ref: trimOrNull(input.externalRef, 120),
      declared_at: (actor.now ?? new Date()).toISOString(),
      declared_by_user_id: actor.userId,
      source: actor.source,
    },
  }
}

export type DeclareAffiliationResult =
  | { ok: true; affiliation: DeclaredAffiliation }
  | { ok: false; error: string; /** m765 not applied yet (PGRST204 / 42703) — the column is missing, the tenant is untouched. */ columnMissing?: boolean }

/**
 * Write the declaration on the subscriber's OWN tenant row — COUNTED (an update
 * that matches nothing resolves too, CLAUDE.md §3) and audited as a kernel event.
 * It touches exactly one column of exactly one row; nothing else moves.
 */
export async function declareBrokerageAffiliation(
  svc: any,
  brokerageId: string,
  input: DeclaredAffiliationInput & Record<string, unknown>,
  actor: { userId: string | null; source: AffiliationSource; now?: Date },
  deps: { emit?: (input: Record<string, unknown>) => Promise<unknown> } = {},
): Promise<DeclareAffiliationResult> {
  if (!brokerageId) return { ok: false, error: "No tenant to declare on." }
  const normalized = normalizeDeclaredAffiliation(input, actor)
  if (!normalized.ok) return normalized
  const at = normalized.affiliation.declared_at
  const { data: rows, error } = await svc
    .from("brokerages")
    .update({ declared_affiliation: normalized.affiliation, updated_at: at })
    .eq("id", brokerageId)
    .select("id")
  if (error) {
    const missing = /declared_affiliation|PGRST204|42703/i.test(`${error.code ?? ""} ${error.message ?? ""}`)
    return { ok: false, error: `Declared affiliation not saved: ${error.message}${missing ? " (m765 not applied — the column is missing)" : ""}`, columnMissing: missing }
  }
  if ((rows ?? []).length !== 1) return { ok: false, error: "Declared affiliation not saved: the tenant row was not matched." }
  try {
    const { KernelEvent } = await import("@/lib/kernel/events")
    const emit = deps.emit ?? (await import("@/lib/kernel/emit")).emitKernelEvent
    await emit({
      event: KernelEvent.BROKERAGE_AFFILIATION_DECLARED, brokerageId,
      entityType: "brokerage", entityId: brokerageId, actorUserId: actor.userId, auditOnly: true,
      metadata: { source: actor.source, name: normalized.affiliation.name, license_state: normalized.affiliation.license_state, state: normalized.affiliation.state },
      client: svc,
    })
  } catch (e) {
    console.warn("[brokerage-identity] affiliation audit event not recorded:", (e as Error)?.message)
  }
  return { ok: true, affiliation: normalized.affiliation }
}

/** Read the declaration (null when none, or when m765 is not applied — reported as `columnMissing`). */
export async function readDeclaredAffiliation(
  svc: any,
  brokerageId: string,
): Promise<{ ok: true; affiliation: DeclaredAffiliation | null } | { ok: false; error: string; columnMissing?: boolean }> {
  const { data, error } = await svc.from("brokerages").select("declared_affiliation").eq("id", brokerageId).maybeSingle()
  if (error) {
    const missing = /declared_affiliation|42703/i.test(`${error.code ?? ""} ${error.message ?? ""}`)
    return { ok: false, error: error.message, columnMissing: missing }
  }
  const raw = (data as { declared_affiliation?: unknown } | null)?.declared_affiliation
  return { ok: true, affiliation: raw && typeof raw === "object" && typeof (raw as DeclaredAffiliation).name === "string" ? (raw as DeclaredAffiliation) : null }
}

/**
 * PURE: the tiers that subscribe INDEPENDENTLY and may therefore declare an
 * affiliation or be adopted by a brokerage-location tenant. An org tier IS the
 * brokerage (lib/kernel/tenant-creation.ts platformMembershipFlags).
 */
export const INDEPENDENT_SUBSCRIBER_TIERS: readonly string[] = ["solo_agent", "team"]

export function isIndependentSubscriberTier(tier: string | null | undefined): boolean {
  return INDEPENDENT_SUBSCRIBER_TIERS.includes(String(tier ?? ""))
}
