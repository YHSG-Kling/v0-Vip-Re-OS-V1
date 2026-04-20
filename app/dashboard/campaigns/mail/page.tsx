import { Suspense } from "react"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { MailDashboard } from "./mail-dashboard"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Direct Mail | VIP Agents AI",
  description: "Manage direct mail campaigns, recipients, tracking, and responses",
}

export default async function DirectMailPage() {
  let brokerageId = ""

  try {
    const supabase = await createClient()

    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) redirect("/login")

    const { data: profile } = await supabase
      .from("users")
      .select("brokerage_id")
      .eq("id", user.id)
      .maybeSingle()

    brokerageId = profile?.brokerage_id ?? ""
  } catch (err) {
    // Non-fatal — render dashboard in degraded state; the client will retry
    console.error("[DirectMailPage] Failed to load brokerage context:", err)
  }

  return (
    <div className="flex flex-col h-full">
      <Suspense fallback={<MailLoadingSkeleton />}>
        <MailDashboard brokerageId={brokerageId} />
      </Suspense>
    </div>
  )
}

function MailLoadingSkeleton() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div className="h-8 w-48 bg-muted rounded animate-pulse" />
        <div className="h-10 w-32 bg-muted rounded animate-pulse" />
      </div>
      <div className="h-10 w-full max-w-md bg-muted rounded animate-pulse" />
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="h-48 bg-muted rounded-xl animate-pulse" />
        ))}
      </div>
    </div>
  )
}
