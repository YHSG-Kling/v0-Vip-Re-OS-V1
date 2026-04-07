import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { AIIdentityEditor } from "@/app/components/ai-identity/AIIdentityEditor"
import { getAIIdentityProfile } from "@/app/actions/ai-identity"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "AI Identity | Admin",
  description: "Configure how your AI assistant represents your brokerage",
}

export default async function AdminAIIdentityPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profile } = await supabase
    .from("users")
    .select("id, user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  // Role gate: admin + broker only
  if (!profile?.brokerage_id || !["broker", "admin"].includes(profile.user_type || "")) {
    redirect("/dashboard")
  }

  const brokerageId = profile.brokerage_id

  // Get brokerage name
  const { data: brokerage } = await supabase
    .from("brokerages")
    .select("name")
    .eq("id", brokerageId)
    .maybeSingle()

  // Load brokerage AI identity profile
  const { data: existingProfile } = await getAIIdentityProfile("brokerage", brokerageId)

  return (
    <div className="container mx-auto p-6 max-w-5xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">AI Identity Studio</h1>
        <p className="text-muted-foreground mt-1">
          Define the voice, knowledge, and guardrails your AI assistant uses when representing{" "}
          {brokerage?.name ?? "your brokerage"}. These settings cascade to teams and agents who can
          override them as needed.
        </p>
      </div>

      <AIIdentityEditor
        scope="brokerage"
        scopeId={brokerageId}
        brokerageId={brokerageId}
        brokerageName={brokerage?.name ?? undefined}
        initialProfile={existingProfile}
        parentProfile={null}
      />
    </div>
  )
}
