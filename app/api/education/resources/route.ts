import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { NextResponse } from "next/server"

// CLAUDE.md §4 FIX (found alongside the handler-parity POST tombstone below,
// 2026-09-11): this handler had NO auth check at all and trusted a
// query-string `brokerageId` — any caller, signed in or not, could read
// another brokerage's published learning_modules by changing the query
// string. Tenant now comes from the SESSION (requireAuth), never the URL;
// the caller (EducationLibrary.tsx) already passes its OWN brokerageId prop
// so its behavior is unchanged, and a mismatched/forged id can no longer
// widen a read. No parameters are declared at all — every input this
// handler now uses comes from the session, so there is nothing on the
// Request object to name.
export async function GET() {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    // Post-1042: educational_moments collapsed into learning_modules
    const { data: resources } = await supabase
      .from("learning_modules")
      .select("id, title, summary, body, channels, estimated_minutes, view_count, is_ai_generated, status, published_at, created_at")
      .eq("brokerage_id", auth.brokerageId)
      .eq("status", "published")
      .order("created_at", { ascending: false })

    return NextResponse.json({ resources })
  } catch (error) {
    return NextResponse.json({ error: "Failed to fetch resources" }, { status: 500 })
  }
}

// TOMBSTONE (§1.3 orphan doctrine — scripts/handler-parity-census.ts,
// 2026-09-11): POST used to live here, wrapping createEducationalResource —
// zero in-tree callers, and it trusted `body.brokerageId` directly (the same
// class of §4 violation the GET above carried, just on the write side).
// app/actions/education-kernel.ts::createResourceAction is the live door for
// authoring a resource — it resolves the actor + tenant from the SESSION
// (resolveActor → getAgentContext) before calling the exact same
// lib/kernel/education.ts::createEducationalResource this route called, so
// the capability was never missing, only reachable through a door with a
// real tenancy gate on it.
