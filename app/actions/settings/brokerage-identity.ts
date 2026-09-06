'use server'

import { resolveBrokerageFinanceAdmin } from '@/lib/auth/resolve-user-role'
// ★ ACT-AS WRITE SEAM ★ — OWNER RULING: a FULL impersonation grant walks what
// the user's account can walk, including this finance-gated surface. The gates
// below resolve the EFFECTIVE identity (the impersonated seat when platform
// staff act as the tenant) through the acting-context seam, and the SAME
// finance predicate (resolveBrokerageFinanceAdmin) is evaluated against that
// IMPERSONATED identity — the investigator inherits the seat's authority,
// never exceeds it: if the impersonated seat would be refused, so is the
// investigator. resolveWriteContext refuses a read_only grant outright,
// re-validated against the live session row on the very call.
import { resolveActingContext, resolveWriteContext } from '@/lib/platform/acting-context'
import { STATE_CODES } from '@/lib/constants/us-states'
import {
  CAP_ANNIVERSARY_BASES,
  DEFAULT_CAP_ANNIVERSARY_BASIS,
  normalizeCapAnniversaryBasis,
  parseCapAmountInput,
  type CapAnniversaryBasis,
} from '@/lib/commission/cap-resolver'

// ─────────────────────────────────────────────────────────────────────────────
// BROKERAGE IDENTITY — the ONE place a brokerage's real identity is set.
//
// Legal name, DBA, real-estate licence (number + state) and the COMPLETE mailing
// address (street, suite, city, state, ZIP) all live on the `brokerages` row and
// are all edited from the "Brokerage Info" card at /settings/general.
//
// WHY THIS FILE EXISTS SEPARATELY FROM update-global-settings.ts:
// that action writes the `global_settings` row (workspace formatting — timezone,
// date format, currency, notification toggles). Identity is a different row on a
// different table with a different RLS policy. Keeping them apart means the
// identity write can be allow-listed against `brokerages` specifically, and the
// role gate can mirror the `brokerages` policy rather than the settings one.
//
// ── ALLOW-LIST, NOT A SPREAD ────────────────────────────────────────────────
// `brokerages` carries identity and BILLING columns in the same row: id, slug,
// plan_tier, status, trial_ends_at, billing_metadata, is_demo,
// brokerage_on_platform, twilio_subaccount_sid. A settings action that spread a
// client payload into an update would be a privilege-escalation bug — a broker
// could promote their own tenant's plan_tier from a form post. Only the eleven
// fields below are ever written, and the payload is re-sanitized through
// pickWritableFields() on the way in, the same defence-in-depth
// lib/platform/config-snapshots.ts applies to SNAPSHOT_SITE_FIELDS on apply.
//
// ── AND THE BROKERAGE'S DEFAULT COMMISSION CAP ──────────────────────────────
// m461 added `default_cap_amount` and `default_cap_anniversary_basis` to this
// same row, on the owner's ruling that "brokerage and teams may also have
// commission caps". They are written HERE — extending this allow-list rather
// than standing up a second action against `brokerages` — because a second
// writer is exactly how an allow-list stops being one. See BROKERAGE_CAP_FIELDS.
// ─────────────────────────────────────────────────────────────────────────────

/** The brokerage's IDENTITY columns. See BROKERAGE_WRITABLE_FIELDS for the
 *  complete allow-list this surface may write. */
const BROKERAGE_IDENTITY_FIELDS = [
  'name',
  'dba',
  'license_number',
  'license_state',
  'address',
  'address_line2',
  'city',
  'state',
  'zip',
] as const

/**
 * THE BROKERAGE'S DEFAULT COMMISSION CAP — added to this writer, not given a
 * second one.
 *
 * OWNER RULING: "brokerage and teams may also have commission caps", and settings
 * is where a brokerage configures itself — the same ruling that put the brokerage
 * LICENCE NUMBER beside the brokerage NAME. A cap is a configured fact about the
 * brokerage, so it lives on the `brokerages` row and is written through the one
 * allow-listed writer that row already has. A second action pointed at the same
 * table is how an allow-list stops being one.
 *
 * WHAT THESE TWO COLUMNS ARE (m461):
 *
 *   `default_cap_amount`  numeric(12,2), NULL = uncapped. The ceiling on what the
 *       brokerage COLLECTS from an agent per anniversary year — not what the
 *       agent earns. `lib/commission/waterfall/07-apply-cap.ts` says it in its
 *       own header: once the brokerage has taken this much, its share drops to $0
 *       and the agent keeps the rest.
 *   `default_cap_anniversary_basis`  text, CHECK IN ('agent_start_date',
 *       'calendar_year','brokerage_fiscal_year'), DEFAULT 'agent_start_date'.
 *       Which 12-month window the cap resets on.
 *
 * SETTING THIS ALONE DOES NOT CAP ANYBODY, and the surface says so. The
 * commission engine reads exactly one table — `agent_cap_tracking` — and this
 * default is what `lib/commission/cap-resolver.ts:ensureAgentCapWindow`
 * materialises INTO that ledger for each agent. That seeder is what makes this
 * setting real; before it existed, four agents on the live database carried a cap
 * that had never once been enforced because three of them had no ledger row at
 * all.
 */
const BROKERAGE_CAP_FIELDS = [
  'default_cap_amount',
  'default_cap_anniversary_basis',
] as const

type IdentityField = (typeof BROKERAGE_IDENTITY_FIELDS)[number]
type CapField = (typeof BROKERAGE_CAP_FIELDS)[number]

/** The COMPLETE allow-list — identity plus the cap default, and nothing else.
 *  `pickWritableFields` iterates this, so a column that is not named here can
 *  never reach the update no matter what a form post contains. */
const BROKERAGE_WRITABLE_FIELDS = [
  ...BROKERAGE_IDENTITY_FIELDS,
  ...BROKERAGE_CAP_FIELDS,
] as const

type WritableField = IdentityField | CapField

/**
 * Columns that share the `brokerages` row but must be unreachable from this
 * form. Listed explicitly so a reviewer (and the reader of a future diff) can
 * see what the allow-list is protecting, not just that one exists.
 */
const BROKERAGE_IDENTITY_FORBIDDEN_FIELDS = [
  'id',
  'slug',
  'plan_tier',
  'status',
  'trial_ends_at',
  'billing_metadata',
  'is_demo',
  'brokerage_on_platform',
  'twilio_subaccount_sid',
  'onboarding_status',
] as const

export type BrokerageIdentity = {
  [K in IdentityField]: string | null
} & {
  /**
   * True when the session user may SAVE, not merely read. The read policy on
   * `brokerages` admits any signed-in user in the tenant; the write policy
   * admits only brokerage admins. The card renders read-only when this is false
   * instead of offering a Save button that the database will refuse.
   */
  canEdit: boolean
  /**
   * `brokerages.default_cap_amount` in DOLLARS, or null for UNCAPPED. Typed as a
   * number rather than folded into the string map above because it is money and
   * every reader has to do arithmetic on it; `0` and `null` are different facts
   * and a string map would let "" stand for both.
   */
  defaultCapAmount: number | null
  /** `brokerages.default_cap_anniversary_basis`, normalized to one of the three
   *  values the live CHECK constraint admits. */
  defaultCapAnniversaryBasis: CapAnniversaryBasis
}

type ActionResult<T> = { data: T | null; error: string | null }

/** Blank and whitespace-only are "not set", not a value. */
function trimOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length > 0 ? t : null
}

/**
 * PURE. Keep only allow-listed keys from a client payload. Anything else — a
 * `plan_tier` a tampered form post tried to smuggle in — is dropped here and
 * never reaches the update.
 */
function pickWritableFields(input: Record<string, unknown>): Partial<Record<WritableField, unknown>> {
  const out: Partial<Record<WritableField, unknown>> = {}
  for (const k of BROKERAGE_WRITABLE_FIELDS) {
    if (input[k] !== undefined) out[k] = input[k]
  }
  return out
}

/**
 * State values are stored as the two-letter uppercase USPS code everywhere else
 * in this database — agents.license_state ('FL'), listings.state ('FL'),
 * locations.state ('FL'). One live `brokerages.state` had already drifted to
 * 'Fl' from free-text entry, which is exactly the kind of value that silently
 * fails an `.eq("state", "FL")` filter. The card offers a picker and this
 * normalizes + validates, so neither the form nor a direct action call can
 * write a shape the rest of the app cannot match.
 */
function normalizeStateCode(v: unknown): { value: string | null; invalid: boolean } {
  const t = trimOrNull(v)
  if (!t) return { value: null, invalid: false }
  const code = t.toUpperCase()
  if (!STATE_CODES.includes(code)) return { value: null, invalid: true }
  return { value: code, invalid: false }
}

const ZIP_PATTERN = /^\d{5}(-\d{4})?$/

/**
 * Resolve the acting user's brokerage FROM THE SESSION and decide whether they
 * may write it.
 *
 * The brokerage id is NEVER accepted from the client. app/actions/settings/
 * update-global-settings.ts already ignores the client-supplied `id` on purpose
 * for the same reason; this matches that.
 *
 * THE GATE MIRRORS RLS, IT DOES NOT EXCEED IT. The live UPDATE policy on
 * `brokerages` is:
 *
 *   is_platform_admin() OR (is_brokerage_finance_admin() AND id = current_user_brokerage_id())
 *
 * — that predicate is is_brokerage_finance_admin() and NOT is_brokerage_admin()
 * as of m472, because this row carries default_cap_amount, plan_tier,
 * billing_metadata and revenue_share_enabled alongside the identity fields. The
 * two predicates differ by exactly one role, team_lead, which the owner admits to
 * admin surfaces and holds out of brokerage-wide money.
 *
 * and current_user_brokerage_id() = users.brokerage_id for auth.uid(). Since the
 * brokerage here IS users.brokerage_id, the two decide the same thing.
 *
 * THIS COMMENT WAS STALE, AND THE CODE UNDER IT WITH IT. It said
 * is_brokerage_admin() = user_type IN ('admin','broker','broker_owner'), which
 * stopped being true at m466: on the owner's ruling that a role grant is an
 * ADMINISTERING FACT, that function now admits a tenant role grant in
 * user_role_assignments as well. The app kept testing user_type alone, so a user
 * GRANTED admin was permitted by RLS and refused here — the same direction of
 * mismatch this file's own header already documents for broker_owner, one layer
 * down. resolveBrokerageFinanceAdmin asks BOTH halves, which is what makes the two agree.
 *
 * Every write below still goes through the RLS-respecting user client, so the
 * database re-decides independently — this gate exists to give a refusal a
 * readable message, never to grant anything RLS would deny.
 */
async function resolveSessionBrokerage(): Promise<{
  /** The acting db: the caller's RLS-scoped cookie client normally; the service
   *  client under an ACTIVE impersonation grant (re-validated on this call). */
  supabase: any
  brokerageId: string | null
  canEdit: boolean
  error: string | null
}> {
  // ACT-AS SEAM — the EFFECTIVE identity: the impersonated tenant seat when a
  // platform-staff member is acting as the tenant, the caller themselves
  // otherwise. Under act-as, the raw auth user's row is the STAFF row
  // (brokerage_id NULL) and used to refuse every call here.
  const acting = await resolveActingContext()
  const supabase = acting.db
  if (!acting.ok) {
    return { supabase, brokerageId: null, canEdit: false, error: 'Unauthorized' }
  }

  const brokerageId = acting.brokerageId ?? null
  if (!brokerageId) {
    return { supabase, brokerageId: null, canEdit: false, error: 'Your account is not attached to a brokerage.' }
  }

  // "We could not look" and "you may not edit" are opposite answers, so a
  // refused grant read is reported as an error rather than collapsing into
  // canEdit:false.
  //
  // BROKERAGE-WIDE MONEY (m472), and this one is easy to misread as branding.
  // The writable field list below includes default_cap_amount and
  // default_cap_anniversary_basis — the brokerage-wide DEFAULT CAP and the
  // schedule it resets on — and the row also carries plan_tier, billing_metadata
  // and revenue_share_enabled. So public.brokerages is a FINANCE table under
  // m472, its UPDATE policy is is_brokerage_finance_admin(), and a gate here on
  // the WIDER tenant roster would admit a team lead the database then refuses:
  // supabase-js resolves that refusal as zero rows with `error: null`, and this
  // surface would report a saved cap that was never stored.
  //
  // Evaluated against the EFFECTIVE (impersonated) identity: acting.userId /
  // acting.userType are the impersonated seat's own when acting-as, so the
  // investigator holds exactly that seat's finance authority.
  const admin = await resolveBrokerageFinanceAdmin(
    supabase,
    acting.userId,
    { user_type: acting.userType, brokerage_id: brokerageId },
  )
  if (!admin.ok) {
    return { supabase, brokerageId, canEdit: false, error: `Could not resolve your permissions: ${admin.error}` }
  }

  return {
    supabase,
    brokerageId,
    // A read_only grant may SEE the card but never save it — the Save button
    // stays hidden rather than offering a write resolveWriteContext will refuse.
    canEdit: admin.isFinanceAdmin && !acting.readOnly,
    error: null,
  }
}

/**
 * Read the brokerage's identity for the "Brokerage Info" card at
 * /settings/general. Called by app/settings/general/page.tsx.
 */
export async function getBrokerageIdentity(): Promise<ActionResult<BrokerageIdentity>> {
  const { supabase, brokerageId, canEdit, error: sessionError } = await resolveSessionBrokerage()
  if (sessionError || !brokerageId) return { data: null, error: sessionError ?? 'Unauthorized' }

  // Spelled out as a literal, not built from BROKERAGE_WRITABLE_FIELDS.join():
  // scripts/schema-drift-guard.ts can only check column names it can read
  // statically, and a computed select argument would silently opt this query out
  // of the guard that exists to catch exactly the "column isn't there" failure.
  const { data, error } = await supabase
    .from('brokerages')
    .select('name, dba, license_number, license_state, address, address_line2, city, state, zip, default_cap_amount, default_cap_anniversary_basis')
    .eq('id', brokerageId)
    .maybeSingle()

  if (error) {
    return { data: null, error: `Could not load your brokerage details: ${error.message}` }
  }
  if (!data) {
    // The SELECT policy is `is_platform_staff() OR id = current_user_brokerage_id()`,
    // so a missing row here means the tenant record is genuinely gone — not a
    // permission problem. Say that rather than rendering an empty form the user
    // would fill in and fail to save.
    return { data: null, error: 'Your brokerage record could not be found.' }
  }

  const row = data as unknown as Record<string, unknown>
  const identity = { canEdit } as BrokerageIdentity
  for (const k of BROKERAGE_IDENTITY_FIELDS) identity[k] = trimOrNull(row[k])

  // numeric(12,2) arrives from PostgREST as a STRING. Number("") is 0, which
  // would turn "no cap set" into "the brokerage collects nothing" — the two most
  // opposite answers this field has — so the empty case is mapped explicitly.
  const rawCap = row.default_cap_amount
  const capNum = rawCap === null || rawCap === undefined || rawCap === '' ? null : Number(rawCap)
  identity.defaultCapAmount = capNum !== null && Number.isFinite(capNum) ? capNum : null
  identity.defaultCapAnniversaryBasis = normalizeCapAnniversaryBasis(row.default_cap_anniversary_basis)

  return { data: identity, error: null }
}

export type UpdateBrokerageIdentityInput = Partial<Record<IdentityField, string>> & {
  /** Dollars as typed. "" / null clears the cap (uncapped); more than two
   *  decimal places is REFUSED rather than rounded. */
  default_cap_amount?: string | null
  /** One of CAP_ANNIVERSARY_BASES. */
  default_cap_anniversary_basis?: string
}

/**
 * Save the brokerage's identity. Called by
 * app/components/settings/GeneralSettingsForm.tsx (the "Brokerage Info" card).
 *
 * ── RESOLVING THE NAME DRIFT ────────────────────────────────────────────────
 * Before this, the "Company / Brokerage Name" box on this card wrote
 * `global_settings.app_name` and NOTHING wrote `brokerages.name`.
 * lib/kernel/global-settings.ts seeds app_name FROM brokerages.name once, at row
 * creation, and then the two diverge forever. A broker who renamed their
 * brokerage on this screen changed the client-facing display name and not the
 * column the Fair Housing / disclosure check actually reads.
 *
 * `brokerages.name` is CANONICAL and `global_settings.app_name` is a mirror of
 * it. That direction is not a preference — it is what the readers say:
 *
 *   brokerages.name is read by ~40 non-test call sites, including
 *     lib/brokerage/compliance-identity.ts (the disclosure/attribution resolver),
 *     lib/branding/resolve-brand-context.ts, lib/documents/client-document-producer.ts,
 *     lib/video/reel-brand.ts, lib/campaign-sequences/render-step.ts,
 *     lib/marketing/social-media-pairing.ts, lib/recruiting/recruiting-pitch-kit.ts,
 *     lib/billing/dunning.ts, app/portal/[contactId]/help + /vendors,
 *     and every superadmin tenant console.
 *
 *   global_settings.app_name is read by exactly three:
 *     app/portal/page.tsx (the "we couldn't find your profile" heading),
 *     app/actions/seller-open-house.ts → the open-house sign-in kiosk, where it
 *       is only the FALLBACK for the TCPA consent party name (the kiosk already
 *       prefers listing.brokerages.name), and
 *     lib/platform/config-snapshots.ts (tenant templating).
 *
 * So: ONE name box on the card, written to `brokerages.name`, and app_name kept
 * in step immediately after so all three of those readers keep working. The DBA
 * box stays a separate field because it is a genuinely different fact — the
 * trade name a brokerage advertises under — and compliance-identity.ts already
 * treats it as one. Two free-text boxes that both meant "brokerage name" was the
 * drift; a legal name plus an optional trade name is not.
 *
 * app_name was ALSO removed from the allow-list in
 * app/actions/settings/update-global-settings.ts, so the settings surface can no
 * longer set it independently and re-open the gap.
 */
export async function updateBrokerageIdentity(
  input: UpdateBrokerageIdentityInput,
): Promise<ActionResult<{ saved: true }>> {
  // ★ ACT-AS WRITE SEAM ★ — a read_only impersonation grant is refused HERE,
  // before any tenant resolution or write; the grant is re-validated against
  // the live session row on this very call, never trusted from a stale flag.
  const seam = await resolveWriteContext()
  if (!seam.ok) return { data: null, error: seam.error }

  const { supabase, brokerageId, canEdit, error: sessionError } = await resolveSessionBrokerage()
  if (sessionError || !brokerageId) return { data: null, error: sessionError ?? 'Unauthorized' }
  if (!canEdit) {
    return { data: null, error: 'You do not have permission to change your brokerage details.' }
  }

  const payload = (input ?? {}) as Record<string, unknown>

  // Defence-in-depth. pickWritableFields() alone would silently DROP a smuggled
  // `plan_tier`, which is safe but invisible. A payload carrying an identity or
  // billing column is not a typo — it is someone probing this endpoint — so it
  // is refused outright and never half-applied.
  const smuggled = BROKERAGE_IDENTITY_FORBIDDEN_FIELDS.filter((f) => f in payload)
  if (smuggled.length > 0) {
    console.error('[settings] brokerage identity update rejected — forbidden fields in payload:', smuggled)
    return { data: null, error: 'That request tried to change fields this form does not control.' }
  }

  const picked = pickWritableFields(payload)

  // brokerages.name is NOT NULL in the live schema, and a blank name would break
  // every disclosure line that renders it. Refuse rather than write whitespace.
  if ('name' in picked) {
    const name = trimOrNull(picked.name)
    if (!name) return { data: null, error: 'Brokerage name is required.' }
  }

  const licenceState = normalizeStateCode(picked.license_state)
  if (licenceState.invalid) {
    return { data: null, error: 'Licence state must be a two-letter US state code.' }
  }
  const brokerageState = normalizeStateCode(picked.state)
  if (brokerageState.invalid) {
    return { data: null, error: 'State must be a two-letter US state code.' }
  }

  const zip = trimOrNull(picked.zip)
  if (zip && !ZIP_PATTERN.test(zip)) {
    return { data: null, error: 'ZIP must be 5 digits, or 5+4 (12345-6789).' }
  }

  // ── THE BROKERAGE'S DEFAULT COMMISSION CAP ────────────────────────────────
  // Money is `numeric(12,2)`. parseCapAmountInput REFUSES more precision rather
  // than rounding it away — the same rule `saveTeamSplits` applies to a team
  // split, and for the same reason: a silently rounded cap is not the cap that
  // was agreed. Blank clears it, which means UNCAPPED; `0` is a different and
  // equally real answer meaning the brokerage collects nothing.
  const capAmount = parseCapAmountInput(
    picked.default_cap_amount === undefined ? undefined : (picked.default_cap_amount as string | null),
    "The brokerage's default commission cap",
  )
  if (!capAmount.ok) return { data: null, error: capAmount.error }

  // REFUSED, not normalized. normalizeCapAnniversaryBasis() falls back to the
  // column default, which is right when READING a value the database already
  // holds — but on a WRITE, quietly turning an unrecognised basis into
  // 'agent_start_date' would store a cap that resets on a different day from the
  // one the broker chose, and the live CHECK constraint would have refused it
  // anyway. Say so instead.
  let basisValue: CapAnniversaryBasis | null = null
  if ('default_cap_anniversary_basis' in picked) {
    const rawBasis = trimOrNull(picked.default_cap_anniversary_basis)
    if (rawBasis && !(CAP_ANNIVERSARY_BASES as readonly string[]).includes(rawBasis)) {
      return {
        data: null,
        error: `"${rawBasis}" is not a cap reset schedule. Choose one of: ${CAP_ANNIVERSARY_BASES.join(', ')}.`,
      }
    }
    // The column is NOT NULL-able in practice (it carries a DEFAULT), so a
    // cleared control means "back to the default", not "no schedule".
    basisValue = (rawBasis as CapAnniversaryBasis | null) ?? DEFAULT_CAP_ANNIVERSARY_BASIS
  }

  const updates: Partial<Record<WritableField, string | number | null>> = {}
  if ('name' in picked) updates.name = trimOrNull(picked.name)
  if ('dba' in picked) {
    // A DBA that is just the legal name retyped is not a trade name, and storing
    // it as one would tell lib/brokerage/compliance-identity.ts that this
    // brokerage advertises under a different name when it does not. Same string
    // (ignoring case/whitespace) → not set.
    const dba = trimOrNull(picked.dba)
    const name = trimOrNull(picked.name)
    updates.dba = dba && name && dba.toLowerCase() === name.toLowerCase() ? null : dba
  }
  if ('license_number' in picked) updates.license_number = trimOrNull(picked.license_number)
  if ('license_state' in picked) updates.license_state = licenceState.value
  if ('address' in picked) updates.address = trimOrNull(picked.address)
  if ('address_line2' in picked) updates.address_line2 = trimOrNull(picked.address_line2)
  if ('city' in picked) updates.city = trimOrNull(picked.city)
  if ('state' in picked) updates.state = brokerageState.value
  if ('zip' in picked) updates.zip = zip
  if ('default_cap_amount' in picked) updates.default_cap_amount = capAmount.value
  if (basisValue !== null) updates.default_cap_anniversary_basis = basisValue

  if (Object.keys(updates).length === 0) {
    return { data: null, error: 'Nothing to save.' }
  }

  // The ACTING db: the RLS-respecting user client for a normal tenant user, so
  // the database applies its own finance-admin policy; the service client only
  // under an active FULL impersonation grant, where the app-layer finance gate
  // above (evaluated on the IMPERSONATED identity) plus the `.eq('id',
  // brokerageId)` tenant pin are the gate. Either way a refusal is a ZERO-ROW
  // result with `error: null` — supabase-js does not raise on it — so
  // `.select("id")` is mandatory and the row count is what proves the save
  // happened. Reporting success on a resolved promise (what this card used to
  // do with `{ data: true }`) would tell a broker their licence number was
  // saved when the database had silently refused it.
  const { data: saved, error: updateError } = await supabase
    .from('brokerages')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', brokerageId)
    .select('id')

  if (updateError) {
    return { data: null, error: `Could not save your brokerage details: ${updateError.message}` }
  }
  if (!saved || saved.length === 0) {
    return {
      data: null,
      error: 'Your brokerage details were not saved — the database refused the change. Only a broker or admin on this brokerage can edit them.',
    }
  }

  // ── Keep global_settings.app_name in step with the canonical name ──────────
  // Only when the name actually moved. Same user client: the live
  // `global_settings_tenant_update` policy is `brokerage_id =
  // current_user_brokerage_id()`, which is the identical expression this
  // brokerage id was resolved from, so it cannot refuse a row that exists.
  // `updates` now also carries a NUMERIC column, so the narrowing is explicit:
  // app_name is text and only the name may ever be mirrored into it.
  const mirroredName = typeof updates.name === 'string' ? updates.name : null
  if (mirroredName) {
    const { data: mirrored, error: mirrorError } = await supabase
      .from('global_settings')
      .update({ app_name: mirroredName, updated_at: new Date().toISOString() })
      .eq('brokerage_id', brokerageId)
      .select('id')

    if (mirrorError) {
      return {
        data: null,
        error: `Your brokerage details were saved, but the client-facing display name could not be updated: ${mirrorError.message}`,
      }
    }
    // Zero rows here is NOT a refusal (see the policy note above) — it means the
    // settings row has not been seeded yet. That is self-correcting:
    // lib/kernel/global-settings.ts:ensureGlobalSettingsRow seeds app_name from
    // brokerages.name on first access, and brokerages.name is now the new value.
    void mirrored
  }

  return { data: { saved: true }, error: null }
}
