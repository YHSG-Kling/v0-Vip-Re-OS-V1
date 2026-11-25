/**
 * scripts/wave156-c-forms-directory-guard.ts — wave 156, lane 156C: THE FORMS DIRECTORY IS COMPLETE, EXTENSIBLE AND LICENSED.
 *
 * Owner (wave 156): "the form packet tool should list all possible forms/packets or have the capability for the user or manager to
 * add more." Otherwise forms are found and selected from the user's connected transaction provider. Owned by the Compliance Manager
 * (`compliance_officer`) with the forms kernel — no Forms Manager.
 *
 * DRIVEN, NOT SCANNED: the REAL route handlers (app/api/forms/provider-library GET, app/api/forms/directory GET/POST) and the REAL
 * library modules run on the in-memory client (scripts/in-memory-supabase.ts) with an in-memory storage bucket. The session, the
 * service client and the tenant's e-sign/forms provider are seams replaced by COUNTED stubs — no database, no network, no provider.
 *
 *   A · THE WHOLE LIBRARY — a provider with 250 forms (one unlicensed, one retired) is walked to the end: every authorized form is
 *       discoverable, the 101st and the FINAL form are present and selectable, the total and loaded counts are real, filters work, a
 *       provider that does not page is labelled possibly-truncated (positive control), refusals carry the five tenant codes.
 *   B · ADDING FORMS — upload / state package / provider reference; provenance validation (rights, purpose, dates, checklist, signer
 *       roles, field mapping); checksum; no provider bytes stored; idempotent reference; an unlicensed form refused; revision retires
 *       the old master (a retired PDF is never usable again); a Contact / vendor / suspended / deactivated seat cannot add or overwrite
 *       (driven through the route); signed links carry the short TTL.
 *   C · BUNDLES — two offices' and two states' bundles never mix; required / supplemental / policy-item rules; county items only for
 *       that county; a required form the tenant has not licensed reads not_configured with its recovery route; a retired master
 *       resolves to its replacement.
 *   D · THE AI READER — evidence per proposal, values transcribed not composed, nothing applied, the CDA refused (no model call).
 *   E · ADDENDUM DOOR + WIRING — the addendum signature door is built (its own driven proof is test:addendum-signatures); m1005 /
 *       m1006 vocabularies equal the code constants; the one-page fetch is gone (positive control).
 *
 * RED AT BASE: WAVE156C_ROOT=/home/user/v0-Vip-Re-OS-V1 (run with that directory as cwd so "@/" resolves there) — the base route
 * returns ONE page of 100, so the 101st / final-form checks fail, and the new modules do not exist.
 *
 * BLIND SPOTS (published): RLS and storage.objects policies are asserted from migration TEXT, not executed; the provider stubs model
 * DocuSign's documented start_position paging — no live provider was called, and the four other adapters do not page (they are
 * labelled possibly-truncated, not proven complete); the AI reader's model is a stub — the verifier is what is proven; the FormWizard
 * UI is checked by source scan only (no browser run).
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { registerHooks } from "node:module"
import { createHash } from "node:crypto"
import { stripComments, blankStrings } from "./strip-comments"
import { memSupabase, type MemClient } from "./in-memory-supabase"

const ROOT = process.env.WAVE156C_ROOT ?? process.cwd()
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const section = (t: string) => console.log(`\n[${t}]`)
const raw = (p: string) => { try { return readFileSync(join(ROOT, p), "utf8") } catch { return "" } }
const code = (p: string) => stripComments(raw(p))
const bare = (p: string) => blankStrings(stripComments(raw(p)))
const quiet = async (f: () => Promise<any>): Promise<any> => { const e = console.error, w = console.warn; console.error = () => {}; console.warn = () => {}; try { return await f() } finally { console.error = e; console.warn = w } }
const load = async (p: string): Promise<any> => { const full = join(ROOT, p); if (!existsSync(full)) throw new Error(`${p} does not exist under ${ROOT}`); return import(full) }
async function attempt(name: string, f: () => Promise<void>) { try { await f() } catch (e) { check(`${name} (threw)`, false, e instanceof Error ? e.message.slice(0, 200) : String(e)) } }

// ── THE WORLD ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const G = globalThis as any
G.__156C = { db: null as any, user: null as any, provider: null as any, resolveError: null as string | null, providerName: "docusign" }
const STUBS: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => globalThis.__156C.db",
  "@/lib/supabase/server": "export const createClient = async () => ({ auth: { getUser: async () => ({ data: { user: globalThis.__156C.user }, error: null }) }, from: (t) => globalThis.__156C.db.from(t), storage: globalThis.__156C.db.storage })",
  "@/lib/integrations/resolve-esign-provider": "export const resolveESignProviderForActor = async () => { const w = globalThis.__156C; if (w.resolveError) throw new Error(w.resolveError); return { provider: w.provider, providerName: w.providerName, resolvedScope: 'brokerage', isDefault: false, credentials: { apiKey: 'x', profileId: 'p' }, accountId: null, credentialId: 'c' } }; export const resolveESignChoice = async () => ({ ok: false, error: 'stub' })",
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    const stub = STUBS[spec]
    if (stub !== undefined) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

// ids
const B = "11111111-1111-4111-8111-111111111111", B2 = "22222222-2222-4222-8222-222222222222"
const OFF_N = "0f000000-0000-4000-8000-00000000000a", OFF_S = "0f000000-0000-4000-8000-00000000000b"
const T1 = "7e000000-0000-4000-8000-000000000001"
const U_BROKER = "a0000000-0000-4000-8000-000000000001", U_AG_N = "a0000000-0000-4000-8000-000000000002", U_AG_S = "a0000000-0000-4000-8000-000000000003"
const U_CONTACT = "a0000000-0000-4000-8000-000000000004", U_VENDOR = "a0000000-0000-4000-8000-000000000005", U_SUSP = "a0000000-0000-4000-8000-000000000006"
const U_DEACT = "a0000000-0000-4000-8000-000000000007", U_FOREIGN = "a0000000-0000-4000-8000-000000000008", U_LEAD = "a0000000-0000-4000-8000-000000000009"

function world(): any {
  const db = memSupabase({
    brokerages: [{ id: B, name: "Test Realty" }, { id: B2, name: "Other Realty" }],
    locations: [{ id: OFF_N, brokerage_id: B, name: "North Office" }, { id: OFF_S, brokerage_id: B, name: "South Office" }],
    teams: [{ id: T1, brokerage_id: B, name: "North Team", team_lead_id: U_LEAD, deleted_at: null }],
    users: [
      { id: U_BROKER, brokerage_id: B, user_type: "broker", status: "active", deleted_at: null, platform_role: null, location_id: null },
      { id: U_AG_N, brokerage_id: B, user_type: "agent", status: "active", deleted_at: null, platform_role: null, location_id: OFF_N },
      { id: U_AG_S, brokerage_id: B, user_type: "agent", status: "active", deleted_at: null, platform_role: null, location_id: OFF_S },
      { id: U_CONTACT, brokerage_id: B, user_type: "contact", status: "active", deleted_at: null, platform_role: null, location_id: null },
      { id: U_VENDOR, brokerage_id: B, user_type: "vendor", status: "active", deleted_at: null, platform_role: null, location_id: null },
      { id: U_SUSP, brokerage_id: B, user_type: "agent", status: "suspended", deleted_at: null, platform_role: null, location_id: null },
      { id: U_DEACT, brokerage_id: B, user_type: "agent", status: "active", deleted_at: null, platform_role: null, location_id: null },
      { id: U_FOREIGN, brokerage_id: B2, user_type: "broker", status: "active", deleted_at: null, platform_role: null, location_id: null },
      { id: U_LEAD, brokerage_id: B, user_type: "team_lead", status: "active", deleted_at: null, platform_role: null, location_id: null, team_id: T1 },
    ],
    agents: [{ id: "ag-deact", user_id: U_DEACT, brokerage_id: B, is_active: false }],
    brokerage_form_library: [], form_packet_bundles: [], form_packet_bundle_items: [], team_members: [], user_role_assignments: [], agent_action_ledger: [],
  }, { uuidIds: true }) as MemClient & { storage: any; objects: Map<string, Uint8Array>; signed: Array<{ path: string; ttl: number }> }
  const objects = new Map<string, Uint8Array>()
  const signed: Array<{ path: string; ttl: number }> = []
  ;(db as any).objects = objects
  ;(db as any).signed = signed
  ;(db as any).storage = {
    from: (bucket: string) => ({
      upload: async (path: string, buf: Uint8Array) => (objects.has(`${bucket}/${path}`) ? { data: null, error: { message: "The resource already exists" } } : (objects.set(`${bucket}/${path}`, buf), { data: { path }, error: null })),
      remove: async (paths: string[]) => ({ data: paths.filter((p) => objects.delete(`${bucket}/${p}`)).map((name) => ({ name })), error: null }),
      createSignedUrl: async (path: string, ttl: number) => { signed.push({ path, ttl }); return { data: { signedUrl: `https://signed.example/${bucket}/${path}?expires_in=${ttl}` }, error: null } },
      list: async (prefix: string) => ({ data: [...objects.keys()].filter((k) => k.startsWith(`${bucket}/${prefix}/`) && !k.slice(`${bucket}/${prefix}/`.length).includes("/")).map((k) => ({ name: k.slice(`${bucket}/${prefix}/`.length), id: k })), error: null }),
      copy: async () => ({ data: null, error: { message: "not used" } }),
      download: async (path: string) => { const b = objects.get(`${bucket}/${path}`); return b ? { data: new Blob([b]), error: null } : { data: null, error: { message: "Object not found" } } },
    }),
  }
  return db
}

/** A provider with N forms that pages by an offset cursor exactly like DocuSign's start_position (documented paging). COUNTED. */
function pagedProvider(n: number, opts: { pages?: boolean; failStatus?: number } = {}) {
  const forms = Array.from({ length: n }, (_, i) => {
    const k = i + 1, id = `F${String(k).padStart(3, "0")}`
    return {
      formId: id, name: k === 77 ? `Broker Compliance Checklist ${id}` : `TX Residential Form ${id}`, issuer: "TXR", stateCode: k % 10 === 0 ? "FL" : "TX",
      county: k === 120 ? "Travis" : undefined, category: k === 77 ? undefined : (["offer", "listing", "addendum", "disclosure", "agency"] as const)[k % 5], version: k === 150 ? "2026-07" : "2025-01",
      licensed: k === 7 ? false : undefined, retired: k === 13 ? true : undefined, replacedByFormId: k === 13 ? "F014" : undefined,
      officeIds: k === 90 ? [OFF_N] : undefined,
    }
  })
  const p = {
    calls: 0, forms,
    async listForms(req: { pageSize?: number; cursor?: string; stateCode?: string; query?: string }) {
      p.calls++
      if (opts.failStatus) return { success: false, status: opts.failStatus, error: `Stub listForms ${opts.failStatus}: refused` }
      const size = req.pageSize ?? 100
      const start = Number(req.cursor ?? 0) || 0
      const page = forms.slice(start, start + size)
      if (opts.pages === false) return { success: true, forms: forms.slice(0, size) }
      return { success: true, forms: page, total: forms.length, nextCursor: start + size < forms.length ? String(start + size) : null }
    },
  }
  return p
}

async function callRoute(mod: any, method: "GET" | "POST", url: string, body?: unknown): Promise<{ status: number; json: any }> {
  const init: RequestInit = { method }
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { "content-type": "application/json" } }
  const { NextRequest } = await import("next/server")
  const res = await quiet(() => mod[method](new NextRequest(url, init as any)))
  return { status: res.status, json: await res.json() }
}

async function makePdf(fields: string[], marker = ""): Promise<Uint8Array> {
  const { PDFDocument } = await import("pdf-lib")
  const doc = await PDFDocument.create(); const page = doc.addPage(); const form = doc.getForm()
  fields.forEach((f, i) => form.createTextField(f).addToPage(page, { x: 20, y: 700 - i * 24, width: 200, height: 18 }))
  doc.setTitle(`specimen ${marker}`)
  return new Uint8Array(await doc.save())
}

async function main() {
  console.log(`wave156-c forms directory guard — ROOT=${ROOT}`)

  // ═══ A · THE WHOLE PROVIDER-AUTHORIZED LIBRARY ═══════════════════════════════════════════════════════════════════════════════
  section("A · the provider library is walked to the end")
  await attempt("A", async () => {
    G.__156C.db = world(); G.__156C.user = { id: U_BROKER }; G.__156C.resolveError = null
    const prov = pagedProvider(250); G.__156C.provider = prov
    const route = await load("app/api/forms/provider-library/route.ts")
    // The expected set is DERIVED from the stub (authorized = not unlicensed; active = not retired; brokerage seat on no office ⇒
    // an office-restricted form is not applicable) — never a retyped number.
    const expected = prov.forms.filter((f) => f.licensed !== false && f.retired !== true && !f.officeIds).map((f) => f.formId)
    const got: string[] = []
    let cursor: string | null = null, first: any = null, rounds = 0
    do {
      const r = await callRoute(route, "GET", `http://x/api/forms/provider-library${cursor ? `?cursor=${cursor}` : ""}`)
      if (!first) first = r
      for (const f of r.json.forms ?? []) got.push(f.formId)
      cursor = r.json.nextCursor ?? null
      rounds++
    } while (cursor && rounds < 20)
    check(`TRUNCATION: every authorized active form is discoverable (${expected.length} of the stub's 250; got ${new Set(got).size})`, expected.every((id) => got.includes(id)) && new Set(got).size === expected.length)
    check("the 101st form (F101) and the FINAL form (F250) are in the directory", got.includes("F101") && got.includes("F250"))
    check("the response says the real total (250, the provider's own) and how many were loaded", first?.json?.total === 250 && first?.json?.loaded === (first?.json?.forms ?? []).length)
    check("the walk ends because the provider is exhausted (exhausted, completeness complete, no cursor)", first?.json?.exhausted === true && first?.json?.completeness === "complete" && first?.json?.nextCursor === null)
    check("the provider was paged, not sampled: 3 pages of 100 for 250 forms", prov.calls === 3, `calls=${prov.calls}`)
    check("an UNLICENSED form (F007) is never listed; a RETIRED one (F013) is hidden by default", !got.includes("F007") && !got.includes("F013"))

    const dir = await load("lib/forms/provider-form-directory.ts")
    // chunking: maxPages 1 hands back a cursor; continuing from it reaches the end
    const c1 = await dir.walkProviderLibrary(pagedProvider(250), {}, { maxPages: 1 })
    const c2 = await dir.walkProviderLibrary(pagedProvider(250), {}, { maxPages: 5, cursor: c1.nextCursor })
    check("a chunk keeps the cursor until the library is exhausted (more_available → complete)", c1.ok && c1.completeness === "more_available" && c1.nextCursor === "100" && c2.ok && c2.exhausted && c2.forms.some((f: any) => f.formId === "F250"))
    const silent = await dir.walkProviderLibrary(pagedProvider(250, { pages: false }), {})
    check("POSITIVE CONTROL: a provider that returns a full page with no cursor and no total is labelled unknown_possibly_truncated, never complete", silent.ok && silent.completeness === "unknown_possibly_truncated")
    const small = await dir.walkProviderLibrary(pagedProvider(40, { pages: false }), {})
    check("…and a short page from a non-paging provider is complete (the label is not cried wolf)", small.ok && small.completeness === "complete")
    // filters
    const fl = await dir.walkProviderLibrary(pagedProvider(250), { stateCode: "FL" })
    const comp = await dir.walkProviderLibrary(pagedProvider(250), { category: "compliance" })
    const travis = await dir.walkProviderLibrary(pagedProvider(250), { county: "Travis" })
    const ver = await dir.walkProviderLibrary(pagedProvider(250), { version: "2026-07" })
    const text = await dir.walkProviderLibrary(pagedProvider(250), { text: "F199" })
    const ret = await dir.walkProviderLibrary(pagedProvider(250), { status: "retired" })
    const north = await dir.walkProviderLibrary(pagedProvider(250), { officeId: OFF_N })
    const south = await dir.walkProviderLibrary(pagedProvider(250), { officeId: OFF_S })
    const flExpected = prov.forms.filter((f) => f.stateCode === "FL" && f.licensed !== false && f.retired !== true && !f.officeIds).length
    check(`filter state: FL returns exactly the stub's applicable FL forms (${flExpected})`, fl.forms.every((f: any) => f.stateCode === "FL") && fl.forms.length === flExpected, `got ${fl.forms.length}`)
    check("filters: category compliance, county, legal version, text, retired-only, office applicability",
      comp.forms.map((f: any) => f.formId).join() === "F077"
      && travis.forms.some((f: any) => f.formId === "F120") && ver.forms.map((f: any) => f.formId).join() === "F150" && text.forms.map((f: any) => f.formId).join() === "F199"
      && ret.forms.map((f: any) => f.formId).join() === "F013" && north.forms.some((f: any) => f.formId === "F090") && !south.forms.some((f: any) => f.formId === "F090"))
    // selection by id
    const f101 = await dir.findProviderFormById(pagedProvider(250), "F101")
    const f250 = await dir.findProviderFormById(pagedProvider(250), "F250")
    const f007 = await dir.findProviderFormById(pagedProvider(250), "F007")
    const f999 = await dir.findProviderFormById(pagedProvider(250), "F999")
    const f013 = await dir.findProviderFormById(pagedProvider(250), "F013")
    check("the 101st and the final form are SELECTABLE by id", f101.ok && f250.ok)
    check("an unlicensed form is refused license_missing; an unknown id form_not_in_provider_library; a retired one names its replacement",
      !f007.ok && f007.refusal.code === "license_missing" && !f999.ok && f999.refusal.code === "form_not_in_provider_library" && !f013.ok && /F014/.test(f013.refusal.message))
    // refusals
    const resolverSrc = code("lib/integrations/resolve-esign-provider.ts")
    const notConnected = "E-sign is set to Dotloop (team setting), but no active Dotloop connection was found for you, your team or your brokerage. Connect it in Settings → Integrations, or change the e-sign selection."
    check("POSITIVE CONTROL: the not-connected specimen is the resolver's own sentence shape", /but no active \$\{label\} connection was found/.test(resolverSrc))
    check("refusal codes: a selected-but-unconnected provider → credentials_need_attention; nothing selectable → no_provider_selected",
      dir.classifyResolveFailure(notConnected).code === "credentials_need_attention" && dir.classifyResolveFailure("E-sign is set to Google eSignature, which sends from your own Google window").code === "no_provider_selected")
    check("refusal codes by status: 401 credentials, 403 license, 404 not in library, 503 temporarily unavailable — each with a recovery route",
      dir.classifyProviderCallFailure("x", 401).code === "credentials_need_attention" && dir.classifyProviderCallFailure("x", 403).code === "license_missing"
      && dir.classifyProviderCallFailure("x", 404).code === "form_not_in_provider_library" && dir.classifyProviderCallFailure("DocuSign listTemplates 503: down").code === "provider_unavailable"
      && dir.classifyProviderCallFailure("x", 503).retryable === true && /^\//.test(dir.classifyProviderCallFailure("x", 403).recoverHref))
    G.__156C.provider = pagedProvider(250, { failStatus: 503 })
    const down = await callRoute(route, "GET", "http://x/api/forms/provider-library")
    check("the route says provider_unavailable (retryable, 503) and still returns the tenant's own library half", down.status === 503 && down.json.refusal?.code === "provider_unavailable" && Array.isArray(down.json.entries))
    G.__156C.resolveError = notConnected
    const nc = await callRoute(route, "GET", "http://x/api/forms/provider-library")
    check("the route says credentials_need_attention in tenant words when the selected provider is not connected", nc.json.refusal?.code === "credentials_need_attention" && nc.json.configured === false)
    G.__156C.resolveError = null; G.__156C.provider = pagedProvider(250)
    // gate
    G.__156C.user = { id: U_CONTACT }
    const asContact = await callRoute(route, "GET", "http://x/api/forms/provider-library")
    G.__156C.user = { id: U_VENDOR }
    const asVendor = await callRoute(route, "GET", "http://x/api/forms/provider-library")
    check("a portal CONTACT and a VENDOR seat cannot browse the brokerage's licensed library (403)", asContact.status === 403 && asVendor.status === 403)
    G.__156C.user = { id: U_BROKER }
  })

  // ═══ B · ADDING FORMS ════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("B · adding forms: upload, state package, provider reference — validated, licensed, versioned")
  await attempt("B", async () => {
    const db = world(); G.__156C.db = db
    const tp = await load("lib/forms/tenant-form-packets.ts")
    const intake = await load("lib/forms/form-directory-intake.ts")
    const dir = await load("lib/forms/provider-form-directory.ts")
    const actor = async (u: string) => (await quiet(() => tp.resolvePacketActor(db, u)))
    const broker = (await actor(U_BROKER)).actor, agN = (await actor(U_AG_N)).actor, agS = (await actor(U_AG_S)).actor
    check("the office comes from the session user's row and must be a location of the same brokerage", agN.locationId === OFF_N && agS.locationId === OFF_S && broker.oversight === true)
    const refused = await Promise.all([U_CONTACT, U_VENDOR, U_SUSP, U_DEACT].map(actor))
    check("a CONTACT, a VENDOR, a SUSPENDED and a DEACTIVATED seat are refused an actor — they can add or overwrite nothing", refused.every((r: any) => !r.ok))

    const pdf = await makePdf(["Buyer Name", "Seller Name", "Buyer Signature", "Seller Initials"], "v1")
    const good = { mode: "upload", owner: {}, name: "TX Brokerage Listing Agreement", state: "TX", packetType: "listing", rightsBasis: "association_membership", licenseNote: "TXR member 2026", purpose: "listing", effectiveOn: "2026-01-01", revisionDate: "2025-12-01", checklistKeys: ["listing.agreement"], signerRoles: ["seller", "listing_agent"], fieldMapping: { "Seller Name": "seller.name" }, fileName: "la.pdf", bytes: pdf }
    const bad = async (o: Record<string, unknown>) => intake.addFormToLibrary(db, broker, { ...good, ...o })
    const rRights = await bad({ rightsBasis: "" }), rLicense = await bad({ licenseNote: "" }), rPurpose = await bad({ purpose: "whatever" }), rEff = await bad({ effectiveOn: "soon" })
    const rFuture = await bad({ revisionDate: "2099-01-01" }), rCheck = await bad({ checklistKeys: [] }), rSigner = await bad({ signerRoles: ["notary"] }), rMap = await bad({ fieldMapping: { "Seller Name": "Seller Name!" } })
    check("provenance is validated by name: rights basis, the license it is held under, purpose, effective date, a future revision date, checklist mapping, signer roles, field mapping",
      [rRights, rLicense, rPurpose, rEff, rFuture, rCheck, rSigner, rMap].every((r: any) => !r.ok) && /right/.test(rRights.error) && /license/.test(rLicense.error) && /checklist/.test(rCheck.error) && /signers/.test(rSigner.error) && db.tables.brokerage_form_library.length === 0 && db.objects.size === 0)
    const ok = await quiet(() => intake.addFormToLibrary(db, broker, good))
    const row = ok.ok ? ok.packet : null
    check("a valid upload lands in the tenant's OWN folder with provenance, revision, checksum (sha256 of the bytes), purpose, signer roles and field mapping",
      !!row && row.storage_path?.startsWith(`brokerage/${B}/packets/${row.id}/`) && row.checksum_sha256 === createHash("sha256").update(pdf).digest("hex")
      && row.source_kind === "brokerage_upload" && row.rights_basis === "association_membership" && row.purpose === "listing" && row.effective_on === "2026-01-01"
      && row.revision_date === "2025-12-01" && row.signer_roles?.join() === "seller,listing_agent" && row.field_mapping?.["Seller Name"] === "seller.name" && row.field_count === 4 && row.version === 1, JSON.stringify(ok).slice(0, 300))
    const dup = await intake.addFormToLibrary(db, broker, good)
    check("the same file again is refused as a duplicate (one record per form)", !dup.ok && /already in your library/.test(dup.error))
    // agents
    const agWide = await intake.addFormToLibrary(db, agN, { ...good, bytes: await makePdf(["a"], "agw") })
    const agSupp = await quiet(async () => intake.addFormToLibrary(db, agN, { ...good, owner: { scopeUserId: U_AG_N }, packetType: "custom", purpose: "other", checklistKeys: [], name: "My buyer FAQ sheet", rightsBasis: "own_form", licenseNote: null, bytes: await makePdf(["b"], "sup") }))
    const agSuppListing = await intake.addFormToLibrary(db, agN, { ...good, owner: { scopeUserId: U_AG_N }, packetType: "listing", bytes: await makePdf(["c"], "supl") })
    const agForOther = await intake.addFormToLibrary(db, agN, { ...good, owner: { scopeUserId: U_AG_S }, packetType: "custom", rightsBasis: "own_form", bytes: await makePdf(["d"], "oth") })
    check("an agent cannot add a brokerage master, cannot add a supplemental LISTING master, cannot add for another agent — but adds their own supplemental form",
      !agWide.ok && !agSuppListing.ok && !agForOther.ok && agSupp.ok && agSupp.packet.scope_user_id === U_AG_N && agSupp.packet.source_kind === "agent_upload")
    const usableN = await tp.usableTenantPacketPaths(db, agN, [agSupp.packet.storage_path])
    const usableS = await tp.usableTenantPacketPaths(db, agS, [agSupp.packet.storage_path])
    check("an agent's supplemental form is usable by that agent and NOT by another agent of the brokerage", usableN.usable.has(agSupp.packet.storage_path) && !usableS.usable.has(agSupp.packet.storage_path))
    // office form
    const offN = await quiet(async () => intake.addFormToLibrary(db, broker, { ...good, owner: { locationId: OFF_N }, name: "North Office Disclosure", packetType: "disclosure", purpose: "disclosure", bytes: await makePdf(["e"], "offn") }))
    const vN = await tp.usableTenantPacketPaths(db, agN, [offN.packet.storage_path]), vS = await tp.usableTenantPacketPaths(db, agS, [offN.packet.storage_path])
    const offByAgent = await intake.addFormToLibrary(db, agN, { ...good, owner: { locationId: OFF_N }, bytes: await makePdf(["f"], "offa") })
    check("an OFFICE form reaches that office's agents only; only the brokerage's admins share with an office", offN.ok && vN.usable.size === 1 && vS.usable.size === 0 && !offByAgent.ok)
    // state package
    const sp = await quiet(() => intake.addFormToLibrary(db, broker, { ...good, mode: "state_preconfigured", name: "TXR Seller's Disclosure Notice", rightsBasis: "association_membership", bytes: null }))
    const tx = (await import(join(ROOT, "lib/state-forms/registry.ts"))).STATE_FORMS.TX.listing
    const txName = [...tx.required, ...tx.addenda, tx.brokerageRepresentation][0]
    const sp2 = await quiet(() => intake.addFormToLibrary(db, broker, { ...good, mode: "state_preconfigured", name: txName, bytes: null }))
    check("a state-package pick must be a form the STATE's package names (no universal list), and with no licensed file it reads NOT CONFIGURED — never pretends to exist",
      !sp.ok && sp2.ok && sp2.status === "not_configured" && sp2.packet.storage_path === null && intake.libraryFormStatus(sp2.packet) === "not_configured")
    // provider reference
    const before = db.objects.size
    const deps = { provider: pagedProvider(250), providerName: "docusign" }
    const pRef = await quiet(() => intake.addFormToLibrary(db, broker, { ...good, mode: "provider_form", rightsBasis: "provider_license", providerFormId: "F101", name: "", bytes: null }, deps))
    const pAgain = await quiet(() => intake.addFormToLibrary(db, broker, { ...good, mode: "provider_form", rightsBasis: "provider_license", providerFormId: "F101", name: "", bytes: null }, deps))
    const pFinal = await quiet(() => intake.addFormToLibrary(db, broker, { ...good, mode: "provider_form", rightsBasis: "provider_license", providerFormId: "F250", name: "", bytes: null }, deps))
    const pUnlic = await intake.addFormToLibrary(db, broker, { ...good, mode: "provider_form", rightsBasis: "provider_license", providerFormId: "F007", name: "", bytes: null }, deps)
    check("a provider form is added BY ID as a REFERENCE — no PDF bytes copied into tenant storage; adopting it twice is the same row; the final form is adoptable",
      pRef.ok && pRef.packet.storage_path === null && pRef.packet.provider_form_id === "F101" && pRef.packet.provider_name === "docusign" && db.objects.size === before && pAgain.ok && pAgain.existing === true && pAgain.packet.id === pRef.packet.id && pFinal.ok)
    check("an UNLICENSED provider form is refused (license_missing) and nothing is written", !pUnlic.ok && pUnlic.refusal?.code === "license_missing")
    // merge: the adopted provider form is listed once
    const rows = await tp.listDirectoryRowsForActor(db, broker, {})
    const merged = dir.mergeFormDirectory(rows.rows, (await dir.walkProviderLibrary(pagedProvider(250), {})).forms.map((f: any) => ({ ...f, providerName: "docusign" })))
    const f101s = merged.filter((e: any) => e.providerFormId === "F101")
    check("ONE picker: an adopted provider form appears ONCE (as the tenant's entry, marked adopted); the sources are labelled",
      f101s.length === 1 && f101s[0].source === "brokerage" && f101s[0].adoptedFromProvider === true && merged.some((e: any) => e.source === "connected_provider") && merged.some((e: any) => e.source === "office"))
    // revision
    const pdf2 = await makePdf(["Buyer Name", "Seller Name", "Buyer Signature", "Seller Initials", "Legal Description"], "v2")
    const same = await intake.reviseLibraryForm(db, broker, row.id, { fileName: "la.pdf", bytes: pdf, revisionDate: "2026-06-01", effectiveOn: "2026-07-01" })
    const rev = await quiet(() => intake.reviseLibraryForm(db, broker, row.id, { fileName: "la-v2.pdf", bytes: pdf2, revisionDate: "2026-06-01", effectiveOn: "2026-07-01" }))
    const old = db.tables.brokerage_form_library.find((r: any) => r.id === row.id)
    const useOld = await tp.usableTenantPacketPaths(db, agN, [row.storage_path]), useNew = await tp.usableTenantPacketPaths(db, agN, [rev.packet?.storage_path])
    check("a REVISION is a new version (2) with its provenance carried; an identical file is refused as not a revision",
      !same.ok && rev.ok && rev.packet.version === 2 && rev.packet.rights_basis === "association_membership" && rev.packet.checklist_keys?.join() === "listing.agreement" && rev.packet.revision_date === "2026-06-01")
    check("the old master is RETIRED with replaced_by naming the revision — a retired PDF is never usable again; the revision is", old?.is_active === false && old?.replaced_by_id === rev.packet.id && !!old?.retired_at && useOld.usable.size === 0 && useNew.usable.size === 1)
    const urlRetired = await tp.issueTenantPacketUrl(db, agN, old, "use")
    check("no signed link is minted for the retired master", !urlRetired.ok)
    // signed URL expiry + revocation
    db.signed.length = 0
    const link = await tp.issueTenantPacketUrl(db, agN, db.tables.brokerage_form_library.find((r: any) => r.id === rev.packet.id), "use")
    check(`a packet link is short-lived: minted per view with the ${tp.FORM_PACKET_PREVIEW_TTL_SECONDS}s TTL (never stored, never long-lived)`, link.ok && link.ttlSeconds === tp.FORM_PACKET_PREVIEW_TTL_SECONDS && db.signed.length === 1 && db.signed[0].ttl === tp.FORM_PACKET_PREVIEW_TTL_SECONDS && tp.FORM_PACKET_PREVIEW_TTL_SECONDS <= 3600)
    db.tables.users.find((u: any) => u.id === U_AG_N).user_type = "contact"
    const revoked = await quiet(() => tp.resolvePacketActor(db, U_AG_N))
    check("a seat whose role is REVOKED (agent → contact) loses access on the next request — no actor, no link", !revoked.ok)
    db.tables.users.find((u: any) => u.id === U_AG_N).user_type = "agent"
    // the route: a contact / vendor POST is refused; the broker's add leaves ONE receipt
    G.__156C.db = db
    const droute = await load("app/api/forms/directory/route.ts")
    const masterBefore = JSON.stringify(db.tables.brokerage_form_library)
    G.__156C.user = { id: U_CONTACT }
    const cAdd = await callRoute(droute, "POST", "http://x/api/forms/directory", { action: "add_form", mode: "state_preconfigured", name: txName, state: "TX", packet_type: "listing", rights_basis: "association_membership", purpose: "listing", effective_on: "2026-01-01", checklist_keys: ["listing.agreement"], signer_roles: ["seller"] })
    const cRetire = await callRoute(droute, "POST", "http://x/api/forms/directory", { action: "retire_form", packet_id: rev.packet.id })
    G.__156C.user = { id: U_VENDOR }
    const vRev = await callRoute(droute, "POST", "http://x/api/forms/directory", { action: "retire_form", packet_id: rev.packet.id })
    check("through the ROUTE: a Contact cannot add or retire (overwrite) a packet master and a vendor cannot either — 403, library unchanged",
      cAdd.status === 403 && cRetire.status === 403 && vRev.status === 403 && JSON.stringify(db.tables.brokerage_form_library) === masterBefore)
    G.__156C.user = { id: U_BROKER }
    const ledgerBefore = (db.tables.agent_action_ledger ?? []).length
    const bAdd = await callRoute(droute, "POST", "http://x/api/forms/directory", { action: "add_form", mode: "state_preconfigured", name: tx.brokerageRepresentation, state: "TX", packet_type: "listing", rights_basis: "state_mandated_public", purpose: "agency", effective_on: "2026-01-01", checklist_keys: ["agency.disclosure"], signer_roles: ["seller"] })
    check("the broker's add through the route succeeds and leaves a ledger receipt (LAW 5)", bAdd.status === 200 && bAdd.json.ok === true && (db.tables.agent_action_ledger ?? []).length > ledgerBefore, JSON.stringify(bAdd.json).slice(0, 200))
  })

  // ═══ C · BUNDLES ════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("C · packet bundles: ordered, required/optional, per state and office — never mixed")
  await attempt("C", async () => {
    const db = world()
    const tp = await load("lib/forms/tenant-form-packets.ts")
    const intake = await load("lib/forms/form-directory-intake.ts")
    const bun = await load("lib/forms/form-packet-bundles.ts")
    const A = async (u: string) => (await quiet(() => tp.resolvePacketActor(db, u))).actor
    const broker = await A(U_BROKER), agN = await A(U_AG_N), agS = await A(U_AG_S)
    const base = { mode: "upload", owner: {}, state: "TX", packetType: "listing", rightsBasis: "own_form", purpose: "listing", effectiveOn: "2026-01-01", checklistKeys: ["listing.agreement"], signerRoles: ["seller"] }
    const add = async (name: string, o: Record<string, unknown> = {}) => (await quiet(async () => intake.addFormToLibrary(db, broker, { ...base, name, fileName: `${name}.pdf`, bytes: await makePdf(["x"], name), ...o }))).packet
    const la = await add("TX Listing Agreement"), sd = await add("TX Seller Disclosure", { packetType: "disclosure", purpose: "disclosure" })
    const flForm = await add("FL Listing Agreement", { state: "FL" })
    const northLa = await add("North Office Listing Agreement", { owner: { locationId: OFF_N } })
    const notLicensed = (await quiet(async () => intake.addFormToLibrary(db, broker, { ...base, mode: "state_preconfigured", name: (await import(join(ROOT, "lib/state-forms/registry.ts"))).STATE_FORMS.TX.listing.required[0], bytes: null }))).packet

    const wide = (await bun.createPacketBundle(db, broker, { kind: "listing", name: "TX Listing Packet", state: "TX" })).bundle
    const north = (await bun.createPacketBundle(db, broker, { kind: "listing", name: "North TX Listing Packet", state: "TX", locationId: OFF_N })).bundle
    const flB = (await bun.createPacketBundle(db, broker, { kind: "listing", name: "FL Listing Packet", state: "FL" })).bundle
    const agentCreate = await bun.createPacketBundle(db, agN, { kind: "listing", name: "Mine", state: "TX" })
    check("bundles are created by the brokerage's admins for the brokerage, an office or another state; an agent cannot create one", !!wide && !!north && !!flB && !agentCreate.ok)
    const it = async (bundleId: string, o: Record<string, unknown>, who = broker) => bun.addBundleItem(db, who, bundleId, { requiredName: "Form", isRequired: true, requirementSource: "brokerage", ...o })
    await it(wide.id, { libraryFormId: la.id, requiredName: "Listing agreement" })
    await it(wide.id, { libraryFormId: sd.id, requiredName: "Seller disclosure" })
    await it(wide.id, { libraryFormId: notLicensed.id, requiredName: "Association listing form", requirementSource: "state_policy" })
    await it(wide.id, { requiredName: "Travis County addendum", requirementSource: "county_policy", county: "Travis" })
    await it(north.id, { libraryFormId: northLa.id, requiredName: "North listing agreement" })
    await it(flB.id, { libraryFormId: flForm.id, requiredName: "FL listing agreement" })
    const mixed = await it(wide.id, { libraryFormId: flForm.id, requiredName: "FL form in a TX bundle" })
    check("a form of ANOTHER STATE is refused into a bundle (bundles never mix jurisdictions)", !mixed.ok && /never mix states/.test(mixed.error))
    const rS = await bun.resolveDealPacket(db, agS, { kind: "listing", state: "TX" })
    const rN = await bun.resolveDealPacket(db, agN, { kind: "listing", state: "TX" })
    const rFL = await bun.resolveDealPacket(db, agS, { kind: "listing", state: "FL" })
    const namesS = rS.packet.items.map((i: any) => i.name), namesN = rN.packet.items.map((i: any) => i.name)
    check("TWO OFFICES' bundles do not mix: the South agent gets the brokerage packet, the North agent gets the North office's — no item crosses",
      rS.packet.bundle.id === wide.id && rN.packet.bundle.id === north.id && !namesS.includes("North listing agreement") && namesN.join() === "North listing agreement")
    check("TWO STATES' bundles do not mix: a FL deal gets only the FL packet", rFL.packet.bundle.id === flB.id && rFL.packet.items.map((i: any) => i.name).join() === "FL listing agreement")
    check("items come back in their order, with required markers", namesS.slice(0, 3).join("|") === "Listing agreement|Seller disclosure|Association listing form" && rS.packet.items.every((i: any) => i.required === true))
    const unl = rS.packet.items.find((i: any) => i.name === "Association listing form")
    check("a required form the tenant holds no licensed file for reads NOT CONFIGURED with request access / add licensed file and a recoverable route; the packet counts it missing",
      unl.status === "not_configured" && unl.path === null && unl.actions.includes("request_access") && unl.actions.includes("add_licensed_file") && /^\//.test(unl.recoverHref) && rS.packet.missingRequired === 1)
    const rTravis = await bun.resolveDealPacket(db, agS, { kind: "listing", state: "TX", county: "Travis" })
    check("a COUNTY policy item applies only to a deal in that county", !namesS.includes("Travis County addendum") && rTravis.packet.items.some((i: any) => i.name === "Travis County addendum"))
    // supplemental
    const mine = (await quiet(async () => intake.addFormToLibrary(db, agS, { ...base, owner: { scopeUserId: U_AG_S }, packetType: "custom", purpose: "other", checklistKeys: [], name: "My cover letter", fileName: "c.pdf", bytes: await makePdf(["y"], "cov") }))).packet
    const suppReq = await it(wide.id, { libraryFormId: mine.id, requiredName: "Cover letter", isRequired: true, requirementSource: "user_supplemental" }, agS)
    const supp = await it(wide.id, { libraryFormId: mine.id, requiredName: "Cover letter", isRequired: false, requirementSource: "user_supplemental" }, agS)
    const otherView = await bun.resolveDealPacket(db, await A(U_BROKER), { kind: "listing", state: "TX" })
    const myView = await bun.resolveDealPacket(db, agS, { kind: "listing", state: "TX" })
    check("an agent adds an OPTIONAL supplemental form (never a required one); it shows in THEIR packet only",
      !suppReq.ok && supp.ok && myView.packet.items.some((i: any) => i.name === "Cover letter" && !i.required) && !otherView.packet.items.some((i: any) => i.name === "Cover letter"))
    const reqItem = myView.packet.items.find((i: any) => i.name === "Listing agreement"), policyItem = myView.packet.items.find((i: any) => i.name === "Association listing form")
    const agDel = await bun.removeBundleItem(db, agS, reqItem.itemId)
    const brDelPolicy = await bun.removeBundleItem(db, broker, policyItem.itemId)
    const agDelOwn = await bun.removeBundleItem(db, agS, supp.item.id)
    check("an individual user CANNOT delete a required brokerage form; NO ONE removes a state-policy item here; the agent removes their own supplemental",
      !agDel.ok && /required brokerage form/.test(agDel.error) && !brDelPolicy.ok && /state policy/.test(brDelPolicy.error) && agDelOwn.ok)
    const ids = (await bun.resolveDealPacket(db, broker, { kind: "listing", state: "TX", county: "Travis" })).packet.items.map((i: any) => i.itemId)
    const agReorder = await bun.reorderBundleItems(db, agS, wide.id, [...ids].reverse())
    const brReorder = await bun.reorderBundleItems(db, broker, wide.id, [...ids].reverse())
    const after = (await bun.resolveDealPacket(db, broker, { kind: "listing", state: "TX", county: "Travis" })).packet.items.map((i: any) => i.itemId)
    check("the order is editable by the bundle's manager only", !agReorder.ok && brReorder.ok && after.join() === [...ids].reverse().join())
    // retired master → replacement
    const rev = await quiet(async () => intake.reviseLibraryForm(db, broker, la.id, { fileName: "la2.pdf", bytes: await makePdf(["x", "z"], "la2"), revisionDate: "2026-05-01", effectiveOn: "2026-06-01" }))
    const afterRev = (await bun.resolveDealPacket(db, agS, { kind: "listing", state: "TX" })).packet.items.find((i: any) => i.name === "Listing agreement")
    check("a bundle item whose master was RETIRED resolves to its replacement — the retired PDF's path is never handed out",
      rev.ok && afterRev.status === "replaced" && afterRev.packetId === rev.packet.id && afterRev.path === rev.packet.storage_path && afterRev.path !== la.storage_path)
  })

  // ═══ D · THE AI READER ══════════════════════════════════════════════════════════════════════════════════════════════════════
  section("D · the AI reader proposes with evidence; nothing is applied; the CDA is refused")
  await attempt("D", async () => {
    const rd = await load("lib/forms/form-document-reader.ts")
    const text = "RESIDENTIAL LISTING AGREEMENT. Property: 12 Oak St. Legal description: Lot 4, Block 2, Oak Hills Addition, Travis County, Texas. Seller shall deliver the Seller's Disclosure Notice within 3 days. This agreement is governed by the laws of Texas."
    const fields = ["Property Address", "Legal Description", "Seller Signature", "Buyer Initials", "Price"]
    let calls = 0
    const gen = async () => { calls++; return { proposals: [
      { kind: "field", target: "Property Address", value: "12 Oak St", evidence: { quote: "Property: 12 Oak St." } },
      { kind: "legal_description", target: "Legal Description", value: "Lot 4, Block 2, Oak Hills Addition", evidence: { quote: "Legal description: Lot 4, Block 2, Oak Hills Addition, Travis County, Texas." } },
      { kind: "clause", target: "governing law", evidence: { quote: "governed by the laws of Texas" } },
      { kind: "requirement", target: "seller disclosure", evidence: { quote: "Seller shall deliver the Seller's Disclosure Notice within 3 days" } },
      { kind: "field", target: "Price", value: "450000", evidence: { quote: "Property: 12 Oak St." } },
      { kind: "field", target: "Closing Date", value: "2026-12-01", evidence: { quote: "Property: 12 Oak St." } },
      { kind: "clause", target: "invented", evidence: { quote: "Buyer waives all inspections" } },
    ] } }
    const r = await rd.readFormDocument({ name: "TX Listing Agreement", fields, text, brokerageId: B, userId: U_BROKER }, { generate: gen })
    const model = r.suggestions.filter((s: any) => s.via === "model")
    check("fields, legal description, governing clause and requirement are proposed WITH their evidence; signature / initials boxes are read from the PDF itself",
      r.ok && model.map((s: any) => s.kind).sort().join() === "clause,field,legal_description,requirement" && r.structure.signerBoxes.join() === "Seller Signature,Buyer Initials")
    check("an invented value (a price not in its quote), a field the PDF lacks and a quote not in the document are DROPPED with the reason", r.dropped.length === 3 && r.dropped.some((d: any) => /not stated in its evidence/.test(d.why)) && r.dropped.some((d: any) => /no field/.test(d.why)) && r.dropped.some((d: any) => /not in the document/.test(d.why)))
    check("every surviving proposal is pending_review — the reader applies nothing", r.suggestions.length > 0 && r.suggestions.every((s: any) => s.status === "pending_review"))
    const before = calls
    const cda = await rd.readFormDocument({ name: "Commission Disbursement Authorization", formCode: "CDA", fields, text, brokerageId: B, userId: U_BROKER }, { generate: gen })
    check("a CDA is REFUSED and no model is called — the agent fills the CDA", !cda.ok && /agent fills the CDA/.test(cda.refused) && calls === before && cda.suggestions.length === 0)
    check("POSITIVE CONTROL: the CDA detector sees a CDA by code and by name, and not an ordinary form", rd.isCdaForm({ formCode: "CDA-1" }) && rd.isCdaForm({ name: "commission disbursement form" }) && !rd.isCdaForm({ name: "Seller Disclosure" }))
  })

  // ═══ E · ADDENDUM DOOR + WIRING ══════════════════════════════════════════════════════════════════════════════════════════════
  section("E · the addendum door, the migrations' vocabularies, the one-page fetch")
  await attempt("E", async () => {
    const pkg = raw("package.json")
    check("the proposed-addendum signature request is an executable door with its own driven proof (test:addendum-signatures) — not 'not implemented'",
      /export async function/.test(code("app/actions/buyer-offer/request-addendum-signatures.ts")) && /"test:addendum-signatures"/.test(pkg) && existsSync(join(ROOT, "scripts/addendum-signatures-guard.ts")))
    const ui = bare("app/dashboard/offers/outside-offer-threads.tsx")
    const placeholder = (s: string) => /not\s+implemented/i.test(s)
    check("POSITIVE CONTROL: the placeholder finder sees 'Not implemented' in UI copy", placeholder(`<p>Not implemented</p>`))
    check("no 'not implemented' placeholder remains in the offer threads UI (comments/strings blanked — a tombstone is not UI)", !placeholder(ui.replace(/\/\/.*$/gm, "")) && /requestAddendumSignatures|request-addendum-signatures/.test(code("app/dashboard/offers/outside-offer-threads.tsx")))
    const route = bare("app/api/forms/provider-library/route.ts")
    const oneShot = (s: string) => /listForms\s*\(\s*\{[^}]*pageSize\s*:\s*100[^}]*\}\s*\)/.test(s) && !/cursor/.test(s)
    check("POSITIVE CONTROL: the one-page finder sees the base route's shape", oneShot(`await resolved.provider.listForms({ stateCode: x, pageSize:  100, })`))
    check("the provider-library route no longer fetches one page of 100 and calls it the library", !oneShot(route) && /walkProviderLibrary/.test(route))
    check("the FormWizard continues from the provider's cursor and shows total / loaded", /params\.set\("cursor"/.test(code("app/components/form-wizard/FormWizard.tsx")) && /Load more/.test(raw("app/components/form-wizard/FormWizard.tsx")))
    const intake = await load("lib/forms/form-directory-intake.ts"), bun = await load("lib/forms/form-packet-bundles.ts")
    const m1005 = raw("supabase/migrations/m1005-form-library-provenance-office-agent-scope-and-provider-references.sql") // SQL: read raw — the patterns below match DDL shapes (NAME CHECK (… ARRAY[…])) no header prose carries
    const m1006 = raw("supabase/migrations/m1006-form-packet-bundles-ordered-required-items.sql")
    const checkList = (sql: string, name: string): string[] => { const m = new RegExp(`${name}\\s+CHECK \\([^)]*ARRAY\\[([^\\]]+)\\]`).exec(sql); return m ? m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")) : [] }
    const eq = (a: readonly string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x))
    check("m1005 CHECK vocabularies equal the code constants (source kind, rights basis, purpose)",
      eq(intake.FORM_LIBRARY_SOURCE_KINDS, checkList(m1005, "brokerage_form_library_source_kind_check")) && eq(intake.FORM_RIGHTS_BASES, checkList(m1005, "brokerage_form_library_rights_basis_check")) && eq(intake.FORM_PURPOSES, checkList(m1005, "brokerage_form_library_purpose_check")))
    check("m1006 CHECK vocabularies equal the code constants (bundle kind, requirement source)", eq(bun.PACKET_BUNDLE_KINDS, checkList(m1006, "form_packet_bundles_bundle_kind_check")) && eq(bun.BUNDLE_REQUIREMENT_SOURCES, checkList(m1006, "form_packet_bundle_items_requirement_source_check")))
    check("POSITIVE CONTROL: the CHECK reader parses a specimen", checkList(`x_check CHECK (k = ANY (ARRAY['a','b']))`, "x_check").join() === "a,b")
    check("m1005: a provider reference holds no bytes (CHECK) and one live reference per owner (unique index); m1006: both tables carry brokerage_id, row security and written-out policies",
      /provider_reference_holds_no_bytes\s+CHECK \(provider_form_id IS NULL OR \(storage_path IS NULL/.test(m1005) && /uq_brokerage_form_library_live_provider_reference/.test(m1005)
      && ["form_packet_bundles", "form_packet_bundle_items"].every((t) => new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY`).test(m1006) && new RegExp(`CREATE POLICY ${t}_tenant_select`).test(m1006) && new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${t} \\([\\s\\S]*?brokerage_id\\s+uuid NOT NULL`).test(m1006)))
    check("no storage.objects policy is written as a migration (owner SQL)", !/ON\s+storage\.objects/.test(m1005 + m1006))
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  console.log("BLIND SPOTS: RLS / storage policies asserted from migration text only; providers are counted stubs (DocuSign-style offset paging) — no live provider; the four non-paging adapters are labelled possibly-truncated, not proven complete; the AI model is a stub (the verifier is proven); the FormWizard UI by source scan (no browser).")
  if (failed > 0) { console.log("FAILED:\n  - " + failures.join("\n  - ")); process.exit(1) }
}
main().catch((e) => { console.error(e); process.exit(1) })
