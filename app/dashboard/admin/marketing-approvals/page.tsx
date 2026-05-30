import { Suspense } from "react"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { listPendingMarketingAssetsAction } from "@/app/actions/marketing-ai-approvals"
import { MarketingApprovalsClient } from "./marketing-approvals-client"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Marketing Asset Approvals | Admin",
  description: "Approve AI-generated newsletter / blog / podcast / direct-mail drafts before they reach audiences. Brand voice + brokerage bio applied during generation.",
}

async function Data() {
  const result = await listPendingMarketingAssetsAction()
  if (!result.ok) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
        Failed to load: {result.error}
      </div>
    )
  }
  return <MarketingApprovalsClient initialRows={result.rows} />
}

export default async function MarketingApprovalsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: row } = await supabase
    .from("users").select("user_type").eq("id", user.id).maybeSingle()
  const t = (row?.user_type as string | undefined) ?? ""
  if (!["broker", "broker_admin", "admin", "superadmin", "team_lead"].includes(t)) {
    redirect("/dashboard")
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-foreground">Marketing Asset Approvals</h1>
        <p className="text-muted-foreground max-w-3xl">
          AI-drafted newsletters, blog posts, podcast scripts, and direct-mail copy wait
          here for review. Each draft was flavored with your brokerage&apos;s brand voice,
          about text, and team bio. Approve to allow scheduling, or reject with a reason.
        </p>
      </div>
      <Suspense fallback={<div className="animate-pulse text-muted-foreground">Loading pending assets...</div>}>
        <Data />
      </Suspense>
    </div>
  )
}
