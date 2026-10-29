/**
 * scripts/canaries/wave146-ads.ts — ADS canary (wave 146, lane 146J; owner rulings 2, 8, 9; contracts C2, C5 — lane 146E):
 *   RULING 8 — "groundtruth (https://api-docs.groundtruth.com/) and stackadapt are 2 tv connections": both are ADAPTERS on the
 *     EXISTING ads provider fabric with truthful capability declarations (account access, campaign creation, creative association,
 *     budget/approval, status, performance readback, attribution, CTV inventory — UNKNOWN where the documentation does not say);
 *     nothing reads CONNECTED without credentials (WAITING_EXTERNAL); not every GroundTruth format is TV; Meta / Google Ads / Vibe /
 *     OpenAI Ads are preserved.
 *   RULING 9 / C5 — "the tenants approve their own ads/posts, etc. assets": approverFor({ brokerageId, assetKind, scope }) picks the
 *     approver from the real authority hierarchy; the brokerage only where policy / law says so; every publish door asks it.
 *   RULING 2 / C2 — requestAudienceReengagement({ brokerageId, partyIds, basis, creativeHint? }) on syncAudience: consent + identity
 *     match + budget + authority inside; never a launch without permitted credentials.
 *
 * Through the survivors at bf67aa63: lib/providers/channel-provider-matrix.ts AD_PLATFORMS (lane 145D), lib/ads/connection-status.ts
 * isAdPlatformConnected (the launch precheck), lib/kernel/ads.ts syncAudience. Driven in memory; nothing launches, nothing is sent.
 *
 * MEASURED AT bf67aa63: no GroundTruth / StackAdapt adapter or AD_PLATFORMS row; lib/kernel/approval-authority.ts and
 * lib/ads/audience-reengagement.ts do not exist.
 */
import { setSvc } from "./_harness"
import { listFiles, strippedRepo } from "./_registry"
import { memSupabase } from "../in-memory-supabase"
import { quiet } from "./wave145-harness"
import { CONTRACTS_146, bind146, callDoor, canary146, errText, jsonOf, rowCounts, tableDiff } from "./wave146-harness"
import { landedModule } from "./_harness"

// ── WAVE146 BIND (lane 146E notes, "## Canary requirements") ── not published at the time of writing; C2 / C5 bind by the spec's names,
// the two adapters by the spec's file pattern (lib/providers/groundtruth-*.ts, lib/providers/stackadapt-*.ts).

const CAPABILITY_CONCEPTS: Array<[string, RegExp]> = [
  ["account access", /account/i], ["campaign creation", /campaign/i], ["creative association", /creative/i], ["budget/approval", /budget|approv/i],
  ["status", /status/i], ["performance readback", /performance|report|insight|metric/i], ["attribution", /attribution|conversion/i], ["CTV inventory", /ctv|connected.?tv|\btv\b/i],
]

async function adapterTruth(name: "groundtruth" | "stackadapt"): Promise<{ files: string[]; exportsJson: string; loadError: string | null }> {
  const files = [...listFiles("lib/providers", (f) => new RegExp(`/${name}[-_][^/]*\\.ts$|/${name}\\.ts$`).test(f)), ...listFiles("lib/ads/connectors", (f) => new RegExp(`/${name}[^/]*\\.ts$`).test(f))]
  let exportsJson = "", loadError: string | null = null
  for (const f of files) {
    try { const mod = await quiet(async () => landedModule<Record<string, unknown>>(`../../${f}`)); exportsJson += jsonOf(Object.fromEntries(Object.entries(mod ?? {}).filter(([, v]) => typeof v !== "function"))) } catch (e) { loadError = `${f}: ${errText(e)}` }
  }
  return { files, exportsJson, loadError }
}

export async function run() {
  const c = canary146("Ads: GroundTruth + StackAdapt are adapters on the existing fabric with truthful capabilities, never connected without credentials · Meta/Google/Vibe/OpenAI preserved · tenants approve their own assets through C5 · audience re-engagement (C2) is consented, matched, budgeted, authorized and never launches without credentials")
  const B = "aaaaaaaa-0146-4000-8000-0000000000e1"

  // ── 1 · RULING 8: the two TV connections as adapters with truthful capability declarations ──
  const matrix = await quiet(async () => import("../../lib/providers/channel-provider-matrix")) as unknown as Record<string, any>
  const AD = (matrix.AD_PLATFORMS ?? {}) as Record<string, Record<string, unknown>>
  const declaredCampaignPlatforms: string[] = []
  for (const name of ["groundtruth", "stackadapt"] as const) {
    const t = await adapterTruth(name)
    const declared = t.exportsJson
    for (const m of declared.matchAll(/"campaignPlatforms"\s*:\s*\[([^\]]*)\]/g)) for (const p of m[1].matchAll(/"([a-z_]+)"/g)) declaredCampaignPlatforms.push(p[1])
    const missingConcepts = CAPABILITY_CONCEPTS.filter(([, re]) => !re.test(declared)).map(([k]) => k)
    const honestUnknown = /unknown|not documented|undocumented|UNKNOWN/i.test(declared) || /"supported"\s*:\s*(true|false)/.test(declared)
    const waiting = /WAITING_EXTERNAL|waiting_external|credential/i.test(declared)
    const notAllTv = name !== "groundtruth" || /display|mobile|audio|native|dooh|\bweb\b|not (every|all)|non.?tv/i.test(declared)
    c.rule("146E", `${name === "groundtruth" ? "GROUNDTRUTH" : "STACKADAPT"} IS AN ADAPTER ON THE EXISTING ADS FABRIC WITH A TRUTHFUL CAPABILITY DECLARATION (ruling 8: 'add them to the EXISTING ads provider fabric as adapters with capability declarations (account access, campaign creation, creative association, budget/approval, status, performance readback, attribution, CTV inventory where the account has it) … Credentials/entitlements are WAITING_EXTERNAL … not every GroundTruth format is TV'): the adapter module exists under lib/providers (or lib/ads/connectors), loads, and its exported declaration names all eight capability concepts with a truth value or UNKNOWN and names its credential (WAITING_EXTERNAL)${name === "groundtruth" ? "; it names formats beyond TV" : ""}`,
      t.files.length > 0 && !t.loadError && missingConcepts.length === 0 && honestUnknown && waiting && notAllTv,
      `files ${t.files.join(", ") || "none"}${t.loadError ? `; LOAD FAILED ${t.loadError}` : ""}; concepts missing ${missingConcepts.join(", ") || "none"}; truth/UNKNOWN stated ${honestUnknown}; credential named ${waiting}${name === "groundtruth" ? `; formats beyond TV ${notAllTv}` : ""}`)
  }
  // WAVE146 BIND (lane 146E notes, 18:58Z requirements 1–4): GROUNDTRUTH_DECLARATION / STACKADAPT_DECLARATION capability truth over
  // every AdCapabilityKey; the TV vocabulary and the connector registry; geography-only targeting; no credential → no transport call.
  await c.check("146E", "THE TWO TV CONNECTIONS DECLARE ONLY WHAT IS TRUE, TARGET BY GEOGRAPHY ONLY, AND NEVER CALL OUT WITHOUT A CREDENTIAL (ruling 8: 'capability declarations … mark unknowns UNKNOWN … Credentials/entitlements are WAITING_EXTERNAL; nothing is marked connected without them'; fair housing: a housing ad audience is never demographic): each declaration states every capability as supported / unsupported / unknown with evidence, claims a BUILT path only for a supported one, keeps UNKNOWN as an answer, declares no lead or reply readback (a TV ad has no reply object), cites its sources and read date; both are TV campaign platforms with a registered connector; neither adapter sends a gender / age / income key; a launch with no stored credential is refused before ANY provider call (positive controls: a planted built-on-unknown and a planted demographic key are caught)", async () => {
    const gt = await quiet(async () => landedModule<Record<string, any>>("../../lib/providers/groundtruth-ads.ts")), sa = await quiet(async () => landedModule<Record<string, any>>("../../lib/providers/stackadapt-ads.ts"))
    if (!gt?.GROUNDTRUTH_DECLARATION || !sa?.STACKADAPT_DECLARATION) return { ok: false, evidence: "lib/providers/groundtruth-ads.ts GROUNDTRUTH_DECLARATION / lib/providers/stackadapt-ads.ts STACKADAPT_DECLARATION not landed — awaiting lane 146E" }
    const DOC = new Set(["supported", "unsupported", "unknown"])
    const problems = (d: Record<string, any>): string[] => {
      const out: string[] = []
      for (const [k, v] of Object.entries((d.capabilities ?? {}) as Record<string, any>)) {
        if (!DOC.has(String(v?.documented))) out.push(`${k}: documented '${v?.documented}'`)
        if (v?.documented !== "supported" && v?.built) out.push(`${k}: BUILT while ${v.documented}`)
        if (!String(v?.evidence ?? "").trim()) out.push(`${k}: no evidence`)
      }
      for (const k of ["lead_readback", "response_readback"]) if (d.capabilities?.[k] && d.capabilities[k].documented !== "unsupported") out.push(`${k} claimed`)
      if (!Array.isArray(d.sources) || d.sources.length === 0 || !d.readOn) out.push("no sources / read date")
      return out
    }
    const gtP = problems(gt.GROUNDTRUTH_DECLARATION), saP = problems(sa.STACKADAPT_DECLARATION)
    const keepsUnknown = Object.values(gt.GROUNDTRUTH_DECLARATION.capabilities ?? {}).some((v) => (v as Record<string, unknown>).documented === "unknown")
    const planted = problems({ ...gt.GROUNDTRUTH_DECLARATION, capabilities: { ...gt.GROUNDTRUTH_DECLARATION.capabilities, provider_review: { documented: "unknown", built: "x.ts y", evidence: "z" } } }).some((p) => /BUILT while unknown/.test(p))
    const voc = await quiet(async () => landedModule<Record<string, any>>("../../lib/integrations/ad-campaign-vocabulary.ts"))
    const tv = (voc?.TV_AD_CAMPAIGN_PLATFORMS ?? []) as readonly string[]
    const tvOk = ["vibe_ctv", "groundtruth", "stackadapt"].every((p) => tv.includes(p))
    const reg = await quiet(async () => landedModule<Record<string, any>>("../../lib/ads/connectors/registry.ts"))
    const connectors = typeof reg?.getConnector === "function" ? ["groundtruth", "stackadapt"].filter((p) => { try { return !!reg.getConnector(p) } catch { return false } }) : []
    const DEMOGRAPHIC = /["']?\b(genders?|ages?|age_range|age_min|age_max|incomes?|household_income|ethnicit\w*|religion|marital\w*)\b["']?\s*:/
    const demoIn = ["lib/providers/groundtruth-ads.ts", "lib/providers/stackadapt-ads.ts", "lib/ads/connectors/groundtruth.ts", "lib/ads/connectors/stackadapt.ts"].filter((f) => DEMOGRAPHIC.test(strippedRepo(f) ?? ""))
    const demoControl = DEMOGRAPHIC.test("const targeting = { genders: [1, 2], geo: x }") && !DEMOGRAPHIC.test("const targeting = { geo: { zip: z } }")
    // No credential → no call: the launch with a resolver answering not_connected records ZERO transport calls.
    const camp = memSupabase({ ad_campaigns: [{ id: "camp-gt", brokerage_id: B, platform: "groundtruth", status: "staged", campaign_name: "TV spot", daily_budget: 50, targeting_config: { geo: { zips: ["32801"] } } }, { id: "camp-sa", brokerage_id: B, platform: "stackadapt", status: "staged", campaign_name: "TV spot", daily_budget: 50, targeting_config: { geo: { zips: ["32801"] } } }] }, { uuidIds: true })
    let calls = 0
    const transport = async () => { calls++; return { ok: true, status: 200, data: {} } }
    const notConnected = async () => ({ status: "not_connected", reason: "no credential stored" })
    const gtL = (await quiet(async () => gt.launchGroundtruthCampaign?.("camp-gt", { transport, client: camp, resolve: notConnected }))) as Record<string, unknown> | undefined
    const saL = (await quiet(async () => sa.launchStackadaptCampaign?.("camp-sa", { transport, client: camp, resolve: notConnected }))) as Record<string, unknown> | undefined
    const refusedNoCall = !!gtL && !!saL && gtL.dispatched !== true && saL.dispatched !== true && calls === 0
    const ok = gtP.length === 0 && saP.length === 0 && keepsUnknown && planted && tvOk && connectors.length === 2 && demoIn.length === 0 && demoControl && refusedNoCall
    return { ok, evidence: `GroundTruth declaration problems ${gtP.slice(0, 3).join("; ") || "none"} (UNKNOWN kept ${keepsUnknown}); StackAdapt ${saP.slice(0, 3).join("; ") || "none"}; planted built-on-unknown caught ${planted}; TV platforms ${tv.join(",") || "∅"}; connectors ${connectors.join(",") || "none"}; demographic keys in ${demoIn.join(", ") || "no adapter"} (control ${demoControl}); no credential → ${gtL ? String(gtL.reason ?? gtL.dispatched).slice(0, 50) : "∅"} / ${saL ? String(saL.reason ?? saL.dispatched).slice(0, 40) : "∅"}, provider calls ${calls}` }
  })

  // The ONE ads truth table (AD_PLATFORMS, lib/providers/channel-provider-matrix.ts — lane 146B owns the file this wave; lane 146E
  // publishes the rows' facts) carries both, never verified-as-connected without a credential.
  const gtRow = Object.entries(AD).find(([k]) => k.includes("groundtruth"))?.[1] ?? null, saRow = Object.entries(AD).find(([k]) => k.includes("stackadapt"))?.[1] ?? null
  c.rule("146B", "THE ONE AD-PLATFORM TRUTH TABLE CARRIES GROUNDTRUTH AND STACKADAPT (ruling 8 'add them to the EXISTING ads provider fabric'; contract C7 — lane 146E publishes the ads rows' facts, lane 146B merges them into lib/providers/channel-provider-matrix.ts): AD_PLATFORMS has a row for each, naming its adapter and readiness row",
    !!gtRow && !!saRow && typeof gtRow.adapter === "string" && typeof saRow.adapter === "string", `AD_PLATFORMS keys ${Object.keys(AD).join(",")}`)

  // ── 2 · …and NOTHING READS CONNECTED WITHOUT CREDENTIALS (the launch precheck on an empty tenant) ──
  const cs = await quiet(async () => import("../../lib/ads/connection-status")) as unknown as Record<string, any>
  const empty = memSupabase({ platform_credentials: [], integration_credentials: [], provider_connections: [], brokerage_integrations: [], connection_os_connections: [], tenant_connections: [], connections: [] }, { uuidIds: true })
  setSvc(empty)
  const campaignKeys = [...new Set([...declaredCampaignPlatforms, ...Object.entries(AD).filter(([k]) => /groundtruth|stackadapt/.test(k)).flatMap(([, v]) => ((v.campaignPlatforms as string[] | undefined) ?? []))])]
  const probes = campaignKeys.length ? campaignKeys : ["groundtruth", "stackadapt"]
  const answers: string[] = []
  let anyConnected = false
  for (const p of probes) {
    try { const r = (await quiet(async () => cs.isAdPlatformConnected(B, p, empty))) as { connected: boolean; reason?: string }; answers.push(`${p} → ${r.connected ? "CONNECTED" : "not connected"}`); if (r.connected) anyConnected = true } catch (e) { answers.push(`${p} → threw ${errText(e)}`) }
  }
  c.rule("146E", "NOTHING IS MARKED CONNECTED WITHOUT ITS CREDENTIALS (ruling 8: 'Credentials/entitlements are WAITING_EXTERNAL; nothing is marked connected without them'): on a tenant with no stored credential the launch precheck (isAdPlatformConnected) reads every GroundTruth / StackAdapt campaign platform as NOT connected",
    campaignKeys.length > 0 && !anyConnected, `${campaignKeys.length ? "" : "no GroundTruth / StackAdapt campaign platform declared yet — probing the bare names; "}${answers.join("; ")}`)

  // ── 3 · PRESERVE: Meta / Google Ads / Vibe / OpenAI Ads stay on the fabric ──
  const keep = ["meta", "google_ads", "vibe_tv", "openai_ads"]
  c.rule("146E", "META, GOOGLE ADS, VIBE (TV) AND OPENAI ADS ARE PRESERVED (lane 146E item 1: 'preserve Meta/Google/Vibe/OpenAI'; green, preserve): each remains an AD_PLATFORMS row with its adapter and readiness row",
    keep.every((k) => !!AD[k] && typeof AD[k].adapter === "string" && typeof AD[k].readinessRow === "string"), `AD_PLATFORMS keys ${Object.keys(AD).join(",")}`)

  // ── 4 · RULING 9 / C5: the approver comes from the real authority hierarchy; the brokerage only when policy says so ──
  const C5 = await bind146(CONTRACTS_146.C5_APPROVER)
  await c.check("146E", "C5 · approverFor PICKS THE TENANT'S OWN AUTHORIZED HUMAN — NEVER ANOTHER TENANT, NEVER THE PLATFORM, AND FAILS CLOSED (ruling 9: 'The tenant-authorized human approves their own ads, posts, videos, assets and publications; brokerage approval only where the tenant/brokerage policy or a legal requirement imposes it; team/agent approvals follow their delegated permissions'): for an agent's own social post with no brokerage policy the agent IS an approver and every approver named is a user OF THAT brokerage (never a platform role, never a foreign tenant's user); a scope naming another tenant's agent never names that tenant's users; when the tenant's policy requires the brokerage for TV spots, the brokerage roster — and not the agent — approves the agent's TV spot; an unreadable approval policy fails closed to the brokerage roster; the publish door refuses another agent's approval of this agent's post (control: the owner's is accepted)", async () => {
    if (!C5.mod) return { ok: false, evidence: C5.evidence }
    const B2 = "aaaaaaaa-0146-4000-8000-0000000000e2", T = "team-146e"
    const users = [
      { id: "u-owner", brokerage_id: B, user_type: "broker_owner", platform_role: null, status: "active" },
      { id: "u-lead", brokerage_id: B, user_type: "team_lead", platform_role: null, status: "active", team_id: T },
      { id: "u-agent", brokerage_id: B, user_type: "agent", platform_role: null, status: "active", team_id: T },
      { id: "u-foreign", brokerage_id: B2, user_type: "broker_owner", platform_role: null, status: "active" },
      { id: "u-staff", brokerage_id: null, user_type: "admin", platform_role: "superadmin", status: "active" },
    ]
    const seed = (settings: Record<string, unknown>[]) => memSupabase({ users, agents: [{ id: "a-agent", user_id: "u-agent", brokerage_id: B, team_id: T, is_active: true }, { id: "a-foreign", user_id: "u-foreign", brokerage_id: B2, team_id: null, is_active: true }], teams: [{ id: T, brokerage_id: B, team_lead_id: "u-lead", deleted_at: null }], team_members: [], user_role_assignments: [], brokerage_settings: settings, tenant_policies: [], approval_policies: [] }, { uuidIds: true })
    const svc = seed([])
    const ask = async (s: unknown, input: Record<string, unknown>) => { setSvc(s); try { return { r: await quiet(async () => callDoor(C5.mod!.approverFor, s, { ...input, client: s })), e: null as string | null } } catch (e) { return { r: null, e: errText(e) } } }
    const own = await ask(svc, { brokerageId: B, assetKind: "social_post", scope: { agentId: "a-agent", teamId: T } })
    const ownJson = jsonOf(own.r)
    const named = users.filter((u) => ownJson.includes(u.id)).map((u) => u.id)
    const foreign = await ask(svc, { brokerageId: B, assetKind: "social_post", scope: { agentId: "a-foreign" } })
    // The brokerage approves ONLY where the tenant's policy says so: with the policy requiring it for TV spots, the agent is not an
    // approver of their own TV spot and the brokerage roster is (the policy's seed shape is the landed module's own key).
    const KEY = String(C5.mod.PUBLICATION_APPROVAL_POLICY_KEY ?? "publication_approval")
    const policySvc = seed([{ id: "bs-1", brokerage_id: B, settings: { [KEY]: { require_brokerage_approval: { tv_spot: { basis: "brokerage_policy" } } } } }])
    const tv = await ask(policySvc, { brokerageId: B, assetKind: "tv_spot", scope: { agentId: "a-agent", teamId: T } })
    const tvJson = jsonOf(tv.r)
    // FAIL CLOSED (lane 146E requirement 5): the tenant's approval POLICY unreadable → the brokerage roster approves (never the agent alone).
    const settingsRefused = memSupabase({ users, agents: [{ id: "a-agent", user_id: "u-agent", brokerage_id: B, team_id: T, is_active: true }], teams: [{ id: T, brokerage_id: B, team_lead_id: "u-lead", deleted_at: null }], team_members: [], user_role_assignments: [] }, { refuse: { brokerage_settings: "permission denied for table brokerage_settings" } })
    const blind = await ask(settingsRefused, { brokerageId: B, assetKind: "social_post", scope: { agentId: "a-agent", teamId: T } })
    const blindJson = jsonOf(blind.r)
    // And the publish door checks the PERSON: another agent of the same brokerage cannot approve this agent's post (control: the owner can).
    let doorEv = "requirePublishApprover not exported", doorOk = false
    if (typeof C5.mod.requirePublishApprover === "function") {
      const doorSvc = seed([])
      ;(doorSvc.tables.users as Array<Record<string, unknown>>).push({ id: "u-agent2", brokerage_id: B, user_type: "agent", platform_role: null, status: "active" })
      ;(doorSvc.tables.agents as Array<Record<string, unknown>>).push({ id: "a-agent2", user_id: "u-agent2", brokerage_id: B, team_id: null, is_active: true })
      doorSvc.tables.social_posts = [{ id: "sp-1", brokerage_id: B, agent_id: "a-agent", user_id: "u-agent", platform: "facebook", status: "draft", approval_status: "pending" }]
      setSvc(doorSvc)
      const other = (await quiet(async () => C5.mod!.requirePublishApprover({ brokerageId: B, assetKind: "social_post", assetTable: "social_posts", assetId: "sp-1", approverUserId: "u-agent2", client: doorSvc }))) as Record<string, unknown>
      const self = (await quiet(async () => C5.mod!.requirePublishApprover({ brokerageId: B, assetKind: "social_post", assetTable: "social_posts", assetId: "sp-1", approverUserId: "u-agent", client: doorSvc }))) as Record<string, unknown>
      doorOk = other.ok === false && self.ok === true
      doorEv = `another agent approves → ${other.ok === false ? "refused" : "ALLOWED"}; the owner agent → ${self.ok === true ? "allowed" : `refused (${String(self.reason ?? "").slice(0, 60)})`}`
    }
    const ownOk = !own.e && named.includes("u-agent") && named.every((id) => ["u-owner", "u-lead", "u-agent"].includes(id)) && !/u-foreign|u-staff|superadmin/.test(ownJson)
    const foreignOk = !/u-foreign|u-staff/.test(jsonOf(foreign.r))
    const policyOk = !tv.e && tvJson.includes("u-owner") && !tvJson.includes("u-agent")
    const blindOk = !blind.e && blindJson.includes("u-owner") && !/"permittedUserIds"\s*:\s*\[[^\]]*"u-agent"/.test(blindJson) && !/"primaryUserIds"\s*:\s*\[[^\]]*"u-agent"/.test(blindJson)
    return { ok: ownOk && foreignOk && policyOk && blindOk && doorOk, evidence: `agent's own post (no brokerage policy) → ${own.e ?? `approver(s) ${named.join(",") || `none named (${ownJson.slice(0, 80)})`}`}; another tenant's agent named as scope → ${foreign.e ?? (foreignOk ? "no foreign / platform user" : "FOREIGN USER NAMED")}; tenant policy requires the brokerage for TV → ${tv.e ?? (policyOk ? "roster only (agent not an approver)" : `wrong (${tvJson.slice(0, 100)})`)}; approval policy unreadable → ${blind.e ?? (blindOk ? "the brokerage roster approves (fail closed)" : `NOT fail-closed (${blindJson.slice(0, 100)})`)}; ${doorEv}` }
  })
  // RE-ASSERTED at bind (lane 146E): a door asks C5 directly (approverFor) or through its publish-time check (requirePublishApprover,
  // the same module) — both are "asking C5"; the doors are every ads / social / video publication module, not a hand-picked list.
  const PUBLISH_DOORS = [...listFiles("lib/social", (f) => /\.ts$/.test(f)), ...listFiles("lib/ads", (f) => /\.ts$/.test(f)), ...listFiles("lib/marketing", (f) => /\/publish[^/]*\.ts$/.test(f)), ...listFiles("app/actions", (f) => /\/(social|ads|ctv)[^/]*\.ts$/.test(f)), "lib/kernel/ads.ts", ...listFiles("lib/video", (f) => /\.ts$/.test(f) && !/\/welcome/.test(f))]
  const askers = PUBLISH_DOORS.filter((f) => /\b(approverFor|requirePublishApprover)\s*\(/.test(strippedRepo(f) ?? ""))
  const families = { ads: askers.some((f) => /ads|ctv/.test(f)), social: askers.some((f) => /social/.test(f)), video: askers.some((f) => /video/.test(f)) }
  // The owner follows the missing family: ads / social doors are lane 146E's; the video door is lane 146F's staging (spec C5:
  // "lane F's staging and lane H's screens call it").
  c.rule(families.ads && families.social && !families.video ? "146F" : "146E", "EVERY PUBLISH DOOR ASKS C5 FOR ITS APPROVER (ruling 9: 'Every publish door picks the approver from the real authority hierarchy and publishes the approved creative version'): at least one door of each family — ads, social, video — asks C5 (approverFor or its publish-time check requirePublishApprover; stripped source)",
    families.ads && families.social && families.video, `doors read ${PUBLISH_DOORS.length}; calling approverFor: ${askers.join(", ") || "none"}`)

  // ── 5 · RULING 2 / C2: audience re-engagement is consented, matched, budgeted, authorized — and never launches without credentials ──
  const C2 = await bind146(CONTRACTS_146.C2_REENGAGE)
  await c.check("146E", "C2 · requestAudienceReengagement IS A GOVERNED RECOMMENDATION FOR A CONSENTED, MATCHED PERSON — NEVER A LAUNCH, NEVER 'EVERYONE' (ruling 2: 'It may recommend audience sync / retargeting / personalized creative for an identity-matched, consented audience. Never spam, never impersonate'; lane 146E item 3: 'consent, identity match, budget, authority, approval gates; no launch without permitted credentials'; fair housing: an audience is never a demographic): a request naming a consented contact, an opted-out one, another brokerage's contact and a platform prospect admits ONLY the consented one, is filed for a human (pending approval — ONE approval item), writes nothing for the others and launches nothing; the same request again reuses it and writes nothing; a demographic basis ('age_55_plus') and an empty party list ('everyone') are refused", async () => {
    if (!C2.mod) return { ok: false, evidence: C2.evidence }
    const B2 = "aaaaaaaa-0146-4000-8000-0000000000e2"
    const svc = memSupabase({
      contacts: [
        // The live consent columns the audience floor reads (lib/ads/audience-eligibility.ts AUDIENCE_CONSENT_COLUMNS) — consented,
        // opted out of everything, and another tenant's consented contact.
        { id: "k-yes", contact_id: "kc-yes", brokerage_id: B, agent_id: "a-e", email: "yes146e@example.test", phone: "+15555550121", tcpa_consent: true, nurture_status: "active", dnc_status: false, email_opt_out: false, email_unsubscribed: false, sms_opt_out: false, sms_unsubscribed: false, phone_opt_out: false, opt_out_channels: [] },
        { id: "k-no", contact_id: "kc-no", brokerage_id: B, agent_id: "a-e", email: "no146e@example.test", tcpa_consent: false, nurture_status: "withdrawn", dnc_status: true, email_opt_out: true, email_unsubscribed: true, sms_opt_out: true, sms_unsubscribed: true, phone_opt_out: true, opt_out_channels: ["all"] },
        { id: "k-foreign", contact_id: "kc-f", brokerage_id: B2, agent_id: "a-x", email: "f146e@example.test", tcpa_consent: true, nurture_status: "active", dnc_status: false, email_opt_out: false, email_unsubscribed: false, sms_opt_out: false, sms_unsubscribed: false, phone_opt_out: false, opt_out_channels: [] },
      ],
      platform_credentials: [], ad_campaigns: [], ad_audiences: [], audience_segments: [], facebook_custom_audiences: [], audience_members: [], ad_manager_actions: [], approval_items: [], agent_action_ledger: [], kernel_events: [], notifications: [],
      users: [{ id: "u-owner-e", brokerage_id: B, user_type: "broker_owner", platform_role: null, status: "active" }, { id: "u-agent-e", brokerage_id: B, user_type: "agent", platform_role: null, status: "active" }],
      agents: [{ id: "a-e", user_id: "u-agent-e", brokerage_id: B, team_id: null, is_active: true }], teams: [], user_role_assignments: [], brokerage_settings: [], platform_prospects: [{ id: "pp-1", email: "p@prospect.example.test" }],
    }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] } })
    setSvc(svc)
    const before = rowCounts(svc.tables)
    // WAVE146 BIND (lane 146E requirement 6): the entitlement / connection seams answer yes, so the GOVERNED half runs — a request
    // that is admitted for the consented party only, filed for a human (pending approval), never uploaded or launched.
    const seams = { entitled: async () => ({ allowed: true }), connected: async () => true }
    const ask = async (input: Record<string, unknown>) => { try { return { r: await quiet(async () => C2.mod!.requestAudienceReengagement({ client: svc, deps: seams, ...input })) as Record<string, any>, e: null as string | null } } catch (x) { return { r: null, e: errText(x) } } }
    const first = await ask({ brokerageId: B, partyIds: ["k-yes", "k-no", "k-foreign", { kind: "platform_prospect", id: "pp-1" }], basis: "inbound_ad_response", creativeHint: "new listings near you" })
    const diff = tableDiff(before, svc.tables)
    const mid = rowCounts(svc.tables)
    const again = await ask({ brokerageId: B, partyIds: ["k-yes", "k-no", "k-foreign", { kind: "platform_prospect", id: "pp-1" }], basis: "inbound_ad_response", creativeHint: "new listings near you" })
    const diff2 = tableDiff(mid, svc.tables)
    const demographic = await ask({ brokerageId: B, partyIds: ["k-yes"], basis: "age_55_plus" })
    const everyone = await ask({ brokerageId: B, partyIds: [], basis: "inbound_ad_response" })
    const live = (svc.tables.ad_campaigns ?? []).filter((x) => /live|active|running/.test(String(x.status)))
    const written = jsonOf(Object.fromEntries(Object.keys(diff).map((t) => [t, (svc.tables[t] ?? []).slice(before[t] ?? 0)])))
    const leakedNo = /k-no|no146e@example\.test/.test(written), leakedForeign = /k-foreign|f146e@example\.test/.test(written)
    const pendingHuman = first.r?.ok === true && /pending/.test(String(first.r?.status)) && first.r?.admitted === 1 && Array.isArray(first.r?.refused) && first.r.refused.length >= 2
    const oneApproval = (svc.tables.approval_items ?? []).length === 1
    const idempotent = again.r?.reused === true && Object.values(diff2).reduce((n, x) => n + x, 0) === 0
    const refusedBases = demographic.r?.ok === false && everyone.r?.ok === false
    const ok = pendingHuman && oneApproval && idempotent && refusedBases && live.length === 0 && !leakedNo && !leakedForeign
    return { ok, evidence: `request → ${first.e ?? `${first.r?.status ?? jsonOf(first.r).slice(0, 80)}, admitted ${first.r?.admitted}, refused ${(first.r?.refused ?? []).length}`}; rows written ${jsonOf(diff)}; approval items ${(svc.tables.approval_items ?? []).length}; same request again → ${again.e ?? `reused ${again.r?.reused}, wrote ${jsonOf(diff2)}`}; basis 'age_55_plus' → ${demographic.r?.ok === false ? "refused" : "ADMITTED"}; no parties → ${everyone.r?.ok === false ? "refused" : "ADMITTED (everyone)"}; live campaigns ${live.length}; unconsented / foreign party written ${leakedNo}/${leakedForeign}` }
  })

  c.blind("The adapters' capability truth is read from their non-function exports and the AD_PLATFORMS row by MEANING (the eight concepts named, a truth value or UNKNOWN stated, the credential WAITING_EXTERNAL) — whether each declared capability matches the vendor's documentation is lane 146E's own sourced notes, not verified here. C5 is driven on a seeded authority hierarchy with no tenant approval policy; the policy-REQUIRES-brokerage branch is re-bound once lane 146E publishes its policy key. C2 is driven through its entitlement/connection seams answering yes (no ad credential exists in the canary), so the REQUEST half — admit, refuse, file for a human, reuse — is proven; what happens AFTER a human approves (syncAudience → provider upload) is lane 146E's test:ads-* proof, not this canary.")
  return c.report([], 0)
}
