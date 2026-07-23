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

  // Insert only the identifying/audit columns; every other column falls back to
  // its DB default (app_name, colors, timezone, notification toggles, etc.), so
  // no brand/product identity is hardcoded in runtime code.
  const { data: inserted, error: insertError } = await svc
    .from("global_settings")
    .insert({
      brokerage_id: brokerageId,
      created_by_user_id: userId,
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
