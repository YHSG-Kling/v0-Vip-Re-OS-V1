import { redirect } from "next/navigation"

/**
 * Legacy buyer-detail route consolidated under the CRM contacts dashboard.
 * Permanent redirect to /contacts/[contactId] — the unified agent-facing view
 * for buyers, sellers, and lifetime contacts.
 */
export default async function LegacyBuyerDetailRedirect(
  { params }: { params: Promise<{ contactId: string }> },
) {
  const { contactId } = await params
  redirect(`/contacts/${contactId}`)
}
