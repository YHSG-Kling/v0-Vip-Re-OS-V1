import { redirect } from "next/navigation"

// Legacy console retired to the capability-gated superadmin subtree (keep-one consolidation).
export default function LegacyAdminProvidersPage() {
  redirect("/dashboard/superadmin/connectors")
}
