// app/api/agentic-os/actions/route.ts
// Agentic-API DISCOVER endpoint (agenticapi.com ACTION model). Returns the unified,
// VENDOR-ANONYMOUS action manifest — every external connector capability AND every
// internal kernel operation — as AGIS intent verbs with the scope each requires.
// Authenticates via an agent bearer token (scopes from the credential) OR the session
// (platform staff hold all scopes). `authorized` is the subset the caller may invoke.
import { NextResponse } from "next/server"
import { buildFullActionManifest } from "@/lib/agentic-os/app-capability-registry"
import { AGIS_VERBS } from "@/lib/agentic-os/vendor-capability-registry"
import { authorizedActions } from "@/lib/agentic-os/agent-scopes"
import { resolveAgenticCaller } from "@/lib/agentic-os/agent-credentials"

export async function GET(req: Request) {
  const caller = await resolveAgenticCaller(req)
  if (caller.via === "none") {
    return NextResponse.json({ error: "Unauthenticated — supply an agent bearer token or sign in" }, { status: 401 })
  }

  const manifest = buildFullActionManifest()
  return NextResponse.json({
    protocol: "agentic-api",
    verbs: AGIS_VERBS,
    actions: manifest,
    authorized: authorizedActions(manifest, caller.scopes).map((a) => a.action),
    authenticatedVia: caller.via,
  })
}
