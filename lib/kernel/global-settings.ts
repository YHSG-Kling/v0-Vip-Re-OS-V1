import { createClient } from "@/lib/supabase/server"

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

// Seed values used the first time a brokerage opens its settings. One row per
// brokerage; column defaults in the DB mirror these, but we set them explicitly
// so the returned row is fully populated without a second round-trip.
const DEFAULT_GLOBAL_SETTINGS = {
  app_name: "VIP Real Estate OS",
  app_logo_url: null,
  primary_color: "#2563eb",
  secondary_color: "#1e40af",
  font_family: "system-ui",
  fiscal_year_start: 1,
  timezone: "America/New_York",
  date_format: "MM/DD/YYYY" as const,
  currency_symbol: "$",
  email_notifications_enabled: true,
  sms_notifications_enabled: false,
  push_notifications_enabled: false,
}

// Returns the brokerage's settings row, creating it from defaults on first
// access. This makes settings self-seeding: a brand-new brokerage no longer
// hits "Settings not found" the first time an admin opens the page or saves.
async function ensureGlobalSettingsRow(
  brokerageId: string,
  userId: string
): Promise<GlobalSettingsRow> {
  const supabase = await createClient()

  const { data: existing } = await supabase
    .from("global_settings")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (existing) return existing as GlobalSettingsRow

  const { data: inserted, error: insertError } = await supabase
    .from("global_settings")
    .insert({
      ...DEFAULT_GLOBAL_SETTINGS,
      brokerage_id: brokerageId,
      created_by_user_id: userId,
    })
    .select("*")
    .single()

  if (inserted) return inserted as GlobalSettingsRow

  // A concurrent request may have inserted the row first (unique brokerage_id).
  // Re-read before giving up so the caller still gets a valid row.
  const { data: reread } = await supabase
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
  const supabase = await createClient()

  const { error } = await supabase
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
