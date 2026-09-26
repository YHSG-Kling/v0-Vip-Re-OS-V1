#!/usr/bin/env tsx
/**
 * scripts/user-type-tool-surfaces-guard.ts   (npm run test:user-type-tool-surfaces)
 * ─────────────────────────────────────────────────────────────────────────────
 * Lane 77A — owner verbatim (wave 77): "vendors are not contact type, they
 * are user type. persona tools need to be for true persona types and other
 * user types need their own tools if there are no tools already covered."
 *
 * Proves, in STRIPPED source (scripts/strip-comments.ts — a tombstone is not
 * a call site, CLAUDE.md §2) and at runtime (no DB, no network):
 *   Layer 0 — strip-comments positive control.
 *   Layer 1 — ToolPersona contains NO user type: the persona vocabulary
 *             (lib/ai-isa/persona-tool-policy.ts) and the seat vocabulary
 *             (lib/ai-isa/user-type-tool-policy.ts) are DISJOINT, and no
 *             users.user_type CHECK value (scripts/check-vocabularies.ts)
 *             is a persona. POSITIVE CONTROL: a fake persona list carrying
 *             "vendor" makes the SAME predicate go red.
 *   Layer 2 — every seat in the policy table maps to REGISTERED tools only
 *             (USER_TYPE_SEAT_TOOL_NAMES ⊆ builder registry), and the runtime
 *             mounts exactly the table's names. POSITIVE CONTROL: a phantom
 *             name is caught by the same set difference.
 *   Layer 3 — vendor/lender tools never expose another vendor's or a
 *             contact's data: every vendor-table read carries BOTH the
 *             vendor_id and brokerage_id predicates, the file reads no
 *             contacts/leads table, no inputSchema accepts a vendor / brokerage
 *             / contact id from the model, and a seat with no identity gets
 *             NO tools (fail closed). POSITIVE CONTROL: a fixture chain
 *             missing the vendor predicate IS flagged.
 *   Layer 4 — no BatchData/RentCast/staff tool on any partner seat (table +
 *             selection + source), staff-side seats keep them.
 *   Layer 5 — the staff copilot still gets the WHOLE toolkit: every
 *             `name: tool({` the route declares survives selectToolsForSeat
 *             for staff / team_lead / broker_admin / platform_staff.
 *   Layer 6 — seat resolution: lender is a CATEGORY (a 'lender' grant on a
 *             non-lender vendor is a vendor seat), title / team_lead /
 *             broker_admin (incl. the two seats the old roster omitted) /
 *             platform staff / staff.
 *   Layer 7 — the route MOUNTS the selection, the arbitrary-vendor read and
 *             the un-pinned compliance_flags read are gone, the persona
 *             surfaces no longer thread a vendor persona, and the proof is
 *             registered after test:scrapers with a MAINTENANCE_DOMAINS entry.
 *
 * Run:  npx tsx scripts/user-type-tool-surfaces-guard.ts
 */
import { readFileSync } from "node:fs"
import { stripComments, blankStrings } from "./strip-comments"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const stripped = (path: string) => stripComments(readFileSync(path, "utf8"))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 0 · strip-comments positive control]")
const policySrc = stripped("lib/ai-isa/user-type-tool-policy.ts")
check("a comment-only phrase is ABSENT from stripped user-type-tool-policy.ts (the scanner sees comments)",
  !policySrc.includes("THE ONE USER-TYPE (SEAT) TOOL TABLE"))
check("a real code token from the same file IS present (the scanner did not eat the code too)",
  policySrc.includes("export function resolveUserTypeSeat"))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 1 · ToolPersona contains NO user type — personas and seats are disjoint]")
const { TOOL_PERSONAS, resolveToolPersona, PERSONA_TOOL_POLICY } = await import("../lib/ai-isa/persona-tool-policy")
const { USER_TYPE_SEATS, USER_TYPE_TOOL_POLICY, USER_TYPE_SEAT_TOOL_NAMES, PARTNER_SEATS, COPILOT_ADMITTED_ROLES, resolveUserTypeSeat, selectToolsForSeat, seatPromptBlock } = await import("../lib/ai-isa/user-type-tool-policy")
const { CHECK_VOCABULARIES } = await import("./check-vocabularies")
const { TENANT_ADMIN_USER_TYPES } = await import("../lib/auth/resolve-user-role")

const userTypeVocab: string[] = (CHECK_VOCABULARIES as Record<string, Record<string, string[]>>).users?.user_type ?? []
check("users.user_type CHECK vocabulary loaded from the generated cache (not a silent empty list)", userTypeVocab.length >= 10, `got ${userTypeVocab.length}`)

/** PURE — the rule: a persona list may share NO word with the seat/user-type vocabularies. */
const personaSeatOverlap = (personas: readonly string[]) =>
  personas.filter((p) => (USER_TYPE_SEATS as readonly string[]).includes(p) || userTypeVocab.includes(p) || TENANT_ADMIN_USER_TYPES.has(p) || ["vendor", "lender", "title", "title_agent", "agent", "staff", "isa", "tc"].includes(p))

check("TOOL_PERSONAS ∩ {seat names, users.user_type values, tenant roster, partner words} = ∅",
  personaSeatOverlap(TOOL_PERSONAS).length === 0, personaSeatOverlap(TOOL_PERSONAS).join(","))
check("PERSONA_TOOL_POLICY's keys equal TOOL_PERSONAS exactly (no orphan row, no missing row)",
  Object.keys(PERSONA_TOOL_POLICY).sort().join(",") === [...TOOL_PERSONAS].sort().join(","))
check("POSITIVE CONTROL: a fake persona list carrying 'vendor' makes the SAME predicate go red",
  personaSeatOverlap([...TOOL_PERSONAS, "vendor"]).includes("vendor"))
check("POSITIVE CONTROL 2: a fake persona list carrying 'team_lead' (a tenant roster word) also goes red",
  personaSeatOverlap(["buyer", "team_lead"]).includes("team_lead"))
const personaSrc = stripped("lib/ai-isa/persona-tool-policy.ts")
const unionLine = personaSrc.match(/export type ToolPersona =[^\n]*/)?.[0] ?? ""
check("source: the `export type ToolPersona = …` line carries no user-type word",
  unionLine.length > 0 && !/"(vendor|lender|title|agent|staff|isa|tc|team_lead|broker)"/.test(unionLine), unionLine)
check("resolveToolPersona: contact_type 'vendor' → sphere (a CRM record about a business relationship), never a 'vendor' persona",
  resolveToolPersona({ contactType: "vendor" }) === "sphere")
const { PERSONA_QUESTION_GUIDE } = await import("../lib/ai-isa/qualification-playbook")
const { CAPABILITY_CATALOGUE } = await import("../lib/ai-isa/capability-catalogue")
check("PERSONA_QUESTION_GUIDE has no seat entry; no catalogue capability names a seat in its personas; get_my_vendor_status is not a customer capability",
  personaSeatOverlap(Object.keys(PERSONA_QUESTION_GUIDE)).length === 0
  && CAPABILITY_CATALOGUE.every((c) => !c.personas || personaSeatOverlap(c.personas).length === 0)
  && !CAPABILITY_CATALOGUE.some((c) => (c.id as string) === "get_my_vendor_status"))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 2 · every seat maps to registered tools only]")
const { USER_TYPE_SEAT_TOOL_BUILDERS, buildUserTypeSeatTools } = await import("../lib/ai-isa/user-type-tools")
const registered = new Set(Object.keys(USER_TYPE_SEAT_TOOL_BUILDERS))
const phantom = (names: readonly string[]) => names.filter((n) => !registered.has(n))
check("USER_TYPE_SEAT_TOOL_NAMES ⊆ builder registry (no phantom promise)", phantom(USER_TYPE_SEAT_TOOL_NAMES).length === 0, phantom(USER_TYPE_SEAT_TOOL_NAMES).join(","))
check("every registered builder is promised by at least one seat (no orphan builder)",
  [...registered].every((n) => USER_TYPE_SEAT_TOOL_NAMES.includes(n)), [...registered].filter((n) => !USER_TYPE_SEAT_TOOL_NAMES.includes(n)).join(","))
check("POSITIVE CONTROL: a phantom tool name IS caught by the same set difference", phantom(["get_my_vendor_status", "phantom_tool"]).join(",") === "phantom_tool")
for (const seat of USER_TYPE_SEATS) {
  const p = USER_TYPE_TOOL_POLICY[seat]
  check(`${seat}: asks ≥ 2 and rules ≥ 1 (a seat with no realistic asks is not a seat)`, p.asks.length >= 2 && p.rules.length >= 1)
  if (PARTNER_SEATS.has(seat)) check(`${seat}: a partner seat promises ≥ 3 seat tools of its own`, p.seatToolNames.length >= 3, p.seatToolNames.join(","))
}
const vendorCtx = { seat: "vendor" as const, brokerageId: "b-1", userId: "u-1", vendorId: "v-1", titleMemberships: [] }
const mountedVendor = Object.keys(buildUserTypeSeatTools(vendorCtx)).sort()
check("runtime: a vendor seat WITH an identity mounts EXACTLY the table's vendor tool names",
  mountedVendor.join(",") === [...USER_TYPE_TOOL_POLICY.vendor.seatToolNames].sort().join(","), mountedVendor.join(","))
const mountedLender = Object.keys(buildUserTypeSeatTools({ ...vendorCtx, seat: "lender" })).sort()
check("runtime: a lender seat WITH an identity mounts EXACTLY the table's lender tool names",
  mountedLender.join(",") === [...USER_TYPE_TOOL_POLICY.lender.seatToolNames].sort().join(","), mountedLender.join(","))
const mountedTitle = Object.keys(buildUserTypeSeatTools({ seat: "title", brokerageId: "b-1", userId: "u-1", vendorId: null, titleMemberships: [{ id: "t-1", transactionId: "tx-1" }] })).sort()
check("runtime: a title seat WITH a membership mounts EXACTLY the table's title tool names",
  mountedTitle.join(",") === [...USER_TYPE_TOOL_POLICY.title.seatToolNames].sort().join(","), mountedTitle.join(","))
const mountedTeamLead = Object.keys(buildUserTypeSeatTools({ seat: "team_lead", brokerageId: "b-1", userId: "u-1", vendorId: null, titleMemberships: [] })).sort()
check("runtime: team_lead mounts its board/rules/coaching tools; broker_admin its readiness/billing/compliance tools",
  mountedTeamLead.join(",") === [...USER_TYPE_TOOL_POLICY.team_lead.seatToolNames].sort().join(",")
  && Object.keys(buildUserTypeSeatTools({ seat: "broker_admin", brokerageId: "b-1", userId: "u-1", vendorId: null, titleMemberships: [] })).sort().join(",") === [...USER_TYPE_TOOL_POLICY.broker_admin.seatToolNames].sort().join(","))
for (const seat of USER_TYPE_SEATS) {
  const block = seatPromptBlock(seat, USER_TYPE_TOOL_POLICY[seat].seatToolNames)
  const promised = (block.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []).filter((t) => t.startsWith("get_") || t.startsWith("update_") || t.startsWith("send_") || t.startsWith("respond_") || t.startsWith("flag_") || t.startsWith("list_"))
  // Lane 79B — a staff-side seat's followUps may also name the CUSTOMER
  // bundle's catalogue tools (it acts FOR a contact: send_matching_listings…),
  // but ONLY when the table lets that seat mount the customer bundle.
  const customerBundleIds = new Set<string>(USER_TYPE_TOOL_POLICY[seat].customerPersonaToolsForContact ? CAPABILITY_CATALOGUE.map((c) => c.id as string) : [])
  const unknown = [...new Set(promised)].filter((t) => !registered.has(t) && t !== "draft_ai_reply" && !customerBundleIds.has(t))
  check(`${seat}: the seat prompt block promises only registered seat tools (or draft_ai_reply from the staff toolkit${USER_TYPE_TOOL_POLICY[seat].customerPersonaToolsForContact ? ", or the customer bundle it may act through" : ""})`, unknown.length === 0, unknown.join(","))
  check(`${seat}: the seat carries ≥ 2 follow-up offers (lane 79B — a seat with nothing to offer next is not a copilot)`, USER_TYPE_TOOL_POLICY[seat].followUps.length >= 2)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 3 · vendor/lender tools never expose another vendor's or a contact's data — fail closed]")
const toolsSrc = stripped("lib/ai-isa/user-type-tools.ts")
/** PURE — every `.from("vendor_*")` / `.from("vendors")` chain must carry BOTH predicates before the chain ends. */
const unpinnedVendorReads = (src: string): string[] => {
  const out: string[] = []
  for (const m of src.matchAll(/\.from\(["'](vendors|vendor_[a-z_]+)["']\)([^\n]*(?:\n[^\n]*){0,3}?)(?=\n\s*(?:const|let|if|return|\]|\)|\})|$)/g)) {
    const chain = m[0]
    const vendorPinned = /\.eq\(["']vendor_id["'],\s*ctx\.vendorId\)/.test(chain) || /\.eq\(["']id["'],\s*ctx\.vendorId\)/.test(chain)
    const tenantPinned = /\.eq\(["']brokerage_id["'],\s*ctx\.brokerageId\)/.test(chain)
    if (!vendorPinned || !tenantPinned) out.push(`${m[1]} @${m.index}`)
  }
  return out
}
const unpinned = unpinnedVendorReads(toolsSrc)
check("every vendors / vendor_* read in user-type-tools.ts carries BOTH .eq(vendor_id|id, ctx.vendorId) AND .eq(brokerage_id, ctx.brokerageId)", unpinned.length === 0, unpinned.join(" | "))
check(`denominator: ≥ 8 vendor-table chains actually scanned`, (toolsSrc.match(/\.from\(["'](vendors|vendor_[a-z_]+)["']\)/g) ?? []).length >= 8, String((toolsSrc.match(/\.from\(["'](vendors|vendor_[a-z_]+)["']\)/g) ?? []).length))
const leakFixture = `const { data } = await svc.from("vendor_invoices").select("id, total_amount").eq("brokerage_id", ctx.brokerageId).limit(5)\nconst x = 1`
check("POSITIVE CONTROL: a fixture vendor_invoices chain pinned to the TENANT only (no vendor_id) IS flagged", unpinnedVendorReads(leakFixture).length === 1)
const cleanFixture = `const { data } = await svc.from("vendor_invoices").select("id").eq("vendor_id", ctx.vendorId).eq("brokerage_id", ctx.brokerageId).limit(5)\nconst x = 1`
check("NEGATIVE CONTROL: the correctly double-pinned chain is NOT flagged", unpinnedVendorReads(cleanFixture).length === 0)
// The PARTNER-seat builders are the slice between two CODE anchors (the
// first vendor builder and the team-lead helper) — comments are stripped, so
// a section banner cannot anchor. The staff-side team board legitimately
// reads leads for the team it leads; a vendor/lender/title tool never may.
const partnerStart = toolsSrc.indexOf("function buildGetMyVendorStatusTool")
const partnerEnd = toolsSrc.indexOf("async function ledTeam(")
const partnerSlice = toolsSrc.slice(partnerStart, partnerEnd)
check("partner-seat builders (vendor/lender/title) were actually sliced (≥ 8 KB of code between the two anchors)", partnerStart > 0 && partnerEnd > partnerStart && partnerSlice.length > 8_000, String(partnerSlice.length))
check("the vendor/lender/title builders read NO contacts / leads table (a partner seat never touches a person's CRM row)",
  !/\.from\(["'](contacts|leads)["']\)/.test(partnerSlice))
check("POSITIVE CONTROL: the same scan DOES flag a fixture partner builder that reads contacts",
  /\.from\(["'](contacts|leads)["']\)/.test(`const { data } = await svc.from("contacts").select("email").eq("id", x)`))
check("no inputSchema in user-type-tools.ts accepts a vendor_id / brokerage_id / contact_id / lead_id from the model (identity is locked from ctx)",
  !/z\.object\(\{[^}]*\b(vendor_id|brokerage_id|contact_id|lead_id|user_id)\s*:\s*z\./s.test(toolsSrc))
check("every lender/title write re-checks the model-named transaction against the SESSION's own list before calling the survivor (ids.includes / titleMembershipFor)",
  (toolsSrc.match(/if \(!ids\.includes\(transaction_id\)\)/g) ?? []).length >= 4 && (toolsSrc.match(/titleMembershipFor\(ctx, transaction_id\)/g) ?? []).length >= 2)
check("fail closed: a vendor seat with NO vendor identity mounts ZERO tools",
  Object.keys(buildUserTypeSeatTools({ ...vendorCtx, vendorId: null })).length === 0)
check("fail closed: a lender seat with NO vendor identity mounts ZERO tools",
  Object.keys(buildUserTypeSeatTools({ ...vendorCtx, seat: "lender", vendorId: null })).length === 0)
check("fail closed: a title seat with NO membership mounts ZERO tools",
  Object.keys(buildUserTypeSeatTools({ seat: "title", brokerageId: "b-1", userId: "u-1", vendorId: null, titleMemberships: [] })).length === 0)
check("fail closed: the seat prompt says 'none' when nothing mounted, and names the tools when they did",
  seatPromptBlock("vendor", []).includes("none — this account is not linked") && seatPromptBlock("vendor", ["get_my_vendor_status"]).includes("get_my_vendor_status"))
check("every seat-tool read destructures { data, error } (supabase-js RESOLVES refusals — §3): no bare `const { data } = await svc.from(` in the file",
  !/const \{ data \} = await svc\.from\(/.test(toolsSrc))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 4 · no BatchData / RentCast / staff tool on any partner seat]")
const fake = (names: string[]) => Object.fromEntries(names.map((n) => [n, { execute: async () => ({}) }]))
const parts = {
  staffTools: fake(["lookup_contact", "send_portal_message", "update_contact_status", "stage_listing_packet"]),
  batchDataTools: fake(["lookup_property", "comparable_property_preview"]),
  rentCastTools: fake(["rentcast_value_lookup"]),
  customerTools: fake(["get_my_context", "search_our_listings"]),
}
for (const seat of PARTNER_SEATS) {
  const p = USER_TYPE_TOOL_POLICY[seat]
  check(`${seat}: table says staffToolkit none, batchData false, rentCast false, customerPersonaToolsForContact false`,
    p.staffToolkit === "none" && !p.batchData && !p.rentCast && !p.customerPersonaToolsForContact)
  const selected = Object.keys(selectToolsForSeat(seat, { ...parts, seatTools: fake([...p.seatToolNames]) })).sort()
  check(`${seat}: selectToolsForSeat yields ONLY the seat's own tools — no lookup_contact, no BatchData, no RentCast, no customer bundle`,
    selected.join(",") === [...p.seatToolNames].sort().join(","), selected.join(","))
}
check("a seat tool the table does NOT name for this seat never mounts even if the caller built it (lender's tools handed to a vendor seat are dropped)",
  !("get_my_loan_pipeline" in selectToolsForSeat("vendor", { ...parts, seatTools: fake(["get_my_loan_pipeline", "get_my_vendor_status"]) })))
const blanked = blankStrings(toolsSrc)
check("user-type-tools.ts source carries no batchdata / rentcast / skip-trace / meterVendorSpend token (blankStrings so a description cannot false-match)",
  !/batchdata|rentcast|skip_?trace|metervendorspend/i.test(blanked))
check("POSITIVE CONTROL: the same token scan DOES flag a fixture that imports batchDataIsaTools",
  /batchdata/i.test(blankStrings(`import { batchDataIsaTools } from "@/lib/ai-isa/batchdata-isa-tools"`)))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 5 · the staff copilot still gets the WHOLE toolkit]")
const routeSrc = stripped("app/api/internal/ai-chat/route.ts")
const agentToolsStart = routeSrc.indexOf("const agentTools = {")
const agentToolsSlice = routeSrc.slice(agentToolsStart, routeSrc.indexOf("const batchDataToolsFull"))
const staffToolNames = [...agentToolsSlice.matchAll(/^\s{4}([a-z_]+): tool\(\{/gm)].map((m) => m[1])
check("the route's staff toolkit was actually enumerated (≥ 19 `name: tool({` declarations)", staffToolNames.length >= 19, String(staffToolNames.length))
for (const seat of ["staff", "team_lead", "broker_admin", "platform_staff"] as const) {
  const p = USER_TYPE_TOOL_POLICY[seat]
  const selected = selectToolsForSeat(seat, { ...parts, staffTools: fake(staffToolNames), seatTools: fake([...p.seatToolNames]) })
  check(`${seat}: every staff tool survives (${staffToolNames.length}/${staffToolNames.length}) + BatchData + RentCast${p.customerPersonaToolsForContact ? " + the customer bundle" : ""}`,
    staffToolNames.every((n) => n in selected) && "lookup_property" in selected && "rentcast_value_lookup" in selected
    && (p.customerPersonaToolsForContact ? "get_my_context" in selected : !("get_my_context" in selected)))
}
check("staff / team_lead / broker_admin / platform_staff keep batchData: true + rentCast: true in the table (the wave-72B ruling stands)",
  (["staff", "team_lead", "broker_admin", "platform_staff"] as const).every((s) => USER_TYPE_TOOL_POLICY[s].batchData && USER_TYPE_TOOL_POLICY[s].rentCast && USER_TYPE_TOOL_POLICY[s].staffToolkit === "all"))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 6 · seat resolution — lender is a CATEGORY, the roster is derived]")
const base = { role: null, userType: null, platformRole: null, vendorCategory: null, hasVendorId: false, isTitleUser: false }
check("a vendor grant on a LENDER-category vendor → lender", resolveUserTypeSeat({ ...base, role: "vendor", vendorCategory: "lender", hasVendorId: true }) === "lender")
check("a 'lender' ROLE word on a NON-lender vendor → vendor (the category makes a lender, not the word — CLAUDE.md §4)",
  resolveUserTypeSeat({ ...base, role: "lender", vendorCategory: "inspector", hasVendorId: true }) === "vendor")
check("a 'lender' role with NO vendor grant → vendor seat with no identity (tools fail closed), never lender",
  resolveUserTypeSeat({ ...base, role: "lender" }) === "vendor")
check("a title_company_users row → title; a title-category vendor → title", resolveUserTypeSeat({ ...base, role: "vendor", isTitleUser: true }) === "title" && resolveUserTypeSeat({ ...base, role: "vendor", vendorCategory: "title", hasVendorId: true }) === "title")
check("team_lead → team_lead", resolveUserTypeSeat({ ...base, role: "team_lead" }) === "team_lead")
check("broker / broker_owner / broker_admin / admin / compliance_officer → broker_admin (derived from TENANT_ADMIN_USER_TYPES minus team_lead)",
  ["broker", "broker_owner", "broker_admin", "admin", "compliance_officer"].every((r) => resolveUserTypeSeat({ ...base, role: r }) === "broker_admin"))
check("agent / isa / tc → staff", ["agent", "isa", "tc"].every((r) => resolveUserTypeSeat({ ...base, role: r }) === "staff"))
check("platform_role 'superadmin' (user_type 'admin') → platform_staff — never user_type='superadmin'", resolveUserTypeSeat({ ...base, role: "admin", userType: "admin", platformRole: "superadmin" }) === "platform_staff")
check("COPILOT_ADMITTED_ROLES carries broker_owner and broker_admin (the two storable seats the hand-typed PERMITTED_ROLES omitted) and is derived from the roster",
  COPILOT_ADMITTED_ROLES.has("broker_owner") && COPILOT_ADMITTED_ROLES.has("broker_admin") && [...TENANT_ADMIN_USER_TYPES].every((r) => COPILOT_ADMITTED_ROLES.has(r)))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 7 · the route mounts the selection; old defects gone; registration]")
check("route: PERMITTED_ROLES literal set is GONE; COPILOT_ADMITTED_ROLES is consulted", !/const PERMITTED_ROLES = new Set/.test(routeSrc) && routeSrc.includes("COPILOT_ADMITTED_ROLES.has(r)"))
check("route: seat resolved from SESSION facts (selectVendorId over grants, vendors.category, title_company_users by user.id) — never the body",
  /resolveUserTypeSeat\(\{\s*role,/.test(routeSrc) && /selectVendorId\(grants\)/.test(routeSrc) && /\.from\("title_company_users"\)[^\n]*\.eq\("user_id", user\.id\)/.test(routeSrc))
check("route: streamTextRouted receives selectToolsForSeat's output (tools), not a hand-merged spread",
  /const tools = selectToolsForSeat\(seat, \{ staffTools: agentTools, seatTools, batchDataTools, rentCastTools, customerTools \}\)/.test(routeSrc) && /maxTokens: 1024,\s*tools,/.test(routeSrc))
check("route: the acting-for contact is TENANT-CHECKED (contacts by id + session brokerage) and its persona derived from the row (resolveToolPersona)",
  /\.from\("contacts"\)[\s\S]{0,200}?\.eq\("id", claimedContactId\)[\s\S]{0,60}?\.eq\("brokerage_id", brokerageId\)/.test(routeSrc) && routeSrc.includes("persona: resolveToolPersona({ contactType: contact.contact_type"))
check("route: loadVendorContext no longer picks an ARBITRARY vendor of the tenant (no vendors … .limit(1).maybeSingle()); it takes the session vendorId",
  !/\.from\("vendors"\)[\s\S]{0,160}?\.limit\(1\)/.test(routeSrc) && /loadVendorContext\(service, user\.id, brokerageId, vendorIdForSeat\)/.test(routeSrc))
check("route: compliance_flags read is TENANT-PINNED", /\.from\("compliance_flags"\)[\s\S]{0,200}?\.eq\("brokerage_id", brokerageId\)/.test(routeSrc))
check("route: the system prompt carries the seat block and describes the staff toolkit ONLY for a staff-side seat",
  routeSrc.includes("seatPromptBlock(seat, mountedSeatTools)") && /const staffToolsSection = hasStaffToolkit \? `TOOLS/.test(routeSrc))
check("route: partner loaders are picked by SEAT (a lender grant on a non-lender vendor never loads the lender context)",
  /if \(seat === "lender"\) return loadLenderContext/.test(routeSrc) && /if \(seat === "vendor"\) return loadVendorContext/.test(routeSrc))
const assistantSrc = stripped("app/components/shared/internal-ai-assistant.tsx")
check("the copilot panel sends pageContext.contactId in the transport body (so a staff seat can act for the contact it is open on)",
  /body: pageContext\?\.contactId \? \{ contactId: pageContext\.contactId \} : \{\}/.test(assistantSrc))
for (const f of ["lib/ai-isa/customer-context-tools.ts", "lib/ai-isa/capability-catalogue.ts", "lib/ai-isa/qualification-playbook.ts", "lib/voice/twilio-voice.ts"]) {
  const src = stripped(f)
  check(`${f}: no live \`persona === "vendor"\` / \`"vendor" as\` branch remains (tombstones only)`, !/persona === ["']vendor["']|["']vendor["'] as ToolPersona/.test(src))
}
check("POSITIVE CONTROL: the vendor-branch scan DOES flag a fixture that still branches on a vendor persona",
  /persona === ["']vendor["']/.test(`if (ctx.persona === "vendor") return {}`))

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }
check("package.json registers test:user-type-tool-surfaces → this file", pkg.scripts["test:user-type-tool-surfaces"] === "tsx scripts/user-type-tool-surfaces-guard.ts")
const guardLine = pkg.scripts.guard ?? ""
check("the guard chain runs it AFTER test:scrapers (wave 76/77 ruling: new proofs append after test:scrapers)",
  guardLine.indexOf("npm run test:scrapers") >= 0 && guardLine.indexOf("npm run test:user-type-tool-surfaces") > guardLine.indexOf("npm run test:scrapers"))
const { MAINTENANCE_DOMAINS } = await import("../lib/kernel/manager-registry")
check("MAINTENANCE_DOMAINS.user_type_tool_surfaces names this proof under ai_isa",
  MAINTENANCE_DOMAINS.user_type_tool_surfaces?.proof === "test:user-type-tool-surfaces" && MAINTENANCE_DOMAINS.user_type_tool_surfaces?.manager === "ai_isa")

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(60))
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  ✗ ${f}`)
  console.log("\n❌ USER_TYPE_TOOL_SURFACES — see failures above")
  process.exit(1)
} else {
  console.log(" ✅ USER_TYPE_TOOL_SURFACES — personas are customers, seats are user types; every seat maps to registered tools; partner seats read only their own rows, fail closed, and never see a staff/BatchData/RentCast tool; the staff copilot keeps the whole toolkit")
}
