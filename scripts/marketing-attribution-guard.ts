#!/usr/bin/env tsx
/**
 * scripts/marketing-attribution-guard.ts — MARKETING PERMISSIONS, LINEAGE AND HONEST ROI (wave 155, lane 155J; directive J1 / J2 /
 * J4; owner R4 "content catalog is missing leadid", R7 approvers + the delegated office, R9 "video is an artifact not a channel";
 * eval SCOPE-005, PRIV-002, PRIV-004, REWARD-001, REWARD-005).   npm run test:marketing-attribution
 *
 *   1  J1 — the delegated office markets ITS team's content; another office (location-only grant) and another tenant are refused.
 *      (Lane 155D built and proved the rule — test:marketing-approver; this re-executes only the directive-438 canary.)
 *   2  PRIV-004 / J2 — the Lead link is TRACEABLE for the lead desk (brokerage AND the owning team's lead — the team-lead path 155D
 *      left unproven) and HIDDEN from an ordinary agent ("restricted"; a by-Lead query is refused); another team's lead gets none.
 *   3  R9 — a video step is an ARTIFACT: its delivery is ONE email touch stamped artifact=video (never a "video" channel touch,
 *      never two touches); a render with no recipient is no touch. The channel ROI rollup has no "video" channel; the video's
 *      leads are an artifact breakdown; the newsletter channel's leads are UNMEASURED (null), never recipients × a rate.
 *   4  STALE APPROVAL AT THE DOOR — the one re-open rule; the door check refuses an edited / regenerated / rejected studio asset,
 *      passes an intact one and a URL that is no studio asset, and fails closed on a refused read; the doors and writers call it.
 *   5  J4 LEARNING — a declined recommendation is recorded in THE proposal kernel (REJECTED + reason) and not proposed again;
 *      a replayed decline adds nothing (REWARD-005).
 *   6  J2 QR LINEAGE + the refused-scan reader — a blog's code (no qr_code_id column) is found through qr_codes.mint_context with
 *      its slot; refused scans are summarized by state only; the QR board and the ROI page mount their readers.
 * Every execution proof is SIMULATED (scripts/in-memory-supabase.ts; no provider, no model, no network). Code-token scans read
 * STRIPPED source (CLAUDE.md §2). Each absence claim carries a positive control.
 * BLIND SPOTS (published): the door check matches studio assets by URL (asset_url / thumbnail_url) — a door that embeds an asset
 * some other way is not seen; lib/kernel/marketing.ts publishBlogPost (the second blog door) was RETIRED at merge — survivor app/actions/blog.ts publishBlogPost; a video code minted by
 * label (video:<kind>:<entity>:u:<user>) is not joined to the catalog; the assignment caps 155D published (2000 facts / 200
 * catalog or-filter / 500 parent ids) are unchanged.
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import * as AA from "../lib/kernel/approval-authority"
import { resolveCatalogViewer, readContentCatalog } from "../lib/marketing/content-catalog"
import * as TB from "../lib/campaign-sequences/touchpoint-bridge"
import { recalculateChannelPerformance } from "../lib/campaigns/roi-calculator"
import * as RL from "../lib/intelligence/roi-ledger"
import { proposeImprovement, decideProposal } from "../lib/kernel/improvement-proposals"
import * as QG from "../lib/marketing/qr-governance"
// Namespace imports on purpose: at the base (d2d6468c) the lane's new exports do not exist, and a named import would crash the
// whole file instead of letting each check report red. These are the same functions.
const { requireMarketingApprover, marketingAssetFingerprint, MARKETING_DELEGATION_KEY } = AA
const marketingApprovalReopened = (...a: Parameters<typeof AA.marketingApprovalReopened>) => (AA as any).marketingApprovalReopened(...a) as ReturnType<typeof AA.marketingApprovalReopened>
const refuseReopenedMarketingAssets = (...a: Parameters<typeof AA.refuseReopenedMarketingAssets>) => (AA as any).refuseReopenedMarketingAssets(...a) as ReturnType<typeof AA.refuseReopenedMarketingAssets>
const { recordSequenceTouchpoint, touchpointChannelForStep } = TB
const applyDeclinedRecommendations = (...a: Parameters<typeof RL.applyDeclinedRecommendations>) => (RL as any).applyDeclinedRecommendations(...a) as ReturnType<typeof RL.applyDeclinedRecommendations>
const roiRecommendationSubjectKey = (...a: Parameters<typeof RL.roiRecommendationSubjectKey>) => (RL as any).roiRecommendationSubjectKey(...a) as string
const summarizeRefusedScans = (...a: Parameters<typeof QG.summarizeRefusedScans>) => (QG as any).summarizeRefusedScans(...a) as ReturnType<typeof QG.summarizeRefusedScans>

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const code = (p: string) => stripComments(readFileSync(join(root, p), "utf8"))
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) } else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const U = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`
const now = new Date().toISOString()
const B = "bJ"
const ATEAM = U(1), ATEAM2 = U(2), C1 = U(10), L1 = U(20), DM1 = U(30), BLOG1 = U(40), QR1 = U(50), QR2 = U(51)

function db() {
  return memSupabase({
    brokerages: [{ id: B, plan_tier: "multi_location", name: "Harbor Realty Group", dba: "Harbor Realty", address: "1 Harbor Way", city: "Bayside", state: "FL", zip: "32501" }, { id: "bX", plan_tier: "solo_agent", name: "Other" }],
    locations: [{ id: "o1", brokerage_id: B, status: "active", address: "100 Main St" }, { id: "o2", brokerage_id: B, status: "active", address: "200 Elm St" }],
    teams: [
      { id: "tT", brokerage_id: B, name: "Main Street Team", team_lead_id: "uLead", location_id: "o1", deleted_at: null },
      { id: "tT2", brokerage_id: B, name: "Elm Team", team_lead_id: "uLead2", location_id: "o2", deleted_at: null },
    ],
    users: [
      { id: "uAg", brokerage_id: B, user_type: "agent", location_id: "o1", team_id: "tT", platform_role: null },
      { id: "uLead", brokerage_id: B, user_type: "team_lead", location_id: "o1", team_id: "tT", platform_role: null },
      { id: "uLead2", brokerage_id: B, user_type: "team_lead", location_id: "o2", team_id: "tT2", platform_role: null },
      { id: "uOwner", brokerage_id: B, user_type: "broker_owner", location_id: null, team_id: null, platform_role: null },
      { id: "uTeamDel", brokerage_id: B, user_type: "agent", location_id: "o1", team_id: null, platform_role: null },
      { id: "uOffice2", brokerage_id: B, user_type: "agent", location_id: "o2", team_id: null, platform_role: null },
      { id: "uX", brokerage_id: "bX", user_type: "broker_owner", location_id: null, team_id: null, platform_role: null },
    ],
    agents: [{ id: "agAg", user_id: "uAg", brokerage_id: B, team_id: "tT", location_id: "o1", is_active: true }],
    team_members: [{ id: U(60), brokerage_id: B, agent_id: "agAg", team_id: "tT", is_active: true }],
    organization_members: [
      { id: U(61), brokerage_id: B, user_id: "uOwner", scope_kind: "tenant", location_id: null, team_id: null, access_level: "leadership", revoked_at: null, permissions: {} },
      { id: U(62), brokerage_id: B, user_id: "uTeamDel", scope_kind: "team", location_id: null, team_id: "tT", access_level: "member", revoked_at: null,
        permissions: { [MARKETING_DELEGATION_KEY]: { acts_for: "team", team_id: "tT", may: ["prepare", "approve"], granted_by: "uLead", granted_at: now } } },
      { id: U(63), brokerage_id: B, user_id: "uOffice2", scope_kind: "location", location_id: "o2", team_id: null, access_level: "member", revoked_at: null,
        permissions: { [MARKETING_DELEGATION_KEY]: { acts_for: "team", team_id: "tT", may: ["prepare", "approve"] } } },
    ],
    user_role_assignments: [], transactions: [], transaction_assignments: [], transaction_coordinators: [], brokerage_settings: [],
    contacts: [{ id: C1, brokerage_id: B, agent_id: "agAg", email: "pat@example.test" }, { id: U(11), brokerage_id: B, agent_id: "agAg", email: null }],
    leads: [{ id: L1, brokerage_id: B, agent_id: "agAg", contact_id: null, converted_at: null }],
    marketing_assets: [
      { id: ATEAM, brokerage_id: B, agent_user_id: "uTeamDel", asset_type: "image", asset_name: "Main Street team flyer art", asset_url: "https://cdn.example.test/t1.png", approval_status: "pending", visibility_scope: "team", team_id: "tT", metadata: {}, created_at: now },
      { id: ATEAM2, brokerage_id: B, agent_user_id: "uLead2", asset_type: "image", asset_name: "Elm team art", asset_url: "https://cdn.example.test/t2.png", approval_status: "pending", visibility_scope: "team", team_id: "tT2", metadata: {}, created_at: now },
    ],
    direct_mail_campaigns: [{ id: DM1, brokerage_id: B, created_by: "uAg", agent_id: "agAg", campaign_name: "Just listed postcard", status: "planning", approval_status: "pending", lead_id: L1, contact_id: null, created_at: now }],
    blog_posts: [{ id: BLOG1, brokerage_id: B, agent_user_id: "uAg", team_id: "tT", visibility_scope: "agent", title: "Spring market notes", publish_status: "published", approval_status: "approved", created_at: now }],
    qr_codes: [
      { id: QR1, brokerage_id: B, slug: "spring", target_url: "https://harbor.example.test/blog/spring", is_active: true, retired_at: null, expires_at: null, destination_history: [], scan_count: 4, mint_context: { source_table: "blog_posts", asset_id: BLOG1, artifact_slot: "blog_footer", placement: "web" } },
      // the same id under ANOTHER table must not attach to the blog (lineage is table + id, never id alone)
      { id: QR2, brokerage_id: B, slug: "other", target_url: "https://harbor.example.test/x", is_active: true, retired_at: null, expires_at: null, destination_history: [], scan_count: 0, mint_context: { source_table: "podcast_episodes", asset_id: BLOG1, artifact_slot: "show_notes" } },
    ],
    marketing_campaign_touchpoints: [], improvement_proposals: [], audit_logs: [], video_performance_tracking: [{ id: U(70), brokerage_id: B, lead_conversions: 3, created_at: now }],
    social_engagement_tracking: [], ad_performance: [], newsletter_scheduled_sends: [{ id: U(71), brokerage_id: B, recipient_count: 500, scheduled_time: now }],
    podcast_analytics_events: [], marketing_campaigns: [], channel_performance: [],
  }, { uuidIds: true })
}
const seat: Record<string, string> = { uAg: "agent", uLead: "team_lead", uLead2: "team_lead", uOwner: "broker_owner", uTeamDel: "agent", uOffice2: "agent", uX: "broker_owner" }

async function officeSection() {
  console.log("\n[1 · J1 — the delegated office markets its team's content; another office and another tenant are refused]  SIMULATED")
  const d = db()
  const may = (who: string, id: string, b = B) => requireMarketingApprover({ brokerageId: b, approverUserId: who, approverUserType: seat[who], table: "marketing_assets", id, authority: "content_brand", client: d as any })
  check("POSITIVE: the team's delegated office APPROVES the team's piece", (await may("uTeamDel", ATEAM)).ok)
  check("SCOPE-005: the same delegate is REFUSED on another team's piece", !(await may("uTeamDel", ATEAM2)).ok)
  check("PRIV-002: another office whose grant sits on a LOCATION membership is REFUSED on the team's piece", !(await may("uOffice2", ATEAM)).ok)
  check("another tenant's owner naming the piece is REFUSED", !(await may("uX", ATEAM, "bX")).ok)
}

async function leadSection() {
  console.log("\n[2 · PRIV-004 — the Lead link: traceable for the lead desk (brokerage + the owning team's lead), hidden from an agent]  SIMULATED")
  const d = db()
  const read = async (who: string, filters: Record<string, unknown> = {}) => readContentCatalog(d as any, await resolveCatalogViewer(d as any, { userId: who, brokerageId: B, userType: seat[who] }), { sourceType: "direct_mail_campaigns", ...filters })
  const owner = (await read("uOwner")).rows.find((r) => r.sourceId === DM1)
  check("POSITIVE CONTROL: the brokerage lead desk sees the piece's TRACEABLE lead_id", owner?.leadLinkVisibility === "shown" && !!owner?.leadLink?.leadIds.includes(L1), JSON.stringify(owner?.leadLink))
  const lead = (await read("uLead")).rows.find((r) => r.sourceId === DM1)
  check("TEAM-LEAD PATH (unproven at the base): the lead of the lead's agent's team sees the lead_id (team-scoped lead desk)", lead?.leadLinkVisibility === "shown" && !!lead?.leadLink?.leadIds.includes(L1), JSON.stringify({ v: lead?.leadLinkVisibility, l: lead?.leadLink }))
  const lead2 = (await read("uLead2")).rows.find((r) => r.sourceId === DM1)
  check("another team's lead gets NO lead identity for it (row hidden or link none)", !lead2 || !lead2.leadLink, JSON.stringify(lead2?.leadLink))
  const ag = await read("uAg")
  const agRow = ag.rows.find((r) => r.sourceId === DM1)
  check("PRIV-004: the ordinary agent sees the piece they own, with the Lead link RESTRICTED and no lead id anywhere in the row", !!agRow && agRow.leadLinkVisibility === "restricted" && agRow.leadLink === null && !JSON.stringify(agRow).includes(L1), JSON.stringify(agRow?.leadLinkVisibility))
  const byLead = await read("uAg", { leadId: L1 })
  check("PRIV-004: a by-Lead catalog query from the agent is REFUSED (no queue oracle)", !byLead.ok && !!byLead.refusal && byLead.rows.length === 0, byLead.refusal ?? "")
}

async function videoSection() {
  console.log("\n[3 · R9 — video is an artifact: one email touch, never a video channel; ROI has no video channel and invents no leads]  SIMULATED")
  const d = db()
  const touch = (contactId: string, stepChannel: string) => recordSequenceTouchpoint(d as any, { brokerageId: B, sequenceId: U(80), contactId, enrollmentId: U(81), stepId: U(82), stepChannel, sentAt: now })
  await touch(C1, "video")
  const rows = d.tables.marketing_campaign_touchpoints
  check("a DELIVERED video records exactly ONE touch, on its delivering channel (email), stamped artifact=video", rows.length === 1 && rows[0].channel === "email" && rows[0].metadata?.artifact === "video", JSON.stringify(rows.map((r: any) => [r.channel, r.metadata?.artifact])))
  check("no touch row anywhere names 'video' as a channel", !rows.some((r: any) => r.channel === "video"))
  await touch(U(11), "video")
  check("a video rendered for a Contact with NO email records NO touch (nobody was reached)", d.tables.marketing_campaign_touchpoints.length === 1)
  await touch(C1, "email")
  check("POSITIVE CONTROL: a plain email step still records its email touch (artifact null)", d.tables.marketing_campaign_touchpoints.length === 2 && d.tables.marketing_campaign_touchpoints[1].metadata?.artifact === null && touchpointChannelForStep("email") === "email")
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
  const r = await recalculateChannelPerformance(B, now.slice(0, 10), tomorrow, true, d as any)
  const types = (r.channels ?? []).map((c) => c.channel_type)
  check("the channel rollup ran (positive control) and has NO 'video' channel", r.success && types.length >= 5 && !types.includes("video"), `${r.error ?? ""} ${types.join(",")}`)
  check("the video's measured leads are an ARTIFACT breakdown (3), spend unknown (null), never a channel row", JSON.stringify((r.artifacts ?? []).map((a) => [a.artifact, a.leads, a.spend])) === JSON.stringify([["video", 3, null]]) && !d.tables.channel_performance.some((x: any) => x.channel_type === "video"))
  const nl = (r.channels ?? []).find((c) => c.channel_type === "newsletter")
  check("REWARD-001 / J4: 500 newsletter recipients are NOT 10 invented leads — the channel's leads are UNMEASURED (null), stored null", nl?.leads === null && d.tables.channel_performance.find((x: any) => x.channel_type === "newsletter")?.leads === null, JSON.stringify(nl))
}

async function staleSection() {
  console.log("\n[4 · STALE APPROVAL AT THE DOOR — edited / regenerated / rejected refuses; intact passes; a refused read refuses]  SIMULATED")
  const base = { asset_type: "image", asset_name: "Open house art", asset_url: "https://cdn.example.test/oh.png", preview_text: null, variants: null, audience: null, brand: null }
  const stamp = { approval: { fingerprint: marketingAssetFingerprint(base), scope_key: "k", approved_by: "uOwner", approved_at: now, authority: "content_brand" } }
  const intact = { id: U(90), brokerage_id: B, ...base, approval_status: "approved", metadata: stamp }
  const edited = { ...intact, id: U(91), asset_url: "https://cdn.example.test/oh-v2.png" }
  const regen = { ...intact, id: U(92), asset_url: "https://cdn.example.test/oh-regen.png", approval_status: "pending" }
  const rejected = { ...intact, id: U(93), asset_url: "https://cdn.example.test/oh-rej.png", approval_status: "rejected", metadata: {} }
  const legacy = { ...intact, id: U(94), asset_url: "https://cdn.example.test/legacy.png", metadata: {} }
  check("the rule: intact → holds; edited → re-opened; regenerated-to-pending → re-opened; rejected → refused; no stamp → not judged",
    !marketingApprovalReopened(intact).reopened && marketingApprovalReopened(edited).reopened && marketingApprovalReopened(regen).reopened && marketingApprovalReopened(rejected).reopened && !marketingApprovalReopened(legacy).reopened)
  const d = memSupabase({ marketing_assets: [intact, edited, regen, rejected, legacy, { ...edited, id: U(95), brokerage_id: "bX", asset_url: "https://cdn.example.test/oh.png" }] })
  const pass = await refuseReopenedMarketingAssets(d as any, B, ["https://cdn.example.test/oh.png"])
  check("POSITIVE CONTROL: the intact approved asset PASSES the door (another tenant's same-URL edited row is not read)", pass.ok && pass.matched === 1, JSON.stringify(pass))
  for (const [label, url] of [["edited after approval", edited.asset_url], ["regenerated (writer reset to pending)", regen.asset_url], ["rejected", rejected.asset_url]] as const) {
    const v = await refuseReopenedMarketingAssets(d as any, B, [url])
    check(`a design ${label} is REFUSED at send`, !v.ok, JSON.stringify(v))
  }
  check("a URL that is no studio asset (a listing photo) is not this rule's to judge", (await refuseReopenedMarketingAssets(d as any, B, ["https://photos.example.test/1.jpg", null])).ok)
  const refusedRead = memSupabase({ marketing_assets: [] }, { refuse: { marketing_assets: "permission denied" } })
  check("FAIL CLOSED: a refused read refuses the door", !(await refuseReopenedMarketingAssets(refusedRead as any, B, [intact.asset_url])).ok)
  const dm = code("app/actions/direct-mail.ts"), soc = code("lib/social/publisher.ts"), blog = code("app/actions/blog.ts"), shot = code("lib/assets/screenshot-capture.ts"), cat = code("lib/marketing/content-catalog.ts")
  const sendBody = dm.slice(dm.indexOf("export async function sendCampaign"), dm.indexOf("export async function sendCampaign") + 9000)
  check("DOOR: direct mail sendCampaign checks the printed design before any spend", /refuseReopenedMarketingAssets\([\s\S]{0,160}campaign\.design_url/.test(sendBody) && sendBody.indexOf("refuseReopenedMarketingAssets(") < sendBody.indexOf("campaignSendGate("))
  check("DOOR: the social publisher's single door checks the media before the ledger claim", /refuseReopenedMarketingAssets\([\s\S]{0,160}params\.mediaUrls/.test(soc) && soc.indexOf("refuseReopenedMarketingAssets(") < soc.indexOf("return ledgerSocialPublish("))
  check("DOOR: the blog publish door checks the featured image", /refuseReopenedMarketingAssets\([\s\S]{0,160}featured_image_url/.test(blog))
  const upd = dm.slice(dm.indexOf("export async function updateMailCampaign"), dm.indexOf("export async function deleteMailCampaign"))
  check("WRITER: an approved mail campaign's substantive edit re-opens approval, tenant-pinned from the session", /mailCampaignEditReopensApproval\(/.test(upd) && /approval_status\s*=\s*"pending"/.test(upd) && /\.eq\("brokerage_id", actor\.brokerageId\)/.test(upd))
  check("WRITER: the screenshot regen resets a page capture to pending and is pinned to its own tenant (155D request 1)", /approval_status: kind === "os_surface" \? "approved" : "pending"/.test(shot) && /applyTenantScope\(regenQ, regenScope\)/.test(shot) && /tenantScope\(row\.brokerage_id,/.test(shot))
  check("ONE rule: the catalog reads marketingApprovalReopened (no second inline copy)", /marketingApprovalReopened\(r\)/.test(cat) && !/stamp\.fingerprint !== marketingAssetFingerprint/.test(cat))
}

async function learningSection() {
  console.log("\n[5 · J4 — a declined recommendation is recorded with why and not proposed again; a replay adds nothing]  SIMULATED")
  const camp = U(100)
  const recs = [{ kind: "review_reduce", campaignId: camp, text: "a" }, { kind: "record_spend", campaignId: camp, text: "b" }, { kind: "review_reduce", campaignId: U(101), text: "c" }]
  const before = applyDeclinedRecommendations(recs, [])
  check("POSITIVE CONTROL: with nothing declined every recommendation is kept", before.kept.length === 3 && before.declined.length === 0)
  const d = db()
  const key = roiRecommendationSubjectKey("review_reduce", camp)
  const p = await proposeImprovement(d as any, { brokerageId: B, subjectKind: "allocation", subjectKey: key, proposer: "human", proposedChange: { kind: "review_reduce", campaign_id: camp, source: "roi_reader" } })
  check("the proposal kernel ACCEPTS the subject (allocation / human) — no new store", p.ok, p.ok ? "" : p.error)
  const dec = p.ok ? await decideProposal(d as any, { brokerageId: B, id: p.id, decision: "reject", actor: { type: "user", userId: "uOwner", isTenantAdmin: true, userType: "broker_owner" }, reason: "postcards in this farm never pay back" }) : { ok: false as const, error: "no proposal" }
  const row = d.tables.improvement_proposals.find((r: any) => r.subject_key === key)
  check("the decline is REJECTED with the person's reason", dec.ok && row?.status === "REJECTED" && row?.decision_reason === "postcards in this farm never pay back", JSON.stringify(row))
  const agentDecide = p.ok ? await decideProposal(d as any, { brokerageId: B, id: p.id, decision: "reject", actor: { type: "user", userId: "uAg", isTenantAdmin: false }, reason: "x" }) : { ok: true }
  check("an ordinary agent cannot decide it (the kernel's own roster rule)", !agentDecide.ok)
  const rej = d.tables.improvement_proposals.filter((r: any) => r.status === "REJECTED")
  const after = applyDeclinedRecommendations(recs, rej as any)
  check("the SAME (kind, campaign) is not proposed again; the other campaign's and the other kind's stay", after.kept.length === 2 && !after.kept.some((x) => x.kind === "review_reduce" && x.campaignId === camp) && after.declined[0]?.reason === "postcards in this farm never pay back")
  const replay = applyDeclinedRecommendations(recs, [...rej, ...rej] as any)
  check("REWARD-005: a replayed decline adds nothing (one declined entry, same kept set)", replay.declined.length === 1 && replay.kept.length === 2)
  const ledger = code("lib/intelligence/roi-ledger.ts"), act = code("app/dashboard/campaigns/roi/actions.ts")
  check("the reader reads REJECTED allocation proposals under the tenant and applies them", /from\("improvement_proposals"\)[\s\S]{0,200}\.eq\("brokerage_id", brokerageId\)\.eq\("subject_kind", "allocation"\)\.eq\("status", "REJECTED"\)/.test(ledger) && /applyDeclinedRecommendations\(recommendations,/.test(ledger))
  check("the decline door: session tenant, the roster spread (never copied), the kernel, a 3-segment ledger action, idempotent per day",
    /^"use server"/.test(readFileSync(join(root, "app/dashboard/campaigns/roi/actions.ts"), "utf8")) && /auth\.getUser\(\)/.test(act) && /TENANT_ADMIN_USER_TYPES\.has\(/.test(act) && /decideProposal\(/.test(act) && /action: "marketing\.recommendation\.decline"/.test(act) && /idempotencyKey:/.test(act) && !/brokerageId:\s*input\./.test(act))
}

async function lineageSection() {
  console.log("\n[6 · J2 — QR lineage through the one minter's record; the refused-scan reader; the client-question result]  SIMULATED")
  const d = db()
  const v = await resolveCatalogViewer(d as any, { userId: "uAg", brokerageId: B, userType: "agent" })
  const blog = (await readContentCatalog(d as any, v, { sourceType: "blog_posts" })).rows.find((r) => r.sourceId === BLOG1)
  check("POSITIVE CONTROL: the agent's blog post is in their catalog", !!blog)
  check("the blog's QR placement is found through qr_codes.mint_context (no qr_code_id column) with its slot and placement", !!blog && blog.qrLinks.length === 1 && blog.qrLinks[0].qrCodeId === QR1 && blog.qrLinks[0].slot === "blog_footer" && blog.qrLinks[0].placement === "web" && blog.qrLinks[0].active, JSON.stringify(blog?.qrLinks))
  check("a code minted for ANOTHER table with the same id does NOT attach (lineage is table + id)", !!blog && !blog.qrLinks.some((q) => q.qrCodeId === QR2))
  const sum = summarizeRefusedScans([{ created_at: "2026-01-02T00:00:00Z", metadata: { state: "retired" } }, { created_at: "2026-01-03T00:00:00Z", metadata: { state: "paused" } }, { created_at: "2026-01-01T00:00:00Z", metadata: { state: "retired" } }])
  check("refused scans summarize by STATE only (counts + latest) — nothing about the scanner", sum.total === 3 && sum.byState.retired === 2 && sum.byState.paused === 1 && sum.lastAt === "2026-01-03T00:00:00Z" && summarizeRefusedScans([]).total === 0)
  const gov = code("lib/marketing/qr-governance.ts"), board = code("app/dashboard/agent/qr-codes/QRCodesClient.tsx"), page = code("app/dashboard/campaigns/roi/page.tsx"), client = code("app/dashboard/campaigns/roi/roi-dashboard-client.tsx")
  check("the QR board's activity READS the qr_scan_refused events (the writer had no reader) — tenant-pinned, null when unread", /\.eq\("event_type", "qr_scan_refused"\)/.test(gov) && /\.eq\("brokerage_id", actor\.brokerageId\)\.eq\("entity_type", "qr_code"\)/.test(gov) && /refusedScans: refusedErr \? null :/.test(gov) && /refusedScans/.test(board))
  check("the ROI page mounts the client-question reader (dynamic import, tenant view) and shows 'Not measured' for null", /import\("@\/lib\/customer-intelligence\/website-question-topics"\)/.test(page) && /readQuestionLoopMetrics\(createServiceClient\(\), \{ brokerageId: profile\.brokerage_id \}\)/.test(page) && /ClientQuestionsCard/.test(client) && /Not measured/.test(client))
  check("the ROI client copies no role roster (CLAUDE.md §4) — the page passes a boolean from TENANT_ADMIN_USER_TYPES", !/"compliance_officer"/.test(client) && /canDecideRecommendations=\{TENANT_ADMIN_USER_TYPES\.has\(/.test(page))
}

async function main() {
  console.log("Marketing attribution guard — wave 155, lane 155J")
  for (const s of [officeSection, leadSection, videoSection, staleSection, learningSection, lineageSection]) {
    try { await s() } catch (e) { check(`${s.name} ran without throwing`, false, (e as Error)?.stack?.split("\n").slice(0, 3).join(" | ")) }
  }
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
  if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1) }
  console.log("MARKETING_ATTRIBUTION_PASS")
}
main()
