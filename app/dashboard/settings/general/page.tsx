import { redirect } from "next/navigation"

// Redirect to main settings page
export default function DashboardSettingsGeneralPage() {
  redirect("/settings/general")
}
