import { Suspense } from "react"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import MarketingStudioClient from "./marketing-studio-client"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Marketing Studio | Dashboard",
  description: "Unified marketing command center for campaigns, assets, and content scheduling",
}

export default async function MarketingStudioPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>
}) {
  const params = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: userRow } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()

  return (
    <Suspense fallback={<MarketingStudioSkeleton />}>
      <MarketingStudioClient
        userId={user.id}
        brokerageId={userRow?.brokerage_id ?? ""}
        userRole={userRow?.user_type ?? "agent"}
        initialTab={params.tab ?? "overview"}
      />
    </Suspense>
  )
}

function MarketingStudioSkeleton() {
  return (
    <div className="min-h-screen bg-background p-6 lg:p-8">
      <div className="max-w-[1600px] mx-auto space-y-6">
        {/* Header skeleton */}
        <div className="h-32 bg-muted animate-pulse rounded-xl" />
        {/* Stats skeleton */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />
          ))}
        </div>
        {/* Tabs skeleton */}
        <div className="h-16 bg-muted animate-pulse rounded-lg" />
        {/* Content skeleton */}
        <div className="h-96 bg-muted animate-pulse rounded-lg" />
      </div>
    </div>
  )
}
