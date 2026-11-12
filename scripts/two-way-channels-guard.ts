/**
 * scripts/two-way-channels-guard.ts — `npm run test:two-way-channels`   (wave 150, lane 150QTV — directives 150Q / 150T / 150V)
 * ─────────────────────────────────────────────────────────────────────────────
 * What this proves, EXECUTED through the real modules on the in-memory client wherever a module can run without a network:
 *   1  CANARY 12 — every arbiter channel declares its RECEIVE side (lib/providers/channel-provider-matrix.ts C7), counted with
 *      its denominator; the gaps are published, never upgraded.
 *   2  CANARY 12 — a FAILED send becomes a staff action at the provider's event (no timer): lib/outcomes/reconciliation-ledger.ts
 *      ingestProviderTruth → lib/kernel/completion-tracking.ts notifyFailedSend → the assigned agent's notification;
 *      ONCE per claim (escalated_at); a confirmation tells nobody; a lead with no agent reaches the staff roster.
 *   3  CANARY 12 — the ONE arbiter refuses a channel whose latest provider verdict is a contradiction (deliveryFailuresFrom, the
 *      readiness check that consumes it), and a later confirmation clears it.
 *   4  CANARY 11 / R4 — persona audiences sync AUTOMATICALLY: approval uploads at once; the existing tick re-syncs by EVIDENCE
 *      (audiencesNeedingResync); every re-upload is a full REPLACE on Meta (usersreplace) and Google (removeAll), so a revocation
 *      leaves; the provider's acknowledgment (fetchAudienceStatus) and the campaign result (fetchStatus) are read back; the
 *      "Sync Now" button and its public endpoint are gone.
 *   5  150Q — preference memory from the person's OWN words on the survivor ledger (contacts.metadata.context_spine.facts):
 *      first-person statements only, tenant-pinned, read back by the arbiter's memory keys and the inbound responder.
 *   6  R7 — the persona-label set covers EVERY persona source (counted per source).
 *   7  C38 / R2 / R5 — the arbiter's input shape: segments (never contact_type), the play → stance mapping enforced in code, a
 *      handwritten card never offered while no pen provider is active.
 *   8  lane 150R Outside-lane 1 — the Lob dispatcher: a back never falls back to the front, the tenant's return address, Lob's
 *      Idempotency-Key header.
 *
 * BLIND SPOTS (published): no live provider is called — Meta usersreplace / CustomAudience fields and Google removeAll are
 * written from the vendors' published references and proven against a stubbed Graph / Ads transport (WAITING_EXTERNAL: a
 * connected ad account); memSupabase has no RLS / CHECK (notifications.channel / priority are compared to the generated
 * vocabulary instead); the cron route and the dashboard are proven by STRIPPED-source census, not rendered or invoked; the
 * preference reader is rule-based English + Spanish only — other languages record nothing (never a guess).
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { registerHooks } from "node:module"
import { stripComments } from "./strip-comments"
import { memSupabase, type MemClient } from "./in-memory-supabase"

const g = globalThis as unknown as { __150QTV_svc?: MemClient; __150QTV_graph?: Array<{ method: string; path: string; body?: unknown }>; __150QTV_graphReply?: (m: string, p: string) => unknown; __150QTV_signals?: unknown[] }
const STUB: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => globalThis.__150QTV_svc",
  "@/lib/kernel/manager-signals": "export const publishManagerSignal = async (s) => { (globalThis.__150QTV_signals ??= []).push(s); return { ok: true } }",
  "@/lib/providers/meta/client":
    "const rec = (method, segs, body) => { const path = segs.join('/'); (globalThis.__150QTV_graph ??= []).push({ method, path, body }); const r = globalThis.__150QTV_graphReply ? globalThis.__150QTV_graphReply(method, path) : {}; return { ok: true, status: 200, data: r, error: null } };" +
    "export const graphGet = async (t, segs, q) => rec('GET', segs, q); export const graphPost = async (t, segs, b) => rec('POST', segs, b);",
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    const body = STUB[spec]
    if (body !== undefined) return { url: `data:text/javascript,${encodeURIComponent(body)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, d?: string) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) } }
const ROOT = process.cwd()
const raw = (p: string) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), "utf8") : "")
const src = (p: string) => stripComments(raw(p))

const A = "00000000-0000-4000-8000-0000000000a0", B = "00000000-0000-4000-8000-0000000000b0"

async function main() {
  // ── 1 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n[1 — canary 12: every channel says how it LISTENS]")
  const matrix = await import("../lib/providers/channel-provider-matrix")
  const rows = Object.entries(matrix.CHANNEL_PROVIDER_TRUTH)
  const listening = rows.filter(([, r]) => r.receive.supported)
  check(`every one of the ${rows.length} arbiter channels declares a receive side (supported / via / record / gaps)`, rows.length === 9 && rows.every(([, r]) => typeof r.receive.supported === "boolean" && !!r.receive.record && Array.isArray(r.receive.gaps)))
  check("a channel that does not listen says so in its gaps (never an empty claim)", rows.every(([, r]) => r.receive.supported || r.receive.gaps.length > 0))
  console.log(`  · listening: ${listening.length}/${rows.length} (${listening.map(([k]) => k).join(", ")}); not listening: ${rows.filter(([, r]) => !r.receive.supported).map(([k]) => k).join(", ") || "none"}`)

  // ── 2 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n[2 — canary 12: a failed send becomes a staff action at the provider's event, once]")
  const seed = () => memSupabase({
    contacts: [{ id: "c-1", brokerage_id: A, first_name: "Rosa", last_name: "Diaz", agent_id: "ag-1" }, { id: "c-2", brokerage_id: A, first_name: "Sam", last_name: "Lee", agent_id: null }],
    leads: [{ id: "l-1", brokerage_id: A, first_name: "Pat", last_name: "Kim", agent_id: null }],
    agents: [{ id: "ag-1", brokerage_id: A, user_id: "u-agent", is_active: true }],
    users: [{ id: "u-broker", brokerage_id: A, user_type: "broker" }, { id: "u-agent", brokerage_id: A, user_type: "agent" }],
    outcome_reconciliations: [
      { id: "r-1", brokerage_id: A, channel: "email", provider_ref: "sg-1", claimed_status: "sent", claimed_at: "2026-11-06T10:00:00Z", verdict: "pending", escalated_at: null, claimed_by_manager: "ai_isa", entity_type: "contact", entity_id: "c-1", contact_id: "c-1", lead_id: null, provider_reported_at: null },
      { id: "r-2", brokerage_id: A, channel: "direct_mail", provider_ref: "lob-1", claimed_status: "mailed", claimed_at: "2026-11-01T10:00:00Z", verdict: "pending", escalated_at: null, claimed_by_manager: "campaign_orchestrator", entity_type: "lead", entity_id: null, contact_id: null, lead_id: "l-1", provider_reported_at: null },
      { id: "r-3", brokerage_id: A, channel: "email", provider_ref: "sg-3", claimed_status: "sent", claimed_at: "2026-11-06T10:00:00Z", verdict: "pending", escalated_at: null, claimed_by_manager: "ai_isa", entity_type: "contact", entity_id: "c-2", contact_id: "c-2", lead_id: null, provider_reported_at: null },
    ],
    notifications: [],
  })
  const svc = seed()
  g.__150QTV_svc = svc
  const ledger = await import("../lib/outcomes/reconciliation-ledger")
  const bounced = await ledger.ingestProviderTruth({ channel: "email", providerRef: "sg-1", truth: { status: "bounce", at: "2026-11-06T10:05:00Z", detail: { reason: "550 mailbox unavailable" } } })
  const n1 = (svc.tables.notifications ?? []).filter((n) => n.type === "delivery_failed")
  check("a bounced email flips the claim to contradicted", bounced.ok && bounced.verdict === "contradicted", JSON.stringify(bounced))
  check("…and the contact's ASSIGNED AGENT (agents.user_id — never agents.id) is told at once, high priority, in-app, with the provider's words",
    n1.length === 1 && n1[0].user_id === "u-agent" && n1[0].priority === "high" && n1[0].channel === "in_app" && /550 mailbox unavailable/.test(String(n1[0].body)) && n1[0].brokerage_id === A, JSON.stringify(n1))
  check("…the notice says nothing was re-sent and the assistant will choose another way (a heads-up, never a re-send)", /Nothing was re-sent/.test(String(n1[0]?.body)) && /choose another way/.test(String(n1[0]?.body)))
  check("…and escalated_at is stamped (the once-only guard)", !!svc.tables.outcome_reconciliations.find((r) => r.id === "r-1")?.escalated_at)
  await ledger.ingestProviderTruth({ channel: "email", providerRef: "sg-1", truth: { status: "dropped", at: "2026-11-06T10:06:00Z" } })
  check("a second failure event on the same claim tells nobody again", (svc.tables.notifications ?? []).filter((n) => n.type === "delivery_failed").length === 1)
  const before = (svc.tables.notifications ?? []).length
  await ledger.ingestProviderTruth({ channel: "email", providerRef: "sg-3", truth: { status: "delivered", at: "2026-11-06T10:05:00Z" } })
  check("CONTROL — a confirmed delivery tells nobody", (svc.tables.notifications ?? []).length === before)
  await ledger.ingestProviderTruth({ channel: "direct_mail", providerRef: "lob-1", truth: { status: "postcard.returned_to_sender", at: "2026-11-05T10:00:00Z" } })
  const n2 = (svc.tables.notifications ?? []).filter((n) => n.type === "delivery_failed" && n.entity_type === "lead")
  check("a returned postcard to an UNASSIGNED lead reaches the staff roster (lead desk), never an agent it is not assigned to", n2.length === 1 && n2[0].user_id === "u-broker" && n2[0].entity_id === "l-1", JSON.stringify(n2))
  const vocab = raw("scripts/check-vocabularies.ts")
  check("the notification's channel / priority are in the live CHECK vocabulary (generated cache)", /notifications: \{\s*channel: \[[^\]]*"in_app"/.test(vocab) && /priority: \[[^\]]*"high"/.test(vocab.slice(vocab.indexOf("notifications: {"))))
  const ledgerSrc = src("lib/outcomes/reconciliation-ledger.ts")
  check("census: the staff notice sits INSIDE the once-only branch (needsManager && !row.escalated_at), on the provider's event — no timer",
    ledgerSrc.indexOf("notifyFailedSend(") > ledgerSrc.indexOf("result.needsManager && !row.escalated_at") && ledgerSrc.indexOf("result.needsManager && !row.escalated_at") > 0 && !/setTimeout|setInterval/.test(src("lib/kernel/completion-tracking.ts").slice(src("lib/kernel/completion-tracking.ts").indexOf("export async function notifyFailedSend"))))

  // ── 3 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n[3 — canary 12: the ONE arbiter routes around a channel the provider rejected]")
  const arb = await import("../lib/ai-isa/followup-arbiter")
  const df = arb.deliveryFailuresFrom([
    { channel: "email", verdict: "contradicted", provider_status: "bounce" },
    { channel: "sms", verdict: "confirmed", provider_status: "delivered" },
    { channel: "sms", verdict: "contradicted", provider_status: "undelivered" },
    { channel: "direct_mail", verdict: "contradicted", provider_status: "returned_to_sender" },
  ])
  check("the newest contradiction refuses the channel (email bounce, mail returned)", df.email === "bounce" && df.direct_mail === "returned_to_sender")
  check("…and a NEWER confirmation clears an older contradiction (sms delivered after undelivered)", df.sms === undefined)
  const arbSrc = src("lib/ai-isa/followup-arbiter.ts")
  check("census: readiness reads outcome_reconciliations pinned to the tenant AND the contact, reads its error, and refuses the channel",
    /from\("outcome_reconciliations"\)[\s\S]{0,200}\.eq\("brokerage_id", a\.brokerageId\)\.eq\("contact_id", a\.contactId\)/.test(arbSrc) && /if \(dr\.error\)/.test(arbSrc) && /const failed = input\.deliveryFailures\?\.\[channel\]\s*\n\s*if \(failed\) refuse\(/.test(arbSrc))
  check("…and the arbiter's own system prompt tells the model the channel is not offered", /the provider said the last message on it did not arrive/.test(raw("lib/ai-isa/followup-arbiter.ts")))
  check("POSITIVE CONTROL — the refusal finder sees a refusal", /const failed = input\.deliveryFailures\?\.\[channel\]\s*\n\s*if \(failed\) refuse\(/.test("const failed = input.deliveryFailures?.[channel]\n    if (failed) refuse(`x`)"))

  // ── 4 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n[4 — canary 11 / R4: automatic audience sync, revocations, provider read-back]")
  const pa = await import("../lib/ads/persona-audience")
  const t0 = "2026-11-05T00:00:00Z", t1 = "2026-11-06T00:00:00Z"
  const aud = memSupabase({
    facebook_custom_audiences: [
      { id: "fa-new", brokerage_id: A, audience_name: "First-time buyers", status: "approved", last_synced_at: null },
      { id: "fa-live-changed", brokerage_id: A, audience_name: "Relocating", status: "synced", last_synced_at: t0 },
      { id: "fa-live-quiet", brokerage_id: B, audience_name: "Downsizers", status: "synced", last_synced_at: t1 },
      { id: "fa-failed", brokerage_id: B, audience_name: "Investors", status: "failed", last_synced_at: t0 },
      { id: "fa-draft", brokerage_id: A, audience_name: "Draft", status: "draft", last_synced_at: null },
    ],
    contacts: [{ id: "c-a", brokerage_id: A, updated_at: t1 }, { id: "c-b", brokerage_id: B, updated_at: t0 }],
    contact_suppression_list: [{ id: "s-a", brokerage_id: A, created_at: t0 }],
  })
  const picked = await pa.audiencesNeedingResync(aud)
  const ids = picked.ok ? picked.audiences.map((a) => a.id).sort() : []
  check("approved-never-uploaded, a failed upload and a live audience whose tenant changed after the last upload are re-synced",
    picked.ok && ids.includes("fa-new") && ids.includes("fa-failed") && ids.includes("fa-live-changed"), JSON.stringify(picked))
  check("…a live audience with nothing new since its upload is NOT re-uploaded, and a draft never is", picked.ok && !ids.includes("fa-live-quiet") && !ids.includes("fa-draft"))
  const revoked = memSupabase({
    facebook_custom_audiences: [{ id: "fa-q", brokerage_id: B, audience_name: "Q", status: "synced", last_synced_at: t1 }],
    contacts: [{ id: "c-b", brokerage_id: B, updated_at: t0 }],
    contact_suppression_list: [{ id: "s-b", brokerage_id: B, created_at: "2026-11-06T12:00:00Z" }],
  })
  const pr = await pa.audiencesNeedingResync(revoked)
  check("a SUPPRESSION after the last upload re-syncs the audience (the revocation leaves on the platform)", pr.ok && pr.audiences.some((a) => a.id === "fa-q" && /eligibility changed/.test(a.reason)), JSON.stringify(pr))
  const blind = memSupabase({ facebook_custom_audiences: [{ id: "fa-z", brokerage_id: B, audience_name: "Z", status: "synced", last_synced_at: t1 }] }, { refuse: { contacts: "permission denied" } })
  const pb = await pa.audiencesNeedingResync(blind)
  check("FAIL TOWARD THE REVOCATION — unreadable evidence re-syncs, and says so", pb.ok && pb.audiences.some((a) => a.id === "fa-z" && /unreadable/.test(a.reason)) && pb.notes.length === 1, JSON.stringify(pb))
  const refusedRead = await pa.audiencesNeedingResync(memSupabase({}, { refuse: { facebook_custom_audiences: "denied" } }))
  check("a refused audience read REFUSES the selection (never 'nothing to sync')", !refusedRead.ok)

  const { metaConnector } = await import("../lib/ads/connectors/meta")
  const cred = { accessToken: "tok", accountId: "123" } as never
  g.__150QTV_graph = []
  g.__150QTV_graphReply = (m, p) => (p.endsWith("customaudiences") ? { id: "aud-9" } : p.endsWith("/users") || p.endsWith("usersreplace") ? { num_received: 2, num_invalid_entries: 0 } : {})
  const created = await metaConnector.pushCustomAudience({ audienceName: "X", externalAudienceId: null, members: [{ email_sha256: "e1" }, { phone_sha256: "p2" }] as never, cred })
  const calls1 = g.__150QTV_graph.map((c) => c.path)
  check("a FIRST upload creates the Meta audience and adds users", created.ok && created.mode === "create" && calls1.some((p) => p.endsWith("customaudiences")) && calls1.some((p) => p === "aud-9/users"), JSON.stringify(calls1))
  g.__150QTV_graph = []
  const replaced = await metaConnector.pushCustomAudience({ audienceName: "X", externalAudienceId: "aud-9", members: [{ email_sha256: "e1" }] as never, cred })
  const calls2 = g.__150QTV_graph
  check("a RE-upload REPLACES the list (usersreplace, one session, last batch) — never an append that keeps a revoked person",
    replaced.ok && replaced.mode === "replace" && calls2.length === 1 && calls2[0].path === "aud-9/usersreplace" && (calls2[0].body as any)?.session?.last_batch_flag === true, JSON.stringify(calls2))
  check("CONTROL — the append path (/users) is NOT used for an existing audience", !calls2.some((c) => c.path === "aud-9/users"))
  g.__150QTV_graph = []
  const emptied = await metaConnector.pushCustomAudience({ audienceName: "X", externalAudienceId: "aud-9", members: [] as never, cred })
  check("everyone revoked → REFUSED with the reason (a person clears the list) — never a silent success that leaves them targeted", !emptied.ok && /Ads Manager/.test(emptied.error ?? "") && g.__150QTV_graph.length === 0)
  g.__150QTV_graphReply = (m, p) => (p.startsWith("aud-9") ? { approximate_count_lower_bound: 1000, approximate_count_upper_bound: 1200, operation_status: { code: 200, description: "Normal" }, delivery_status: { code: 200, description: "This audience is ready for use" } } : { effective_status: "PAUSED", configured_status: "PAUSED" })
  const ack = await metaConnector.fetchAudienceStatus!({ externalAudienceId: "aud-9", cred })
  check("the provider's ACKNOWLEDGMENT is read back verbatim (operation / delivery status, approximate size)", ack.ok && ack.state === "normal" && ack.delivery === "this audience is ready for use" && ack.approxSize.lower === 1000, JSON.stringify(ack))
  const st = await metaConnector.fetchStatus!({ campaignExternalId: "cmp-1", cred })
  check("the CAMPAIGN result is read back (Meta effective_status) for the performance ingest to record", st.ok && st.state === "paused" && st.review === null, JSON.stringify(st))
  const googleSrc = src("lib/ads/connectors/google.ts")
  check("Google Customer Match re-uploads REPLACE too (removeAll first when the list exists)", /replacing \? \[\{ removeAll: true \}, \.\.\.operations\] : operations/.test(googleSrc))
  const kernelAds = src("lib/kernel/ads.ts")
  check("the kernel sync records the provider's acknowledgment on the run (provider_ack), a refused read as read_error", /connector\.fetchAudienceStatus\(/.test(kernelAds) && /provider_ack:/.test(kernelAds) && /read_error:/.test(kernelAds))
  const fas = src("lib/ads/facebook-audience-sync.ts")
  const approveBody = fas.slice(fas.indexOf("export async function approveAudience"), fas.indexOf("export async function deleteAudience"))
  check("APPROVAL uploads at once — approveAudience calls the kernel sync AFTER the counted status flip, on the session actor",
    approveBody.indexOf("kernelSyncAudience({ ctx: actor.ctx, audienceId })") > approveBody.indexOf('update({ status: "approved"') && approveBody.indexOf('update({ status: "approved"') > 0)
  const SYNC_EXPORT = /export\s+async\s+function\s+syncAudience\b/
  check("the manual-sync public endpoint is GONE from the \"use server\" module", !SYNC_EXPORT.test(fas))
  check("POSITIVE CONTROL — the endpoint finder sees one", SYNC_EXPORT.test("export async function syncAudience(_u, p) {}"))
  const dash = src("app/dashboard/campaigns/ads/ads-dashboard-client.tsx")
  check("the ads dashboard has no 'Sync Now' button and no manual sync handler (R4: no extra final Sync button)", !/Sync Now/.test(dash) && !/handleSyncAudience|syncAudience\(/.test(dash))
  check("POSITIVE CONTROL — the button finder sees the retired shape", /Sync Now/.test("<Button onClick={() => handleSyncAudience(a.id)}>Sync Now</Button>"))
  const cron = src("app/api/cron/sync-facebook-audiences/route.ts")
  check("the EXISTING tick selects by evidence (audiencesNeedingResync) — no longer status 'approved' only, and no new cron", /audiencesNeedingResync\(/.test(cron) && !/\.eq\("status", "approved"\)/.test(cron) && /sync-facebook-audiences/.test(raw("lib/kernel/cron-dispatch.ts")))

  // ── 5 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n[5 — 150Q: preference memory from the person's own words]")
  const pm = await import("../lib/kernel/conversation-memory")
  const said = pm.preferencesFromOwnWords("Thanks! Please text me instead, evenings are best. Can you explain it simply? Too many emails lately.")
  const keyed = Object.fromEntries(said.map((p) => [p.key, p.value]))
  check("first-person statements become preferences: channel sms, time evenings, plain explanations, fewer messages",
    keyed.channel_preference === "sms" && keyed.preferred_contact_time === "evenings" && keyed.explanation_style === "plain_language" && keyed.contact_frequency === "fewer", JSON.stringify(said))
  check("…each with the quote that carried it and the person's-word confidence", said.every((p) => p.quote.length > 0 && p.confidence === 0.9))
  const es = pm.preferencesFromOwnWords("Hola, por favor en español. Tenemos que vender primero.")
  check("a stated language maps to the ONE language vocabulary (es)", es.some((p) => p.key === "language" && p.value === "es"), JSON.stringify(es))
  const barrier = pm.preferencesFromOwnWords("We have to sell our house first and we're waiting on pre-approval.")
  check("a stated barrier is remembered (must sell first) — care before pace", barrier.some((p) => p.key === "barrier" && p.value === "must_sell_first"))
  check("NEGATIVE — a sentence that only MENTIONS a channel records nothing", pm.preferencesFromOwnWords("Got your email, thanks.").length === 0)
  check("NEGATIVE — no demographic or age word becomes a preference", pm.preferencesFromOwnWords("He is 72 and retired, the family is Hispanic.").length === 0)
  const mem = memSupabase({ contacts: [{ id: "c-p", brokerage_id: A, metadata: { context_spine: { summary: "s", facts: [] } }, motivation_type: null }] })
  const rec = await pm.rememberStatedPreferences(mem, { brokerageId: A, contactId: "c-p", body: "Please call me, mornings work best.", channel: "sms", providerRef: "SM1", now: new Date("2026-11-06T12:00:00Z") })
  const facts = (mem.tables.contacts[0].metadata?.context_spine?.facts ?? []) as Array<{ key: string; value: string; source: string }>
  check("remembered on the SURVIVOR ledger (contacts.metadata.context_spine.facts) with the message as source",
    rec.recorded === 2 && facts.some((f) => f.key === "channel_preference" && f.value === "phone" && f.source === "person_words:sms:SM1") && facts.some((f) => f.key === "preferred_contact_time" && f.value === "mornings"), JSON.stringify({ rec, facts }))
  const foreign = await pm.rememberStatedPreferences(mem, { brokerageId: B, contactId: "c-p", body: "Please call me.", channel: "sms" })
  check("TENANT-PINNED — another tenant writes nothing (the survivor writer refuses)", foreign.recorded === 0 && !!foreign.error)
  const cm = await import("../lib/kernel/conversation-memory")
  const current = cm.currentMemoryFacts(mem.tables.contacts[0].metadata.context_spine, new Date("2026-11-07T00:00:00Z"))
  check("the arbiter's memory keys admit what was remembered (and nothing protected or financial)",
    current.every((f) => arb.ARBITER_MEMORY_KEYS.includes(f.key)) && ["communication_format", "contact_frequency", "barrier", "explanation_style", "scenario_choice"].every((k) => arb.ARBITER_MEMORY_KEYS.includes(k)) && !arb.ARBITER_MEMORY_KEYS.some((k) => /^(income|household_income|age|age_range|birthday|race|ethnicity|religion|gender|marital_status|commission|net_worth)$/.test(k)))
  const inbound = src("lib/communications/inbound-record.ts")
  check("census: the inbound chain remembers stated preferences BEFORE the arbiter answers, and after a STOP returns",
    inbound.indexOf("rememberStatedPreferences(") > inbound.indexOf("detectOptOutIntent(body)") && inbound.indexOf("rememberStatedPreferences(") < inbound.indexOf("const respond = deps.respond"))
  check("census: the inbound responder lets the person's latest words beat a stored column", /currentMemoryFacts\(mem\.spine\)/.test(src("lib/communications/inbound-responder.ts")))
  check("the arbiter prompt is care-first on these keys (slow down, explain, one kind question)", /contact_frequency 'fewer' or 'pause'/.test(raw("lib/ai-isa/followup-arbiter.ts")))

  // ── 6 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n[6 — R7: every persona source is in the label set]")
  // Wave 152 (lane 152K — row 66): the five persona sources are ONE set, lib/portal/persona-config.ts personaAudienceLabels
  // (intent-interface's second composition, everyPersonaAudienceLabel, is tombstoned).
  const labels = (await import("../lib/portal/persona-config")).personaAudienceLabels()
  check("row 66 — ONE persona label set: intent-interface reads personaAudienceLabels and no second composition remains",
    !/function everyPersonaAudienceLabel\(/.test(src("lib/voice-admin/intent-interface.ts")) && /audienceProxyHits\(audience, personaAudienceLabels\(\)\)/.test(src("lib/voice-admin/intent-interface.ts")))
  const cs = await import("../lib/campaigns/contact-sources")
  const pl = await import("../lib/contacts/persona-layers")
  const aud2 = await import("../lib/compliance-rules/audience-compliance")
  const covered = (word: string) => aud2.audienceProxyHits(word, labels).length === 0
  const personas = cs.CAMPAIGN_PERSONAS.filter((p) => p !== "other")
  const needs = Object.entries(pl.MARKETING_NEEDS)
  check(`every canonical persona (${personas.length}) is admitted as an audience word`, personas.every((p) => covered(p.replace(/_/g, " "))), personas.filter((p) => !covered(p.replace(/_/g, " "))).join(", "))
  check(`every persona-study need label (${needs.length}) is admitted as an audience word`, needs.every(([, n]) => covered((n as { label: string }).label)), needs.filter(([, n]) => !covered((n as { label: string }).label)).map(([k]) => k).join(", "))
  check("CONTROL — a proxy word that is not a persona is still caught", !covered("church-goers"))

  // ── 7 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n[7 — C38 / R2 / R5: the arbiter's input shape]")
  const plan = arbSrc.slice(arbSrc.indexOf("function planWithLifeChangeSignals"), arbSrc.indexOf("export interface ArbiterFacts"))
  check("R2 — the planner reads the moment's SEGMENTS, never contact_type", /person: \{ segments: readonly string\[\] \| null \}/.test(plan) && !/contactType/.test(plan))
  check("…and the call site passes the moment's segments", /\{ segments: sig\.opportunity\?\.moment\?\.segments \?\? null \}/.test(arbSrc))
  check("POSITIVE CONTROL — the contact_type finder sees the retired read", /contactType/.test("const type = (person.contactType ?? '')"))
  check("C38 — the play → stance mapping is enforced in CODE (invite/clarify → act now, explain/match → educate, watch/stay quiet → wait)",
    /PLAY_STANCE[^=]*= Object\.freeze\(\{ invite: "act_now", explain: "educate", match: "educate", clarify: "act_now", watch: "wait", stay_quiet: "wait" \}\)/.test(arbSrc) && /playsStanceRefusal\(decided\.stance/.test(arbSrc))
  check("R5 — a handwritten card is offered on direct mail only when the format router has a pen provider", /routeMailFormat\("handwritten_card"\)\.ok/.test(arbSrc))

  // ── 8 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n[8 — lane 150R Outside-lane 1: the Lob dispatcher]")
  const disp = src("lib/providers/dispatch.ts")
  const FRONT_AS_BACK = /backTemplateId \?\? [^\n]*params\.templateId/
  check("a postcard back / self-mailer outside never falls back to the front", !FRONT_AS_BACK.test(disp) && /back === params\.templateId/.test(disp))
  check("POSITIVE CONTROL — the alias finder sees the retired fallback", FRONT_AS_BACK.test("back: params.backTemplateId ?? process.env.LOB_POSTCARD_BACK_ID ?? params.templateId,"))
  check("the tenant's return address rides `from` when given; Lob's Idempotency-Key header comes from the caller's ledger key",
    /params\.fromAddress/.test(disp) && /"Idempotency-Key": params\.ledger\.idempotencyKey/.test(disp) && (disp.match(/\}, lobHeaders\)/g) ?? []).length === 3)

  console.log("\nBLIND SPOTS: no live provider is called (Meta usersreplace / CustomAudience fields and Google removeAll are proven against a stubbed transport — WAITING_EXTERNAL a connected ad account); memSupabase has no RLS / CHECK; the cron and the dashboard are censused on stripped source, not invoked; the preference reader is English + Spanish rules only.")
  console.log(`\nRESULT: ${pass} passed, ${fail} failed${fail === 0 ? " ✅ TWO_WAY_CHANNELS_PASS" : ""}`)
  if (fail > 0) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
