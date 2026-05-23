import { redirect } from "next/navigation"

/**
 * Legacy buyer-lane dashboard consolidated into the single chronological CRM.
 * Buyers are not a separate lane — they're a contact_type within /crm. Permanent
 * redirect to the buyer-filtered view of the unified CRM dashboard.
 */
export default function LegacyBuyersDashboardRedirect() {
  redirect("/crm?contact_type=buyer")
}
