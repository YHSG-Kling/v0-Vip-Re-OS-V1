import { redirect } from "next/navigation"

export default async function LegacyPersonaDashboardRedirect({
  params,
}: {
  params: Promise<{ contactId: string; persona: string }>
}) {
  const { contactId } = await params
  // Legacy persona routing removed. Kernel portal determines view automatically
  // via lib/kernel/portal.ts → determinePortalView() → contacts.contact_persona
  redirect(`/portal/${contactId}`)
}
