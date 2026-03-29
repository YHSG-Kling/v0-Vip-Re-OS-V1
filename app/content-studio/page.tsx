import { Suspense } from "react"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { Loader2 } from "lucide-react"
import ContentStudioClient from "./content-studio-client"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Content & Marketing Studio | VIP Agents AI",
  description: "AI-powered content creation for real estate professionals",
}

export default async function ContentStudioPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect("/login")

  // Resolve user_type (not role) and brokerage_id from users table
  const { data: userRow } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()

  const brokerageId = userRow?.brokerage_id ?? ""
  const userRole = userRow?.user_type ?? "agent"

  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-background flex items-center justify-center">
          <div className="text-center">
            <Loader2 className="h-12 w-12 animate-spin text-primary mx-auto mb-4" />
            <p className="text-muted-foreground font-medium">Loading Content Studio...</p>
          </div>
        </div>
      }
    >
      <ContentStudioClient
        userId={user.id}
        userRole={userRole}
        brokerageId={brokerageId}
      />
    </Suspense>
  )
}
