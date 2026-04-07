// app/api/admin/domain-coherence/routes/enumerate/route.ts
// Input contract:  GET with optional ?includePersonaRoutes=true
// Output contract: EnumerateRoutesOutput | { error: string }
// Access:          superadmin only
// Tables read:     none (filesystem/registry)
// Tables written:  none

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import {
  enumerateDomainRoutes,
  type EnumerateRoutesOutput,
} from "@/lib/kernel/routes"

export async function GET(req: NextRequest): Promise<NextResponse<EnumerateRoutesOutput | { error: string }>> {
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

  const includePersona = req.nextUrl.searchParams.get("includePersonaRoutes") === "true"

  const output = enumerateDomainRoutes({ includePersonaRoutes: includePersona })
  return NextResponse.json(output)
}
