import { Suspense } from "react"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { listPendingApprovalModulesAction } from "@/app/actions/learning-modules-approvals"
import { ApprovalsClient } from "./approvals-client"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "AI Learning Module Approvals | Admin",
  description: "Review AI-generated learning modules. Brokerage brand voice + bio applied during generation; admin approves before publish.",
}

async function ApprovalsData() {
  const result = await listPendingApprovalModulesAction()
  if (!result.ok) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
        Failed to load pending approvals: {result.error}
      </div>
    )
  }
  return <ApprovalsClient initialRows={result.rows} />
}

export default async function ApprovalsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: row } = await supabase
    .from("users")
    .select("user_type")
    .eq("id", user.id)
    .maybeSingle()
  const t = (row?.user_type as string | undefined) ?? ""
  if (!["broker", "broker_admin", "admin", "superadmin", "team_lead"].includes(t)) {
    redirect("/dashboard")
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-foreground">AI Module Approvals</h1>
        <p className="text-muted-foreground max-w-3xl">
          AI-generated learning modules wait here before they reach customers and agents.
          Each draft was flavored with your brokerage&apos;s about text, team bio, and brand
          voice. Approve to publish, or reject with a reason — the kernel records who
          decided and when.
        </p>
      </div>

      <Suspense
        fallback={
          <div className="flex items-center justify-center h-64">
            <div className="animate-pulse text-muted-foreground">Loading pending modules...</div>
          </div>
        }
      >
        <ApprovalsData />
      </Suspense>
    </div>
  )
}
