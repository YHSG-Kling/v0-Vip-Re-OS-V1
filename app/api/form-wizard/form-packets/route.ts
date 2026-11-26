import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { FORM_PACKET_BUCKET, FORM_PACKET_PREVIEW_TTL_SECONDS, listFormPacketsForActor, resolvePacketActor } from "@/lib/forms/tenant-form-packets"

/**
 * GET /api/form-wizard/form-packets?purpose=listing|offer&state=FL — the FormWizard's "My Forms" packets from the BROKERAGE and
 * the TEAM (wave 144, lane 144C — owner ruling 3: "The brokerage or team uploads approved form packets … into THEIR OWN
 * tenant/team bucket and shares them with their agents as templates. Agents only see packets reachable through their actual
 * memberships/permissions; no cross-tenant/team leakage.").
 *
 * TOMBSTONE (§1): DELETED app/api/form-wizard/platform-packets/route.ts (wave 143) — it offered the PLATFORM's packets to
 * every tenant's agents directly. Survivor for what an agent may see: lib/forms/tenant-form-packets.ts listFormPacketsForActor —
 * the brokerage's library, the agent's OWN team's library (canonical membership, lib/kernel/resolve-user-team.ts), and a platform
 * catalogue packet only once the brokerage has added it to its own library (lib/forms/platform-form-packets.ts
 * addPlatformPacketToLibrary).
 *
 * TENANT FROM THE SESSION (CLAUDE.md §4): the caller must be signed in and attached to a brokerage; no id is read from the query
 * string. The library is read with the service client AFTER that gate, as the RESOLVED actor. A packet master is handed out only
 * as a short-lived SIGNED url — never public, never downgraded to public if signing fails (the entry is skipped and counted).
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 })

  const url = new URL(req.url)
  const purposeRaw = url.searchParams.get("purpose")
  if (purposeRaw !== null && purposeRaw !== "listing" && purposeRaw !== "offer") {
    return NextResponse.json({ error: "purpose must be listing or offer" }, { status: 400 })
  }
  const stateRaw = (url.searchParams.get("state") ?? "").trim().toUpperCase()
  const stateCode = /^[A-Z]{2}$/.test(stateRaw) ? stateRaw : null

  const svc = createServiceClient()
  const resolved = await resolvePacketActor(svc as never, user.id)
  if (!resolved.ok) return NextResponse.json({ error: resolved.error, packets: [] }, { status: 403 })

  const listed = await listFormPacketsForActor(svc as never, resolved.actor, { stateCode, purpose: purposeRaw })
  // A refused library read is an error the wizard can show, not an empty list that reads as "your brokerage shares nothing".
  if (!listed.ok) return NextResponse.json({ error: listed.error, packets: [] }, { status: 503 })

  const packets: Array<{ packetId: string | null; name: string; path: string; url: string; scope: "brokerage" | "team"; origin: string; formCode: string | null; state: string | null }> = []
  let unsigned = 0
  for (const p of listed.packets) {
    const { data: signed, error: signErr } = await svc.storage.from(FORM_PACKET_BUCKET).createSignedUrl(p.path, FORM_PACKET_PREVIEW_TTL_SECONDS)
    if (signErr || !signed?.signedUrl) { unsigned++; continue }
    packets.push({ packetId: p.packetId, name: p.name, path: p.path, url: signed.signedUrl, scope: p.scope, origin: p.origin, formCode: p.formCode, state: p.state })
  }
  return NextResponse.json({ packets, unsigned })
}
