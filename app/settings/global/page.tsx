import { redirect } from "next/navigation"

/**
 * /settings/global — retired.
 *
 * It was a 395-line superset with no nav entry and no inbound link anywhere: reachable
 * only by typing the URL. It edited the same per-brokerage `global_settings` row as
 * /settings/general and /settings/branding, so the same field could be saved from
 * three places and the last page you happened to open won.
 *
 * "Global" was also a misnomer. Platform-wide settings — the ones belonging to whoever
 * runs the whole OS — live at /dashboard/superadmin/platform and always did. Nothing
 * on this page was platform-level; every field was one brokerage's.
 *
 * Where each field went, none dropped:
 *   app_name, timezone, date_format   → /settings/general      (already owned them)
 *   primary/secondary_color, font     → /settings/branding     (already owned them)
 *   currency_symbol                   → /settings/general      (moved — was unique here)
 *   email/sms/push notification gates → /settings/notifications (moved — was unique here)
 *   chat widget scope + embed code    → /dashboard/settings/widget (moved — was unique here)
 *
 * General is the surface everyone actually reaches, so the URL lands there.
 */
export default function RetiredGlobalSettingsPage() {
  redirect("/settings/general")
}
