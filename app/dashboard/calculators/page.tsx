import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { CalculatorsDashboardClient } from "./calculators-client"

export const dynamic = "force-dynamic"

export default async function CalculatorsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  const { data: userProfile } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  const brokerageId = userProfile?.brokerage_id ?? ""

  return <CalculatorsDashboardClient brokerageId={brokerageId} />
}
