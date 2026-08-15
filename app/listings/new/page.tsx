import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity"

export default async function NewListingPage() {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect("/login")
  if (!ctx.brokerageId) redirect("/dashboard/onboarding")
  redirect("/dashboard/listings?action=new")
}
