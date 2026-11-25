import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolvePacketActor, retireTenantFormPacket, type PacketActor } from "@/lib/forms/tenant-form-packets"

/**
 * /api/forms/directory — ADD FORMS AND PACKET BUNDLES; RESOLVE A DEAL'S PACKET (wave 156, lane 156C).
 *
 * Owner (wave 156): "the form packet tool should list all possible forms/packets or have the capability for the user or manager to
 * add more." Owned by the Compliance Manager (`compliance_officer`) with the forms kernel; no Forms Manager.
 *
 * GET  ?kind=<bundle kind>&state=TX&county=Travis → the deal's ONE packet (lib/forms/form-packet-bundles.ts resolveDealPacket):
 *      ordered items, required / optional, each `ready` / `replaced` / `retired` / `license_expired` / `not_configured` with its
 *      recovery actions (request access / add licensed file / link provider form).
 * POST JSON { action, … } or multipart (action=add_form, mode=upload, file=<pdf>, meta=<json>):
 *      add_form           — upload / state_preconfigured / provider_form (lib/forms/form-directory-intake.ts addFormToLibrary)
 *      revise_form        — a new revision (multipart: packet_id, file, revision_date, effective_on) — the old one retired, replaced_by
 *      retire_form        — retire (optional replaced_by_id)
 *      create_bundle / add_bundle_item / remove_bundle_item / reorder_bundle
 *
 * GATE (CLAUDE.md §4): a signed-in ACTIVE tenant staff seat — resolvePacketActor refuses a contact, vendor, suspended or deactivated
 * seat (so a Contact or vendor can never add or overwrite a packet master). Tenant / team / office come from the SESSION; a body
 * never names a brokerage. Authority per owner is decided in the writers (mayManagePacketOwner). Every write leaves ONE receipt
 * through ledgerSessionAction (LAW 5); provider lookups go through the tenant's own connected provider, resolved here.
 */

async function gate(): Promise<{ actor: PacketActor; svc: ReturnType<typeof createServiceClient> } | NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const svc = createServiceClient()
  const resolved = await resolvePacketActor(svc as never, user.id)
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 403 })
  return { actor: resolved.actor, svc }
}

export async function GET(req: NextRequest) {
  const g = await gate()
  if (g instanceof NextResponse) return g
  const url = new URL(req.url)
  const { PACKET_BUNDLE_KINDS, resolveDealPacket } = await import("@/lib/forms/form-packet-bundles")
  const kind = url.searchParams.get("kind") ?? ""
  const state = (url.searchParams.get("state") ?? "").trim().toUpperCase()
  if (!(PACKET_BUNDLE_KINDS as readonly string[]).includes(kind)) return NextResponse.json({ error: `kind must be one of ${PACKET_BUNDLE_KINDS.join(", ")}` }, { status: 400 })
  if (!/^[A-Z]{2}$/.test(state)) return NextResponse.json({ error: "state must be a two-letter code" }, { status: 400 })
  const r = await resolveDealPacket(g.svc as never, g.actor, { kind: kind as (typeof PACKET_BUNDLE_KINDS)[number], state, county: url.searchParams.get("county") })
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 503 })
  return NextResponse.json(r.packet)
}

const str = (v: unknown) => (typeof v === "string" ? v : null)
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 50) : [])

export async function POST(req: NextRequest) {
  const g = await gate()
  if (g instanceof NextResponse) return g
  const { actor, svc } = g
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")

  let body: Record<string, unknown> = {}
  let file: { name: string; bytes: Uint8Array } | null = null
  const ctype = req.headers.get("content-type") ?? ""
  try {
    if (ctype.includes("multipart/form-data")) {
      const form = await req.formData()
      const meta = form.get("meta")
      body = typeof meta === "string" ? JSON.parse(meta) : {}
      for (const k of ["action", "mode", "packet_id", "revision_date", "effective_on"]) { const v = form.get(k); if (typeof v === "string") body[k] = v }
      const f = form.get("file")
      if (f && typeof f === "object" && "arrayBuffer" in f) file = { name: (f as File).name, bytes: new Uint8Array(await (f as File).arrayBuffer()) }
    } else {
      body = await req.json()
    }
  } catch { return NextResponse.json({ error: "Send JSON, or multipart with a `meta` JSON field." }, { status: 400 }) }

  const action = str(body.action)
  const receipt = <T,>(name: string, subject: { type: string; id?: string | null }, riskClass: string, run: () => Promise<T>) =>
    ledgerSessionAction({ brokerageId: actor.brokerageId, action: name, actor: { type: "user", userId: actor.userId }, subject, riskClass, reasonCode: "HUMAN_REQUESTED" }, run)
  const done = (r: unknown) => {
    const o = r as { ok?: boolean; success?: boolean; error?: string }
    return NextResponse.json(r, { status: o.ok === false || o.success === false ? 422 : 200 })
  }

  if (action === "add_form") {
    const mode = str(body.mode)
    if (mode !== "upload" && mode !== "state_preconfigured" && mode !== "provider_form") return NextResponse.json({ error: "mode must be upload, state_preconfigured or provider_form" }, { status: 400 })
    const { addFormToLibrary } = await import("@/lib/forms/form-directory-intake")
    let provider: { listForms: (r: any) => Promise<any> } | null = null
    let providerName: string | null = null
    if (mode === "provider_form") {
      const { resolveESignProviderForActor } = await import("@/lib/integrations/resolve-esign-provider")
      const { classifyResolveFailure } = await import("@/lib/forms/provider-form-directory")
      try {
        const res = await resolveESignProviderForActor({ brokerageId: actor.brokerageId, userId: actor.userId, teamId: actor.teamId })
        provider = res.provider; providerName = res.providerName
      } catch (err: any) {
        const refusal = classifyResolveFailure(err?.message)
        return NextResponse.json({ ok: false, error: refusal.message, refusal }, { status: 409 })
      }
    }
    const input = {
      mode, owner: { teamId: str(body.team_id), locationId: str(body.location_id), scopeUserId: body.for_myself === true ? actor.userId : null },
      name: str(body.name) ?? "", state: str(body.state) ?? "", packetType: str(body.packet_type) ?? "", formCode: str(body.form_code), description: str(body.description),
      licenseNote: str(body.license_note), licenseExpiresAt: str(body.license_expires_at), rightsBasis: str(body.rights_basis) ?? "", purpose: str(body.purpose) ?? "",
      county: str(body.county), effectiveOn: str(body.effective_on) ?? "", revisionDate: str(body.revision_date), checklistKeys: strs(body.checklist_keys),
      signerRoles: strs(body.signer_roles), fieldMapping: body.field_mapping && typeof body.field_mapping === "object" ? (body.field_mapping as Record<string, string>) : null,
      fileName: file?.name ?? null, bytes: file?.bytes ?? null, providerFormId: str(body.provider_form_id),
    } as const
    return done(await receipt("forms.library.add", { type: "brokerage_form_library", id: null }, "LEGAL", () => addFormToLibrary(svc as never, actor, input as never, { provider, providerName })))
  }
  if (action === "revise_form") {
    if (!file) return NextResponse.json({ error: "Attach the new revision's PDF." }, { status: 400 })
    const { reviseLibraryForm } = await import("@/lib/forms/form-directory-intake")
    const id = str(body.packet_id) ?? ""
    return done(await receipt("forms.library.revise", { type: "brokerage_form_library", id }, "LEGAL", () => reviseLibraryForm(svc as never, actor, id, { fileName: file!.name, bytes: file!.bytes, revisionDate: str(body.revision_date) ?? "", effectiveOn: str(body.effective_on) ?? "" })))
  }
  if (action === "retire_form") {
    const id = str(body.packet_id) ?? ""
    return done(await receipt("forms.library.retire", { type: "brokerage_form_library", id }, "LEGAL", () => retireTenantFormPacket(svc as never, actor, id, { replacedById: str(body.replaced_by_id) })))
  }
  const bundles = await import("@/lib/forms/form-packet-bundles")
  if (action === "create_bundle") {
    return done(await receipt("forms.bundle.create", { type: "form_packet_bundles", id: null }, "LEGAL", () => bundles.createPacketBundle(svc as never, actor, { kind: str(body.kind) ?? "", name: str(body.name) ?? "", state: str(body.state) ?? "", county: str(body.county), teamId: str(body.team_id), locationId: str(body.location_id) })))
  }
  if (action === "add_bundle_item") {
    const bundleId = str(body.bundle_id) ?? ""
    return done(await receipt("forms.bundle.add_item", { type: "form_packet_bundles", id: bundleId }, "LEGAL", () => bundles.addBundleItem(svc as never, actor, bundleId, {
      libraryFormId: str(body.library_form_id), providerName: str(body.provider_name), providerFormId: str(body.provider_form_id), requiredName: str(body.required_name) ?? "",
      isRequired: body.is_required === true, requirementSource: str(body.requirement_source) ?? "", county: str(body.county),
    })))
  }
  if (action === "remove_bundle_item") {
    const itemId = str(body.item_id) ?? ""
    return done(await receipt("forms.bundle.remove_item", { type: "form_packet_bundle_items", id: itemId }, "LEGAL", () => bundles.removeBundleItem(svc as never, actor, itemId)))
  }
  if (action === "reorder_bundle") {
    const bundleId = str(body.bundle_id) ?? ""
    return done(await receipt("forms.bundle.reorder", { type: "form_packet_bundles", id: bundleId }, "LOW_RISK_WRITE", () => bundles.reorderBundleItems(svc as never, actor, bundleId, strs(body.ordered_ids))))
  }
  return NextResponse.json({ error: "Unknown action." }, { status: 400 })
}
