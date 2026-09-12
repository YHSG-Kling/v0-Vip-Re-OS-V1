import { redirect } from "next/navigation"
import { Suspense } from "react"
import { createClient } from "@/lib/supabase/server"
import { listMarketingCampaignsAction } from "@/app/actions/marketing-campaigns-admin"
import { MarketingCampaignsClient } from "./marketing-campaigns-client"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

export const dynamic = "force-dynamic"

export const metadata = {
  title:       "Marketing Campaigns | Admin",
  description: "Author, schedule, launch, and measure campaigns. Each campaign fans out across newsletter / blog / podcast / direct mail / social, all priced into one ROI rollup.",
}

async function CampaignsData() {
  const result = await listMarketingCampaignsAction()
  if (!result.ok) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
        Failed to load campaigns: {result.error}
      </div>
    )
  }
  return <MarketingCampaignsClient initialRows={result.rows} />
}

export default async function MarketingCampaignsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: row } = await supabase
    .from("users")
    .select("user_type")
    .eq("id", user.id)
    .maybeSingle()
  const t = (row?.user_type as string | undefined) ?? ""
  if (!isAdminOrBroker({ user_type: t })) {
    redirect("/dashboard")
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-foreground">Marketing Campaigns</h1>
        <p className="text-muted-foreground max-w-3xl">
          One campaign, every channel. Audience-targeted by persona / generation / age /
          lead source / buyer stage. Compliance-gated before launch (DNC, TCPA, channel
          opt-outs all enforced). Performance rolls up into one impression / engagement /
          conversion score across newsletter, blog, podcast, direct mail, social, and QR.
        </p>
      </div>

      <Suspense
        fallback={
          <div className="flex items-center justify-center h-64">
            <div className="animate-pulse text-muted-foreground">Loading campaigns...</div>
          </div>
        }
      >
        <CampaignsData />
      </Suspense>
    </div>
  )
}
