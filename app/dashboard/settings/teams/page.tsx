import { redirect } from "next/navigation"

// Redirect to main settings users page
export default function DashboardSettingsTeamsPage() {
  redirect("/settings/users")
}
