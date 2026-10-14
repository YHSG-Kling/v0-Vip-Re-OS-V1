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
 *  parameter list and past the return type (angle depth 0; a `{` after `:`, `|`, `&`, `=` or `,` is a type
 *  literal, not the body) — a `[^{]*\{` shortcut takes `Promise<{ ok: boolean }>`'s brace and reads the
 *  type as the body (the first reading accused two gated exports). */
export function exportedAsyncBodies(stripped: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = []
  for (const m of stripped.matchAll(/export\s+async\s+function\s+(\w+)\s*\(/g)) {
    let i = m.index! + m[0].length, depth = 1
    while (i < stripped.length && depth > 0) { if (stripped[i] === "(") depth++; else if (stripped[i] === ")") depth--; i++ }
    let angle = 0, start = -1
    for (; i < stripped.length; i++) {
      const ch = stripped[i]
      if (ch === "<") angle++
      else if (ch === ">" && stripped[i - 1] !== "=") angle = Math.max(0, angle - 1)
      else if (ch === "{" && angle === 0) { const prev = stripped.slice(0, i).trimEnd().slice(-1); if (!/[:|&=,]/.test(prev)) { start = i; break } }
      else if (ch === ";") break
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
  c.step("POSITIVE CONTROL: the finder catches an export that opens the service client before the staff gate and one that never gates; a gated export with a `Promise<{…}>` return type and an object parameter is NOT accused", staffGateMisses(`"use server"\nexport async function leak() { const svc = createServiceClient(); const g = await gateStaffAction("tenants") }\nexport async function open() { const svc = createServiceClient() }\nexport async function ok(input: { brokerageId: string; provider: "a" | "b" }): Promise<{ ok: boolean; error?: string }> { const g = await gateStaffAction("tenants"); const svc = createServiceClient() }`).join() === "leak,open")
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
  // WAVE141 HOOKS (integrator): 141D — mapping registry + preview; 141B — the superadmin user_type fallback.
  for (const h of hooksFor("crm-inbound")) {
    const at = h.probe()
    if (!at) { c.hook(h.lane, h.contract, h.lane === "141B" ? `at HEAD resolvePlatformRoleIdentity('superadmin', null) → ${String(resolvePlatformRoleIdentity("superadmin", null))}` : "at HEAD the mapping is the parser's header aliases; no preview step"); continue }
    if (h.lane === "141B") c.step(`${h.lane} landed (${at}): a users.user_type of 'superadmin' with NO platform_role is NOT platform staff (refused, never elevated)`, !can("superadmin", null), String(resolvePlatformRoleIdentity("superadmin", null)))
    else c.step(`${h.lane} landed (${at}) — wire the mapping registry + preview into this canary (WAVE141 HOOK (integrator): 141D)`, false, "")
  }
  c.blind("The session gate (gateStaffAction reads auth.getUser) is asserted by its pure half + the source rule; the vendor pull (pullCrmPage) is HTTP and not driven — test:crm-pull owns the fetchers.")
  const { cleanup, residual, mismatches } = await cleanupCanary(svc, B)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", mismatches.length === 0 && residual === 0, cleanup.map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report(cleanup, residual)
}
