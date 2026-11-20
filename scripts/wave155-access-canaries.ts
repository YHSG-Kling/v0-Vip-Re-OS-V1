#!/usr/bin/env tsx
/**
 * scripts/wave155-access-canaries.ts   (npm run test:wave155-access-canaries)   — wave 155, lane 155A
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 * NO PROTECTED DOCUMENT LEAKS THROUGH THE APP. Every private document a person opens goes through ONE door:
 * app/api/documents/open/route.ts → lib/storage/signed-doc-url.ts openDocumentReference (the session's seat, the row
 * located inside its tenant, the row kind's existing access rule, then a 5-minute signed link). This proof drives that
 * REAL door logic with the REAL access rules — lib/auth/deal-work-ownership.ts loadDealWorkAccess, lib/kernel/
 * deal-document-visibility.ts isClientVisibleDealDocument, the tenant / finance rosters from lib/auth/resolve-user-role.ts,
 * the real share-grant sealer lib/security/secret-crypto.ts — over an IN-MEMORY database, with a COUNTED signer seam.
 * Every refusal must ALSO mint nothing (signer count unchanged); every refusal has a POSITIVE TWIN that opens, so a dead door
 * (refusing everyone) cannot pass. The external party's lane (lib/kernel/portal-auth.ts externalPartnerTransactionLane) is
 * an injected seam here, keyed per (party, deal). SIMULATED — no database, no storage, no provider is called.
 *
 * NOT RE-EXECUTED (already executed by scripts/document-links-sign-on-read-guard.ts, which this proof relies on):
 *   (b) another seat in the tenant without deal access · (c) another TENANT, identical to unknown / junk · (d) a reassigned
 *   deal on the next click · BINDING (a row pointing at another tenant's object) · CONTACT party / hidden / non-party on a
 *   DEAL document · PARTY own upload / delivered CDA / not-own / lane gone · a lead-magnet grant replayed on a deal document ·
 *   a grant minted for a custody kind · expired / tampered / unsealed / cross-tenant / wrong-purpose / other-contact grants.
 * ADDED HERE (the rows that guard does not execute): other OFFICE and other TEAM inside one brokerage (+ the team lead's
 * positive); a Contact asking for ANOTHER Contact's own document (client_documents); a vendor OUTSIDE its deal lane on its
 * own upload; an off-platform lender / title party with NO seat; a REVOKED seat on the next click (status / soft delete /
 * agent deactivation); the photographer / assigned vendor limited to its OWN uploads; the agent's Contacts-only view (no
 * Lead-queue table is a door kind; a brokerage-owned Lead deliverable stays with the tenant roster); a share grant replayed
 * on FOUR other custody kinds and by a signed-in seat of another tenant.
 * RED AT BASE 9d9626b9 (before lane 155A's door fixes): R1 (vendor opens a deal file it did not upload), R2 (revoked seat
 * keeps opening), R3 (photographer opens another vendor's upload). Measured by running this file against the base door.
 * BLIND SPOTS: the lane seam replaces portal-auth (its own proof is test:external-partner-portal-auth); the content
 * catalog's Lead linkage is lane 155D's (lib/marketing/content-catalog.ts) and is not read here; storage.objects policies
 * are the live database's (OWNER-SQL §F / §G) — a direct storage call is bounded by them, not by this door.
 */
import {
  openDocumentReference, toDocumentRef, mintDocumentShareGrant, documentShareUrl, DOCUMENT_DOOR_KINDS, DOC_VIEW_TTL_SECONDS,
  type DocumentDoorActor, type DocumentDoorRules,
} from "../lib/storage/signed-doc-url"
import { loadDealWorkAccess } from "../lib/auth/deal-work-ownership"
import { TENANT_ADMIN_USER_TYPES, BROKERAGE_FINANCE_ADMIN_USER_TYPES } from "../lib/auth/resolve-user-role"
import { isClientVisibleDealDocument } from "../lib/kernel/deal-document-visibility"
import { encryptSecret, decryptSecret, isEncrypted } from "../lib/security/secret-crypto"

let failures = 0
let passes = 0
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) { passes++; console.log(`  ✓ ${name}`) } else { failures++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

type Row = Record<string, any>
/** The in-memory database: the query shapes the door and loadDealWorkAccess use (select with aliases, eq, in, like, limit). */
function memoryDb(tables: Record<string, Row[]>) {
  const likeRe = (p: string) => new RegExp("^" + p.replace(/\\([\\%_])|([.*+?^${}()|[\]])|%|_/g, (m, esc, special) => esc ? esc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : special ? "\\" + special : m === "%" ? ".*" : ".") + "$")
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let projection = "*"
    let lim = Infinity
    const project = (r: Row): Row => {
      if (projection.trim() === "*") return { ...r }
      const o: Row = {}
      for (const part of projection.split(",").map((s) => s.trim()).filter(Boolean)) {
        const [alias, col] = part.includes(":") ? part.split(":").map((s) => s.trim()) : [part, part]
        o[alias] = r[col]
      }
      return o
    }
    const run = () => ({ data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, lim).map(project), error: null })
    const b: any = {
      select: (s = "*") => { projection = s; return b },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return b },
      like: (c: string, p: string) => { const re = likeRe(p); filters.push((r) => typeof r[c] === "string" && re.test(r[c])); return b },
      limit: (n: number) => { lim = n; return b },
      order: () => b,
      maybeSingle: async () => ({ data: run().data[0] ?? null, error: null }),
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    }
    return b
  }
  return { client: { from } as any, tables }
}

// ── the tenant: one brokerage, two offices, two teams; a second brokerage ──────────────────────────────────────────────
const B1 = "b1550000-0000-4000-8000-000000000001", B2 = "b1550000-0000-4000-8000-000000000002"
const LOC1 = "10c10000-0000-4000-8000-000000000001", LOC2 = "10c20000-0000-4000-8000-000000000002"
const TEAM_A = "7ea00000-0000-4000-8000-00000000000a", TEAM_B = "7eb00000-0000-4000-8000-00000000000b"
const U = {
  agentA: "e1550000-0000-4000-8000-0000000000a1", agentB: "e1550000-0000-4000-8000-0000000000b1",
  leadA: "e1550000-0000-4000-8000-0000000000a9", leadB: "e1550000-0000-4000-8000-0000000000b9",
  owner: "e1550000-0000-4000-8000-0000000000f0", adminB2: "e1550000-0000-4000-8000-0000000002f0",
  contactMe: "e1550000-0000-4000-8000-0000000000c1", contactOther: "e1550000-0000-4000-8000-0000000000c2",
  lender: "e1550000-0000-4000-8000-0000000000d1", title: "e1550000-0000-4000-8000-0000000000d2",
  photographer: "e1550000-0000-4000-8000-0000000000d3", stager: "e1550000-0000-4000-8000-0000000000d4",
  noSeat: "e1550000-0000-4000-8000-0000000000ee",
}
const AG = { a: "a1550000-0000-4000-8000-0000000000a1", b: "a1550000-0000-4000-8000-0000000000b1" }
const DEAL_X = "d1550000-0000-4000-8000-00000000000a", DEAL_Y = "d1550000-0000-4000-8000-00000000000b"
const C_ME = "c1550000-0000-4000-8000-0000000000c1", C_OTHER = "c1550000-0000-4000-8000-0000000000c2"

const seat = (id: string, brokerage_id: string, user_type: string) => ({ id, brokerage_id, user_type, status: "active", deleted_at: null })
const ref = (bucket: string, path: string) => toDocumentRef(bucket, path)
const R = {
  dealFile: ref("transaction-documents", `transactions/${DEAL_X}/documents/purchase-agreement.pdf`),
  lenderOwnX: ref("transaction-documents", `transactions/${DEAL_X}/lender/pre-approval.pdf`),
  lenderOwnY: ref("transaction-documents", `transactions/${DEAL_Y}/lender/pre-approval.pdf`),
  cdaX: ref("transaction-documents", `transactions/${DEAL_X}/documents/cda.pdf`),
  photoOwn: ref("transaction-documents", `vendor-jobs/${B1}/${DEAL_X}/photos-1.zip`),
  stagerOwn: ref("transaction-documents", `vendor-jobs/${B1}/${DEAL_X}/staging-plan.pdf`),
  otherContactDoc: ref("client-documents", `contacts/${C_OTHER}/bank-statement.pdf`),
  myContactDoc: ref("client-documents", `contacts/${C_ME}/pre-approval.pdf`),
  leadDeliverable: ref("documents", `client-docs/${B1}/checklist-155.pdf`),
  myContactsReport: ref("documents", `client-docs/${B1}/market_report-155.pdf`),
  license: ref("agent-documents", `${U.agentA}/license/1-license.pdf`),
  receipt: ref("documents", `${B1}/receipts/r-155.pdf`),
  cdaPdf: ref("documents", `${B1}/cda/cda-155.pdf`),
}

const db = memoryDb({
  users: [
    seat(U.agentA, B1, "agent"), seat(U.agentB, B1, "agent"), seat(U.leadA, B1, "team_lead"), seat(U.leadB, B1, "team_lead"),
    seat(U.owner, B1, "broker_owner"), seat(U.adminB2, B2, "broker_owner"), seat(U.contactMe, B1, "contact"), seat(U.contactOther, B1, "contact"),
    seat(U.lender, B1, "vendor"), seat(U.title, B1, "vendor"), seat(U.photographer, B1, "vendor"), seat(U.stager, B1, "vendor"),
  ],
  agents: [
    { id: AG.a, user_id: U.agentA, brokerage_id: B1, team_id: TEAM_A, location_id: LOC1, is_active: true },
    { id: AG.b, user_id: U.agentB, brokerage_id: B1, team_id: TEAM_B, location_id: LOC2, is_active: true },
  ],
  teams: [{ id: TEAM_A, brokerage_id: B1, team_lead_id: U.leadA }, { id: TEAM_B, brokerage_id: B1, team_lead_id: U.leadB }],
  transactions: [
    { id: DEAL_X, brokerage_id: B1, agent_id: AG.a, coordinator_id: null, status: "active", stage: "under_contract", contact_id: C_ME, buyer_contact_id: C_ME, seller_contact_id: null },
    { id: DEAL_Y, brokerage_id: B1, agent_id: AG.a, coordinator_id: null, status: "active", stage: "under_contract", contact_id: null, buyer_contact_id: null, seller_contact_id: null },
  ],
  transaction_coordinators: [], transaction_assignments: [], user_role_assignments: [],
  contacts: [
    { id: C_ME, brokerage_id: B1, contact_user_id: U.contactMe, agent_id: AG.a, avatar_url: null },
    { id: C_OTHER, brokerage_id: B1, contact_user_id: U.contactOther, agent_id: AG.a, avatar_url: null },
  ],
  vendors: [],
  transaction_documents: [
    { id: "td-deal", brokerage_id: B1, transaction_id: DEAL_X, contact_id: null, uploaded_by: U.agentA, client_visible: false, doc_type: "purchase_agreement", metadata: {}, storage_url: R.dealFile },
    { id: "td-lx", brokerage_id: B1, transaction_id: DEAL_X, contact_id: null, uploaded_by: U.lender, client_visible: false, doc_type: "pre_approval", metadata: {}, storage_url: R.lenderOwnX },
    { id: "td-ly", brokerage_id: B1, transaction_id: DEAL_Y, contact_id: null, uploaded_by: U.lender, client_visible: false, doc_type: "pre_approval", metadata: {}, storage_url: R.lenderOwnY },
    { id: "td-cda", brokerage_id: B1, transaction_id: DEAL_X, contact_id: null, uploaded_by: U.owner, client_visible: false, doc_type: "cda", metadata: { delivered_to_title_user_id: U.title }, storage_url: R.cdaX },
    { id: "td-photo", brokerage_id: B1, transaction_id: DEAL_X, contact_id: null, uploaded_by: U.photographer, client_visible: false, doc_type: "listing_photos", metadata: {}, storage_url: R.photoOwn },
    { id: "td-stage", brokerage_id: B1, transaction_id: DEAL_X, contact_id: null, uploaded_by: U.stager, client_visible: false, doc_type: "staging_plan", metadata: {}, storage_url: R.stagerOwn },
  ],
  client_documents: [
    { id: "cd-other", brokerage_id: B1, transaction_id: null, contact_id: C_OTHER, uploaded_by: U.contactOther, client_visible: true, document_url: R.otherContactDoc },
    { id: "cd-me", brokerage_id: B1, transaction_id: null, contact_id: C_ME, uploaded_by: U.agentA, client_visible: true, document_url: R.myContactDoc },
  ],
  offers: [], documents: [], ai_video_projects: [], seller_updates: [], agent_certifications: [], brokerage_forms: [], brokerage_cda_templates: [],
  agent_licenses: [{ id: "lic-1", brokerage_id: B1, agent_id: AG.a, document_url: R.license, eo_certificate_url: null }],
  business_expenses: [{ id: "bx-1", brokerage_id: B1, agent_id: AG.a, receipt_url: R.receipt }],
  closing_disclosure_agreement: [{ id: "cda-1", brokerage_id: B1, transaction_id: null, agent_id: AG.a, generated_pdf_url: R.cdaPdf }],
  generated_documents: [
    // a deliverable a LEAD asked for: brokerage-owned, no agent, no contact (Leads belong to the tenant)
    { id: "gd-lead", brokerage_id: B1, transaction_id: null, contact_id: null, agent_id: null, document_type: "checklist", metadata: { source: "lead_magnet_funnel" }, blob_url: R.leadDeliverable },
    // a report for one of agent A's CONTACTS
    { id: "gd-contact", brokerage_id: B1, transaction_id: null, contact_id: C_ME, agent_id: AG.a, document_type: "market_report", metadata: {}, blob_url: R.myContactsReport },
  ],
})

// The external party's lane per (party, deal): lender and title on X only; photographer and stager assigned to X.
const LANES = new Map<string, Set<string>>([[U.lender, new Set([DEAL_X])], [U.title, new Set([DEAL_X])], [U.photographer, new Set([DEAL_X])], [U.stager, new Set([DEAL_X])]])
const signs: Array<{ bucket: string; path: string; ttl: number }> = []
process.env.SECRETS_ENCRYPTION_KEY = process.env.SECRETS_ENCRYPTION_KEY || "wave155-access-canaries-test-key"
const SEALER = { seal: encryptSecret, open: decryptSecret, isSealed: isEncrypted }

function deps(actor: DocumentDoorActor | null) {
  const rules: DocumentDoorRules = {
    tenantAdminUserTypes: TENANT_ADMIN_USER_TYPES,
    financeReaderUserTypes: new Set([...BROKERAGE_FINANCE_ADMIN_USER_TYPES, "compliance_officer"]),
    clientVisibleDealDocument: isClientVisibleDealDocument,
    dealRead: async (transactionId) => {
      const r = await loadDealWorkAccess(db.client, { userId: actor!.userId, brokerageId: actor!.brokerageId, userType: actor!.userType, transactionId })
      return r.ok ? { ok: true, read: r.access.capabilities.read } : { ok: false, error: r.error }
    },
    partnerLane: async (transactionId) => ({ ok: true, granted: !!actor && (LANES.get(actor.userId)?.has(transactionId) ?? false) }),
  }
  return {
    db: db.client, rules, sealer: SEALER,
    actor: async () => actor ? { ok: true as const, actor } : { ok: false as const, reason: "unauthenticated" as const },
    sign: async (bucket: string, path: string, ttl: number) => { signs.push({ bucket, path, ttl }); return { ok: true as const, url: `https://proj.supabase.co/storage/v1/object/sign/${bucket}/${path}?token=CANARY-${signs.length}`, ttlSeconds: ttl } },
  }
}
const who = (userId: string, userType: string | null, brokerageId = B1): DocumentDoorActor => ({ userId, brokerageId, userType })

/** A refusal: the expected status AND nothing minted. */
async function refused(label: string, actor: DocumentDoorActor | null, r: string, grant?: string, status = 404): Promise<boolean> {
  const before = signs.length
  const a = await openDocumentReference(deps(actor), r, grant)
  const ok = a.status === status && signs.length === before
  if (!ok) console.log(`      (${label}: status ${a.status}, signer calls +${signs.length - before})`)
  return ok
}
/** An open: 302 AND exactly one 5-minute link minted for exactly this object. */
async function opens(label: string, actor: DocumentDoorActor | null, r: string, grant?: string): Promise<boolean> {
  const before = signs.length
  const a = await openDocumentReference(deps(actor), r, grant)
  const s = signs[signs.length - 1]
  const ok = a.status === 302 && signs.length === before + 1 && s.ttl === DOC_VIEW_TTL_SECONDS && r === toDocumentRef(s.bucket, s.path)
  if (!ok) console.log(`      (${label}: status ${a.status}, signer calls +${signs.length - before})`)
  return ok
}

async function main() {
  console.log("\n[EXECUTED · SIMULATED — the real door, the real deal rule, an in-memory database, a counted signer]")

  // 1 · OTHER OFFICE / OTHER TEAM inside one brokerage, no grant
  check("OFFICE/TEAM positive twins: the deal's owning agent (office 1, team A) and team A's lead open the deal file",
    await opens("owner agent", who(U.agentA, "agent"), R.dealFile) && await opens("team A lead", who(U.leadA, "team_lead"), R.dealFile))
  check("OFFICE/TEAM: an agent of ANOTHER office and team, and ANOTHER team's lead, are refused the same file — nothing minted",
    await refused("office-2 agent", who(U.agentB, "agent"), R.dealFile) && await refused("team B lead", who(U.leadB, "team_lead"), R.dealFile))

  // 2 · a Contact asking for ANOTHER Contact's own document
  check("CONTACT positive twin: a contact opens its OWN client-visible document; the other contact opens theirs",
    await opens("own", who(U.contactMe, "contact"), R.myContactDoc) && await opens("theirs", who(U.contactOther, "contact"), R.otherContactDoc))
  check("CONTACT: a contact asking for ANOTHER contact's document (same tenant, same agent) is refused — nothing minted",
    await refused("other contact's", who(U.contactMe, "contact"), R.otherContactDoc))

  // 3 · a vendor OUTSIDE its deal lane; R1 — a deal file it did not upload
  check("VENDOR positive twins: the lender opens its OWN upload on the deal it is laned onto; the title party opens the CDA delivered to it",
    await opens("lender own X", who(U.lender, "vendor"), R.lenderOwnX) && await opens("title cda", who(U.title, "vendor"), R.cdaX))
  check("VENDOR: the lender's OWN upload on a deal it has NO lane onto is refused — nothing minted",
    await refused("lender own Y", who(U.lender, "vendor"), R.lenderOwnY))
  check("R1 VENDOR: a laned lender / title party asking for the deal's purchase agreement it did NOT upload is refused (m888 row rule) — nothing minted",
    await refused("lender deal file", who(U.lender, "vendor"), R.dealFile) && await refused("title deal file", who(U.title, "vendor"), R.dealFile)
    && await refused("lender reads title's cda", who(U.lender, "vendor"), R.cdaX))

  // 4 · an OFF-PLATFORM lender / title party with no seat
  check("NO SEAT: no session and no grant → 401 (the route sends the sign-in page) — nothing minted",
    await refused("anonymous", null, R.lenderOwnX, undefined, 401))
  check("NO SEAT: an account with no users row (the route's actor carries no tenant) is refused — nothing minted; its seated twin opened above",
    await refused("no users row", who(U.noSeat, null, ""), R.lenderOwnX) && await refused("account typed vendor, no row", who(U.noSeat, "vendor"), R.lenderOwnX))

  // 5 · R2 — a REVOKED seat on the NEXT click
  const me = db.tables.users.find((u) => u.id === U.agentA)!
  const myAgent = db.tables.agents.find((a) => a.id === AG.a)!
  const first = await opens("before revocation", who(U.agentA, "agent"), R.dealFile)
  me.status = "inactive"
  const inactive = await refused("inactive", who(U.agentA, "agent"), R.dealFile)
  me.status = "active"; me.deleted_at = "2026-11-19T00:00:00Z"
  const deleted = await refused("soft-deleted", who(U.agentA, "agent"), R.dealFile)
  me.deleted_at = null; myAgent.is_active = false
  const deactivated = await refused("agent deactivated", who(U.agentA, "agent"), R.dealFile)
  myAgent.is_active = true
  const restored = await opens("restored", who(U.agentA, "agent"), R.dealFile)
  check("R2 REVOKED: the same session opens, then is refused on the next click once the seat is inactive, soft-deleted or a deactivated agent — and opens again when restored",
    first && inactive && deleted && deactivated && restored)
  const lenderSeat = db.tables.users.find((u) => u.id === U.lender)!
  lenderSeat.status = "suspended"
  const vendorRevoked = await refused("vendor suspended", who(U.lender, "vendor"), R.lenderOwnX)
  lenderSeat.status = "active"
  check("R2 REVOKED: a suspended vendor seat loses even its OWN upload on the next click (and its twin opened above)", vendorRevoked)

  // 6 · R3 — the photographer / assigned vendor limited to its OWN uploads
  check("PHOTOGRAPHER positive twin: the assigned photographer opens its own delivery on the deal",
    await opens("photographer own", who(U.photographer, "vendor"), R.photoOwn))
  check("R3 PHOTOGRAPHER: the same photographer asking for the STAGER's upload, the deal file, or a contact's document is refused — nothing minted",
    await refused("stager's upload", who(U.photographer, "vendor"), R.stagerOwn) && await refused("deal file", who(U.photographer, "vendor"), R.dealFile)
    && await refused("contact doc", who(U.photographer, "vendor"), R.myContactDoc))

  // 7 · the agent's CONTACTS-ONLY acquisition view — no Lead queue through any document path
  const LEAD_QUEUE = /^(leads?|raw_?leads?|lead_[a-z_]+|isa_[a-z_]*queue[a-z_]*|acquisition_[a-z_]+)$/
  const leadKinds = (kinds: ReadonlyArray<{ table: string }>) => kinds.filter((k) => LEAD_QUEUE.test(k.table)).map((k) => k.table)
  check(`LEADS: no door kind reads a Lead-queue table (${DOCUMENT_DOOR_KINDS.length} kinds: ${[...new Set(DOCUMENT_DOOR_KINDS.map((k) => k.table))].join(", ")})`,
    leadKinds(DOCUMENT_DOOR_KINDS).length === 0, leadKinds(DOCUMENT_DOOR_KINDS).join(", "))
  check("LEADS POSITIVE CONTROL: the finder catches a planted leads / raw_leads / lead_queue kind and passes contacts",
    leadKinds([{ table: "leads" }, { table: "raw_leads" }, { table: "lead_queue" }, { table: "contacts" }]).join() === "leads,raw_leads,lead_queue")
  check("LEADS positive twins: the tenant owner opens the brokerage-owned Lead deliverable; agent A opens the report for its own Contact",
    await opens("owner lead deliverable", who(U.owner, "broker_owner"), R.leadDeliverable) && await opens("agent own contact", who(U.agentA, "agent"), R.myContactsReport))
  check("LEADS: an agent asking for the brokerage-owned Lead deliverable is refused, and another agent is refused agent A's Contact report — nothing minted",
    await refused("agent lead deliverable", who(U.agentA, "agent"), R.leadDeliverable) && await refused("other agent contact report", who(U.agentB, "agent"), R.myContactsReport))

  // 8 · a SHARE GRANT replayed on a custody document
  const g = mintDocumentShareGrant(SEALER, { ref: R.leadDeliverable, purpose: "lead_magnet", brokerageId: B1, rowId: "gd-lead" })
  const grant = g.ok ? g.grant : ""
  const shareUrl = g.ok ? new URL(documentShareUrl(R.leadDeliverable, grant, "https://app.example") ?? "https://x") : null
  check("GRANT positive twin: the lead's own grant opens its deliverable with NO session (a 5-minute link)",
    g.ok && !!shareUrl && await opens("grant on its row", null, shareUrl.searchParams.get("ref") ?? "", shareUrl.searchParams.get("g") ?? ""))
  const custody = [["license", R.license], ["expense receipt", R.receipt], ["CDA pdf", R.cdaPdf], ["contact document", R.otherContactDoc]] as const
  const replays = await Promise.all(custody.map(async ([l, r]) => refused(`grant on ${l}`, null, r, grant)))
  check("GRANT: the same grant replayed on a license, an expense receipt, a CDA and a contact's document is refused with no session — nothing minted",
    replays.every(Boolean))
  check("GRANT: replayed by a signed-in seat of ANOTHER tenant, it falls back to that seat's rule and is refused — nothing minted",
    await refused("tenant B admin with grant", who(U.adminB2, "broker_owner", B2), R.license, grant))

  console.log(`\n${failures === 0 ? "GREEN" : "RED"} — wave155-access-canaries: ${passes} passed, ${failures} failed; signer calls ${signs.length} (SIMULATED)`)
  process.exit(failures === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
