import { redirect } from "next/navigation"

// Legacy console retired to the capability-gated superadmin subtree (keep-one consolidation).
export default function LegacyAdminBrokeragesPage() {
  redirect("/dashboard/superadmin/brokerages")
}
