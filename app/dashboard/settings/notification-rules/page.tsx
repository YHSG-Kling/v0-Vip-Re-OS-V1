import { redirect } from "next/navigation"

// Consolidated: Notification Rules had two pages over the SAME kernel
// (createNotificationRule/updateNotificationRule/listNotificationRules, all
// requireBrokerAdmin-gated). Canonical is /settings/notifications (the settings
// tree, and the only one carrying the Push Notifications toggle). This legacy
// dashboard-tree page is now a redirect stub — same pattern as general/branding.
export default function DashboardSettingsNotificationRulesPage() {
  redirect("/settings/notifications")
}
