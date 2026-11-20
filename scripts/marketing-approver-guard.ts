#!/usr/bin/env tsx
/**
 * scripts/marketing-approver-guard.ts — WHO MAY APPROVE MARKETING (wave 155, lane 155D; owner ruling R7: "an approver should
 * be compliance, tc, team lead and admin. if the office is sending marketing for the brokerage or team then they need
 * access."; eval SCOPE-005, PRIV-002; directive D3 / D4).   npm run test:marketing-approver
 *
 *   1  EACH APPROVER, IN SCOPE AND OUT: the assigned compliance officer, the assigned TC, the team lead, an office admin, the
 *      tenant leadership and the owner each approve within their business scope and are each REFUSED outside it — executed
 *      through requireMarketingApprover (lib/kernel/approval-authority.ts), the check approveAsset / rejectAsset call.
 *   2  SCOPE-005 / PRIV-002: office 2's broker can neither see nor approve office 1's piece; the C5 publish door
 *      (requirePublishApprover — social posts, ad creatives, audiences) is narrowed the same way. CONTROL: the unchanged C5
 *      decision (approverFor) still lists office 2's broker — the narrowing is what refuses (this is what was red at 9d9626b9).
 *   3  THE DELEGATED OFFICE: a grant on the delegate's tenant / team membership (organization_members.permissions) lets an
 *      office approve and prepare for the brokerage or ONE team, with the principal's brand, sender and return address
 *      (resolveActingSender); a location membership alone confers nothing; another office is refused; a revoked membership ends it.
 *   4  FIVE AUTHORITIES, SEPARATE: content / compliance / render proof / spend / legal never stand in for one another.
 *   5  VERSIONS: editing an approved version RE-OPENS its approval (catalog readback); inheritance only on identical scope + version.
 *   6  THE WRITERS: approveAsset / rejectAsset / createAsset / the delegation doors call the authority (stripped source).
 * Every execution proof is SIMULATED (scripts/in-memory-supabase.ts; no provider, no network).
 * BLIND SPOTS (published): the facts loader caps assigned contacts / deals at 2000 and the catalog's or-filter at 200 (a larger
 * assignment under-reports, never over-reports); a pre-wave-155 approval carries no stamp, so its staleness is unknown and it
 * stays approved; the delegation writer needs a session, so its stored shape is seeded exactly as it writes it and the writer's
 * source is checked statically.
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import {
  requireMarketingApprover, requirePublishApprover, approverFor, decideMarketingApproval, loadMarketingApproverFacts, approvalInherits,
  approvalFingerprint, marketingAssetFingerprint, marketingScopeKey, parseMarketingDelegation, resolveActingSender,
  MARKETING_APPROVAL_AUTHORITIES, MARKETING_AUTHORITY_KEYS, MARKETING_DELEGATION_KEY, type MarketingAuthority,
} from "../lib/kernel/approval-authority"
import { resolveCatalogViewer, readContentCatalog, planContentAction } from "../lib/marketing/content-catalog"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const src = (p: string) => readFileSync(join(root, p), "utf8")
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) } else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const U = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`
const now = "2026-11-19T12:00:00.000Z"
const B = "bM"
const A1 = U(1), A2 = U(2), ABRK = U(3), ATEAM = U(4), ATEAM2 = U(5), SP1 = U(6), C1 = U(10), C2 = U(11)

function db(opts: { policy?: boolean } = {}) {
  return memSupabase({
    brokerages: [{ id: B, plan_tier: "multi_location", name: "Harbor Realty Group", dba: "Harbor Realty", address: "1 Harbor Way", city: "Bayside", state: "FL", zip: "32501" }, { id: "bX", plan_tier: "solo_agent", name: "Other" }],
    locations: [
      { id: "oM1", brokerage_id: B, status: "active", managing_broker_user_id: null, address: "100 Main St, Bayside" },
      { id: "oM2", brokerage_id: B, status: "active", managing_broker_user_id: null, address: "200 Elm St, Shoreline" },
    ],
    teams: [
      { id: "tT", brokerage_id: B, name: "Main Street Team", team_lead_id: "uLead", location_id: "oM1", deleted_at: null },
      { id: "tT2", brokerage_id: B, name: "Elm Team", team_lead_id: "uLead2", location_id: "oM2", deleted_at: null },
    ],
    users: [
      { id: "uAg", brokerage_id: B, user_type: "agent", location_id: "oM1", team_id: "tT" },
      { id: "uAg2", brokerage_id: B, user_type: "agent", location_id: "oM2", team_id: null },
      { id: "uLead", brokerage_id: B, user_type: "team_lead", location_id: "oM1", team_id: "tT" },
      { id: "uLead2", brokerage_id: B, user_type: "team_lead", location_id: "oM2", team_id: "tT2" },
      { id: "uCompA", brokerage_id: B, user_type: "compliance_officer", location_id: "oM2", team_id: null },
      { id: "uCompB", brokerage_id: B, user_type: "compliance_officer", location_id: "oM2", team_id: null },
      { id: "uTc", brokerage_id: B, user_type: "tc", location_id: "oM2", team_id: null },
      { id: "uAdm1", brokerage_id: B, user_type: "admin", location_id: "oM1", team_id: null },
      { id: "uAdm2", brokerage_id: B, user_type: "broker", location_id: "oM2", team_id: null },
      { id: "uOwner", brokerage_id: B, user_type: "broker_owner", location_id: null, team_id: null },
      { id: "uOffice", brokerage_id: B, user_type: "agent", location_id: "oM1", team_id: null },
      { id: "uOffice2", brokerage_id: B, user_type: "agent", location_id: "oM2", team_id: null },
      { id: "uTeamDel", brokerage_id: B, user_type: "agent", location_id: "oM1", team_id: null },
      { id: "uX", brokerage_id: "bX", user_type: "broker_owner", location_id: null, team_id: null },
    ],
    agents: [
      { id: "agAg", user_id: "uAg", brokerage_id: B, team_id: "tT", location_id: "oM1", is_active: true },
      { id: "agAg2", user_id: "uAg2", brokerage_id: B, team_id: null, location_id: "oM2", is_active: true },
    ],
    team_members: [{ id: U(50), brokerage_id: B, agent_id: "agAg", team_id: "tT", is_active: true }],
    organization_members: [
      { id: U(60), brokerage_id: B, user_id: "uOwner", scope_kind: "tenant", location_id: null, team_id: null, access_level: "leadership", revoked_at: null, permissions: {} },
      { id: U(61), brokerage_id: B, user_id: "uOffice", scope_kind: "tenant", location_id: null, team_id: null, access_level: "member", revoked_at: null,
        permissions: { [MARKETING_DELEGATION_KEY]: { acts_for: "brokerage", team_id: null, may: ["prepare", "approve"], granted_by: "uOwner", granted_at: now } } },
      { id: U(62), brokerage_id: B, user_id: "uOffice2", scope_kind: "location", location_id: "oM2", team_id: null, access_level: "member", revoked_at: null,
        // a delegation written onto a LOCATION membership is ignored: office association confers nothing brokerage-wide
        permissions: { [MARKETING_DELEGATION_KEY]: { acts_for: "brokerage", may: ["prepare", "approve"] } } },
      { id: U(63), brokerage_id: B, user_id: "uTeamDel", scope_kind: "team", location_id: null, team_id: "tT", access_level: "member", revoked_at: null,
        permissions: { [MARKETING_DELEGATION_KEY]: { acts_for: "team", team_id: "tT", may: ["prepare", "approve"], granted_by: "uLead", granted_at: now } } },
    ],
    user_role_assignments: [],
    contacts: [
      { id: C1, brokerage_id: B, agent_id: "agAg", compliance_officer_id: "uCompA", tc_user_id: "uTc" },
      { id: C2, brokerage_id: B, agent_id: "agAg2", compliance_officer_id: null, tc_user_id: null },
    ],
    transaction_coordinators: [{ id: U(70), brokerage_id: B, user_id: "uTc", is_active: true }],
    transactions: [], transaction_assignments: [],
    brokerage_settings: opts.policy ? [{ id: U(80), brokerage_id: B, settings: { publication_approval: { require_brokerage_approval: { asset: { basis: "brokerage_policy" } } } } }] : [],
    marketing_assets: [
      { id: A1, brokerage_id: B, agent_user_id: "uAg", asset_type: "image", asset_name: "Office one spring graphic", asset_url: "https://cdn.example.test/a1.png", approval_status: "pending", visibility_scope: "agent", contact_id: C1, metadata: {}, created_at: now },
      { id: A2, brokerage_id: B, agent_user_id: "uAg2", asset_type: "image", asset_name: "Office two graphic", asset_url: "https://cdn.example.test/a2.png", approval_status: "pending", visibility_scope: "agent", contact_id: C2, metadata: {}, created_at: now },
      { id: ABRK, brokerage_id: B, agent_user_id: "uOwner", asset_type: "mailer", asset_name: "Brokerage holiday mailer", asset_url: "https://cdn.example.test/brk.png", approval_status: "pending", visibility_scope: "brokerage", metadata: {}, created_at: now },
      { id: ATEAM, brokerage_id: B, agent_user_id: "uTeamDel", asset_type: "image", asset_name: "Main Street team flyer art", asset_url: "https://cdn.example.test/t1.png", approval_status: "pending", visibility_scope: "team", team_id: "tT", metadata: {}, created_at: now },
      { id: ATEAM2, brokerage_id: B, agent_user_id: "uLead2", asset_type: "image", asset_name: "Elm team art", asset_url: "https://cdn.example.test/t2.png", approval_status: "pending", visibility_scope: "team", team_id: "tT2", metadata: {}, created_at: now },
    ],
    social_posts: [{ id: SP1, brokerage_id: B, agent_id: "agAg", user_id: "uAg", content: "Office one post", platform: "facebook", status: "draft", approval_status: "pending", created_at: now }],
  }, { uuidIds: true })
}
type Db = ReturnType<typeof db>
const seat: Record<string, string> = { uAg: "agent", uAg2: "agent", uLead: "team_lead", uLead2: "team_lead", uCompA: "compliance_officer", uCompB: "compliance_officer", uTc: "tc", uAdm1: "admin", uAdm2: "broker", uOwner: "broker_owner", uOffice: "agent", uOffice2: "agent", uTeamDel: "agent", uX: "broker_owner" }
const may = (d: Db, who: string, id: string, authority: MarketingAuthority = "content_brand", renderProven?: boolean, brokerageId = B) =>
  requireMarketingApprover({ brokerageId, approverUserId: who, approverUserType: seat[who], table: "marketing_assets", id, authority, renderProven, client: d as any })

async function approverSection() {
  console.log("\n[1 · EACH APPROVER — within scope, and refused outside it (executed)]  SIMULATED")
  const d = db()
  const pairs: Array<[string, string, string, string]> = [
    ["the owner", "uAg", A1, A2],
    ["the team lead (teams.team_lead_id of the owner's team)", "uLead", A1, A2],
    ["the ASSIGNED compliance officer (contacts.compliance_officer_id) — office 2's seat, office 1's piece", "uCompA", A1, ATEAM],
    ["the ASSIGNED TC (contacts.tc_user_id)", "uTc", A1, A2],
    ["office 1's admin (C34 hierarchy: office 1)", "uAdm1", A1, A2],
  ]
  for (const [label, who, inScope, outScope] of pairs) {
    const yes = await may(d, who, inScope)
    const no = await may(d, who, outScope)
    check(`${label}: APPROVES within scope`, yes.ok, yes.ok ? yes.decision.basis.join(", ") : yes.reason)
    check(`${label}: REFUSED outside scope, told who decides`, !no.ok && /sits with|not|could not/.test(no.reason), no.ok ? `approved: ${no.decision.basis.join(", ")}` : no.reason)
  }
  const unassigned = await may(d, "uCompB", A1)
  check("an UNASSIGNED compliance officer in another office is refused (compliance is by assignment + scope, never global)", !unassigned.ok, unassigned.ok ? unassigned.decision.basis.join(",") : "")
  const leader = [await may(d, "uOwner", A1), await may(d, "uOwner", A2)]
  check("the tenant leadership (organization_members tenant leadership grant) approves in every office", leader.every((x) => x.ok))
  const cross = await may(d, "uX", A1, "content_brand", undefined, "bX")
  check("another tenant's owner naming this piece is refused (the piece is not in their workspace)", !cross.ok && /not in your workspace/.test(cross.reason))
  const policy = db({ policy: true })
  const ownerUnderPolicy = await may(policy, "uAg", A1), adminUnderPolicy = await may(policy, "uAdm1", A1)
  check("the tenant's publication policy requiring the brokerage removes the owner / lead / TC path (C5), keeps the in-scope admin", !ownerUnderPolicy.ok && adminUnderPolicy.ok)
}

async function scopeSection() {
  console.log("\n[2 · SCOPE-005 / PRIV-002 — office 2 can neither see nor approve office 1's piece; the C5 door narrows the same way]  SIMULATED")
  const d = db()
  const office2 = await may(d, "uAdm2", A1)
  check("SCOPE-005: office 2's broker approving office 1's piece → REFUSED", !office2.ok, office2.ok ? office2.decision.basis.join(",") : office2.reason)
  check("CONTROL: office 2's broker DOES approve office 2's own piece (the refusal is scope, not a dead rule)", (await may(d, "uAdm2", A2)).ok)
  const v2 = await resolveCatalogViewer(d as any, { userId: "uAdm2", brokerageId: B, userType: "broker" })
  const rows2 = (await readContentCatalog(d as any, v2, { sourceType: "marketing_assets" })).rows
  check("PRIV-002: office 2's catalog does not contain office 1's asset or its approval queue entry", !rows2.some((r) => r.sourceId === A1) && rows2.some((r) => r.sourceId === A2), rows2.map((r) => r.sourceId).join(" "))
  const v1 = await resolveCatalogViewer(d as any, { userId: "uAdm1", brokerageId: B, userType: "admin" })
  const r1 = (await readContentCatalog(d as any, v1, { sourceType: "marketing_assets" })).rows.find((r) => r.sourceId === A1)
  check("office 1's admin sees office 1's piece and the catalog OFFERS the approval the writer will accept (one rule, two readers)", !!r1 && r1.actions.some((a) => a.kind === "approve") && planContentAction(r1, { sourceType: "marketing_assets", sourceId: A1, action: "approve" }).ok)
  const vt = await resolveCatalogViewer(d as any, { userId: "uTc", brokerageId: B, userType: "tc" })
  const tcRows = (await readContentCatalog(d as any, vt, { sourceType: "marketing_assets" })).rows
  check("the assigned TC SEES the assigned contact's piece (assignment widens visibility to that piece only) and is offered its approval", tcRows.some((r) => r.sourceId === A1 && r.actions.some((a) => a.kind === "approve")) && !tcRows.some((r) => r.sourceId === A2))
  // the C5 door (social posts / ad creatives / audiences)
  const pub2 = await requirePublishApprover({ brokerageId: B, assetKind: "social_post", assetTable: "social_posts", assetId: SP1, approverUserId: "uAdm2", client: d as any })
  const pub1 = await requirePublishApprover({ brokerageId: B, assetKind: "social_post", assetTable: "social_posts", assetId: SP1, approverUserId: "uAdm1", client: d as any })
  const pubLead = await requirePublishApprover({ brokerageId: B, assetKind: "social_post", assetTable: "social_posts", assetId: SP1, approverUserId: "uLead", client: d as any })
  check("SCOPE-005 on the C5 publish door: office 2's broker approving office 1's social post → REFUSED", !pub2.ok, pub2.ok ? "approved" : pub2.reason)
  check("the C5 door still admits office 1's admin and the owner's team lead (no over-narrowing)", pub1.ok && pubLead.ok, `${pub1.ok ? "" : pub1.reason} ${pubLead.ok ? "" : pubLead.reason}`)
  const base = await approverFor({ brokerageId: B, assetKind: "social_post", scope: { agentId: "agAg" }, client: d as any })
  check("CONTROL (red at 9d9626b9): the unchanged C5 decision lists office 2's broker as permitted — the office reach is what refuses", base.ok && base.permittedUserIds.includes("uAdm2"))
}

async function delegationSection() {
  console.log("\n[3 · THE DELEGATED OFFICE — approve / prepare for the brokerage or ONE team, with that principal's brand]  SIMULATED")
  const d = db()
  check("a delegated office (tenant membership grant) APPROVES the brokerage-voice piece", (await may(d, "uOffice", ABRK)).ok)
  const loc = await may(d, "uOffice2", ABRK)
  check("another office whose grant sits on a LOCATION membership is REFUSED (office association confers nothing brokerage-wide)", !loc.ok)
  check("office 1's admin (office scope, no tenant leadership) cannot approve the BROKERAGE-voice piece either", !(await may(d, "uAdm1", ABRK)).ok)
  check("a team delegate APPROVES its team's piece and is REFUSED on another team's", (await may(d, "uTeamDel", ATEAM)).ok && !(await may(d, "uTeamDel", ATEAM2)).ok)
  check("CONTROL: parseMarketingDelegation ignores a location membership and an empty grant, reads tenant / team grants", parseMarketingDelegation({ id: "x", scope_kind: "location", team_id: null, permissions: { [MARKETING_DELEGATION_KEY]: { may: ["approve"] } } }) === null && parseMarketingDelegation({ id: "y", scope_kind: "tenant", team_id: null, permissions: { [MARKETING_DELEGATION_KEY]: { may: [] } } }) === null && parseMarketingDelegation({ id: "z", scope_kind: "team", team_id: "tT", permissions: { [MARKETING_DELEGATION_KEY]: { may: ["prepare"] } } })?.teamId === "tT")
  // D4 — the principal's brand, sender and return address
  const brk = await resolveActingSender(d as any, { brokerageId: B, actorUserId: "uOffice", actorUserType: "agent", actsFor: "brokerage" })
  check("D4: the delegate preparing for the BROKERAGE gets the brokerage's brand and return address — not its own office's, not the platform's", brk.ok && brk.level === "brokerage" && brk.brandName === "Harbor Realty" && !!brk.returnAddress && /1 Harbor Way/.test(brk.returnAddress) && !/Main St|Elm St|vipagents/i.test(`${brk.brandName} ${brk.returnAddress}`), JSON.stringify(brk))
  const team = await resolveActingSender(d as any, { brokerageId: B, actorUserId: "uTeamDel", actorUserType: "agent", actsFor: "team", teamId: "tT" })
  check("D4: the team delegate preparing for the TEAM gets the team's name and its office's return address — never the other office's", team.ok && team.level === "team" && team.brandName === "Main Street Team" && team.returnAddress === "100 Main St, Bayside", JSON.stringify(team))
  const refusedSend = await resolveActingSender(d as any, { brokerageId: B, actorUserId: "uOffice2", actorUserType: "agent", actsFor: "brokerage" })
  const refusedTeam = await resolveActingSender(d as any, { brokerageId: B, actorUserId: "uTeamDel", actorUserType: "agent", actsFor: "team", teamId: "tT2" })
  check("D4: another office cannot prepare in the brokerage's name, and a team delegate cannot speak for another team", !refusedSend.ok && !refusedTeam.ok)
  ;(d.tables.organization_members.find((m: any) => m.user_id === "uOffice") as any).revoked_at = now
  check("REVOCABLE: revoking the delegate's membership ends the grant (approve and prepare both refused)", !(await may(d, "uOffice", ABRK)).ok && !(await resolveActingSender(d as any, { brokerageId: B, actorUserId: "uOffice", actorUserType: "agent", actsFor: "brokerage" })).ok)
}

async function authoritiesSection() {
  console.log("\n[4 · FIVE AUTHORITIES, SEPARATE — none stands in for another]  SIMULATED")
  const d = db()
  check("the five authorities are named and each says where it is decided", MARKETING_AUTHORITY_KEYS.join() === "content_brand,compliance_review,render_quality,spend_publication,legal_transaction" && MARKETING_AUTHORITY_KEYS.every((k) => MARKETING_APPROVAL_AUTHORITIES[k].decidedAt.length > 20))
  const legal = await Promise.all(["uOwner", "uAdm1", "uCompA", "uTc"].map((w) => may(d, w, A1, "legal_transaction")))
  check("LEGAL / TRANSACTION approval is never a marketing approval — refused for every seat, the owner included", legal.every((x) => !x.ok && /never/.test((x as any).reason)))
  check("COMPLIANCE REVIEW: the owner agent and the TC cannot clear their own regulated claim; the assigned compliance officer can", !(await may(d, "uAg", A1, "compliance_review")).ok && !(await may(d, "uTc", A1, "compliance_review")).ok && (await may(d, "uCompA", A1, "compliance_review")).ok)
  check("SPEND / PUBLICATION: a compliance officer (held out of commerce) cannot obligate spend; the tenant leadership can", !(await may(d, "uCompA", A1, "spend_publication")).ok && (await may(d, "uOwner", A1, "spend_publication")).ok)
  check("RENDER PROOF is evidence, not a click: refused with no playable file even for the owner, admitted once the render is proven", !(await may(d, "uOwner", A1, "render_quality", false)).ok && (await may(d, "uOwner", A1, "render_quality", true)).ok)
  const facts = await loadMarketingApproverFacts(d as any, { userId: "uOwner", brokerageId: B, userType: "broker_owner" })
  const scope = { brokerageId: B, ownerUserId: "uAg", teamId: null, ownerLocationId: "oM1", ownerTeamIds: ["tT"], actsFor: null, contactId: C1, transactionId: null }
  check("one approved master authorizes no paid campaign / regulated claim: spend and compliance never INHERIT; content does only on identical scope + version",
    !approvalInherits("spend_publication", { scopeKey: "k", fingerprint: "v" }, { scopeKey: "k", fingerprint: "v" }) && !approvalInherits("compliance_review", { scopeKey: "k", fingerprint: "v" }, { scopeKey: "k", fingerprint: "v" })
    && approvalInherits("content_brand", { scopeKey: "k", fingerprint: "v" }, { scopeKey: "k", fingerprint: "v" }) && !approvalInherits("content_brand", { scopeKey: "k", fingerprint: "v" }, { scopeKey: "k2", fingerprint: "v" }) && !approvalInherits("content_brand", { scopeKey: "k", fingerprint: "v" }, { scopeKey: "k", fingerprint: "v2" }))
  check("FAIL CLOSED: facts with a refusal decide nothing, even for the tenant leadership", !decideMarketingApproval({ ...facts, refusal: "memberships read refused" }, scope, "content_brand").ok && decideMarketingApproval(facts, scope, "content_brand").ok)
  const refusing = memSupabase({ contacts: [] }, { refuse: { contacts: "permission denied for table contacts" } })
  const f2 = await loadMarketingApproverFacts(refusing as any, { userId: "uOwner", brokerageId: B, userType: "broker_owner" })
  check("an unreadable assignment read becomes a named refusal (never 'nobody needs to approve')", !!f2.refusal && /compliance assignments/.test(f2.refusal))
}

async function versionSection() {
  console.log("\n[5 · VERSIONS — editing an approved version re-opens its approval (catalog readback)]  SIMULATED")
  const d = db()
  const row = d.tables.marketing_assets.find((r: any) => r.id === A1) as any
  // approveAsset's own write, applied as written: approval_status + the stamp of the version approved
  row.approval_status = "approved"
  row.metadata = { approval: { fingerprint: marketingAssetFingerprint(row), scope_key: marketingScopeKey({ brokerageId: B, actsFor: null, teamId: null, ownerUserId: "uAg" }), approved_by: "uAdm1", approved_at: now, authority: "content_brand" } }
  const v = await resolveCatalogViewer(d as any, { userId: "uAg", brokerageId: B, userType: "agent" })
  const before = (await readContentCatalog(d as any, v, { sourceType: "marketing_assets", sourceId: A1 })).rows[0]
  check("the approved, unedited version reads READY (the stamp matches)", before?.status === "ready" && !before.approvalReopened)
  row.asset_url = "https://cdn.example.test/a1-regenerated.png" // a substantive edit (e.g. lib/assets/screenshot-capture.ts regen)
  const after = (await readContentCatalog(d as any, v, { sourceType: "marketing_assets", sourceId: A1 })).rows[0]
  check("after a substantive edit the approval is RE-OPENED: awaiting approval, labeled, and re-approval offered to the owner", after?.status === "awaiting_approval" && after.approvalReopened && /re-approval/i.test(after.statusLabel) && after.actions.some((a) => a.kind === "approve" && /Re-approve/.test(a.label)))
  check("CONTROL: a non-substantive field (created_at) does not change the version", marketingAssetFingerprint({ ...row, created_at: "2020-01-01" }) === marketingAssetFingerprint(row) && approvalFingerprint({ a: 1 }) !== approvalFingerprint({ a: 2 }))
}

function writersSection() {
  console.log("\n[6 · THE WRITERS — each calls the ONE authority (stripped source)]")
  const studio = stripComments(src("app/actions/marketing-studio.ts"))
  const fn = (name: string) => { const i = studio.indexOf(`export async function ${name}(`); const j = studio.indexOf("\nexport ", i + 10); return i < 0 ? "" : studio.slice(i, j < 0 ? undefined : j) }
  const approve = fn("approveAsset"), reject = fn("rejectAsset"), create = fn("createAsset")
  const reg = stripComments(src("lib/marketing/campaign-registry.ts"))
  const rfn = (name: string) => { const i = reg.indexOf(`export async function ${name}(`); const j = reg.indexOf("\nexport ", i + 10); return i < 0 ? "" : reg.slice(i, j < 0 ? undefined : j) }
  const grant = rfn("grantMarketingDelegation"), revoke = rfn("revokeMarketingDelegation")
  const comp = stripComments(src("app/dashboard/marketing/studio/components/content-command-center.tsx"))
  check("the delegation doors have a real caller: the Command tab's delegation card grants and revokes through them", /await grantMarketingDelegation\(\{/.test(comp) && /await revokeMarketingDelegation\(\{/.test(comp) && /await getMarketingDelegations\(\)/.test(comp))
  check("approveAsset asks requireMarketingApprover(content_brand) BEFORE its write and stamps the approved version", /requireMarketingApprover\(\{[\s\S]{0,200}authority: "content_brand"/.test(approve) && approve.indexOf("requireMarketingApprover(") < approve.indexOf('.from("marketing_assets")\n    .update') && /approval: \{ fingerprint: marketingAssetFingerprint\(row\)/.test(approve))
  check("rejectAsset asks the same authority before its write", /requireMarketingApprover\(\{[\s\S]{0,200}authority: "content_brand"/.test(reject))
  check("createAsset routes a brokerage / team voice through resolveActingSender and refuses without it", /resolveActingSender\(/.test(create) && /if \(!sender\.ok\) return \{ success: false, error: sender\.reason \}/.test(create))
  check("the delegation doors write organization_members.permissions on an ACTIVE tenant / team membership, gated by the granter's hierarchy, on the ledger (3-segment actions)",
    /resolveViewerHierarchy\(/.test(reg) && /scope_kind", input\.actsFor === "brokerage" \? "tenant" : "team"\)/.test(reg) && /\.is\("revoked_at", null\)/.test(reg)
    && /action: "marketing\.delegation\.grant"/.test(grant) && /action: "marketing\.delegation\.revoke"/.test(revoke) && /update\(\{ permissions: next/.test(grant))
  const auth = stripComments(src("lib/kernel/approval-authority.ts"))
  check("the roster is DERIVED (ORG_STAFF_ROLES / TENANT_COMMERCE_ADMIN_USER_TYPES spread), never a retyped list", /has\(ORG_STAFF_ROLES\)/.test(auth) && /\[\.\.\.TENANT_COMMERCE_ADMIN_USER_TYPES\]/.test(auth) && !/\["broker", "broker_owner"/.test(auth))
}

async function main() {
  console.log("marketing-approver-guard — wave 155 lane 155D (R7 / D3 / D4 / SCOPE-005 / PRIV-002)")
  await approverSection()
  await scopeSection()
  await delegationSection()
  await authoritiesSection()
  await versionSection()
  writersSection()
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1) }
}
main().catch((e) => { console.error(e); process.exit(1) })
