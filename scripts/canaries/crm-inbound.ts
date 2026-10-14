/**
 * scripts/canaries/crm-inbound.ts — CRM INBOUND canary (wave 141, lane 141J):
 *   a tenant is REFUSED; platform staff's mapped import is accepted
 * through the staff gate's pure half (lib/platform/platform-staff-roster.ts resolvePlatformRoleIdentity +
 * platformStaffCan — what app/actions/lead-import/crm-pull-actions.ts gateStaffAction("tenants") decides),
 * the vendor → CSV-shaped mapper (lib/crm/import-pull.ts ghlToRow), the parser (lib/platform/
 * tenant-import-parser.ts parseContactRecords) and the ONE insert lane (lib/platform/tenant-import.ts
 * importParsedContacts: target-tenant anchor, owner-agent resolution, dedupe against the TARGET tenant,
 * consent never imported as true, vendor-only columns to notes). Owner (wave 141): "INBOUND (external CRM →
 * VIPAgents) is PLATFORM STAFF ONLY … External schemas never write canonical fields directly." The explicit
 * mapping registry + preview (lane 141D) and the superadmin user_type fallback in the role resolver (lane
 * 141B) are WAVE141 HOOKS.
 */
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, nowIso, setSvc, uuid } from "./_harness"
import { hooksFor, strippedRepo } from "./_registry"

/** PURE: the BODIES of a module's exported async functions. The body brace is found AFTER the matched
 *  parameter list and past the return type (angle depth 0, outside any type literal; a `{` after `:`, `|`,
 *  `&`, `=` or `,` opens a type literal, not the body) — a `[^{]*\{` shortcut takes `Promise<{ ok: boolean }>`'s
 *  brace and reads the type as the body (the first reading accused two gated exports), and a `;` INSIDE that
 *  type literal (`Promise<{ ok: boolean; error?: string }>`) must not end the scan — the second reading (141K)
 *  silently SKIPPED two gated exports that way, so a count of bodies is asserted beside the misses. */
export function exportedAsyncBodies(stripped: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = []
  for (const m of stripped.matchAll(/export\s+async\s+function\s+(\w+)\s*\(/g)) {
    let i = m.index! + m[0].length, depth = 1
    while (i < stripped.length && depth > 0) { if (stripped[i] === "(") depth++; else if (stripped[i] === ")") depth--; i++ }
    let angle = 0, typeBrace = 0, start = -1
    for (; i < stripped.length; i++) {
      const ch = stripped[i]
      if (ch === "<") angle++
      else if (ch === ">" && stripped[i - 1] !== "=") angle = Math.max(0, angle - 1)
      else if (ch === "{") {
        const prev = stripped.slice(0, i).trimEnd().slice(-1)
        if (angle === 0 && typeBrace === 0 && !/[:|&=,]/.test(prev)) { start = i; break }
        typeBrace++
      }
      else if (ch === "}") typeBrace = Math.max(0, typeBrace - 1)
      // A top-level `;` (outside angles and type literals) ends a declaration: an overload signature, no body.
      else if (ch === ";" && angle === 0 && typeBrace === 0) break
    }
    if (start < 0) continue
    let d = 0, end = stripped.length
    for (let j = start; j < stripped.length; j++) { if (stripped[j] === "{") d++; else if (stripped[j] === "}" && --d === 0) { end = j; break } }
    out.push({ name: m[1], body: stripped.slice(start + 1, end) })
  }
  return out
}
/** PURE: exported async functions of a "use server" module whose body reaches createServiceClient() before
 *  gateStaffAction(…) — or never gates at all. */
export function staffGateMisses(stripped: string): string[] {
  return exportedAsyncBodies(stripped).filter(({ body }) => {
    const gate = body.search(/\bgateStaffAction\s*\(/), svc = body.search(/\bcreateServiceClient\s*\(/)
    return gate < 0 || (svc >= 0 && svc < gate)
  }).map((f) => f.name)
}
/** PURE: a `...spread` inside an `.insert(` / `.upsert(` argument — an external row written onto a canonical table. */
export function spreadIntoWrite(stripped: string): number {
  return [...stripped.matchAll(/\.(insert|upsert)\(\s*\{[^}]*\.\.\.\s*\w+/g)].length
}

export async function run() {
  const c = canary("CRM inbound: tenant refused; platform staff's mapped import accepted (no external schema on canonical fields)")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: an import writes contacts into a tenant — in-memory only")
  const { resolvePlatformRoleIdentity, platformStaffCan } = await import("../../lib/platform/platform-staff-roster")
  const can = (user_type: string | null, platform_role: string | null) => platformStaffCan(resolvePlatformRoleIdentity(user_type, platform_role), "tenants")
  c.step("tenant REFUSED: a broker_owner, broker_admin, team_lead or agent with no platform_role has no 'tenants' capability", !can("broker_owner", null) && !can("broker_admin", null) && !can("team_lead", null) && !can("agent", null), "")
  c.step("staff ACCEPTED: a user whose platform_role is superadmin (the column, not the user_type) holds 'tenants'", can("admin", "superadmin"), "")
  c.step("gate wiring (stripped source): every export of app/actions/lead-import/crm-pull-actions.ts calls gateStaffAction BEFORE the service client; no tenant admin type is admitted by name", staffGateMisses(strippedRepo("app/actions/lead-import/crm-pull-actions.ts") ?? "export async function x() { }").length === 0 && !/["'](broker_owner|broker_admin|team_lead|agent)["']/.test(strippedRepo("app/actions/lead-import/crm-pull-actions.ts") ?? ""), staffGateMisses(strippedRepo("app/actions/lead-import/crm-pull-actions.ts") ?? "").join(",") || "0 misses")
  const SPECIMEN = `"use server"\nexport async function leak() { const svc = createServiceClient(); const g = await gateStaffAction("tenants") }\nexport async function open() { const svc = createServiceClient() }\nexport async function ok(input: { brokerageId: string; provider: "a" | "b" }): Promise<{ ok: boolean; error?: string }> { const g = await gateStaffAction("tenants"); const svc = createServiceClient() }\nexport async function bare(\n  id: string,\n): { ok: boolean; connected: string[] } { const g = await gateStaffAction("tenants"); const svc = createServiceClient() }`
  c.step("POSITIVE CONTROL: the finder catches an export that opens the service client before the staff gate and one that never gates; a gated export with a `Promise<{…;…}>` return type (and one with a bare `{…;…}` return type) is FOUND and NOT accused — all four bodies read", staffGateMisses(SPECIMEN).join() === "leak,open" && exportedAsyncBodies(SPECIMEN).map((b) => b.name).join() === "leak,open,ok,bare", exportedAsyncBodies(SPECIMEN).map((b) => b.name).join())
  const B = uuid(), AG = uuid(), U = uuid(), STAFF = uuid()
  const svc = canaryClient({
    brokerages: [{ id: B, name: `${CANARY_TAG} Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-in` }],
    users: [{ id: U, email: `owner@${CANARY_EMAIL_DOMAIN}`, user_type: "broker_owner", brokerage_id: B }, { id: STAFF, email: `staff@${CANARY_EMAIL_DOMAIN}`, user_type: "admin", platform_role: "superadmin", brokerage_id: null }],
    agents: [{ id: AG, user_id: U, brokerage_id: B, first_name: "Canary", last_name: "Owner", is_active: true, created_at: nowIso() }],
    contacts: [{ id: uuid(), brokerage_id: B, agent_id: AG, first_name: "Dana", last_name: "Canary", email: `dana@${CANARY_EMAIL_DOMAIN}`, phone: "5125550199", phone_digits: "5125550199", status: "active", notes: CANARY_TAG }],
  })
  setSvc(svc)
  const { ghlToRow } = await import("../../lib/crm/import-pull")
  const { parseContactRecords } = await import("../../lib/platform/tenant-import-parser")
  const { importParsedContacts } = await import("../../lib/platform/tenant-import")
  // The vendor's records — with a vendor-only field and a consent CLAIM the OS must not honour.
  const vendor = [
    { id: "ghl-1", firstName: "Jordan", lastName: "Canary", email: `jordan@${CANARY_EMAIL_DOMAIN}`, phone: "5125550123", address1: "1 Canary Way", city: "Pensacola", state: "FL", postalCode: "32501", type: "buyer", tags: ["expo", "hot"], dnd: false, customField: "vendor-only" },
    { id: "ghl-2", firstName: "Dana", lastName: "Canary", email: `dana@${CANARY_EMAIL_DOMAIN}`, phone: "5125550199", tags: [] },
  ]
  const rows = vendor.map(ghlToRow)
  c.step("mapping: the vendor record is mapped onto the CSV-shaped canonical keys (First Name / Email / Phone …); unmapped vendor fields never become keys", rows[0]["First Name"] === "Jordan" && rows[0].Email === `jordan@${CANARY_EMAIL_DOMAIN}` && !("customField" in rows[0]) && !("id" in rows[0]) && !("dnd" in rows[0]), Object.keys(rows[0]).join(","))
  const parsed = parseContactRecords(rows)
  c.step("validation: the parser validates every row (2 data rows, 0 errors) and keeps the vendor's own tags as notes/tags, never a canonical column", parsed.rows.length === 2 && parsed.errors.length === 0 && parsed.totalDataRows === 2, JSON.stringify(parsed.errors))
  const r = await importParsedContacts({ svc, brokerageId: B, dedupe: "email_phone", importedBy: STAFF, parsed, emptyLabel: "gohighlevel page" })
  const jordan = (svc.tables.contacts ?? []).find((x) => x.email === `jordan@${CANARY_EMAIL_DOMAIN}`)
  c.step("controlled commit (staff actor): 1 inserted under the TARGET tenant, anchored to the tenant's owner agent, source 'import', consent FALSE, imported_by = the staff user; 1 duplicate skipped (Dana already on file)", r.ok && r.inserted === 1 && r.skippedDuplicates === 1 && !!jordan && jordan.brokerage_id === B && jordan.agent_id === AG && jordan.source === "import" && jordan.tcpa_consent === false && (jordan.metadata as { imported_by?: string })?.imported_by === STAFF, r.error ?? JSON.stringify({ inserted: r.inserted, skipped: r.skippedDuplicates }))
  c.step("no external schema on canonical fields: the inserted row carries only canonical columns (no 'GHL Tags', no vendor id, no customField)", !!jordan && !Object.keys(jordan).some((k) => /GHL|customField|^id$/.test(k) && k !== "id") && !("ghl_id" in jordan), Object.keys(jordan ?? {}).join(","))
  const again = await importParsedContacts({ svc, brokerageId: B, dedupe: "email_phone", importedBy: STAFF, parsed, emptyLabel: "gohighlevel page" })
  c.step("idempotent: the same page again inserts nothing (2 duplicates skipped) — one contacts row per person", again.ok && again.inserted === 0 && again.skippedDuplicates === 2 && (svc.tables.contacts ?? []).filter((x) => x.brokerage_id === B).length === 2, "")
  const lanes = ["lib/platform/tenant-import.ts", "app/actions/lead-import/crm-pull-actions.ts", "lib/crm/import-pull.ts"]
  const spreads = lanes.map((f) => ({ f, n: spreadIntoWrite(strippedRepo(f) ?? "") })).filter((x) => x.n > 0)
  c.step("source rule: no `...row` spread into an insert/upsert on the inbound lane (external shapes never write canonical fields directly)", spreads.length === 0 && lanes.every((f) => strippedRepo(f) !== null), spreads.map((x) => `${x.f}×${x.n}`).join(",") || "0")
  c.step("POSITIVE CONTROL: the finder catches `.insert({ ...row, brokerage_id })` and ignores a literal insert", spreadIntoWrite(`svc.from("contacts").insert({ ...row, brokerage_id: b })`) === 1 && spreadIntoWrite(`svc.from("contacts").insert({ first_name: r.firstName, brokerage_id: b })`) === 0)
  // THE ROLE-SAFETY CONTRACT (141B), asserted on the resolver itself — never relaxed. At 81fcd1f14 it FAILS:
  // lib/platform/platform-staff-roster.ts:242 still answers "superadmin" for users.user_type='superadmin' with no
  // platform_role (lane 141B left it as "proof-pinned elsewhere"; CLAUDE.md §4 and the wave-141 ruling say platform
  // staff live in platform_role and an unknown type is never elevated). INTEGRATOR FINDING (lane141K-notes). The
  // inbound doors are safe regardless — lane 141D's inboundImportGate refuses a null platform_role (asserted below).
  c.step("141B CONTRACT: resolvePlatformRoleIdentity('superadmin', null) is NOT platform staff — no authority resolver falls an unknown user_type back to superadmin", !can("superadmin", null), `lib/platform/platform-staff-roster.ts:242 → ${String(resolvePlatformRoleIdentity("superadmin", null))} (platform staff live in platform_role; the inbound doors refuse it through inboundImportGate)`)
  // WAVE141 HOOKS (integrator): 141D — the registry + preview + controlled commit (wired 141K); 141B — the superadmin
  // user_type fallback (pending while the resolver keeps it; the contract step above fails loudly).
  for (const h of hooksFor("crm-inbound")) {
    const at = h.probe()
    if (!at) { c.hook(h.lane, h.contract, h.lane === "141B" ? `lib/platform/platform-staff-roster.ts:242 resolvePlatformRoleIdentity('superadmin', null) → ${String(resolvePlatformRoleIdentity("superadmin", null))} — the contract step above fails loudly` : "at HEAD the mapping is the parser's header aliases; no preview step"); continue }
    if (h.lane === "141B") { c.step(`${h.lane} landed (${at}): a users.user_type of 'superadmin' with NO platform_role is NOT platform staff (refused, never elevated)`, !can("superadmin", null), String(resolvePlatformRoleIdentity("superadmin", null))); continue }
    const { CRM_CONTACT_INGRESS_CONTRACT, CRM_CONTACT_INGRESS_IDENTITY_ANY_OF } = await import("../../lib/kernel/schema-adaptation")
    const { fubToRow, loftyToRow, crmImportPreviewToken } = await import("../../lib/crm/import-pull")
    const paths = new Set(CRM_CONTACT_INGRESS_CONTRACT.fields.flatMap((f) => f.paths))
    const keys = CRM_CONTACT_INGRESS_CONTRACT.fields.map((f) => f.key)
    const mapperKeys = [...new Set([...Object.keys(ghlToRow({})), ...Object.keys(fubToRow({})), ...Object.keys(loftyToRow({}))])]
    c.step(`${h.lane} landed (${at}): ONE registry — CRM_CONTACT_INGRESS_CONTRACT names the canonical contact fields an import may land (${keys.length}) and the identity any-of rule (name / email / phone); every key the three vendor mappers emit (${mapperKeys.length}) resolves to a registry path — 0 unmapped; no consent field exists to import (TCPA consent is earned on our rail)`, ["first_name", "last_name", "email", "phone", "address", "city", "state", "zip", "source", "notes", "tags"].every((k) => keys.includes(k)) && mapperKeys.every((k) => paths.has(k)) && CRM_CONTACT_INGRESS_IDENTITY_ANY_OF[0].includes("email") && CRM_CONTACT_INGRESS_IDENTITY_ANY_OF[0].includes("phone") && !keys.some((k) => /consent/i.test(k)), mapperKeys.filter((k) => !paths.has(k)).join(",") || "0 unmapped")
    const p2 = parseContactRecords([{ ...rows[0], customField: "vendor-only" }])
    const p3 = parseContactRecords([{ Address: "1 Canary Way" }])
    c.step("141D the mapping is EXPLICIT and inspectable: the parser reports header → canonical for the page; a vendor-only key is reported as unmapped and never becomes a key; a record with NO identity (no name, email or phone) is refused with its line, never landed", parsed.mapping["First Name"] === "first_name" && parsed.mapping.Email === "email" && parsed.mapping.Phone === "phone" && p2.unmappedHeaders.includes("customField") && !("customField" in (p2.rows[0] ?? {})) && p3.rows.length === 0 && p3.errors.length === 1, JSON.stringify(parsed.mapping).slice(0, 160))
    const tokenInput = { provider: "gohighlevel" as const, brokerageId: B, mapping: parsed.mapping, ignoredKeys: parsed.unmappedHeaders }
    const token = crmImportPreviewToken(tokenInput)
    c.step("141D CONTROLLED COMMIT: the preview token binds a run to (provider, target tenant, mapping, ignored keys) — deterministic, and it MISSES when the mapping or the tenant changes, so what was previewed is provably what lands", token === crmImportPreviewToken(tokenInput) && token !== crmImportPreviewToken({ ...tokenInput, brokerageId: uuid() }) && token !== crmImportPreviewToken({ ...tokenInput, mapping: { ...parsed.mapping, Phone: "notes" } }) && token !== crmImportPreviewToken({ ...tokenInput, ignoredKeys: ["customField"] }), token)
    const fresh = parseContactRecords([ghlToRow({ id: "ghl-3", firstName: "Sam", lastName: "Canary", email: `sam@${CANARY_EMAIL_DOMAIN}`, tags: [] })])
    const onTenant = () => (svc.tables.contacts ?? []).filter((x) => x.brokerage_id === B).length
    const countBefore = onTenant()
    const dry = await importParsedContacts({ svc, brokerageId: B, dedupe: "email_phone", importedBy: STAFF, parsed: fresh, emptyLabel: "gohighlevel page", dryRun: true })
    c.step("141D PREVIEW is a DRY RUN of the whole lane (tenant anchor, owner agent, dedupe against the TARGET) that writes NOTHING: wouldInsert reported, inserted 0, no contacts row landed", dry.ok && dry.dryRun === true && dry.wouldInsert === 1 && dry.inserted === 0 && dry.skippedDuplicates === 0 && onTenant() === countBefore, JSON.stringify({ wouldInsert: dry.wouldInsert, inserted: dry.inserted }))
    const doorsSrc = strippedRepo("app/actions/lead-import/crm-pull-actions.ts") ?? ""
    const bodies = exportedAsyncBodies(doorsSrc)
    const runBody = bodies.find((b) => b.name === "runCrmImportAction")?.body ?? ""
    c.step("141D PLATFORM STAFF ONLY at every door: each exported action calls inboundImportGate(await gateStaffAction(\"tenants\")) before the service client; the gate refuses a null platform_role by rule (a legacy user_type marker is not accepted) and a tenant gets ONE clear sentence; the run door refuses without the preview token, recomputes it from the page it pulls, and writes lead_imports + LEAD_IMPORT_COMPLETED only AFTER the commit", bodies.length >= 4 && bodies.every(({ body }) => { const g = body.search(/inboundImportGate\(\s*await\s+gateStaffAction\(\s*["']tenants["']\s*\)\s*\)/), s = body.search(/\bcreateServiceClient\s*\(/); return g >= 0 && (s < 0 || s > g) }) && /if\s*\(\s*!gate\.platformRole\s*\)/.test(doorsSrc) && /INBOUND_IMPORT_TENANT_REFUSAL/.test(doorsSrc) && /previewToken/.test(runBody) && /crmImportPreviewToken\(/.test(runBody) && runBody.search(/importParsedContacts\(/) >= 0 && runBody.search(/importParsedContacts\(/) < runBody.search(/["']lead_imports["']/) && runBody.search(/["']lead_imports["']/) < runBody.search(/LEAD_IMPORT_COMPLETED/), bodies.map((b) => b.name).join(","))
  }
  c.blind("The session gate (gateStaffAction reads auth.getUser) is asserted by its pure half + the source rule; the vendor pull (pullCrmPage) is HTTP and not driven — test:crm-pull owns the fetchers.")
  const { cleanup, residual, mismatches } = await cleanupCanary(svc, B)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", mismatches.length === 0 && residual === 0, cleanup.map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report(cleanup, residual)
}
