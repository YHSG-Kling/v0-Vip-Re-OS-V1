import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getAiOpsAction } from "@/app/actions/superadmin/ai-ops"
import { AiOpsConsole } from "./ai-ops-console"

export const dynamic = "force-dynamic"

export default async function SuperadminAiOpsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")
  const { data: profile } = await supabase.from("users").select("user_type, platform_role").eq("id", user.id).maybeSingle()
  const isStaff = ["superadmin", "support"].includes((profile as any)?.user_type) || ["superadmin", "support"].includes((profile as any)?.platform_role)
  if (!isStaff) return <div className="p-6 text-red-600">Forbidden: platform staff only</div>

  const res = await getAiOpsAction(24)
  if (!res.ok) return <div className="p-6 text-red-600">Failed: {res.error}</div>
  return <AiOpsConsole data={res.data} />
}
