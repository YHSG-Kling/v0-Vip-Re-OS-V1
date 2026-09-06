import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isPlatformSuperadminIdentity } from "@/lib/platform/platform-staff-roster"
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"

// ─── TYPES ───────────────────────────────────────────────────────────────────

export type GlobalSettingsRow = {
  id: string
  brokerage_id: string
  app_name: string
  app_logo_url: string | null
  primary_color: string
  secondary_color: string
  font_family: string
  fiscal_year_start: number
  timezone: string
  date_format: "MM/DD/YYYY" | "DD/MM/YYYY" | "YYYY-MM-DD"
  currency_symbol: string
  smtp_host: string | null
  smtp_port: number | null
  smtp_username: string | null
  smtp_password: string | null
  from_email: string | null
  from_name: string | null
  email_notifications_enabled: boolean
  sms_notifications_enabled: boolean
  push_notifications_enabled: boolean
  ghl_api_key: string | null
  zapier_api_key: string | null
  airtable_api_key: string | null
  additional_settings: Record<string, unknown> | null
  created_by_user_id: string | null
  created_at: string | null
  updated_at: string | null
}

// ─── INTERNAL HELPER ─────────────────────────────────────────────────────────

/** Minimal client shape this module needs — lets the actions inject the
 *  ctx-resolved acting db without importing supabase types here. */
type SupabaseLike = { from: (table: string) => any }

// The tenant roster, MIRRORING public.is_brokerage_admin() exactly:
//
//   SELECT user_type IN ('admin', 'broker', 'broker_owner') …
//
// which is what the global_settings INSERT/UPDATE/DELETE policies gate on. This
// list previously read ["admin", "broker", "superadmin"] and so omitted
// `broker_owner` — a user_type the users_user_type_check constraint genuinely
// admits and that RLS genuinely permits. The database was correctly broader than
// the app: the OWNER of a brokerage was refused their own brokerage settings by
// app code the database would have let through. Widening to broker_owner brings
// the app up to the database; it does not go past it.
// DERIVED, not restated (§6, integrator 2026-09-03): this was the THIRD copy of
// the tenant-admin roster (the other two: lib/auth/require-brokerage-admin.ts,
// now also derived, and the SQL function is_brokerage_admin, which admits five
// roles live). The survivor is lib/auth/resolve-user-role.ts TENANT_ADMIN_USER_TYPES;
// the local name is kept so the gate below reads the same.
//
// 2026-09-04 (lane ROSTER + integrator): the survivor gained
// `compliance_officer` on the owner's ruling that the compliance officer is
// tenant staff, so this gate admits them too — and the MIRRORS-is_brokerage_admin()
// claim at the top of this comment still holds, because the SQL half was
// APPLIED the same day (supabase/migrations/m602-a-compliance-officer-administers-the-brokerage.sql,
// live on hrvaqgvukzxfskkcrwbt). The "five roles live" count above is six now,
// on both sides. Left un-applied it would have mattered here in the quiet
// direction: global_settings writes ride the INJECTED, ctx-resolved client, so
// an un-widened policy would have refused the write — and supabase-js resolves a
// refusal (§3), so the surface would have reported success over zero rows.
const BROKERAGE_ADMIN_USER_TYPES: ReadonlySet<string> = TENANT_ADMIN_USER_TYPES

// ★ ACT-AS WRITE SEAM ★ — the users-row read rides an INJECTED, ctx-resolved
// client when the caller provides one (lib/platform/acting-context.ts:
// resolveWriteContext / resolveActingContext hand their `db` through the
// actions). Before this, the row was always read through the caller's COOKIE
// client keyed on the RAW auth user: under act-as that is the platform-staff
// row (brokerage_id NULL), so every settings read/write while acting-as died
// on "User not found"/NULL tenant. The actions now pass the EFFECTIVE user id
// (the impersonated identity) plus the acting db, so this gate evaluates the
// SAME admin predicate against the IMPERSONATED identity's own row — the
// investigator inherits that seat's authority and never exceeds it. The
// predicate itself is unchanged.
async function requireBrokerAdmin(
  userId: string,
  db?: SupabaseLike
): Promise<{ brokerageId: string; userType: string; platformRole: string | null }> {
  const supabase = db ?? (await createClient())

  const { data: user, error } = await supabase
    .from("users")
    .select("brokerage_id, user_type, platform_role")
    .eq("id", userId)
    .single()

  if (error || !user) {
    throw new Error("User not found")
  }

  const userType = String((user as { user_type?: string | null }).user_type ?? "")
  const platformRole = (user as { platform_role?: string | null }).platform_role ?? null

  // PLATFORM STAFF, READ FROM BOTH IDENTITY COLUMNS. The old test was
  // `user_type === 'superadmin'` alone, which is DEAD CODE on this database:
  // measured on hrvaqgvukzxfskkcrwbt, ZERO users rows carry user_type='superadmin',
  // and the platform's only superadmin is (user_type='admin', platform_role='superadmin').
  // So the branch could never fire for the account it exists to admit. This is the
  // same both-columns shape as public.is_platform_admin() in RLS, lib/auth/platform-guard.ts:
  // requireSuperadmin and lib/kernel/api-auth.ts:requireSuperadminAuth; the canonical
  // explanation is app/actions/vendor-budget.ts:136-147.
  //
  // Deliberately the SUPERADMIN test and NOT isPlatformStaffIdentity(): the four-role
  // staff roster (superadmin | admin | marketing | support) would admit a
  // platform_role='marketing' account whose user_type is 'system', which
  // is_brokerage_admin() does NOT permit — that would push this gate PAST the database.
  // Narrowing to superadmin keeps it at or inside RLS, and on live data it admits
  // nobody new at all: the one superadmin already qualifies via user_type='admin'.
  //
  // TOMBSTONE (ruling 1, 2026-08-24): this line used to re-spell the test as
  // `userType === "superadmin" || platformRole === "superadmin"`. Survivor:
  // lib/platform/platform-staff-roster.ts:isPlatformSuperadminIdentity.
  const isPlatformSuperadmin = isPlatformSuperadminIdentity(userType, platformRole)

  if (!BROKERAGE_ADMIN_USER_TYPES.has(userType) && !isPlatformSuperadmin) {
    throw new Error("Forbidden: insufficient permissions")
  }

  return { brokerageId: user.brokerage_id, userType, platformRole }
}

// Returns the brokerage's settings row, creating it on first access. This makes
// settings self-seeding: a brand-new brokerage no longer hits "Settings not
// found" the first time a broker/admin opens the page or saves.
//
// Authorization is enforced by requireBrokerAdmin() in the callers; the row I/O
// here uses the SERVICE client deliberately. The global_settings write policies
// gate on is_brokerage_admin() AND brokerage_id = current_user_brokerage_id(),
// and the SELECT policy is brokerage-scoped only — so a platform superadmin
// operating outside their own brokerage would be denied the seed INSERT and the
// read. requireBrokerAdmin above mirrors is_brokerage_admin()'s roster
// (admin | broker | broker_owner) and adds only the platform-superadmin identity,
// so the app gate never reaches past the database. Gating in app code +
// service-client I/O is the same pattern the other global_settings actions use.
async function ensureGlobalSettingsRow(
  brokerageId: string,
  userId: string
): Promise<GlobalSettingsRow> {
  const svc = createServiceClient()

  const { data: existing } = await svc
    .from("global_settings")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (existing) return existing as GlobalSettingsRow

  // app_name is THIS TENANT'S client-facing name, not the product's. It is rendered
  // as the brokerage on the open-house sign-in kiosk and, more seriously, inside the
  // TCPA consent text a lead agrees to (app/open-house/[eventId]/signin), plus the
  // client portal. Letting it fall to the column default meant a fresh brokerage
  // inherited the PRODUCT's own name from that default and showed it to their clients
  // as their own — the walkthrough's "this is supposed to be the tenants info not what
  // to name the app". Seed it from the brokerage's real name so it is correct on the
  // first load and the broker edits their own name rather than adopting ours.
  //
  // Every OTHER column still falls back to its DB default (colors, timezone,
  // notification toggles), so no brand identity beyond the tenant's own name is
  // hardcoded here.
  const { data: brokerage } = await svc
    .from("brokerages")
    .select("name")
    .eq("id", brokerageId)
    .maybeSingle()
  const tenantName = ((brokerage as { name?: string | null } | null)?.name ?? "").trim()

  const { data: inserted, error: insertError } = await svc
    .from("global_settings")
    .insert({
      brokerage_id: brokerageId,
      created_by_user_id: userId,
      ...(tenantName ? { app_name: tenantName } : {}),
    })
    .select("*")
    .single()

  if (inserted) return inserted as GlobalSettingsRow

  // A concurrent request may have inserted the row first (unique brokerage_id).
  // Re-read before giving up so the caller still gets a valid row.
  const { data: reread } = await svc
    .from("global_settings")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (reread) return reread as GlobalSettingsRow

  throw insertError ?? new Error("Failed to initialize brokerage settings")
}

// ─── EXPORTED FUNCTIONS ───────────────────────────────────────────────────────

export async function getGlobalSettings(params: {
  userId: string
  /** Optional ctx-resolved client (acting-context db) for the gate's users-row
   *  read — required for act-as, harmless otherwise. Row I/O stays on the
   *  service client regardless (see ensureGlobalSettingsRow). */
  db?: SupabaseLike
}): Promise<GlobalSettingsRow> {
  const { brokerageId } = await requireBrokerAdmin(params.userId, params.db)
  return ensureGlobalSettingsRow(brokerageId, params.userId)
}

export async function updateGlobalSettings(params: {
  userId: string
  /** Optional ctx-resolved client (acting-context db) for the gate's users-row
   *  read. The WRITE below stays on the service client either way; callers must
   *  gate through resolveWriteContext so a read_only grant never reaches here. */
  db?: SupabaseLike
  updates: Partial<
    Pick<
      GlobalSettingsRow,
      | "app_name"
      | "app_logo_url"
      | "primary_color"
      | "secondary_color"
      | "font_family"
      | "fiscal_year_start"
      | "timezone"
      | "date_format"
      | "currency_symbol"
      | "email_notifications_enabled"
      | "sms_notifications_enabled"
      | "push_notifications_enabled"
    >
  >
}): Promise<void> {
  // Note: SMTP + API keys are secrets — do NOT update via this function.
  // A separate hardened update function will handle those fields.
  const { brokerageId } = await requireBrokerAdmin(params.userId, params.db)
  // Guarantee a row exists first so saving on a fresh brokerage creates it
  // instead of silently updating zero rows.
  await ensureGlobalSettingsRow(brokerageId, params.userId)
  // Service client for the same RLS reason as ensureGlobalSettingsRow. The caller
  // is already authorized by requireBrokerAdmin above — is_brokerage_admin()'s own
  // roster (admin | broker | broker_owner) plus the platform superadmin.
  const svc = createServiceClient()

  const { error } = await svc
    .from("global_settings")
    .update({
      ...params.updates,
      updated_at: new Date().toISOString(),
    })
    .eq("brokerage_id", brokerageId)

  if (error) {
    throw error
  }
}
