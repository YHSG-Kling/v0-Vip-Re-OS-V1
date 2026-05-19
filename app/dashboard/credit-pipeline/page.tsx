import { redirect } from "next/navigation"

export default async function DashboardCreditPipelinePage({
  searchParams,
}: {
  searchParams: Promise<{ contactId?: string }>
}) {
  const sp = await searchParams
  const qs = sp.contactId ? `?contactId=${sp.contactId}` : ""
  redirect(`/credit-pipeline${qs}`)
}
