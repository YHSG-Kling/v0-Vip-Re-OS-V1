/**
 * scripts/channel-provider-matrix-guard.ts — test:channel-provider-matrix (wave 145, lane 145D; contract C1 + C5).
 *
 * THE RULE. lib/providers/channel-provider-matrix.ts says which provider carries each of the nine follow-up channels.
 * Owner ruling 13 (2026-10-27): "the channel provider rules are incorrect again … stop hallucinating". So every row is
 * re-proved here against the code that SENDS (stripped source — a tombstone or a comment is never a call site) and
 * against the ONE readiness scan the arbiter reads (getBrokerageProviderReadiness), never against a belief.
 *
 *   A · shape        the nine channels, identical to the arbiter's ARBITER_CHANNELS; the contract rule is DERIVED from the truth rows
 *   B · rows exist   every provider a rule names is a real readiness row (a rule naming a phantom row can never read ready)
 *   C · email        the outbound egress is SendGrid on the platform key; mailgun / resend / postmark are inbound-only and never in the rule
 *   D · sms / phone  the rule equals the adapters that exist (SMS_ADAPTERS) / the one dial door (Twilio)
 *   E · voice drop   delivery is the ringless-voicemail connector on VOICEDROP_API_KEY; the readiness row can now light; ElevenLabs is audio only
 *   F · social       the rule equals the native publishers; buffer is not one; facebook + instagram fold onto meta
 *   G · ads          AD_PLATFORMS map onto real rows; `verified` never outruns the code (credential storable LIVE, writer = reader, a connector egress)
 *   H · TV           ONE TV provider; the gateway takes { topicId, assetId } and refuses an unapproved topic at stage AND at launch (contract C5)
 *   I · retired      no retired vendor in the matrix; the decommission set is still consumed
 *   J · receive      (wave 146, lane 146B — contract C7, owner ruling 3) every channel and provider declares how it LISTENS
 *                    (webhook / poll / none); every claimed ingress route exists and exports the handler; a documented
 *                    receiver the code does not run is a stated gap, never a claim; the social / email doors land on the
 *                    ONE inbound record (contract C1) — the spine's portal-table write and meta-dm's raw insert are gone
 *
 * Every absence assertion carries a POSITIVE CONTROL (CLAUDE.md §2). Blind spots are printed at the end.
 */
import { readFileSync, readdirSync } from "node:fs"
import { stripComments } from "./strip-comments"
import { runtimeFiles } from "./runtime-roots"
import { memSupabase } from "./in-memory-supabase"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import {
  CHANNEL_PROVIDER_MATRIX, CHANNEL_PROVIDER_TRUTH, AD_PLATFORMS, TV_AD_PROVIDER,
  type ArbiterChannelName,
} from "../lib/providers/channel-provider-matrix"
import { getBrokerageProviderReadiness, DECOMMISSIONED_PROVIDERS } from "../lib/platform/provider-posture"
import { PLATFORM_PROVIDER_KEYS } from "../lib/agentic-os/connector-probe"
import { adapterFor } from "../lib/kernel/provider-adapters"
import { SMS_ADAPTERS } from "../lib/providers/messaging/sms-adapters"
import { adCredentialPlatform } from "../lib/ads/connection-status"
import { stageCtvCampaign, ensureCtvBroadcastReady, launchCtvCampaignOnVibe, CTV_TOPIC_APPROVAL_ITEM_TYPES } from "../lib/ads/ctv-campaign"

let pass = 0, fail = 0
const failures: string[] = []
function check(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const raw = (p: string) => { try { return readFileSync(p, "utf8") } catch { return "" } }
const code = (p: string) => stripComments(raw(p))
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|")

// The ONE readiness scan, driven with an empty tenant (no credential rows) — the row SET is what a rule can name.
const emptyQ: any = { select: () => emptyQ, eq: () => emptyQ, in: () => emptyQ, then: (r: (v: unknown) => unknown) => r({ data: [], error: null }) }
const emptySvc = { from: () => emptyQ }
async function readinessWith(rows: Record<string, Array<Record<string, unknown>>>) {
  const q = (t: string): any => { const b: any = { select: () => b, eq: () => b, in: () => b, then: (r: (v: unknown) => unknown) => r({ data: rows[t] ?? [], error: null }) }; return b }
  return getBrokerageProviderReadiness({ from: q }, "b-1")
}

const CHANNELS: readonly ArbiterChannelName[] = ["email", "sms", "phone", "voice_drop", "in_app", "direct_mail", "social", "ads", "human_task"]

async function main() {
  const empty = await getBrokerageProviderReadiness(emptySvc, "b-1")
  const ROWS = new Map(empty.rows.map((r) => [r.provider, r]))

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section("A · shape — nine channels, the arbiter's own list, the rule DERIVED from the truth rows")
  const keys = Object.keys(CHANNEL_PROVIDER_MATRIX)
  check("CHANNEL_PROVIDER_MATRIX is keyed by exactly the nine arbiter channel names", same(keys, CHANNELS), keys.join(","))
  {
    const arb = code("lib/ai-isa/followup-arbiter.ts")
    const m = arb.match(/ARBITER_CHANNELS\s*=\s*Object\.freeze\(\[([^\]]*)\]/)
    const arbList = m ? [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]) : []
    check("…the same list lib/ai-isa/followup-arbiter.ts ARBITER_CHANNELS declares (read from stripped source)", arbList.length === 9 && same(arbList, CHANNELS), arbList.join(","))
  }
  for (const c of CHANNELS) {
    const t = CHANNEL_PROVIDER_TRUTH[c], rule = CHANNEL_PROVIDER_MATRIX[c]
    check(`${c}: the contract rule is the truth row's providers (no hand-copied second list)`, same(rule.providers ?? [], t.providers) && !rule.categories)
    check(`${c}: the truth row names its send, credential reader, authority, callback, retry and evidence`, [t.send, t.configuredBy, t.authority, t.callback, t.retry, t.evidence, t.ownership, t.cost].every((s) => s.trim().length > 3))
  }
  check("in_app and human_task are EMPTY rules (not provider-gated) — and nothing else is", CHANNELS.filter((c) => (CHANNEL_PROVIDER_MATRIX[c].providers ?? []).length === 0).sort().join(",") === "human_task,in_app")

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section("B · every provider a rule names is a REAL readiness row")
  for (const c of CHANNELS) for (const p of CHANNEL_PROVIDER_MATRIX[c].providers ?? []) {
    check(`${c} → '${p}' is a getBrokerageProviderReadiness row`, ROWS.has(p), `rows: ${[...ROWS.keys()].length}`)
  }
  check("POSITIVE CONTROL: the old arbiter rule's 'facebook_ads' is NOT a row (a rule naming it could never read ready)", !ROWS.has("facebook_ads"))
  check("POSITIVE CONTROL: 'slybroadcast' is not a row either (the drop row is 'voicedrop')", !ROWS.has("slybroadcast") && ROWS.has("voicedrop"))

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section("C · email — SendGrid sends; mailgun / resend / postmark only receive")
  {
    const files = runtimeFiles(".")
    // Stripped source: a tombstone or a comment naming a connector is never an egress (CLAUDE.md §2).
    const egress = (name: string) => files.filter((f) => new RegExp(`connector:\\s*["']${name}["']`).test(stripComments(raw(f))))
    const sg = egress("sendgrid")
    check("POSITIVE CONTROL: the egress finder sees SendGrid's outbound connector (lib/providers/messaging/index.ts)", sg.includes("lib/providers/messaging/index.ts"), sg.join(","))
    for (const p of ["mailgun", "resend", "postmark"]) {
      const hits = egress(p)
      check(`no runtime file calls the gateway as '${p}' (no outbound ${p} path exists)`, hits.length === 0, hits.join(","))
      check(`…and its adapter declares it inbound-only`, adapterFor(p)?.lifecycle === "inbound_only", String(adapterFor(p)?.lifecycle))
      check(`…and the email rule does not name it`, !(CHANNEL_PROVIDER_MATRIX.email.providers ?? []).includes(p))
    }
    const msg = code("lib/providers/messaging/index.ts")
    const sendBody = msg.slice(msg.indexOf("export async function sendEmail"))
    check("sendEmail reads the PLATFORM key (process.env.SENDGRID_API_KEY) and POSTs /v3/mail/send through the gateway", /process\.env\.SENDGRID_API_KEY/.test(sendBody) && /connector:\s*"sendgrid"/.test(sendBody) && /\/v3\/mail\/send/.test(sendBody))
    check("…and resolves NO tenant SendGrid credential (no resolveConnection / credential read in the send)", !/resolveConnection|platform_credentials|integration_credentials/.test(sendBody))
    const emailShelf = empty.rows.filter((r) => r.category === "email").map((r) => r.provider)
    check(`the readiness EMAIL shelf holds ${emailShelf.length} rows (${emailShelf.join(", ")}) — the old {categories:["email"]} rule admitted all of them; the rule now names the sender only`, emailShelf.length > 1 && emailShelf.includes("mailgun") && same(CHANNEL_PROVIDER_MATRIX.email.providers ?? [], ["sendgrid"]))
    const arbDoor = code("app/actions/ai-isa/engage-contact.ts")
    check("the arbiter's door (engage-contact) never asks for the agent-mailbox tier (no sendAsAgentUserId) — gmail / outlook are supporting, not the rule", !/sendAsAgentUserId/.test(arbDoor) && !(CHANNEL_PROVIDER_MATRIX.email.providers ?? []).some((p) => p === "gmail" || p === "outlook"))
  }

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section("D · sms / phone — the adapters that exist, the one dial door")
  check("sms rule == SMS_ADAPTERS keys (twilio, telnyx, bandwidth)", same(CHANNEL_PROVIDER_MATRIX.sms.providers ?? [], Object.keys(SMS_ADAPTERS)), Object.keys(SMS_ADAPTERS).join(","))
  check("POSITIVE CONTROL: plivo / sinch ARE voice_sms rows the old category rule admitted — and have no adapter", ROWS.get("plivo")?.category === "voice_sms" && ROWS.get("sinch")?.category === "voice_sms" && !("plivo" in SMS_ADAPTERS) && !("sinch" in SMS_ADAPTERS))
  {
    const out = code("lib/voice/twilio-outbound.ts")
    check("phone: placeOutboundAiCall dials Twilio with machine detection on", /export async function placeOutboundAiCall/.test(out) && /machineDetection:\s*"Enable"/.test(out))
    check("phone rule == ['twilio'] (a call is never placed on telnyx / bandwidth)", same(CHANNEL_PROVIDER_MATRIX.phone.providers ?? [], ["twilio"]))
  }

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section("E · voice drop — ringless delivery on VOICEDROP_API_KEY; ElevenLabs is the AUDIO")
  {
    const vd = code("lib/voicedrop/orchestrate-voicedrop-send.ts")
    check("delivery: orchestrateVoicedropSend reads process.env.VOICEDROP_API_KEY and calls the gateway as 'voicedrop'", /process\.env\.VOICEDROP_API_KEY/.test(vd) && /connector:\s*"voicedrop"/.test(vd))
    check("audio: a TTS preset is rendered by renderVoiceDrop (ElevenLabs) — the drop never calls ElevenLabs to DELIVER", /renderVoiceDrop\(/.test(vd) && !/connector:\s*"elevenlabs"/.test(vd))
    check("the rule names the deliverer only; elevenlabs is supporting", same(CHANNEL_PROVIDER_MATRIX.voice_drop.providers ?? [], ["voicedrop"]) && CHANNEL_PROVIDER_TRUTH.voice_drop.supporting.includes("elevenlabs"))
    check("the readiness key is mapped: PLATFORM_PROVIDER_KEYS.voicedrop === 'VOICEDROP_API_KEY'", PLATFORM_PROVIDER_KEYS.voicedrop === "VOICEDROP_API_KEY")
    const prev = process.env.VOICEDROP_API_KEY
    delete process.env.VOICEDROP_API_KEY
    const dark = (await readinessWith({})).rows.find((r) => r.provider === "voicedrop")
    process.env.VOICEDROP_API_KEY = "proof-not-a-key"
    const lit = (await readinessWith({})).rows.find((r) => r.provider === "voicedrop")
    if (prev === undefined) delete process.env.VOICEDROP_API_KEY; else process.env.VOICEDROP_API_KEY = prev
    check("POSITIVE CONTROL: with the key unset the voicedrop row reads platform_dark …", dark?.state === "platform_dark" && dark?.ready === false, dark?.state)
    check("…and with the key set it reads live_platform (it could NEVER light before 145D)", lit?.state === "live_platform" && lit?.ready === true, lit?.state)
  }

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section("F · social — the native publishers")
  {
    const pub = code("lib/social/publisher.ts")
    const cases = [...pub.matchAll(/case\s+"([a-z_]+)":/g)].map((m) => m[1])
    check("POSITIVE CONTROL: the case finder sees the publisher's platforms", cases.includes("facebook") && cases.includes("linkedin"), cases.join(","))
    check("buffer is NOT a publisher — and not in the social rule", !cases.includes("buffer") && !(CHANNEL_PROVIDER_MATRIX.social.providers ?? []).includes("buffer"))
    const canon = (p: string) => (p === "facebook" || p === "instagram" ? "meta" : p)
    const published = new Set(cases.map(canon).filter((p) => ROWS.has(p)))
    check("social rule == the publishers that have a readiness row (facebook + instagram fold onto meta)", same(CHANNEL_PROVIDER_MATRIX.social.providers ?? [], [...published]), [...published].join(","))
    check("POSITIVE CONTROL: meta's row is shelved 'leadgen' — the old {categories:['social']} rule missed the main publisher", ROWS.get("meta")?.category === "leadgen")
  }

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section("G · ads — AD_PLATFORMS on real rows; `verified` never outruns the code")
  {
    check("AD_PLATFORMS keys are meta / google_ads / vibe_tv / openai_ads", same(Object.keys(AD_PLATFORMS), ["meta", "google_ads", "vibe_tv", "openai_ads"]))
    check("the ads rule == the AD_PLATFORMS readiness rows", same(CHANNEL_PROVIDER_MATRIX.ads.providers ?? [], Object.values(AD_PLATFORMS).map((a) => a.readinessRow)))
    const campaignVocab = CHECK_VOCABULARIES.ad_campaigns?.platform ?? []
    for (const a of Object.values(AD_PLATFORMS)) {
      check(`${a.key}: readiness row '${a.readinessRow}' exists`, ROWS.has(a.readinessRow))
      check(`${a.key}: its campaign platforms are admitted by the live ad_campaigns CHECK`, a.campaignPlatforms.every((p) => campaignVocab.includes(p)), a.campaignPlatforms.join(","))
    }
    // A tenant connection lights the row (the reason vibe / openai_ads / google_ads are now USER-CONNECTED vendors).
    const conn = await readinessWith({ platform_credentials: [{ platform: "vibe" }, { platform: "openai_ads" }, { platform: "google_ads" }] })
    for (const p of ["vibe", "openai_ads", "google_ads"]) check(`a tenant '${p}' credential reads live_connected`, conn.rows.find((r) => r.provider === p)?.state === "live_connected")
    check("POSITIVE CONTROL: with no credential the same rows are needs_connection (tenant-actionable), never ready", ["vibe", "openai_ads", "google_ads"].every((p) => ROWS.get(p)?.state === "needs_connection"))

    // verified ⟹ credential storable in the LIVE CHECK (files are not the database) ∧ OAuth writer = connector reader ∧ an egress.
    const liveCred = CHECK_VOCABULARIES.platform_credentials?.platform ?? []
    const oauth = code("app/api/integrations/oauth/[provider]/route.ts")
    const writerFor = (oauthProvider: string) => oauth.match(new RegExp(`oauthProvider === "${oauthProvider}" \\? "([a-z_]+)"`))?.[1] ?? null
    const credName: Record<string, { reader: string; writer: string | null; egress: boolean }> = {
      meta: { reader: adCredentialPlatform("facebook"), writer: writerFor("meta_ads"), egress: /graphPost\s*[<(]/.test(code("lib/ads/connectors/meta.ts")) },
      google_ads: { reader: adCredentialPlatform("google"), writer: writerFor("google_ads"), egress: /connector:\s*"google_ads"/.test(code("lib/ads/connectors/google.ts")) },
      vibe_tv: { reader: "vibe", writer: "vibe", egress: /callConnector/.test(code("lib/providers/vibe.ts")) },
      openai_ads: { reader: "openai_ads", writer: "openai_ads", egress: /connector:\s*"openai_ads"/.test(code("lib/providers/openai-ads.ts")) && /\/ad_account/.test(code("lib/providers/openai-ads.ts")) },
    }
    for (const a of Object.values(AD_PLATFORMS)) {
      const c = credName[a.key]
      const derivable = liveCred.includes(c.reader) && c.writer === c.reader && c.egress
      check(`${a.key}: verified=${a.verified} never outruns the code (live-storable '${c.reader}': ${liveCred.includes(c.reader)}, writer '${c.writer}' = reader: ${c.writer === c.reader}, egress: ${c.egress})`, !a.verified || derivable)
      if (!a.verified && derivable) console.log(`  ℹ ${a.key} is now DERIVABLE as verified (m862 applied + the callback writes the reader's name) — flip AD_PLATFORMS.${a.key}.verified`)
    }
    check("POSITIVE CONTROL: the live credential CHECK does NOT admit 'google' — the name the Google Ads callback wrote at b364eb4b", !liveCred.includes("google"))
    check("the Google Ads reader asks for 'google_ads' (adCredentialPlatform), instagram still rides facebook", adCredentialPlatform("google") === "google_ads" && adCredentialPlatform("instagram") === "facebook" && adCredentialPlatform("facebook") === "facebook")
    const mig = readdirSync("supabase/migrations").filter((f) => /^m862-/.test(f))
    const m862 = mig.length ? raw(`supabase/migrations/${mig[0]}`) : ""
    check("m862 admits 'google_ads' and KEEPS every live value (no value dropped)", /'google_ads'/.test(m862) && liveCred.every((v) => m862.includes(`'${v}'`)), liveCred.filter((v) => !m862.includes(`'${v}'`)).join(","))
    check("m862 line 1 is the lane stamp or the APPLIED LIVE stamp (the rule, not the waypoint)", /^-- (WRITTEN, NOT APPLIED \(wave 145, lane 145D\)|── APPLIED LIVE )/.test(m862))
  }

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section("H · TV — ONE provider; the gateway takes { topicId, assetId } and refuses an unapproved topic (contract C5)")
  {
    check("TV_AD_PROVIDER is the AD_PLATFORMS key that runs ad_campaigns 'vibe_ctv'", AD_PLATFORMS[TV_AD_PROVIDER]?.campaignPlatforms.includes("vibe_ctv") === true && Object.values(AD_PLATFORMS).filter((a) => a.campaignPlatforms.includes("vibe_ctv")).length === 1)
    // Stripped source, the definition excluded: a CALL is `dispatchCtvCampaign(` outside `function dispatchCtvCampaign(`.
    const tvCallers = runtimeFiles(".").filter((f) => /\bdispatchCtvCampaign\s*\(/.test(stripComments(raw(f)).replace(/function\s+dispatchCtvCampaign\s*\(/g, "")))
    const tvDefiners = runtimeFiles(".").filter((f) => /function\s+dispatchCtvCampaign\s*\(/.test(stripComments(raw(f))))
    check("ONE TV subsystem: the CTV dispatch is DEFINED once (lib/providers/vibe.ts) and called only from lib/ads (the lane and its connector)", tvDefiners.join(",") === "lib/providers/vibe.ts" && tvCallers.length > 0 && tvCallers.every((f) => f.startsWith("lib/ads/")), `defined: ${tvDefiners.join(",")}; called: ${tvCallers.join(",")}`)
    check("the approval item types the gate reads are published (lane 145G files TV topic approvals with one of them)", CTV_TOPIC_APPROVAL_ITEM_TYPES.length >= 1 && CTV_TOPIC_APPROVAL_ITEM_TYPES.includes("ctv_topic" as never))

    const B1 = "11111111-1111-4111-8111-111111111111", B2 = "22222222-2222-4222-8222-222222222222", U1 = "33333333-3333-4333-8333-333333333333"
    const VID = "44444444-4444-4444-8444-444444444444", TOPIC = "55555555-5555-4555-8555-555555555555", CAMP = "66666666-6666-4666-8666-666666666666"
    const video = { id: VID, brokerage_id: B1, title: "Spring market update", status: "completed", video_url: "https://cdn.example/spot.mp4", duration_seconds: 15, format: "16:9", listing_id: null, video_type: "market_update", audience_type: "customer_facing", usage_intent: "public_marketing", contact_id: null, learning_module_id: null, approval_status: "approved", compliance_status: "passed", video_metadata: {} }
    const topic = (over: Record<string, unknown> = {}) => ({ id: TOPIC, brokerage_id: B1, topic_title: "Mortgage rates eased this month", status: "fresh", expires_at: "2099-01-01T00:00:00Z", ...over })
    const approval = (over: Record<string, unknown> = {}) => ({ id: `ap-${Math.random().toString(36).slice(2, 8)}`, brokerage_id: B1, item_type: "ctv_topic", item_id: TOPIC, status: "approved", reviewed_at: "2026-10-26T12:00:00Z", ...over })
    const world = (o: { topics?: unknown[]; approvals?: unknown[]; refuse?: Record<string, string>; campaign?: Record<string, unknown> } = {}) => memSupabase({
      ai_video_projects: [video], content_topic_bank: (o.topics ?? [topic()]) as never[], approval_items: (o.approvals ?? [approval()]) as never[],
      ad_campaigns: o.campaign ? [o.campaign] : [], agent_action_ledger: [],
    }, { uuidIds: true, refuse: o.refuse })
    const stage = (db: ReturnType<typeof world>, over: Record<string, unknown> = {}) =>
      stageCtvCampaign({ brokerageId: B1, agentUserId: U1, topicId: TOPIC, assetId: VID, dailyBudgetCents: 2500, targeting: { zips: ["33602"] }, client: db as never, ...over } as never)

    {
      const db = world()
      const r = await stage(db)
      const cfg = (db.tables.ad_campaigns[0]?.targeting_config ?? {}) as Record<string, unknown>
      check("an APPROVED topic + asset STAGES the draft, the asset is the creative and the topic is stamped on the row", r.success && db.tables.ad_campaigns.length === 1 && cfg.video_project_id === VID && cfg.topic_id === TOPIC && typeof cfg.topic_approval_item_id === "string", r.success ? "" : r.error)
    }
    const refusedStage = async (label: string, o: Parameters<typeof world>[0], re: RegExp, over: Record<string, unknown> = {}) => {
      const db = world(o)
      const r = await stage(db, over)
      check(label, !r.success && re.test(r.error ?? "") && db.tables.ad_campaigns.length === 0, r.success ? "STAGED" : r.error)
    }
    await refusedStage("a topic with NO approval is refused — no draft row", { approvals: [] }, /not approved for TV/)
    await refusedStage("a topic whose only approval is PENDING is refused", { approvals: [approval({ status: "pending", reviewed_at: null })] }, /not approved for TV/)
    await refusedStage("a topic whose LATEST decision is a rejection is refused (an older approval does not survive it)", { approvals: [approval({ reviewed_at: "2026-10-20T00:00:00Z" }), approval({ status: "rejected", reviewed_at: "2026-10-25T00:00:00Z" })] }, /not approved for TV/)
    await refusedStage("an approval of ANOTHER item type (not a TV-topic approval) is refused", { approvals: [approval({ item_type: "blog_post" })] }, /not approved for TV/)
    await refusedStage("ANOTHER tenant's approval of the topic is refused (tenant-pinned)", { approvals: [approval({ brokerage_id: B2 })] }, /not approved for TV/)
    await refusedStage("ANOTHER tenant's topic is refused (not found in this brokerage)", { topics: [topic({ brokerage_id: B2 })] }, /topic not found/)
    await refusedStage("a REJECTED topic is refused even with an old approval", { topics: [topic({ status: "rejected" })] }, /rejected/)
    await refusedStage("FAIL CLOSED: a refused approval read is a refusal with its reason, never a pass", { refuse: { approval_items: "permission denied for table approval_items" } }, /approval_items read refused/)
    await refusedStage("a mismatched asset / video id pair is refused (one creative per spot)", {}, /assetId and videoProjectId disagree/, { videoProjectId: "77777777-7777-4777-8777-777777777777" })
    {
      const db = world({ topics: [topic({ brokerage_id: null })] })
      const r = await stage(db)
      check("a PLATFORM topic (brokerage_id null) is usable when THIS tenant approved it", r.success, r.success ? "" : r.error)
    }
    {
      const db = world({ approvals: [approval({ item_type: "local_campaign_idea" })] })
      check("POSITIVE CONTROL: an approved local campaign idea (local-intel's existing approval) admits its topic", (await stage(db)).success)
    }
    {
      const db = world()
      const r = await stageCtvCampaign({ brokerageId: B1, agentUserId: U1, videoProjectId: VID, dailyBudgetCents: 2500, targeting: { zips: ["33602"] }, client: db as never })
      check("no topic = the pre-145 listing / video path, unchanged (stages, no topic stamped)", r.success && !(db.tables.ad_campaigns[0]?.targeting_config as Record<string, unknown>)?.topic_id, r.success ? "" : r.error)
    }
    // LAUNCH re-reads the approval at the authoritative write (both launch doors share ensureCtvBroadcastReady).
    const staged = { id: CAMP, brokerage_id: B1, platform: "vibe_ctv", status: "draft", daily_budget: 25, targeting_config: { play: "ctv", zips: ["33602"], video_project_id: VID, topic_id: TOPIC, creative_video_url: video.video_url } }
    {
      const db = world({ approvals: [approval({ reviewed_at: "2026-10-20T00:00:00Z" }), approval({ status: "rejected", reviewed_at: "2026-10-26T13:00:00Z" })], campaign: staged })
      const g = await ensureCtvBroadcastReady({ campaignId: CAMP, brokerageId: B1, client: db as never })
      const l = await launchCtvCampaignOnVibe({ campaignId: CAMP, brokerageId: B1, actorUserId: U1, launchedVia: "ads_manager", client: db as never })
      check("an approval REVOKED after staging is refused at LAUNCH (gate + launch door), the row stays draft", !g.ok && /topic is no longer approved for TV/.test(g.reason) && !l.dispatched && db.tables.ad_campaigns[0].status === "draft", `${g.ok ? "" : g.reason} | ${l.reason}`)
    }
    {
      const db = world({ campaign: staged })
      const g = await ensureCtvBroadcastReady({ campaignId: CAMP, brokerageId: B1, client: db as never })
      check("POSITIVE CONTROL: with the approval intact the topic check PASSES and the gate moves on to the TV master (refused for the master, not the topic)", !g.ok && /no TV master/.test(g.reason) && !/topic/.test(g.reason), g.ok ? "ok" : g.reason)
    }
    const ctv = code("lib/ads/ctv-campaign.ts")
    const gateBody = ctv.slice(ctv.indexOf("export async function ensureCtvBroadcastReady"), ctv.indexOf("export const CTV_AUTO_DAILY_BUDGET_USD"))
    check("ORDER: the topic re-check runs before the video read in the shared gate", gateBody.indexOf("approvedTopicForTv(") > 0 && gateBody.indexOf("approvedTopicForTv(") < gateBody.indexOf(`from("ai_video_projects")`))
    const action = code("app/actions/ctv-ads.ts")
    const inputType = action.match(/export async function stageCtvCampaignAction\(input: \{([^}]*)\}/)?.[1] ?? ""
    check("the server action passes topicId / assetId through and takes the tenant from the session (requireActor), never from its input", /topicId:\s*input\.topicId/.test(action) && /assetId:\s*input\.assetId/.test(action) && /brokerageId:\s*actor\.brokerageId/.test(action) && /topicId/.test(inputType) && !/brokerageId/.test(inputType))
  }

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section("I · retired vendors — never in the matrix")
  {
    const src = raw("lib/providers/channel-provider-matrix.ts")
    const token = (v: string) => new RegExp(`(?<![A-Za-z0-9])${v}(?![A-Za-z0-9])`, "i")
    for (const v of ["vapi", "retell"]) check(`the matrix (raw text, comments included) never names '${v}'`, !token(v).test(src))
    check("POSITIVE CONTROL: the token matcher fires on a bare and a snake_case mention, never on VAPID", token("retell").test("vendor: 'retell_ai'") && token("vapi").test('"vapi"') && !token("vapi").test("VAPID_PUBLIC_KEY"))
    const named = new Set(CHANNELS.flatMap((c) => [...CHANNEL_PROVIDER_TRUTH[c].providers, ...CHANNEL_PROVIDER_TRUTH[c].supporting]))
    check("no provider or supporting provider is in DECOMMISSIONED_PROVIDERS", ![...named].some((p) => DECOMMISSIONED_PROVIDERS.has(p)))
    check("POSITIVE CONTROL: the decommission set is non-empty (the check above could fail)", DECOMMISSIONED_PROVIDERS.size > 0)
  }

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section("J · receive truth — every channel and provider says how it LISTENS (contract C7, owner ruling 3)")
  {
    const VIA = new Set(["webhook", "poll", "none"])
    const routeFile = (route: string) => `app${route}/route.ts`
    /** A claimed ingress is real only if the route file exists AND (stripped) exports the handler its transport needs. */
    const ingressReal = (route: string | undefined, via: string): boolean => {
      if (!route) return false
      const src = code(routeFile(route))
      if (!src) return false
      return via === "poll" ? /export\s+(async\s+)?function\s+GET\b|export\s+const\s+GET\b/.test(src) : /export\s+(async\s+)?function\s+POST\b|export\s+const\s+POST\b/.test(src)
    }
    check("POSITIVE CONTROL: the ingress finder refuses a route that does not exist and accepts one that does", !ingressReal("/api/webhooks/no-such-provider", "webhook") && ingressReal("/api/webhooks/meta-dm", "webhook"))
    for (const c of CHANNELS) {
      const r = CHANNEL_PROVIDER_TRUTH[c].receive
      check(`${c}: receive declares supported / via / events / record`, !!r && VIA.has(r.via) && typeof r.supported === "boolean" && Array.isArray(r.events) && r.record.trim().length > 3)
      check(`${c}: supported ⇔ via is not 'none' (a declaration never contradicts itself)`, r.supported === (r.via !== "none"))
      if (r.supported) {
        check(`${c}: the ${r.via} ingress ${r.route} exists and exports its handler (stripped source)`, ingressReal(r.route, r.via), r.route)
        for (const extra of r.alsoRoutes ?? []) check(`${c}: also-route ${extra} exists`, !!code(routeFile(extra)), extra)
        check(`${c}: a listening channel names the events it takes`, r.events.length > 0)
      } else {
        check(`${c}: a channel that does not listen says WHY (a gap) and claims no events`, r.events.length === 0 && r.gaps.length > 0)
      }
    }
    // Per provider (PROVIDER_RECEIVE_TRUTH): code truth beside the vendor's documented capability.
    const { PROVIDER_RECEIVE_TRUTH } = await import("../lib/providers/channel-provider-matrix")
    for (const [p, t] of Object.entries(PROVIDER_RECEIVE_TRUTH)) {
      check(`provider ${p}: a known channel, a valid transport on both sides, a primary source cited`, (CHANNELS as readonly string[]).includes(t.channel) && VIA.has(t.receive.via) && VIA.has(t.documented.via) && t.documented.source.trim().length > 10)
      check(`provider ${p}: receive.supported ⇔ via is not 'none'`, t.receive.supported === (t.receive.via !== "none"))
      if (t.receive.supported) check(`provider ${p}: its ingress ${t.receive.route} exists and exports its handler`, ingressReal(t.receive.route, t.receive.via), t.receive.route)
      if (t.documented.via !== "none" && !t.receive.supported) check(`provider ${p}: documented (${t.documented.via}) but not received — the gap is STATED, never claimed`, !!t.gap && t.gap.length > 10)
    }
    // Every provider a non-ads channel SENDS through declares its receive side (ads platforms: lane 146E publishes theirs).
    for (const c of CHANNELS.filter((x) => x !== "ads")) {
      for (const p of CHANNEL_PROVIDER_TRUTH[c].providers) check(`${c}/${p}: the sending provider declares its receive side`, p in PROVIDER_RECEIVE_TRUTH)
    }
    check("voice drop is declared NOT listening (no c_dispo_url is sent, no route receives it) — the truth source stays null",
      !CHANNEL_PROVIDER_TRUTH.voice_drop.receive.supported && /source:\s*null/.test(code("lib/outcomes/reconciliation.ts").slice(code("lib/outcomes/reconciliation.ts").indexOf("voice_drop: {"))) && !/c_dispo_url/.test(code("lib/voicedrop/orchestrate-voicedrop-send.ts")))
    check("telnyx / bandwidth are declared NOT listening — the inbound router normalizes Twilio only (stripped source)",
      !PROVIDER_RECEIVE_TRUTH.telnyx.receive.supported && !PROVIDER_RECEIVE_TRUTH.bandwidth.receive.supported && !/telnyx|bandwidth/i.test(code("lib/providers/inbound-router.ts")))
    check("POSITIVE CONTROL: the router text DOES name the provider it normalizes (the absence above is not a blind read)", /twilio/i.test(code("lib/providers/inbound-router.ts")))

    // THE DOORS land on the ONE inbound record (contract C1) — read from stripped source.
    const doors: Array<[string, RegExp]> = [
      ["app/api/webhooks/meta-dm/route.ts", /processInboundCommunication\(/],
      ["app/api/webhooks/meta-dm/route.ts", /ingestInboundSocialEvents\(/],
      ["app/api/webhooks/whatsapp/route.ts", /processInboundCommunication\(/],
      ["app/api/webhooks/linkedin/route.ts", /processInboundCommunication\(/],
      ["app/api/webhooks/linkedin/route.ts", /ingestInboundSocialEvents\(/],
      ["app/api/webhooks/twitter/route.ts", /processInboundCommunication\(/],
      ["app/api/webhooks/twitter/route.ts", /ingestInboundSocialEvents\(/],
      ["app/api/webhooks/inbound-mail/route.ts", /processInboundCommunication\(/],
      ["app/api/providers/inbound/route.ts", /processInboundCommunication\(/],
    ]
    for (const [f, re] of doors) check(`${f} calls ${re.source.replace(/\\\(/, "")} (stripped source)`, re.test(code(f)))
    for (const f of ["app/api/webhooks/whatsapp/route.ts", "app/api/webhooks/linkedin/route.ts", "app/api/webhooks/twitter/route.ts"]) {
      check(`${f} no longer writes a social DM to the PORTAL table through the spine (ingestMessageService)`, !/ingestMessageService/.test(code(f)))
    }
    check("meta-dm no longer inserts its own inbound messages row (the record writes it, once, keyed on message.mid)", !/from\("messages"\)\s*\.insert/.test(code("app/api/webhooks/meta-dm/route.ts")) && /mid/.test(code("app/api/webhooks/meta-dm/route.ts")))
    check("POSITIVE CONTROL: the insert finder sees the record's own messages insert", /from\("messages"\)\.insert/.test(code("lib/communications/inbound-record.ts").replace(/\s+/g, "")))
  }

  console.log(`\n${"═".repeat(72)}`)
  console.log(`BLIND SPOTS (published beside the number):
  · readiness is driven with an EMPTY tenant + in-memory rows; a live tenant's rows are not read here (they are 0 live today).
  · "configured?" for platform keys is the env presence at runtime — this sandbox holds none; the live deployment's env was not read (Vercel env listing refused, 403).
  · a tenant-stored sendgrid credential still reads live_connected on the readiness scan though no sender reads it (lane notes, Still open).
  · AD_PLATFORMS.verified covers code + contract; no live launch has happened on any platform (no tenant ad credential exists).
  · the egress finder reads connector: "<name>" literals; a provider reached through an SDK without the gateway would be invisible to section C (test:egress-coverage owns that census).
  · J proves an ingress route EXISTS and exports its handler; that the provider's console points at it (and that its entitlement — X Account Activity, LinkedIn Community Management, Meta app review — is granted) is WAITING_EXTERNAL and not provable from code.
  · J's documented-capability column cites the vendor's primary source as read on 2026-10-29; a vendor that changes its webhooks later is not re-read here. The ads rows are lane 146E's to publish (exempt from the per-provider receive requirement).`)
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail) { console.log("\nFAILURES:"); for (const f of failures) console.log(`  · ${f}`); console.log(" ❌ CHANNEL_PROVIDER_MATRIX_FAIL"); process.exit(1) }
  console.log(" ✅ CHANNEL_PROVIDER_MATRIX_PASS — every channel's provider is the one the code sends through, and the TV gateway refuses an unapproved topic")
}

main().catch((e) => { console.error(e); process.exit(1) })
