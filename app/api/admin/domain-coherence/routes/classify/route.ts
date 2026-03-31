// app/api/admin/domain-coherence/routes/classify/route.ts
// Input contract:  GET — no body, works against full registry
// Output contract: { canonical, redirects, toRemove, children, unclassified }
// Access:          superadmin / admin / broker
// Tables read:     none (registry)
// Tables written:  none

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import {
  enumerateDomainRoutes,
  classifyRouteOwnership,
  detectDuplicateManagerSurfaces,
  type ClassifyOwnershipOutput,
  type DetectDuplicatesOutput,
} from "@/lib/kernel/routes"

interface ClassifyResponse {
  classification: ClassifyOwnershipOutput
  duplicates: DetectDuplicatesOutput
}

export async function GET(): Promise<NextResponse<ClassifyResponse | { error: string }>> {
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

  const { routes } = enumerateDomainRoutes({ includePersonaRoutes: true })
  const classification = classifyRouteOwnership({ routes })
  const duplicates = detectDuplicateManagerSurfaces({ routes })

  return NextResponse.json({ classification, duplicates })
}
