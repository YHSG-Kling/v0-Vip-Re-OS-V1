import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  listPlatformPacketsForTenant,
  PLATFORM_PACKET_BUCKET,
  PLATFORM_PACKET_PREVIEW_TTL_SECONDS,
} from "@/lib/forms/platform-form-packets"

/**
 * GET /api/form-wizard/platform-packets?purpose=listing|offer&state=FL — the FormWizard's "platform Media"
 * source (wave 143, lane 143B; closes wave 142's pending hook "142B SOURCE (a)").
 *
 * The licensed form packets the PLATFORM holds for every subscriber, offered to the wizard as ordinary
 * "My Forms" entries with scope `platform`. The wizard hands the returned `path` to the same fill action
 * every other form uses; lib/forms/form-path-scope.ts admits a `platform/…` path only while its registry
 * row is approved and in licence.
 *
 * TENANT FROM THE SESSION (CLAUDE.md §4). The caller must be a signed-in user attached to a brokerage; no id
 * is read from the query string. The catalogue itself is platform content (no tenant column), read with the
 * service client AFTER that gate, and only `status = 'approved'` rows that are in licence for the question.
 * A blank master is previewed through a short-lived SIGNED url — never public, never downgraded to public if
 * signing fails (the entry is skipped and counted).
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 })

  const { data: me, error: meErr } = await supabase.from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  if (meErr) return NextResponse.json({ error: `Could not read your account: ${meErr.message}` }, { status: 500 })
  if (!me?.brokerage_id) return NextResponse.json({ error: "Your account is not attached to a brokerage" }, { status: 403 })

  const url = new URL(req.url)
  const purposeRaw = url.searchParams.get("purpose")
  if (purposeRaw !== null && purposeRaw !== "listing" && purposeRaw !== "offer") {
    return NextResponse.json({ error: "purpose must be listing or offer" }, { status: 400 })
  }
  const stateRaw = (url.searchParams.get("state") ?? "").trim().toUpperCase()
  const stateCode = /^[A-Z]{2}$/.test(stateRaw) ? stateRaw : null

  const svc = createServiceClient()
  const listed = await listPlatformPacketsForTenant(svc, { stateCode, purpose: purposeRaw })
  // A refused registry read is an error the wizard can show, not an empty list that reads as "none exist".
  if (!listed.ok) return NextResponse.json({ error: listed.error, packets: [] }, { status: 503 })

  const packets: Array<{ packetId: string; name: string; formCode: string | null; state: string | null; version: number; path: string; url: string; description: string | null }> = []
  let unsigned = 0
  for (const p of listed.packets) {
    const { data: signed, error: signErr } = await svc.storage.from(PLATFORM_PACKET_BUCKET).createSignedUrl(p.path, PLATFORM_PACKET_PREVIEW_TTL_SECONDS)
    if (signErr || !signed?.signedUrl) { unsigned++; continue }
    packets.push({ packetId: p.packetId, name: p.name, formCode: p.formCode, state: p.state, version: p.version, path: p.path, url: signed.signedUrl, description: p.description })
  }
  return NextResponse.json({ packets, unsigned })
}
