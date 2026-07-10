import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { loadStaleQueue } from "./actions"
import { StaleClient } from "./stale-client"

export const metadata = { title: "Stale Queue" }
export const dynamic = "force-dynamic"

export default async function StalePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const result = await loadStaleQueue()
  if ("error" in result) redirect("/dashboard")

  return <StaleClient data={result.data} />
}
