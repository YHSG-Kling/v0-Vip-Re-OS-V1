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

// ─── EXPORTED FUNCTIONS ───────────────────────────────────────────────────────

export async function getGlobalSettings(params: {
  userId: string
}): Promise<GlobalSettingsRow> {
  const { brokerageId } = await requireBrokerAdmin(params.userId)
  const supabase = await createClient()

  const { data: row, error } = await supabase
    .from("global_settings")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .single()

  if (error || !row) {
    throw new Error("Settings not initialized for this brokerage")
  }

  return row as GlobalSettingsRow
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
