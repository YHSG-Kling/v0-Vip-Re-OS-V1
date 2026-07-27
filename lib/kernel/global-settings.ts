import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

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

async function requireBrokerAdmin(
  userId: string
): Promise<{ brokerageId: string; userType: string }> {
  const supabase = await createClient()

  const { data: user, error } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", userId)
    .single()

  if (error || !user) {
    throw new Error("User not found")
  }

  if (!["admin", "broker", "superadmin"].includes(user.user_type)) {
    throw new Error("Forbidden: insufficient permissions")
  }

  return { brokerageId: user.brokerage_id, userType: user.user_type }
}

// Returns the brokerage's settings row, creating it on first access. This makes
// settings self-seeding: a brand-new brokerage no longer hits "Settings not
// found" the first time a broker/admin opens the page or saves.
//
// Authorization is enforced by requireBrokerAdmin() in the callers; the row I/O
// here uses the SERVICE client deliberately. The global_settings RLS policies
// are admin-only for writes (and exclude superadmin from reads), which is
// stricter than the app's admin/broker/superadmin permission model — running
// the seed through the user-scoped client would deny brokers the INSERT and
// superadmins the SELECT. Gating in app code + service-client I/O is the same
// pattern the other global_settings actions in this codebase already use.
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
}): Promise<GlobalSettingsRow> {
  const { brokerageId } = await requireBrokerAdmin(params.userId)
  return ensureGlobalSettingsRow(brokerageId, params.userId)
}

export async function updateGlobalSettings(params: {
  userId: string
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
  const { brokerageId } = await requireBrokerAdmin(params.userId)
  // Guarantee a row exists first so saving on a fresh brokerage creates it
  // instead of silently updating zero rows.
  await ensureGlobalSettingsRow(brokerageId, params.userId)
  // Service client for the same RLS reason as ensureGlobalSettingsRow: the write
  // policy is admin-only, but this function is authorized for admin/broker/
  // superadmin via requireBrokerAdmin above.
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
