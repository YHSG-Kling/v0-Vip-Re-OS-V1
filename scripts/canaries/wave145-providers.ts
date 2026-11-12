/**
 * scripts/canaries/wave145-providers.ts — PROVIDERS / CHANNELS canary (wave 145, lane 145J; owner ruling 13, contracts C1 + C5):
 *   "We no longer use vapi or retell. the channel provider rules are incorrect again." ONE canonical matrix
 *   (lib/providers/channel-provider-matrix.ts — C1) keyed by the nine arbiter channel names; every provider it names is a DECLARED
 *   adapter the code really routes (provider truth — never a hallucinated vendor); email is the provider the outbound email path
 *   actually sends through (the owner said "mailgun I think" — the canary asserts the matrix and the code AGREE, whichever it is);
 *   sms / phone are Twilio; voice drop names a real delivery path; video is a FORMAT, never a channel; Facebook / Instagram ARE Meta;
 *   AD_PLATFORMS carries meta · google_ads · vibe_tv · openai_ads each with a verified flag; ONE TV provider (no second TV
 *   subsystem); the arbiter imports the matrix instead of its inline CHANNEL_PROVIDER_RULES (lane 145E); vapi and retell survive only
 *   as epitaphs (historical rows preserved); the ads gateway takes { topicId, assetId } for TV and refuses an unapproved topic (C5).
 *
 * Through the survivors at b364eb4b: lib/ai-isa/followup-arbiter.ts (ARBITER_CHANNELS, the inline rules), lib/kernel/provider-adapters.ts
 * (adapterFor — the declared adapters), lib/platform/provider-posture.ts (DECOMMISSIONED_PROVIDERS), scripts/vendor-retirement-guard.ts
 * (the epitaph list the spec names), lib/providers/vibe.ts (the CTV dispatch survivor). Nothing is dispatched; no provider is called.
 *
 * MEASURED AT b364eb4b: no channel-provider-matrix module; the arbiter carries an inline CHANNEL_PROVIDER_RULES whose ads row names
 * 'facebook_ads' beside 'meta'; DECOMMISSIONED_PROVIDERS = vapi, heygen (no retell); lib/voice-engine/voice-usage-tracker.ts still
 * prices a 'retell' vendor in code; outbound email is SendGrid (Mailgun is declared inbound_only).
 */
import { LIVE } from "./_harness"
import { listFiles, readRepo, strippedRepo } from "./_registry"
import { stripComments } from "../strip-comments"
import { memSupabase } from "../in-memory-supabase"
import { CONTRACTS, bindContract, canary145, quiet } from "./wave145-harness"

// ── WAVE145 BIND (lane 145D notes, "## Canary requirements", published 15:57Z) ─────────────────────────────────────────────────
// lib/providers/channel-provider-matrix.ts CHANNEL_PROVIDER_MATRIX · CHANNEL_PROVIDER_TRUTH · AD_PLATFORMS · TV_AD_PROVIDER;
// lib/ads/ctv-campaign.ts stageCtvCampaign · ensureCtvBroadcastReady · CTV_TOPIC_APPROVAL_ITEM_TYPES; lib/ads/connection-status.ts
// adCredentialPlatform. Lane 145D's EXACT lists (e.g. sms = twilio/telnyx/bandwidth, google_ads.verified === false) are its internal
// shape / a waypoint — the canary asserts the RULES they satisfy (Twilio carries sms + phone; every provider is a readiness row;
// verified ⇒ the credential can be stored) instead.

type Rule = { categories?: readonly string[]; providers?: readonly string[] }
const providersOf = (r: Rule | undefined): string[] => [...(r?.providers ?? [])]

/** PURE — AD_PLATFORMS as [key, entry] whether the module ships a record or an array of { key|id|platform, … }. */
export function adPlatformEntries(v: unknown): Array<[string, Record<string, unknown>]> {
  if (Array.isArray(v)) return v.map((e) => { const o = (e ?? {}) as Record<string, unknown>; return [String(o.key ?? o.id ?? o.platform ?? o.name ?? ""), o] })
  if (v && typeof v === "object") return Object.entries(v as Record<string, unknown>).map(([k, e]) => [k, (e ?? {}) as Record<string, unknown>])
  return []
}

/** PURE — the RETIRED epitaph map of scripts/vendor-retirement-guard.ts, parsed from its stripped source. */
export function retiredEpitaphs(guardSrc: string): Record<string, string[]> {
  // Two shapes: `vapi: ["file", …]` (b364eb4b) and `vapi: { epitaphs: ["file", …], snakeAware: true }` (lane 145D).
  const block = /const\s+RETIRED\s*(?::[^=]+)?=\s*\{([\s\S]*?)\n\}/.exec(guardSrc)?.[1] ?? ""
  const out: Record<string, string[]> = {}
  for (const m of block.matchAll(/^\s{2}(\w+)\s*:\s*(\[[\s\S]*?\]|\{[\s\S]*?epitaphs\s*:\s*\[[\s\S]*?\][\s\S]*?\})/gm)) {
    const list = /\[([\s\S]*?)\]/.exec(m[2])?.[1] ?? ""
    out[m[1]] = [...list.matchAll(/["']([^"']+)["']/g)].map((x) => x[1])
  }
  return out
}

export async function run() {
  const c = canary145("Providers: ONE channel-provider matrix keyed by the arbiter's nine channels · provider truth (declared, routed, not retired) · email = what the code sends through · twilio for sms/phone · video a format · Meta covers Facebook/Instagram · one TV provider · vapi/retell only as epitaphs · TV takes an approved topic")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: static / in-memory only")
  const arb = await quiet(async () => import("../../lib/ai-isa/followup-arbiter"))
  const pa = await quiet(async () => import("../../lib/kernel/provider-adapters"))
  const posture = await quiet(async () => import("../../lib/platform/provider-posture"))
  const nine = [...(arb.ARBITER_CHANNELS as readonly string[])]
  const C1 = await bindContract(CONTRACTS.C1_MATRIX)
  const matrix = (C1.mod?.CHANNEL_PROVIDER_MATRIX ?? null) as Record<string, Rule> | null

  // ── 1 · C1: ONE matrix, keyed by exactly the arbiter's channel names; video is never a key ──
  const keys = matrix ? Object.keys(matrix).sort() : []
  const SPEC_NINE = ["email", "sms", "phone", "voice_drop", "in_app", "direct_mail", "social", "ads", "human_task"]
  c.rule("145D", "C1 · ONE CANONICAL CHANNEL → PROVIDER MATRIX (ruling 13: 'the channel provider rules are incorrect again'): lib/providers/channel-provider-matrix.ts exports CHANNEL_PROVIDER_MATRIX, AD_PLATFORMS and TV_AD_PROVIDER; the matrix is keyed by EXACTLY the arbiter's channel names (ARBITER_CHANNELS — the spec's nine: email, sms, phone, voice_drop, in_app, direct_mail, social, ads, human_task) — no 'video' key (video is a FORMAT, never a channel), no 'voice' / 'portal' spelling", !!matrix && JSON.stringify(keys) === JSON.stringify([...nine].sort()) && JSON.stringify([...nine].sort()) === JSON.stringify([...SPEC_NINE].sort()) && !keys.includes("video"), `${C1.evidence}; matrix keys ${keys.join(",") || "—"}; ARBITER_CHANNELS ${nine.join(",")}`)

  // ── 2 · PROVIDER TRUTH: every named provider is a declared adapter, not decommissioned, not an alias of another key ──
  const named = matrix ? [...new Set(Object.values(matrix).flatMap((r) => providersOf(r)))] : []
  // WHAT THE READINESS SCAN READS (ruling 13: "report what the code actually routes and what the readiness scan reads"; lane 145D
  // requirement 3): the canonical rows of getBrokerageProviderReadiness, read on an EMPTY tenant (no connection, no credential).
  const readiness = await quiet(() => posture.getBrokerageProviderReadiness(memSupabase({}, { uuidIds: true }) as never, "00000000-0000-4000-8000-000000000145"))
  const rowNames = new Set(readiness.rows.map((r) => r.provider))
  const notRows = named.filter((p) => !rowNames.has(p))
  const retiredNamed = named.filter((p) => posture.DECOMMISSIONED_PROVIDERS.has(p) || /^(vapi|retell)/i.test(p))
  const aliasDupes = named.filter((p) => { const a = pa.adapterFor(p); return !!a && a.provider !== p && named.includes(a.provider) })
  const rowControl = !rowNames.has("facebook_ads") && rowNames.has("twilio") // POSITIVE CONTROL: an alias spelling is not a canonical row
  c.rule("145D", "PROVIDER TRUTH — NO HALLUCINATED, RETIRED OR DOUBLE-SPELLED VENDOR (ruling 13: 'stop hallucinating; verify at HEAD'): every provider the matrix names is a CANONICAL row of the readiness scan (lib/platform/provider-posture.ts getBrokerageProviderReadiness — what 'configured?' is read from), none is retired (vapi / retell / heygen), and no provider appears beside its own alias (Facebook and Instagram ARE Meta — 'facebook_ads' is not a row: positive control)", !!matrix && named.length > 0 && rowControl && notRows.length === 0 && retiredNamed.length === 0 && aliasDupes.length === 0, matrix ? `named ${named.join(",")}; not a readiness row ${notRows.join(",") || "none"}; retired ${retiredNamed.join(",") || "none"}; alias duplicates ${aliasDupes.join(",") || "none"}; control ${rowControl}` : `${C1.evidence}; HEAD's inline rules name: ${["voicedrop", "slybroadcast", "lob", "meta", "google_ads", "facebook_ads"].map((p) => `${p}→${rowNames.has(p) ? "row" : "not a row"}`).join(", ")}`)

  // ── 3 · EMAIL = what the outbound email path really sends through (derived from the adapters, never hardcoded) ──
  const emailSenders = ["sendgrid", "mailgun", "ses", "postmark", "resend", "smtp", "gmail", "outlook"].map((p) => pa.adapterFor(p)).filter((a): a is NonNullable<typeof a> => !!a && /\bemail send\b|\bsend(s)? email\b|outbound email/i.test(a.outputs) && a.lifecycle !== "inbound_only")
  const routedEmail = [...new Set(emailSenders.map((a) => a.provider))]
  const emailRule = matrix?.email
  const emailNamed = [...providersOf(emailRule), ...(emailRule?.categories ?? []).flatMap((cat) => cat === "email" ? routedEmail : [])]
  const mailgunInbound = pa.adapterFor("mailgun")?.lifecycle === "inbound_only"
  c.rule("145D", "EMAIL IS THE PROVIDER THE CODE ACTUALLY SENDS THROUGH (ruling 13: 'email is mailgun I think' — VERIFY): the matrix's email row names exactly the outbound sender(s) the declared adapters route (an inbound-only provider is never the sender); if the owner's Mailgun is to send, the adapter and the dispatcher move with it — the matrix never claims a sender the code does not route", !!matrix && routedEmail.length > 0 && emailNamed.length > 0 && emailNamed.every((p) => routedEmail.includes(p)) && routedEmail.every((p) => emailNamed.includes(p)), `routed outbound email at HEAD: ${routedEmail.join(",") || "none"}; mailgun inbound-only ${mailgunInbound}; matrix email → ${emailRule ? JSON.stringify(emailRule) : "—"}`)

  // ── 4 · SMS + PHONE = Twilio; VOICE DROP names a real delivery path ──
  const twilioish = (r: Rule | undefined) => providersOf(r).some((p) => pa.adapterFor(p)?.provider === "twilio") || (r?.categories ?? []).includes("voice_sms")
  const dropProviders = providersOf(matrix?.voice_drop)
  const dropReal = dropProviders.length > 0 && dropProviders.every((p) => { const a = pa.adapterFor(p); return !!a && /voicemail|voice drop|ringless|call/i.test(a.outputs) })
  const truth = (C1.mod?.CHANNEL_PROVIDER_TRUTH ?? null) as Record<string, { providers?: readonly string[]; supporting?: readonly string[] }> | null
  const ttsSupportsOnly = !dropProviders.some((p) => pa.adapterFor(p)?.provider === "elevenlabs") && (!truth || (truth.voice_drop?.supporting ?? []).includes("elevenlabs"))
  c.rule("145D", "SMS, PHONE → TWILIO; VOICE DROP → A REAL DELIVERY PATH (ruling 13: 'voice, sms, phone = twilio · voice drop = twilio or elevenlabs (a TTS API is not an end-to-end voicemail-drop service — verify the real delivery architecture)'): the sms and phone rows resolve to Twilio; every voice-drop provider is a declared adapter whose output is a delivered voicemail / call; ElevenLabs (audio) is at most a SUPPORTING provider of the drop, never its delivery provider", !!matrix && twilioish(matrix.sms) && twilioish(matrix.phone) && dropReal && ttsSupportsOnly,matrix ? `sms ${JSON.stringify(matrix.sms)}; phone ${JSON.stringify(matrix.phone)}; voice_drop ${dropProviders.map((p) => `${p}: ${pa.adapterFor(p)?.outputs ?? "undeclared"}`).join(" | ") || "none"}` : `${C1.evidence}; elevenlabs outputs '${pa.adapterFor("elevenlabs")?.outputs ?? ""}', voicedrop outputs '${pa.adapterFor("voicedrop")?.outputs ?? ""}'`)

  // ── 5 · ADS: meta · google_ads · vibe_tv · openai_ads each with a verified flag; ONE TV provider ──
  const ads = adPlatformEntries(C1.mod?.AD_PLATFORMS)
  const adKeys = ads.map(([k]) => k)
  const wantAds = ["meta", "google_ads", "vibe_tv", "openai_ads"]
  const flagged = ads.every(([, e]) => typeof e.verified === "boolean")
  const noFbIg = !adKeys.some((k) => /^(facebook|instagram)/.test(k)) && !providersOf(matrix?.ads).some((p) => /^(facebook|instagram)/.test(p))
  const tv = C1.mod?.TV_AD_PROVIDER
  const tvName = typeof tv === "string" ? tv : String((tv as Record<string, unknown> | undefined)?.provider ?? (tv as Record<string, unknown> | undefined)?.key ?? "")
  // ONE TV SUBSYSTEM: the CTV dispatch is DEFINED once (stripped source; a definition is not a call).
  const ctvDispatchers = listFiles("lib", (f) => /\.ts$/.test(f)).filter((f) => /\bexport\s+async\s+function\s+dispatch\w*(Ctv|CTV|StreamingTv|Tv)\w*\s*\(/.test(strippedRepo(f) ?? ""))
  const adMap = Object.fromEntries(ads) as Record<string, Record<string, unknown>>
  const tvRow = String(adMap[tvName]?.readinessRow ?? tvName.replace(/_tv$/, ""))
  const metaCovers = (pa.adapterFor("facebook")?.provider === "meta" && pa.adapterFor("instagram")?.provider === "meta") || ["facebook", "instagram"].every((p) => ((adMap.meta?.campaignPlatforms ?? []) as string[]).includes(p))
  c.rule("145D", "ADS = META (Facebook + Instagram ARE Meta), GOOGLE ADS, TV, CHATGPT ADS — EACH WITH A VERIFIED FLAG; ONE TV PROVIDER (ruling 13: 'tv via vibe (or a better-integrated TV provider if one is already wired — never a second TV subsystem), chatgpt ads only if lib/providers/openai-ads.ts is a real verified capability'): AD_PLATFORMS carries meta, google_ads, vibe_tv and openai_ads, each with verified: boolean; Facebook / Instagram are Meta, never a platform of their own; TV_AD_PROVIDER names ONE platform whose readiness row is a CTV provider, and exactly one module defines a CTV campaign dispatcher", !!C1.mod && wantAds.every((k) => adKeys.includes(k)) && flagged && noFbIg && metaCovers && !!tvName && /tv|streaming/i.test(pa.adapterFor(tvRow)?.outputs ?? "") && ctvDispatchers.length === 1, `AD_PLATFORMS ${adKeys.map((k) => `${k}${adMap[k]?.verified === true ? "✓" : adMap[k]?.verified === false ? "✗" : "?"}`).join(",") || "—"} (verified flags ${flagged}); Meta covers FB/IG ${metaCovers}; TV_AD_PROVIDER ${tvName || "—"} → row ${tvRow}; CTV dispatchers: ${ctvDispatchers.join(", ") || "none"}; ${C1.landed ? "" : C1.evidence}`)

  // A PLATFORM IS 'VERIFIED' ONLY WHEN ITS CREDENTIAL CAN BE STORED (lane 145D requirement 5 — the RULE, never the waypoint
  // "google_ads.verified === false"): verified ⇒ the credential platform is admitted by the live CHECK on platform_credentials.platform.
  const cs = await bindContract({ id: "145D ad credential platform", lane: "145D", file: "lib/ads/connection-status.ts", exports: ["adCredentialPlatform"] })
  const credVocab = (((await import("../check-vocabularies")).CHECK_VOCABULARIES as Record<string, Record<string, string[]>>).platform_credentials?.platform ?? [])
  const googleCred = cs.mod ? String(cs.mod.adCredentialPlatform("google") ?? "") : ""
  const googleAdmitted = !!googleCred && credVocab.includes(googleCred)
  const googleVerified = adMap.google_ads?.verified === true
  c.rule("145D", "NO AD PLATFORM CLAIMS 'VERIFIED' WHILE ITS CREDENTIAL CANNOT BE STORED (ruling 13 provider truth): Google Ads is verified only if its credential platform (adCredentialPlatform('google')) is admitted by the live platform_credentials.platform CHECK (generated vocabulary cache)", !!C1.mod && !!cs.mod && (!googleVerified || googleAdmitted), `${cs.landed ? `adCredentialPlatform('google') → ${googleCred || "∅"}` : cs.evidence}; CHECK admits it ${googleAdmitted}; google_ads verified ${String(adMap.google_ads?.verified)}`)
  if (C1.mod) c.pendingOwner("145D", "GOOGLE ADS BECOMES A VERIFIED AD PLATFORM (ruling 13: 'ads = meta, google ads, tv via vibe …')", googleVerified && googleAdmitted, "Integrator: apply supabase/migrations/m862 (the google_ads credential platform in the platform_credentials CHECK), regenerate scripts/check-vocabularies.ts, then flip AD_PLATFORMS.google_ads.verified — until then Google Ads stays unverified (lane 145D requirement 5)", `google_ads verified ${String(adMap.google_ads?.verified)}; credential admitted ${googleAdmitted}`)

  // ── 6 · C1 wired: the arbiter reads the matrix, its inline rules are gone (lane 145E owns the arbiter file) ──
  const arbSrc = strippedRepo("lib/ai-isa/followup-arbiter.ts") ?? ""
  const importsMatrix = (/from\s+["'][^"']*channel-provider-matrix["']/.test(arbSrc) || /import\(\s*["'][^"']*channel-provider-matrix["']\s*\)/.test(arbSrc)) && /\bCHANNEL_PROVIDER_MATRIX\b/.test(arbSrc)
  const inline = /\bconst\s+CHANNEL_PROVIDER_RULES\s*[:=]/.test(arbSrc)
  c.rule("145E", "C1 WIRED · THE ARBITER READS THE ONE MATRIX (contract C1: 'Lane E replaces the inline CHANNEL_PROVIDER_RULES in lib/ai-isa/followup-arbiter.ts with an import of that module'; lane 145I requirement 3): the arbiter imports channel-provider-matrix, names CHANNEL_PROVIDER_MATRIX and declares no `const CHANNEL_PROVIDER_RULES` of its own (stripped source — a tombstone naming the old table is not a declaration)", importsMatrix && !inline, `imports + names the matrix ${importsMatrix}; inline CHANNEL_PROVIDER_RULES ${inline}`)

  // ── 6b · PROVIDER TRUTH CLOSES THE LOOP (lane 145I requirement 6): every ledgered channel opens an outcome claim, every claim is
  //        reconciled by a provider webhook — ledgered ⊆ claimed ⊆ reconciled (the rule, never the list) ──
  const dispatchSrc = strippedRepo("lib/providers/dispatch.ts") ?? ""
  const callArgs = (src: string, fn: string): string[] => [...src.matchAll(new RegExp(`\\b${fn}\\s*\\(`, "g"))].map((m) => { let d = 1, i = (m.index ?? 0) + m[0].length; const s = i; while (i < src.length && d > 0) { const ch = src[i++]; if (ch === "(") d++; else if (ch === ")") d-- } return src.slice(s, i) })
  const chanOf = (args: string): string | null => /\bchannel\s*:\s*["']([\w-]+)["']/.exec(args)?.[1] ?? null
  const ledgered = new Set(callArgs(dispatchSrc, "ledgerContextFor").map((a) => /^\s*["'][^"']+["']\s*,\s*["']([\w-]+)["']/.exec(a)?.[1]).filter((x): x is string => !!x))
  const claimed = new Set(callArgs(dispatchSrc, "recordOutcomeClaim").map(chanOf).filter((x): x is string => !!x))
  const webhooks = listFiles("app/api/webhooks", (f) => /\.ts$/.test(f))
  const reconciled = new Set(webhooks.flatMap((f) => callArgs(strippedRepo(f) ?? "", "ingestProviderTruth").map(chanOf)).filter((x): x is string => !!x))
  const notClaimed = [...ledgered].filter((ch) => !claimed.has(ch)), notReconciled = [...claimed].filter((ch) => !reconciled.has(ch))
  // POSITIVE CONTROL: the parsers read a ledger context's channel and a claim's channel out of literal calls.
  const loopControl = /^\s*["'][^"']+["']\s*,\s*["']([\w-]+)["']/.exec(callArgs(`withActionLedger(ledgerContextFor("comms.email.send", "email", p), fn)`, "ledgerContextFor")[0] ?? "")?.[1] === "email" && chanOf(callArgs(`await recordOutcomeClaim({ brokerageId, channel: "sms", ref })`, "recordOutcomeClaim")[0] ?? "") === "sms"
  c.rule("145D", "EVERY SENT CHANNEL'S OUTCOME IS CLAIMED AND RECONCILED FROM THE PROVIDER (ruling 13 provider truth; lane 145I requirement 6; Constitution law 5): each channel lib/providers/dispatch.ts ledgers opens a recordOutcomeClaim, and each claimed channel has an ingestProviderTruth caller under app/api/webhooks — ledgered ⊆ claimed ⊆ reconciled (parser positive control included)", loopControl && ledgered.size > 0 && notClaimed.length === 0 && notReconciled.length === 0, `ledgered ${[...ledgered].join(",")}; claimed ${[...claimed].join(",")}; reconciled ${[...reconciled].join(",")}; ledgered-not-claimed ${notClaimed.join(",") || "none"}; claimed-not-reconciled ${notReconciled.join(",") || "none"}`)

  // ── 7 · VAPI + RETELL SURVIVE ONLY AS EPITAPHS (historical rows preserved) ──
  const guardSrc = stripComments(readRepo("scripts/vendor-retirement-guard.ts") ?? "")
  const epitaphs = retiredEpitaphs(guardSrc)
  const runtime = [...listFiles("lib", (f) => /\.tsx?$/.test(f)), ...listFiles("app", (f) => /\.tsx?$/.test(f))]
  const tokenOf = (v: string) => new RegExp(`(?<![A-Za-z0-9])${v}(?![A-Za-z0-9])`, "i") // `retell_ai` is retell (an underscore suffix is still the vendor); VAPID is not vapi
  const offenders = (v: string) => runtime.filter((f) => tokenOf(v).test(strippedRepo(f) ?? "") && !(epitaphs[v] ?? []).includes(f))
  const vapiOff = offenders("vapi"), retellOff = offenders("retell")
  // POSITIVE CONTROL: the token finder sees retell_ai and does not see VAPID.
  const tokenControl = tokenOf("retell").test("vendor: 'retell_ai'") && !tokenOf("vapi").test("VAPID_PUBLIC_KEY")
  // vapi had a registry source, so it must ALSO be decommissioned there; retell never had one (lane 145D Still open 7) — the guard's
  // RETIRED entry is what keeps it dead. The CHANNEL truth rows never name either (lane 145D requirement 6).
  const truthNamesRetired = !!truth && /(?<![A-Za-z0-9])(vapi|retell)(?![A-Za-z0-9])/i.test(JSON.stringify(truth))
  c.rule("145D", "VAPI AND RETELL ARE RETIRED — NAMED ONLY WHERE NAMING THEM KEEPS THEM DEAD (ruling 13: 'We no longer use vapi or retell'; historical rows preserved through the epitaph list in scripts/vendor-retirement-guard.ts): both are in the guard's RETIRED map, vapi (which had a registry source) is DECOMMISSIONED, no channel truth row names either, and no runtime file outside a vendor's epitaph sites names it in code (stripped source; token control: retell_ai IS retell, VAPID is NOT vapi)", tokenControl && "vapi" in epitaphs && "retell" in epitaphs && posture.DECOMMISSIONED_PROVIDERS.has("vapi") && !truthNamesRetired && vapiOff.length === 0 && retellOff.length === 0, `RETIRED keys ${Object.keys(epitaphs).join(",")}; DECOMMISSIONED ${[...posture.DECOMMISSIONED_PROVIDERS].join(",")}; truth rows name a retired vendor ${truthNamesRetired}; vapi outside epitaphs ${vapiOff.join(", ") || "none"}; retell outside epitaphs ${retellOff.join(", ") || "none"}`)

  // ── 8 · C5: TV creative takes an APPROVED topic through the existing ads gateway (lane 145D requirement 7 — driven) ──
  const ctv = await bindContract({ id: "C5 ads gateway (TV side)", lane: "145D", file: "lib/ads/ctv-campaign.ts", exports: ["stageCtvCampaign", "ensureCtvBroadcastReady", "CTV_TOPIC_APPROVAL_ITEM_TYPES"] })
  await c.check("145D", "C5 · THE ADS GATEWAY TAKES { topicId, assetId } FOR TV AND REFUSES AN UNAPPROVED TOPIC (contract C5; ruling 13/22: 'TV ads derive from the topic bank'): stageCtvCampaign stages a CTV draft from an APPROVED topic + asset and stamps the topic on it; the same call with NO approval is refused by name and stages nothing; a topic whose approval is REVOKED after staging is refused again at the broadcast gate (ensureCtvBroadcastReady) — the approval is re-read at the authoritative write", async () => {
    if (!ctv.mod) return { ok: false, evidence: ctv.evidence }
    const B1 = "11111111-1111-4111-8111-111111111111", U1 = "33333333-3333-4333-8333-333333333333", VID = "44444444-4444-4444-8444-444444444444", TOPIC = "55555555-5555-4555-8555-555555555555", CAMP = "66666666-6666-4666-8666-666666666666"
    // The TV-ready creative lane 145D's own guard seeds (a finished, approved, compliance-passed 16:9 spot).
    const video = { id: VID, brokerage_id: B1, title: "Spring market update", status: "completed", video_url: "https://cdn.example/spot.mp4", duration_seconds: 15, format: "16:9", listing_id: null, video_type: "market_update", audience_type: "customer_facing", usage_intent: "public_marketing", contact_id: null, learning_module_id: null, approval_status: "approved", compliance_status: "passed", video_metadata: {} }
    const topic = { id: TOPIC, brokerage_id: B1, topic_title: "Mortgage rates eased this month", status: "fresh", expires_at: "2099-01-01T00:00:00Z" }
    const approval = (over: Record<string, unknown> = {}) => ({ id: `ap-${Math.random().toString(36).slice(2, 8)}`, brokerage_id: B1, item_type: "ctv_topic", item_id: TOPIC, status: "approved", reviewed_at: "2026-10-26T12:00:00Z", ...over })
    const world = (approvals: unknown[], campaign?: Record<string, unknown>) => memSupabase({ ai_video_projects: [video], content_topic_bank: [topic], approval_items: approvals as never[], ad_campaigns: campaign ? [campaign] : [], agent_action_ledger: [] }, { uuidIds: true })
    const stage = (db: ReturnType<typeof world>) => quiet(async () => ctv.mod!.stageCtvCampaign({ brokerageId: B1, agentUserId: U1, topicId: TOPIC, assetId: VID, dailyBudgetCents: 2500, targeting: { zips: ["33602"] }, client: db }) as Promise<{ success: boolean; error?: string }>)
    const okDb = world([approval()]); const ok = await stage(okDb)
    const cfg = ((okDb.tables.ad_campaigns ?? [])[0]?.targeting_config ?? {}) as Record<string, unknown>
    const noDb = world([]); const no = await stage(noDb)
    const staged = { id: CAMP, brokerage_id: B1, platform: "vibe_ctv", status: "draft", daily_budget: 25, targeting_config: { play: "ctv", zips: ["33602"], video_project_id: VID, topic_id: TOPIC, creative_video_url: video.video_url } }
    const revDb = world([approval({ reviewed_at: "2026-10-20T00:00:00Z" }), approval({ status: "rejected", reviewed_at: "2026-10-26T13:00:00Z" })], staged)
    const gate = (await quiet(async () => ctv.mod!.ensureCtvBroadcastReady({ campaignId: CAMP, brokerageId: B1, client: revDb }))) as { ok: boolean; reason?: string }
    const types = ctv.mod.CTV_TOPIC_APPROVAL_ITEM_TYPES as readonly string[]
    return { ok: ok.success && cfg.topic_id === TOPIC && !no.success && /not approved for TV/i.test(no.error ?? "") && (noDb.tables.ad_campaigns ?? []).length === 0 && !gate.ok && /no longer approved for TV/i.test(gate.reason ?? "") && types.includes("ctv_topic"), evidence: `approved → ${ok.success ? `staged, topic stamped ${cfg.topic_id === TOPIC}` : ok.error}; unapproved → ${no.success ? "STAGED" : no.error}; revoked at launch → ${gate.ok ? "PASSED" : gate.reason}; approval types ${types.join(",")}` }
  })

  c.blind("Static: the matrix is judged by its exported DATA and the declared adapters (provider-adapters.ts) — not by sending. 'Routed outbound email' is derived from the adapters' declared outputs/lifecycle, not from a live send. The retired-vendor census reads stripped lib/ + app/ (services/ and root files are the vendor-retirement guard's own corpus).")
  return c.report([], 0)
}
