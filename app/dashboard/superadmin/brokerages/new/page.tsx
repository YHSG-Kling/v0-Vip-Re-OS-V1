import { ArrowLeft } from "lucide-react"
import Link from "next/link"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { ManualSubscriberForm } from "./manual-subscriber-form"

export const dynamic = "force-dynamic"

export default async function NewSubscriberPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")
  const { data: profile } = await supabase.from("users").select("user_type").eq("id", user.id).maybeSingle()
  if (profile?.user_type !== "superadmin") {
    return <div className="p-6 text-red-600">Forbidden: superadmin access only</div>
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <Link href="/dashboard/superadmin/brokerages" className="text-xs text-muted-foreground hover:underline flex items-center gap-1">
          <ArrowLeft className="h-3 w-3" /> All brokerages
        </Link>
        <h1 className="text-2xl font-bold mt-2">Add subscriber manually</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Provision a new brokerage tenant + billing admin in one shot.
          They&apos;ll receive a magic-link invite email to finish onboarding.
          Logged to superadmin audit trail.
        </p>
      </div>
      <ManualSubscriberForm />
    </div>
  )
}
