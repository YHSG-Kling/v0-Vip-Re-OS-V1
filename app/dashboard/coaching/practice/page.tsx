import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { listPracticeSessions, OBJECTION_SCENARIOS } from "@/app/actions/objection-training"
import { PracticeClient } from "./practice-client"

export const dynamic = "force-dynamic"
export const metadata = { title: "Objection Practice" }

export default async function PracticePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const sessions = await listPracticeSessions()
  return <PracticeClient scenarios={OBJECTION_SCENARIOS} pastSessions={sessions} />
}
