'use server'

import { createClient } from '@/lib/supabase/server'
import { isAdminOrBroker } from '@/lib/auth/resolve-user-role'
import { STATE_CODES } from '@/lib/constants/us-states'

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
// could promote their own tenant's plan_tier from a form post. Only the nine
// fields below are ever written, and the payload is re-sanitized through
// pickIdentityFields() on the way in, the same defence-in-depth
// lib/platform/config-snapshots.ts applies to SNAPSHOT_SITE_FIELDS on apply.
// ─────────────────────────────────────────────────────────────────────────────

/** The ONLY `brokerages` columns this surface may ever write. */
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

type IdentityField = (typeof BROKERAGE_IDENTITY_FIELDS)[number]

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
function pickIdentityFields(input: Record<string, unknown>): Partial<Record<IdentityField, unknown>> {
  const out: Partial<Record<IdentityField, unknown>> = {}
  for (const k of BROKERAGE_IDENTITY_FIELDS) {
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
 *   is_platform_admin() OR (is_brokerage_admin() AND id = current_user_brokerage_id())
 *
 * where is_brokerage_admin() = user_type IN ('admin','broker','broker_owner')
 * and current_user_brokerage_id() = users.brokerage_id for auth.uid(). Since the
 * brokerage here IS users.brokerage_id, `isAdminOrBroker` (admin, broker,
 * broker_owner, plus the superadmin spellings that satisfy is_platform_admin())
 * is the same set. Every write below still goes through the RLS-respecting user
 * client, so the database re-decides independently — this gate exists to give a
 * refusal a readable message, never to grant anything RLS would deny.
 */
async function resolveSessionBrokerage(): Promise<{
  supabase: Awaited<ReturnType<typeof createClient>>
  brokerageId: string | null
  canEdit: boolean
  error: string | null
}> {
  const supabase = await createClient()

  const { data: auth, error: authError } = await supabase.auth.getUser()
  if (authError || !auth?.user?.id) {
    return { supabase, brokerageId: null, canEdit: false, error: 'Unauthorized' }
  }

  // supabase-js RESOLVES a failed query — a permission denial arrives as
  // `data: null` and is indistinguishable from "no such user" unless `error` is
  // destructured and checked. "We could not look" and "there is nothing there"
  // mean opposite things to the caller, so they are reported separately.
  const { data: profile, error: profileError } = await supabase
    .from('users')
    .select('brokerage_id, user_type')
    .eq('id', auth.user.id)
    .maybeSingle()

  if (profileError) {
    return { supabase, brokerageId: null, canEdit: false, error: `Could not read your profile: ${profileError.message}` }
  }
  if (!profile) {
    return { supabase, brokerageId: null, canEdit: false, error: 'Your user profile could not be found.' }
  }

  const brokerageId = (profile as { brokerage_id: string | null }).brokerage_id ?? null
  if (!brokerageId) {
    return { supabase, brokerageId: null, canEdit: false, error: 'Your account is not attached to a brokerage.' }
  }

  return {
    supabase,
    brokerageId,
    canEdit: isAdminOrBroker(profile as { user_type?: string | null }),
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

  // Spelled out as a literal, not built from BROKERAGE_IDENTITY_FIELDS.join():
  // scripts/schema-drift-guard.ts can only check column names it can read
  // statically, and a computed select argument would silently opt this query out
  // of the guard that exists to catch exactly the "column isn't there" failure.
  const { data, error } = await supabase
    .from('brokerages')
    .select('name, dba, license_number, license_state, address, address_line2, city, state, zip')
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

  return { data: identity, error: null }
}

export type UpdateBrokerageIdentityInput = Partial<Record<IdentityField, string>>

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
  const { supabase, brokerageId, canEdit, error: sessionError } = await resolveSessionBrokerage()
  if (sessionError || !brokerageId) return { data: null, error: sessionError ?? 'Unauthorized' }
  if (!canEdit) {
    return { data: null, error: 'You do not have permission to change your brokerage details.' }
  }

  const payload = (input ?? {}) as Record<string, unknown>

  // Defence-in-depth. pickIdentityFields() alone would silently DROP a smuggled
  // `plan_tier`, which is safe but invisible. A payload carrying an identity or
  // billing column is not a typo — it is someone probing this endpoint — so it
  // is refused outright and never half-applied.
  const smuggled = BROKERAGE_IDENTITY_FORBIDDEN_FIELDS.filter((f) => f in payload)
  if (smuggled.length > 0) {
    console.error('[settings] brokerage identity update rejected — forbidden fields in payload:', smuggled)
    return { data: null, error: 'That request tried to change fields this form does not control.' }
  }

  const picked = pickIdentityFields(payload)

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

  const updates: Partial<Record<IdentityField, string | null>> = {}
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

  if (Object.keys(updates).length === 0) {
    return { data: null, error: 'Nothing to save.' }
  }

  // RLS-respecting user client, so the database applies
  // `is_brokerage_admin() AND id = current_user_brokerage_id()` itself. A refusal
  // is therefore a ZERO-ROW result with `error: null` — supabase-js does not
  // raise on it — so `.select("id")` is mandatory and the row count is what
  // proves the save happened. Reporting success on a resolved promise (what this
  // card used to do with `{ data: true }`) would tell a broker their licence
  // number was saved when the database had silently refused it.
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
  if (updates.name) {
    const { data: mirrored, error: mirrorError } = await supabase
      .from('global_settings')
      .update({ app_name: updates.name, updated_at: new Date().toISOString() })
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
