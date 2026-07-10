import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { loadWealthOpportunities } from "./actions"
import { WealthClient } from "./wealth-client"

export const metadata = { title: "Wealth Opportunities" }
export const dynamic = "force-dynamic"

export default async function WealthOpportunitiesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const result = await loadWealthOpportunities()
  if ("error" in result) redirect("/dashboard")

  return <WealthClient data={result.data} />
}
