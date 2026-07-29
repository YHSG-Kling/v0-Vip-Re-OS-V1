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
import { resolveAllAppCapabilities, blockExplanation } from "@/lib/agentic-os/resolve-app-capability"

export async function GET(req: Request) {
  const caller = await resolveAgenticCaller(req)
  if (caller.via === "none") {
    return NextResponse.json({ error: "Unauthenticated — supply an agent bearer token or sign in" }, { status: 401 })
  }

  const manifest = buildFullActionManifest()

  // AUTHORIZED is not the same question as OPERABLE. Scope says the caller may
  // invoke it; the capability contract says whether it can actually run for this
  // tenant. Without the second answer an agent learned its own limits by calling
  // a tool and watching it fail — so a discovering agent now gets both, and the
  // REASON a dark capability is dark.
  let operable: string[] | undefined
  let dark: Array<{ action: string; capability: string; reason: string; missing: string[]; explanation: string | null }> | undefined

  if (caller.brokerageId) {
    // Brokerage scope only — the caller is a brokerage-scoped agent token or a
    // session; connection-manager still applies its agent → platform → integration
    // precedence internally.
    const resolutions = await resolveAllAppCapabilities({ brokerageId: caller.brokerageId })
    const byCapability = new Map(resolutions.map((r) => [r.capability as string, r]))
    operable = manifest
      .filter((a) => a.kind !== "app" || byCapability.get(a.capability)?.operable !== false)
      .map((a) => a.action)
    dark = resolutions
      .filter((r) => !r.operable)
      .map((r) => ({
        action: `${r.def.verb} ${r.capability}`,
        capability: r.capability,
        reason: r.reason ?? "unknown",
        missing: r.missing,
        explanation: blockExplanation(r),
      }))
  }

  return NextResponse.json({
    protocol: "agentic-api",
    verbs: AGIS_VERBS,
    actions: manifest,
    authorized: authorizedActions(manifest, caller.scopes).map((a) => a.action),
    // Absent when the caller has no brokerage context (platform-wide token):
    // omitted rather than guessed, because an empty list would read as "nothing works".
    ...(operable ? { operable, dark } : {}),
    authenticatedVia: caller.via,
  })
}
