import { redirect } from "next/navigation"

// Retired nav grid — the tenant admin hub is the canonical entry point (keep-one consolidation).
export default function LegacyAdminMenuPage() {
  redirect("/dashboard/admin")
}
