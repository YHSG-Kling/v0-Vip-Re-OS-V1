import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { listFeeTypes, listBrokerageCharges } from "@/app/actions/brokerage-fees"
import { BrokerageFeesClient } from "./brokerage-fees-client"

export const dynamic = "force-dynamic"
export const metadata = { title: "Brokerage Fees" }

export default async function BrokerageFeesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const [feeTypes, charges] = await Promise.all([
    listFeeTypes(),
    listBrokerageCharges(),
  ])

  return <BrokerageFeesClient initialFeeTypes={feeTypes} initialCharges={charges} />
}
