import { redirect } from "next/navigation"

export default async function ContactDetailPage({
  params,
}: {
  params: { contactId: string }
}) {
  const { contactId } = await params
  redirect(`/crm?contact=${contactId}`)
}
