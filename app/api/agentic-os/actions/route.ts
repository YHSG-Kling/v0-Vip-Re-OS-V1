// app/api/agentic-os/actions/route.ts
// Agentic-API DISCOVER endpoint (agenticapi.com ACTION model). Returns the
// machine-readable, VENDOR-ANONYMOUS action manifest: each capability as an AGIS
// intent verb (FIND/ANALYZE/ENRICH/RENDER/NOTIFY...) with the scope it requires, its
// inputs, business purpose, and intent weight — so an external AI agent can DISCOVER
// what the command center can do and which scopes to request. Connector/vendor names
// are NOT exposed here (that's resolved internally at invoke time).
import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { isPlatformStaff } from "@/lib/auth/resolve-user-role"
import { buildActionManifest, AGIS_VERBS } from "@/lib/agentic-os/vendor-capability-registry"
import { authorizedActions, ALL_SCOPES } from "@/lib/agentic-os/agent-scopes"

export async function GET() {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  const manifest = buildActionManifest()
  // Platform staff implicitly hold all scopes. (Per-agent scope grants are a future
  // token layer; until then non-staff callers see the contract but no authorized set.)
  const granted = isPlatformStaff(auth.userType) ? [ALL_SCOPES] : []

  return NextResponse.json({
    protocol: "agentic-api",
    verbs: AGIS_VERBS,
    actions: manifest,
    authorized: authorizedActions(manifest, granted).map((a) => a.action),
  })
}
