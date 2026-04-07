import { redirect } from 'next/navigation'

// /dashboard/contacts/[contactId] redirects to /contacts/[contactId] for Kernel OS compatibility
export default async function DashboardContactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id: contactId } = await params
  redirect(`/contacts/${contactId}`)
}
