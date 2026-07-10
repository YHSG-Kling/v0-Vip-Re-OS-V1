import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { loadSphereResonance } from "./actions"
import { SphereClient } from "./sphere-client"

export const metadata = { title: "Sphere Resonance" }
export const dynamic = "force-dynamic"

export default async function SphereResonancePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const result = await loadSphereResonance()
  if ("error" in result) redirect("/dashboard")

  return <SphereClient data={result.data} />
}
