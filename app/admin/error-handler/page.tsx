import { redirect } from "next/navigation"

// Tenant admin surface relocated into the dashboard tree (keep-one consolidation).
export default function LegacyAdminErrorHandlerPage() {
  redirect("/dashboard/admin/error-handler")
}
