import { redirect } from "next/navigation"

// Redirect to main settings branding page
export default function DashboardSettingsBrandingPage() {
  redirect("/settings/branding")
}
