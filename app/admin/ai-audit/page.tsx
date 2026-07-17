import { redirect } from "next/navigation"

// Tenant admin surface relocated into the dashboard tree (keep-one consolidation).
export default function LegacyAdminAIAuditPage() {
  redirect("/dashboard/admin/ai-audit")
}
