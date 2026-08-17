import { Suspense } from "react"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { listLearningModulesForBrokerageAction } from "@/app/actions/learning-modules"
import { LearningModulesClient } from "./learning-modules-client"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Learning Modules | Admin",
  description: "Author and multi-channel-publish learning modules. One write, fan out to article / video / podcast / newsletter / blog / quiz / social / portal.",
}

async function LearningModulesData() {
  const result = await listLearningModulesForBrokerageAction({ limit: 100 })
  if (!result.ok) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
        Failed to load modules: {result.error}
      </div>
    )
  }
  return <LearningModulesClient initialModules={result.rows} />
}

export default async function LearningModulesPage() {
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
        <h1 className="text-2xl font-semibold text-foreground">Learning Modules</h1>
        <p className="text-muted-foreground max-w-3xl">
          Write once. Publish to any subset of channels — articles, blog, videos, podcasts,
          newsletter, email, social, quiz, portal lessons. The Knowledge & Growth Router
          intersects each module&apos;s audience tags against every actor&apos;s context (persona,
          generation, stage, performance gaps) and surfaces the right module at the right
          moment.
        </p>
      </div>

      <Suspense
        fallback={
          <div className="flex items-center justify-center h-64">
            <div className="animate-pulse text-muted-foreground">Loading modules...</div>
          </div>
        }
      >
        <LearningModulesData />
      </Suspense>
    </div>
  )
}
