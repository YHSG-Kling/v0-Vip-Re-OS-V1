import { redirect } from "next/navigation"

// Legacy console retired to the capability-gated superadmin subtree (keep-one consolidation).
export default function LegacyAdminBillingPage() {
  redirect("/dashboard/superadmin/subscriptions")
}
