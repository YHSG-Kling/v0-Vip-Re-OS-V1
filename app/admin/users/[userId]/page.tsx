import { redirect } from "next/navigation"

// Tenant admin surface relocated into the dashboard tree (keep-one consolidation).
export default async function LegacyAdminUserEditPage({
  params,
}: {
  params: Promise<{ userId: string }>
}) {
  const { userId } = await params
  redirect(`/dashboard/admin/users/${userId}`)
}
