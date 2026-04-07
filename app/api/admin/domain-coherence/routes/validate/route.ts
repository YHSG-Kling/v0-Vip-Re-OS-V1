// app/api/admin/domain-coherence/routes/validate/route.ts
// Input contract:  GET — runs full coherence report
// Output contract: CoherenceReport
// Access:          superadmin / admin / broker
// Tables read:     none (registry)
// Tables written:  none

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import {
  generateDomainCoherenceReport,
  type CoherenceReport,
} from "@/lib/kernel/routes"

export async function GET(): Promise<NextResponse<CoherenceReport | { error: string }>> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { data: profile } = await supabase
    .from("users")
    .select("user_type")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile || !["superadmin", "admin", "broker"].includes(profile.user_type ?? "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const report = generateDomainCoherenceReport({ includeRecommendations: true })
  return NextResponse.json(report)
}
