#!/usr/bin/env tsx
/**
 * scripts/subscription-acceptance-guard.ts   (npm run test:subscription-acceptance)   — wave 151, lane 151A
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SUBSCRIPTION AGREEMENT IS ACCEPTED BY THE CORPORATE SUBSCRIBER'S SIGNATORY, OF A HASHED VERSION, LEAVING AN
 * IMMUTABLE RETRIEVABLE COPY — on the m481 survivor, driven on the in-memory client with the REAL rules module
 * (lib/legal/subscription-agreement.ts) and the REAL predicates it composes (lib/auth/resolve-user-role.ts
 * resolveTenantAdmin / resolveBrokerageFinanceAdmin / resolveTenantPrincipalTeamLead, lib/kernel/resolve-user-office.ts
 * resolveViewerHierarchy):
 *
 *   A  SIGNATORY AUTHORITY — a broker owner signs; a compliance officer, an agent, a team lead inside a brokerage and an
 *      office head of a multi-location brokerage are REFUSED by name; a grant-only admin (the ruling's second seat), the
 *      principal lead of a team subscription and a multi-location owner with the leadership grant SIGN; a refused read
 *      refuses (fail closed).
 *   B  VERSION + HASH + EVIDENCE + IMMUTABLE COPY — the hash is over the normalized text (CRLF-insensitive); a draft,
 *      an unapproved or a retired version cannot be accepted; a text that no longer hashes to the recorded version
 *      cannot be accepted; the acceptance row carries version label, hash, the text itself, the signatory record, ip and
 *      user agent; the copy is handed back only when it still hashes (a tampered copy is refused); another tenant's
 *      record is not readable.
 *   C  LIFECYCLE + RE-ACCEPTANCE — a new text is a DRAFT and INACTIVE; a text carrying the draft banner can be neither
 *      approved nor activated; approval needs a note; an unapproved version cannot be activated; editing an active /
 *      approved / accepted text is a NEW version that supersedes (the accepted text is byte-identical afterwards);
 *      activating the new version retires the old and notifies the earlier signer; a name-only edit changes no version.
 *   D  STATIC — m959's line-1 stamp (the rule, not the waypoint), the approval_status CHECK equals the ONE constant, the
 *      draft-is-never-active CHECK, the append-only trigger, the finance-admin INSERT policy, is_active default false;
 *      the tenant door gates on assessSignatoryAuthority + acceptanceRefusal BEFORE its insert, spreads buildAcceptanceRow,
 *      states its execution method and holds no service client; the superadmin door activates through the ONE rule;
 *      the docs/legal census (every packet carries the banner and a Version: line — skipped with a note while the
 *      directory does not exist); the separation census (this module reads no consent / listing / buyer agreement table).
 *
 * BLIND SPOTS: RLS and the trigger are read from m959, not exercised against Postgres (the in-memory client has neither);
 * the session doors are source-read (cookies); storage (the PDF arm) is not modelled — its hash is proven from bytes only.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { createRequire } from "node:module"
import { stripComments, blankStrings } from "./strip-comments"
import { memSupabase, type Row } from "./in-memory-supabase"

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
const _require = createRequire(import.meta.url)
let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// server-only is a no-op here; the rules module constructs no client of its own (the caller's is passed in).
{
  const nodeModule: any = _require("node:module")
  const realLoad = nodeModule._load
  nodeModule._load = function (request: string, ...rest: unknown[]) {
    if (request === "server-only" || /[\\/]node_modules[\\/]server-only[\\/]/.test(request)) return {}
    return realLoad.call(this, request, ...rest)
  }
  const loader = `
export async function resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export%20default%20null" }
  return next(specifier, context)
}`
  const { register } = await import("node:module")
  try { register(`data:text/javascript,${encodeURIComponent(loader)}`) } catch { /* the CJS patch above still holds */ }
}
const L = await import("../lib/legal/subscription-agreement")

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n[A · the signatory — the corporate subscriber's, not any admin seat]")
const B1 = "b1", T1 = "t1", M1 = "m1"
const world = () => memSupabase({
  brokerages: [
    { id: B1, name: "Gulf Shore Brokerage", dba: "Gulf Shore", license_number: "CQ1234", license_state: "FL", plan_tier: "brokerage" },
    { id: T1, name: "Ridge Team", dba: null, license_number: null, license_state: null, plan_tier: "team" },
    { id: M1, name: "Coastal Realty", dba: null, license_number: "CQ9000", license_state: "FL", plan_tier: "multi_location" },
  ],
  users: [
    { id: "owner", brokerage_id: B1, user_type: "broker_owner", email: "owner@gulf.test", location_id: null },
    { id: "compl", brokerage_id: B1, user_type: "compliance_officer", email: "compliance@gulf.test", location_id: null },
    { id: "agent", brokerage_id: B1, user_type: "agent", email: "agent@gulf.test", location_id: null },
    { id: "tl", brokerage_id: B1, user_type: "team_lead", email: "lead@gulf.test", location_id: null },
    { id: "grantadmin", brokerage_id: B1, user_type: "agent", email: "second-seat@gulf.test", location_id: null },
    { id: "lead", brokerage_id: T1, user_type: "team_lead", email: "lead@ridge.test", location_id: null },
    { id: "headA", brokerage_id: M1, user_type: "broker", email: "head.a@coastal.test", location_id: "LA" },
    { id: "ownerM", brokerage_id: M1, user_type: "broker_owner", email: "owner@coastal.test", location_id: null },
  ],
  user_role_assignments: [{ id: "g1", user_id: "grantadmin", role: "admin", brokerage_id: B1, team_id: null }],
  teams: [
    { id: "b1t1", brokerage_id: B1, team_lead_id: "tl", location_id: "L1", deleted_at: null },
    { id: "b1t2", brokerage_id: B1, team_lead_id: "owner", location_id: "L1", deleted_at: null },
    { id: "t1team", brokerage_id: T1, team_lead_id: "lead", location_id: null, deleted_at: null },
  ],
  locations: [
    { id: "L1", brokerage_id: B1, status: "active", managing_broker_user_id: null },
    { id: "LA", brokerage_id: M1, status: "active", managing_broker_user_id: null },
    { id: "LB", brokerage_id: M1, status: "active", managing_broker_user_id: null },
  ],
  organization_members: [
    { id: "om1", brokerage_id: M1, user_id: "headA", scope_kind: "location", location_id: "LA", team_id: null, access_level: "leadership", revoked_at: null },
    { id: "om2", brokerage_id: M1, user_id: "ownerM", scope_kind: "tenant", location_id: null, team_id: null, access_level: "leadership", revoked_at: null },
  ],
  platform_contract_templates: [], tenant_contract_signatures: [], notifications: [], subscriptions: [],
})
const db = world()
const who = (id: string) => { const u = (db as any).tables.users.find((r: Row) => r.id === id); return { user_type: u.user_type, brokerage_id: u.brokerage_id } }
const assess = (id: string) => L.assessSignatoryAuthority(db as never, id, who(id))

const aOwner = await assess("owner")
check("A1 a broker owner of a one-office brokerage SIGNS — basis names the books predicate (user_type) and the tenant view", aOwner.ok && aOwner.authority.authorized && !aOwner.authority.multiLocation && aOwner.authority.basis.some((b) => /books via user_type/.test(b)), JSON.stringify(aOwner))
const aCompl = await assess("compl")
check("A2 NEGATIVE — a compliance officer is a tenant admin (floor passes) yet CANNOT sign: refused by name (reads the books, does not keep them)", aCompl.ok && !aCompl.authority.authorized && /compliance officer/i.test(aCompl.authority.refusal ?? "") && aCompl.authority.basis.some((b) => /tenant admin via user_type/.test(b)), JSON.stringify(aCompl))
const aAgent = await assess("agent")
check("A3 NEGATIVE — an agent seat is refused at the floor (not a tenant admin at all)", aAgent.ok && !aAgent.authority.authorized && /admins can sign/.test(aAgent.authority.refusal ?? ""))
const aTl = await assess("tl")
check("A4 NEGATIVE — a team lead INSIDE a brokerage (two teams, brokerage tier) is refused: not a finance admin, not the tenant's principal", aTl.ok && !aTl.authority.authorized && /team lead inside a brokerage/.test(aTl.authority.refusal ?? ""), JSON.stringify(aTl))
const aGrant = await assess("grantadmin")
check("A5 the ruling's SECOND SEAT — an agent-typed account holding a tenant-pinned 'admin' grant SIGNS for a one-office brokerage (books via grant)", aGrant.ok && aGrant.authority.authorized && aGrant.authority.basis.some((b) => /books via grant/.test(b)), JSON.stringify(aGrant))
const aLead = await assess("lead")
check("A6 the principal lead of a TEAM subscription (one team, led by them, plan_tier team) SIGNS — books via tenant_principal (m526)", aLead.ok && aLead.authority.authorized && aLead.authority.basis.some((b) => /books via tenant_principal/.test(b)), JSON.stringify(aLead))
const aHead = await assess("headA")
check("A7 NEGATIVE — an OFFICE HEAD of a multi-location brokerage (broker, office leadership only) is refused: an office head signs for no one but their office", aHead.ok && !aHead.authority.authorized && aHead.authority.multiLocation && /several locations/.test(aHead.authority.refusal ?? ""), JSON.stringify(aHead))
const aOwnerM = await assess("ownerM")
check("A8 the multi-location owner holding the TENANT LEADERSHIP grant SIGNS (hierarchy tenant — every office)", aOwnerM.ok && aOwnerM.authority.authorized && aOwnerM.authority.multiLocation && aOwnerM.authority.basis.some((b) => /every office/.test(b)), JSON.stringify(aOwnerM))
{
  const refused = memSupabase({ ...(db as any).tables }, { refuse: { organization_members: "permission denied (fixture)" } })
  const r = await L.assessSignatoryAuthority(refused as never, "ownerM", who("ownerM"))
  check("A9 FAIL CLOSED — a refused memberships read refuses the authority question (never 'authorized', never 'not authorized')", !r.ok && /could not be read/.test(r.error))
  const noTenant = await L.assessSignatoryAuthority(db as never, "owner", { user_type: "broker_owner", brokerage_id: null })
  check("A10 an account with no brokerage has no one to sign for", noTenant.ok && !noTenant.authority.authorized && /No brokerage/.test(noTenant.authority.refusal ?? ""))
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n[B · version + hash + evidence + the immutable, retrievable copy]")
const BODY = "# VIPAgents Platform Subscription and Services Agreement\n\nVersion: 1.0.0\nStatus: APPROVED — owner and counsel 2026-11-20\n\n1. Services. The platform provides …\n2. Seats. The subscription tier determines the seat cap …\n"
const HASH = L.agreementContentHash(BODY)
check("B1 the content hash is over the NORMALIZED text: CRLF, trailing spaces and surrounding whitespace do not change it; one changed character does", /^[0-9a-f]{64}$/.test(HASH) && L.agreementContentHash(BODY.replace(/\n/g, "\r\n") + "\n\n") === HASH && L.agreementContentHash(BODY.replace(/\n/g, "  \n")) === HASH && L.agreementContentHash(BODY.replace("1.0.0", "1.0.1")) !== HASH)
check("B2 the draft banner is read in every spelling (em dash, en dash, hyphen, case, line breaks) and absent text is not a draft",
  L.isDraftMarked(`x\n${L.DRAFT_BANNER}\ny`) && L.isDraftMarked("draft - owner and qualified legal counsel review - not approved for use") && L.isDraftMarked("DRAFT – OWNER AND QUALIFIED LEGAL COUNSEL REVIEW –\nNOT APPROVED FOR USE") && !L.isDraftMarked(BODY) && !L.isDraftMarked(null))
const active = { id: "tpl-a", version: 2, version_label: "1.0.0", content_sha256: HASH, approval_status: "approved", body_text: BODY, body_storage_path: null, is_active: true }
check("B3 only the ACTIVE, APPROVED, banner-free, hashed version is acceptable: retired / draft-status / banner-in-body / missing-hash are each refused by name",
  L.acceptanceRefusal(active) === null && /no longer the active version/.test(L.acceptanceRefusal({ ...active, is_active: false }) ?? "") && /not been recorded as approved/.test(L.acceptanceRefusal({ ...active, approval_status: "draft" }) ?? "")
    && /draft banner/.test(L.acceptanceRefusal({ ...active, body_text: `${L.DRAFT_BANNER}\n${BODY}` }) ?? "") && /content hash/.test(L.acceptanceRefusal({ ...active, content_sha256: null }) ?? "") && /no longer the active version/.test(L.acceptanceRefusal(null) ?? ""))
const authority = (aOwner.ok ? aOwner.authority : { authorized: true, basis: [], refusal: null, multiLocation: false })
const built = L.buildAcceptanceRow({ template: active, signedName: "Jane Owner", signedTitle: "Broker of Record", signer: { id: "owner", email: "owner@gulf.test", userType: "broker_owner" }, authority, legalEntity: { name: "Gulf Shore Brokerage", dba: "Gulf Shore", licenseNumber: "CQ1234", licenseState: "FL" }, ip: "203.0.113.9", userAgent: "proof/1", now: new Date("2026-11-21T10:00:00Z") })
check("B4 the acceptance row carries version label, hash, the text itself, the signatory (account, typed name + title, legal entity, authority basis), ip and user agent, and the in-app execution method",
  built.ok && built.row.content_sha256 === HASH && built.row.version_label === "1.0.0" && built.row.template_version === 2 && built.row.accepted_body_text === BODY && built.row.accepted_document_path === null
    && (built.row.signatory as any).user_id === "owner" && (built.row.signatory as any).typed_title === "Broker of Record" && (built.row.signatory as any).legal_entity.licenseNumber === "CQ1234" && Array.isArray((built.row.signatory as any).authority_basis)
    && built.row.accepted_ip === "203.0.113.9" && built.row.accepted_user_agent === "proof/1" && (built.row.signature as any).method === "in_app_click_to_sign" && (built.row.signature as any).content_sha256 === HASH, built.ok ? "" : built.error)
const mismatch = L.buildAcceptanceRow({ template: { ...active, content_sha256: "deadbeef" }, signedName: "Jane Owner", signedTitle: null, signer: { id: "owner", email: null, userType: "broker_owner" }, authority, legalEntity: null, ip: null, userAgent: null })
check("B5 NEGATIVE — a text that no longer hashes to the recorded version cannot be accepted (what is accepted is what was hashed)", !mismatch.ok && /content hash mismatch/.test(mismatch.error))
const blank = L.buildAcceptanceRow({ template: active, signedName: "   ", signedTitle: null, signer: { id: "owner", email: null, userType: "broker_owner" }, authority, legalEntity: null, ip: null, userAgent: null })
check("B5b NEGATIVE — an empty typed name is refused", !blank.ok && /Type your full name/.test(blank.error))
const pdf = L.buildAcceptanceRow({ template: { ...active, body_text: null, body_storage_path: "platform/platform-contracts/a.pdf", content_sha256: "a".repeat(64) }, signedName: "Jane Owner", signedTitle: null, signer: { id: "owner", email: null, userType: "broker_owner" }, authority, legalEntity: null, ip: null, userAgent: null })
check("B6 the stored-document arm: the acceptance carries the document path + its bytes' hash and no text copy", pdf.ok && pdf.row.accepted_document_path === "platform/platform-contracts/a.pdf" && pdf.row.accepted_body_text === null && pdf.row.content_sha256 === "a".repeat(64))
;(db as any).tables.platform_contract_templates.push({ ...active, name: "Platform Subscription Agreement", contract_type: "subscription_agreement" })
;(db as any).tables.tenant_contract_signatures.push({ id: "sig1", brokerage_id: B1, template_id: "tpl-a", signed_by: "owner", signed_at: "2026-11-21T10:00:00.000Z", ...(built.ok ? built.row : {}) })
const copy = await L.readAcceptedCopy(db as never, { signatureId: "sig1", brokerage_id: B1 })
check("B7 the accepted copy is RETRIEVABLE: provenance header (subscriber, signer + title, time, version, hash, record id) then the text verbatim; a markdown file named by version and date",
  copy.ok && copy.copy.body.includes(BODY) && /Gulf Shore Brokerage \(DBA Gulf Shore\)/.test(copy.copy.body) && /Jane Owner, Broker of Record/.test(copy.copy.body) && copy.copy.body.includes(HASH) && copy.copy.body.includes("sig1") && /^subscription-agreement-1\.0\.0-accepted-2026-11-21\.md$/.test(copy.copy.fileName) && copy.copy.contentType === "text/markdown", copy.ok ? copy.copy.fileName : copy.error)
const cross = await L.readAcceptedCopy(db as never, { signatureId: "sig1", brokerage_id: T1 })
check("B8 NEGATIVE — another tenant cannot read this acceptance (the tenant pin on the read)", !cross.ok && /No such acceptance/.test(cross.error))
{
  const row = (db as any).tables.tenant_contract_signatures.find((r: Row) => r.id === "sig1")
  const original = row.accepted_body_text
  row.accepted_body_text = original + "\n3. An added clause."
  const tampered = await L.readAcceptedCopy(db as never, { signatureId: "sig1", brokerage_id: B1 })
  row.accepted_body_text = original
  const restored = await L.readAcceptedCopy(db as never, { signatureId: "sig1", brokerage_id: B1 })
  check("B9 INTEGRITY — a stored copy that no longer hashes to the recorded version is REFUSED, never served as the contract; the untouched copy is served again", !tampered.ok && /no longer matches/.test(tampered.error) && restored.ok)
  const noHash = { ...row, id: "sig-old", content_sha256: null }
  ;(db as any).tables.tenant_contract_signatures.push(noHash)
  const old = await L.readAcceptedCopy(db as never, { signatureId: "sig-old", brokerage_id: B1 })
  check("B10 a pre-m959 acceptance with no hash is reported as unverifiable, not invented", !old.ok && /no content hash/.test(old.error))
}
{
  const refusedRead = memSupabase({ ...(db as any).tables }, { refuse: { tenant_contract_signatures: "permission denied (fixture)" } })
  const r = await L.readAcceptedCopy(refusedRead as never, { signatureId: "sig1", brokerage_id: B1 })
  check("B11 FAIL CLOSED — a refused acceptance read is a refusal, never 'no record'", !r.ok && /Could not read/.test(r.error))
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n[C · the version lifecycle — draft → approved → active → superseded → re-accepted]")
const db2 = memSupabase({ platform_contract_templates: [], tenant_contract_signatures: [], notifications: [], users: [{ id: "sa", email: "staff@platform.test", platform_role: "superadmin" }, { id: "ux", brokerage_id: "bx", email: "ux@x.test" }], brokerages: [{ id: "bx", name: "X Realty", plan_tier: "brokerage" }] }, { uuidIds: true })
const tpls = () => (db2 as any).tables.platform_contract_templates as Row[]
const DRAFT_TEXT = `# Platform Subscription and Services Agreement\n\n> ${L.DRAFT_BANNER}\n\n**Version:** 0.1.0\n**Status:** ${L.DRAFT_BANNER}\n\n1. Services …\n`
const CLEAN_V1 = "# Platform Subscription and Services Agreement\n\nVersion: 1.0.0\nStatus: Approved by the owner and counsel, 2026-11-20\n\n1. Services …\n"
const CLEAN_V2 = "# Platform Subscription and Services Agreement\n\nVersion: 1.1.0\nStatus: Approved by the owner and counsel, 2026-12-01\n\n1. Services …\n2. Seats …\n"
const r1 = await L.reviseSubscriptionTemplate(db2 as never, { name: "Platform Subscription Agreement", bodyText: DRAFT_TEXT, actorUserId: "sa" })
const t1 = r1.ok ? tpls().find((t) => t.id === r1.id)! : null
check("C1 a new text is a DRAFT, INACTIVE, hashed, version 1, its version label read from the document's own Version: line, and the banner is reported", r1.ok && r1.created && r1.version === 1 && r1.draftMarked && r1.versionLabel === "0.1.0" && !!t1 && t1.is_active === false && t1.approval_status === "draft" && t1.content_sha256 === L.agreementContentHash(DRAFT_TEXT) && t1.version_label === "0.1.0", r1.ok ? "" : r1.error)
const approveDraft = r1.ok ? await L.approveSubscriptionTemplate(db2 as never, { templateId: r1.id, actorUserId: "sa", note: "owner 2026-11-20" }) : { ok: false, error: "no template" }
const activateDraft = r1.ok ? await L.activateSubscriptionTemplate(db2 as never, { templateId: r1.id, actorUserId: "sa" }) : { ok: false, error: "no template" }
check("C2 NEGATIVE — a text carrying the draft banner can be neither recorded as approved nor made active (both refusals name the banner); nothing changed", !approveDraft.ok && /draft banner/.test(approveDraft.error) && !activateDraft.ok && /draft banner/.test(activateDraft.error) && t1?.approval_status === "draft" && t1?.is_active === false)
const r2 = r1.ok ? await L.reviseSubscriptionTemplate(db2 as never, { id: r1.id, name: "Platform Subscription Agreement", bodyText: CLEAN_V1, actorUserId: "sa" }) : { ok: false as const, error: "no template" }
// The door stores the TRIMMED text (surrounding whitespace is not a term); identity is the normalized hash.
const sameText = (stored: unknown, want: string) => typeof stored === "string" && stored === want.trim() && L.agreementContentHash(stored) === L.agreementContentHash(want)
check("C3 editing an unaccepted inactive draft happens IN PLACE: same row, version 2, banner gone, label 1.0.0, still a draft", r2.ok && !r2.created && r2.id === (r1.ok ? r1.id : "") && r2.version === 2 && r2.plan === "in_place" && r2.bodyChanged && !r2.draftMarked && r2.versionLabel === "1.0.0" && t1?.approval_status === "draft" && sameText(t1?.body_text, CLEAN_V1), r2.ok ? JSON.stringify({ st: t1?.approval_status, same: sameText(t1?.body_text, CLEAN_V1) }) : r2.error)
const activateUnapproved = r1.ok ? await L.activateSubscriptionTemplate(db2 as never, { templateId: r1.id, actorUserId: "sa" }) : { ok: false, error: "x" }
const approveNoNote = r1.ok ? await L.approveSubscriptionTemplate(db2 as never, { templateId: r1.id, actorUserId: "sa", note: "  " }) : { ok: false, error: "x" }
const approved = r1.ok ? await L.approveSubscriptionTemplate(db2 as never, { templateId: r1.id, actorUserId: "sa", note: "Approved by the owner and outside counsel, 2026-11-20 (ref LGL-7)" }) : { ok: false, error: "x" }
check("C4 an UNAPPROVED version cannot be made active; approval needs a note naming who/when; with the note the approval is RECORDED (status, approver, time, note)",
  !activateUnapproved.ok && /not been recorded as approved/.test(activateUnapproved.error) && !approveNoNote.ok && /Name the approval/.test(approveNoNote.error) && approved.ok && t1?.approval_status === "approved" && t1?.approved_by === "sa" && !!t1?.approved_at && /LGL-7/.test(String(t1?.approval_note)))
const act1 = r1.ok ? await L.activateSubscriptionTemplate(db2 as never, { templateId: r1.id, actorUserId: "sa" }) : { ok: false as const, error: "x" }
check("C5 the approved version becomes ACTIVE (nothing to retire, nobody to notify yet)", act1.ok && act1.retired === 0 && act1.reacceptanceNotified === 0 && t1?.is_active === true, act1.ok ? "" : act1.error)
// A tenant accepts v2.
;(db2 as any).tables.tenant_contract_signatures.push({ id: "sx", brokerage_id: "bx", template_id: r1.ok ? r1.id : "", signed_by: "ux", signed_at: "2026-11-22T00:00:00.000Z", template_version: 2, content_sha256: t1?.content_sha256, accepted_body_text: CLEAN_V1, signatory: { user_id: "ux" } })
const attachOnAccepted = r1.ok ? L.templateActivationRefusal({ ...t1 }) : "x"
check("C6 an ACTIVE + APPROVED + ACCEPTED version activates cleanly (no blocker) — the fact the superadmin door reads to disable its buttons", attachOnAccepted === null)
const r3 = r1.ok ? await L.reviseSubscriptionTemplate(db2 as never, { id: r1.id, name: "Platform Subscription Agreement", bodyText: CLEAN_V2, actorUserId: "sa" }) : { ok: false as const, error: "x" }
const t3 = r3.ok ? tpls().find((t) => t.id === r3.id) : undefined
check("C7 editing an ACTIVE / APPROVED / ACCEPTED text is a NEW VERSION: a new row (v3, supersedes v2, draft, inactive, label 1.1.0); the accepted v2 text is byte-identical and still active",
  r3.ok && r3.created && r3.plan === "new_version" && r3.supersededId === (r1.ok ? r1.id : "") && r3.version === 3 && !!t3 && t3.supersedes_template_id === (r1.ok ? r1.id : "") && t3.approval_status === "draft" && t3.is_active === false && t3.version_label === "1.1.0"
    && sameText(t1?.body_text, CLEAN_V1) && t1?.is_active === true && t1?.content_sha256 === L.agreementContentHash(CLEAN_V1), r3.ok ? JSON.stringify({ plan: r3.plan, v: r3.version, t3: !!t3, same: sameText(t1?.body_text, CLEAN_V1) }) : r3.error)
const actDraft3 = r3.ok ? await L.activateSubscriptionTemplate(db2 as never, { templateId: r3.id, actorUserId: "sa" }) : { ok: false as const, error: "x" }
const approve3 = r3.ok ? await L.approveSubscriptionTemplate(db2 as never, { templateId: r3.id, actorUserId: "sa", note: "Approved by the owner and counsel, 2026-12-01" }) : { ok: false as const, error: "x" }
const act3 = r3.ok ? await L.activateSubscriptionTemplate(db2 as never, { templateId: r3.id, actorUserId: "sa" }) : { ok: false as const, error: "x" }
const notes = (db2 as any).tables.notifications as Row[]
check("C8 RE-ACCEPTANCE: the new version cannot be activated as a draft; approved then activated it RETIRES v2 and NOTIFIES the brokerage that accepted v2 (its signer, once); v3 holds no acceptance from that brokerage",
  !actDraft3.ok && act3.ok && act3.retired === 1 && act3.reacceptanceNotified === 1 && act3.notifyErrors.length === 0 && t1?.is_active === false && t3?.is_active === true
    && notes.filter((n) => n.type === "subscription_agreement_reacceptance" && n.user_id === "ux" && n.brokerage_id === "bx").length === 1
    && !(db2 as any).tables.tenant_contract_signatures.some((s: Row) => s.brokerage_id === "bx" && s.template_id === (r3.ok ? r3.id : "")), act3.ok ? JSON.stringify(act3) : act3.error)
const rename = r3.ok ? await L.reviseSubscriptionTemplate(db2 as never, { id: r3.id, name: "VIPAgents Subscription Agreement", bodyText: CLEAN_V2, actorUserId: "sa" }) : { ok: false as const, error: "x" }
check("C9 a NAME-ONLY edit of the active version changes no version, no hash, no approval and no activity (in place, bodyChanged false)", rename.ok && !rename.created && !rename.bodyChanged && rename.version === 3 && t3?.name === "VIPAgents Subscription Agreement" && t3?.approval_status === "approved" && t3?.is_active === true, rename.ok ? "" : rename.error)
check("C10 POSITIVE CONTROL — a row whose status says approved but whose body carries the banner is STILL refused activation (the banner is read from the text, not trusted from the status)", /draft banner/.test(L.templateActivationRefusal({ approval_status: "approved", body_text: `${L.DRAFT_BANNER}\n${CLEAN_V2}`, body_storage_path: null, content_sha256: "x" }) ?? ""))
check("C11 activating a second approved version again retires the current one (one active at a time)", (await L.activateSubscriptionTemplate(db2 as never, { templateId: r1.ok ? r1.id : "", actorUserId: "sa" })).ok && t1?.is_active === true && t3?.is_active === false)
{
  const refusedTpl = memSupabase({ ...(db2 as any).tables }, { refuse: { platform_contract_templates: "permission denied (fixture)" } })
  const a = await L.activateSubscriptionTemplate(refusedTpl as never, { templateId: r1.ok ? r1.id : "", actorUserId: "sa" })
  const p = await L.approveSubscriptionTemplate(refusedTpl as never, { templateId: r1.ok ? r1.id : "", actorUserId: "sa", note: "x" })
  const v = await L.reviseSubscriptionTemplate(refusedTpl as never, { id: r1.ok ? r1.id : "", name: "n", bodyText: CLEAN_V2, actorUserId: "sa" })
  check("C12 FAIL CLOSED — a refused template read refuses activate / approve / revise alike (never acts on 'not found')", !a.ok && !p.ok && !v.ok && [a, p, v].every((x) => /permission denied/.test(x.ok ? "" : x.error)))
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n[D · static — m959, the doors, docs/legal, separation]")
const m959 = read("supabase/migrations/m959-subscription-agreement-acceptance-is-a-corporate-act-with-an-immutable-copy.sql")
const sql = m959.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
check("D1 m959 line 1 is the lane stamp OR the APPLIED LIVE stamp (the rule, not the waypoint)", /^-- (WRITTEN, NOT APPLIED \(wave 151, lane 151A\)|── APPLIED LIVE )/.test(m959.split("\n")[0]))
const checkList = (name: string) => { const m = new RegExp(`${name}[\\s\\S]*?in \\(([^)]*)\\)`).exec(sql); return m ? m[1].split(",").map((s) => s.trim().replace(/'/g, "")) : [] }
check("D2 ONE vocabulary: the approval_status CHECK equals AGREEMENT_APPROVAL_STATUSES (code constant), and a draft is never active (CHECK), and is_active defaults false",
  checkList("platform_contract_templates_approval_status_check").join() === L.AGREEMENT_APPROVAL_STATUSES.join() && /\(not is_active\) or approval_status = 'approved'/.test(sql) && /alter column is_active set default false/.test(sql), checkList("platform_contract_templates_approval_status_check").join())
check("D3 m959 makes the acceptance APPEND-ONLY (BEFORE UPDATE OR DELETE trigger, RI-nested passes) and re-pins the INSERT policy to is_brokerage_finance_admin() + the tenant",
  /before update or delete on public\.tenant_contract_signatures/.test(sql) && /pg_trigger_depth\(\) > 1/.test(sql) && /raise exception 'tenant_contract_signatures % is append-only/.test(sql)
    && /create policy tenant_contract_signatures_insert[\s\S]*?public\.is_brokerage_finance_admin\(\)[\s\S]*?brokerage_id = public\.current_user_brokerage_id\(\)/.test(sql) && /cmd in \('UPDATE', 'DELETE'\)/.test(sql))
check("D4 m959 adds the evidence columns the code writes (both tables) and no DROP INDEX / DROP COLUMN (owner SQL)", ["version_label", "content_sha256", "accepted_body_text", "accepted_document_path", "signatory", "accepted_ip", "accepted_user_agent"].every((c) => sql.includes(`add column if not exists ${c}`)) && ["approval_status", "approved_by", "supersedes_template_id", "source_path"].every((c) => sql.includes(`add column if not exists ${c}`)) && !/drop (index|column)/i.test(sql))
const door = stripComments(read("app/actions/admin/subscription-agreement.ts"))
const signFn = door.slice(door.indexOf("export async function signSubscriptionAgreementAction"), door.indexOf("export async function downloadAcceptedAgreementAction"))
/** PURE — the sign door's order: floor gate → corporate authority → acceptance refusal → the built row spread into the insert. */
const gatedDoor = (src: string) => {
  const i = (s: string) => src.indexOf(s)
  return i("resolveTenantAdmin(") > -1 && i("assessSignatoryAuthority(") > i("resolveTenantAdmin(") && i("acceptanceRefusal(") > i("assessSignatoryAuthority(") && i("buildAcceptanceRow(") > i("acceptanceRefusal(") && i(".insert(") > i("buildAcceptanceRow(") && /\.\.\.built\.row/.test(src) && /method: "in_app_click_to_sign"/.test(src)
}
check("D5 the tenant sign door gates in order (tenant admin floor → corporate signatory → acceptable version → built row) BEFORE its insert, spreads the built row, states its execution method, and holds no service client",
  gatedDoor(signFn) && !/createServiceClient/.test(door) && /from "@\/lib\/supabase\/server"/.test(door))
check("D5 POSITIVE CONTROL — a door that inserted before the authority check, or without the built row, is caught", !gatedDoor(signFn.replace(".insert(", "").replace("...built.row", "")) && !gatedDoor(signFn.replace("assessSignatoryAuthority(", "")))
check("D6 the view says who may sign (canSign / signRefusal), re-opens on a new active version (awaitingSignature = no acceptance of the active template) and lists prior acceptances", /canSign/.test(door) && /signRefusal/.test(door) && /awaitingSignature: !signature/.test(door) && /priorAcceptances/.test(door))
const staff = stripComments(read("app/actions/superadmin/subscription-contracts.ts"))
check("D7 the superadmin door revises / approves / activates through the ONE rules module and hashes an attached document's bytes before the row claims it; it never inserts an active template",
  /reviseSubscriptionTemplate\(svc/.test(staff) && /approveSubscriptionTemplate\(svc/.test(staff) && /activateSubscriptionTemplate\(svc/.test(staff) && /agreementBytesHash\(/.test(staff) && !/is_active:\s*true/.test(blankStrings(staff)) && /export async function approveSubscriptionContractTemplateAction/.test(staff))
const lib = stripComments(read("lib/legal/subscription-agreement.ts"))
/** PURE — every INSERT payload on platform_contract_templates (stripped source): each must start the row inactive and as a draft. */
const templateInserts = (src: string) => [...src.matchAll(/from\("platform_contract_templates"\)\.insert\(\{([\s\S]*?)\}\)\.select/g)].map((m) => m[1])
const inserts = templateInserts(lib)
check("D7b the rules module's template INSERTs (both of them) start the row INACTIVE and as a DRAFT — activation is a separate, gated act", inserts.length === 2 && inserts.every((p) => /is_active:\s*false/.test(p) && /approval_status:\s*"draft"/.test(p) && !/is_active:\s*true/.test(p)), `${inserts.length} inserts`)
check("D7b POSITIVE CONTROL — an insert that started a template active is caught", !templateInserts(`svc.from("platform_contract_templates").insert({ name, is_active: true, approval_status: "draft" }).select("id")`).every((p) => /is_active:\s*false/.test(p)))
const card = stripComments(read("app/dashboard/admin/billing/subscription-agreement-card.tsx"))
const manager = stripComments(read("app/dashboard/superadmin/contracts/subscription-contracts-manager.tsx"))
check("D8 the surfaces: the tenant card signs with a title, shows the refusal when not the signatory and downloads the copy; the staff manager records approval and disables activation on the blocker",
  /signedTitle/.test(card) && /signRefusal/.test(card) && /downloadAcceptedAgreementAction/.test(card) && /approveSubscriptionContractTemplateAction/.test(manager) && /activation_blocker/.test(manager) && /draftBanner/.test(manager))
// SEPARATION: the tenant SaaS contract reads no consent / listing / purchase / referral agreement table.
const SEPARATE = ["privacy_acceptances", "contact_consents", "consent_records", "listing_agreements", "buyer_broker_agreements", "referral_agreements", "contract_signatures\"", "platform_tos_acceptances"]
check("D9 SEPARATION — the acceptance module and both doors read none of the consent / listing / buyer / referral / ToS tables", SEPARATE.every((t) => !new RegExp(`from\\("${t.replace(/"/g, "")}"\\)`).test(lib + door + staff)))
check("D9 POSITIVE CONTROL — the separation finder catches a consent-table read", SEPARATE.some((t) => new RegExp(`from\\("${t.replace(/"/g, "")}"\\)`).test(`svc.from("privacy_acceptances").select("id")`)))
// docs/legal census (lane 151A2's packets): every markdown file carries the draft banner and a Version: line.
{
  const dir = join(ROOT, "docs/legal")
  const walk = (d: string, out: string[] = []): string[] => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p, out); else if (/\.md$/i.test(e)) out.push(p) } return out }
  // The version line as the rules module reads it (reviseSubscriptionTemplate's versionLabel comes from the same parse): a quick local read.
  const versionOf = (md: string) => { const v = (/^[>*_\-|\s]*\**\s*version\s*\**\s*[:：]\s*\**\s*(?:\|\s*)?\**\s*([^|\n]+?)\s*\**\s*(?:\|.*)?$/im.exec(md)?.[1] ?? "").replace(/^\*+|\*+$/g, "").trim(); return v || null }
  if (!existsSync(dir)) {
    console.log("  · docs/legal does not exist at this HEAD (lane 151A2 writes it) — the census is SKIPPED, not passed; the positive controls below prove the finders")
  } else {
    const files = walk(dir)
    const bad = files.filter((f) => { const md = readFileSync(f, "utf8"); return !L.isDraftMarked(md) || !versionOf(md) }).map((f) => f.slice(ROOT.length + 1))
    check(`D10 docs/legal census — ${files.length} packet file(s): every one carries the draft banner and a Version: line`, files.length > 0 && bad.length === 0, bad.join(", ") || "no files")
  }
  const specimen = `# Packet\n\n> ${L.DRAFT_BANNER}\n\n| Field | Value |\n|---|---|\n| **Version:** | 0.1.0 |\n`
  check("D10 POSITIVE CONTROL — the census finders read the banner and a table-form Version: line, and reject a file with neither", L.isDraftMarked(specimen) && versionOf(specimen) === "0.1.0" && versionOf("**Version:** 2.3.4\n") === "2.3.4" && !L.isDraftMarked("# Final\nVersion: 1.0.0") && versionOf("# No header\n") === null)
  const viaRules = await L.reviseSubscriptionTemplate(memSupabase({ platform_contract_templates: [] }, { uuidIds: true }) as never, { name: "Packet", bodyText: specimen, actorUserId: "sa" })
  check("D10 the rules module reads the SAME header: a pasted packet lands as a draft with its own version label and the banner reported", viaRules.ok && viaRules.versionLabel === "0.1.0" && viaRules.draftMarked)
}

console.log("\n[blind spots]")
console.log("  · RLS (the finance-admin INSERT policy) and the append-only trigger are read from m959 — the in-memory client has neither; the live twin of the app rule is public.is_brokerage_finance_admin() (read live 2026-11-09)")
console.log("  · the session doors are source-read (cookies); the Stripe-side 'tech fee' and the ToS click (platform_tos_acceptances) are other rails by design")
console.log("  · the PDF arm's bytes hash is proven from bytes only — storage download is not modelled here")
console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
if (fail) { console.log("FAILURES:\n  - " + fails.join("\n  - ")); process.exit(1) }
