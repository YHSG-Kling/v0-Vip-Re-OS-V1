import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getOverdueSummary } from "@/app/actions/overdue"
import { OverdueClient } from "./overdue-client"

export const dynamic = "force-dynamic"
export const metadata = { title: "Overdue" }

export default async function OverduePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const summary = await getOverdueSummary()
  return <OverdueClient summary={summary} />
}
