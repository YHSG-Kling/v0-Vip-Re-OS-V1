import { redirect } from "next/navigation"

// Notification Rules lives under /settings/notifications. This dashboard route
// keeps the URL consistent with the rest of the agent settings subnav.
export default function DashboardSettingsNotificationRulesPage() {
  redirect("/settings/notifications")
}
