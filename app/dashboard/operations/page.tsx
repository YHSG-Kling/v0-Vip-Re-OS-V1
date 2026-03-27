import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { OperationsClient } from "./operations-client"

export const metadata = {
  title: "Operations Command Center | Kernel OS",
  description: "Daily operations: showings, AI handoffs, drafts, and stuck-work detector.",
}

export default async function OperationsPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect("/login")

  const { data: userRecord } = await supabase
    .from("users")
    .select("first_name, role")
    .eq("id", user.id)
    .maybeSingle()

  const role = userRecord?.role ?? "agent"
  const firstName = userRecord?.first_name ?? undefined

  return <OperationsClient role={role} firstName={firstName} />
}
