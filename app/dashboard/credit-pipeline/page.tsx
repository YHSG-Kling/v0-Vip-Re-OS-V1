import { redirect } from "next/navigation"

export default function DashboardCreditPipelinePage({
  searchParams,
}: {
  searchParams: { contactId?: string }
}) {
  const qs = searchParams.contactId ? `?contactId=${searchParams.contactId}` : ""
  redirect(`/credit-pipeline${qs}`)
}
