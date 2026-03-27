"use server"

import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { getAIIdentityProfile } from "@/app/actions/ai-identity"
import { AICallSetupClient } from "./AICallSetupClient"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "AI Call Handling Setup | Onboarding",
}

export default async function AICallSetupPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profile } = await supabase
    .from("users")
    .select("id, user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id || !["broker", "admin", "superadmin"].includes(profile.user_type ?? "")) {
    redirect("/dashboard")
  }

  const brokerageId = profile.brokerage_id

  const { data: brokerage } = await supabase
    .from("brokerages")
    .select("name")
    .eq("id", brokerageId)
    .maybeSingle()

  const { data: existingProfile } = await getAIIdentityProfile("brokerage", brokerageId)

  return (
    <AICallSetupClient
      brokerageId={brokerageId}
      brokerageName={brokerage?.name ?? ""}
      existingProfile={existingProfile}
    />
  )
}
