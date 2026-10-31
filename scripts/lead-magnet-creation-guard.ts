#!/usr/bin/env tsx
/**
 * scripts/lead-magnet-creation-guard.ts  (npm run test:lead-magnet-creation) — in memory, no DB, no network.
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 141, LANE 141E — tenants build their own lead magnets, the AI drafts REAL records a human
 * approves, and an ad's attribution survives the capture. Every rule below drives the REAL kernel
 * commands (lib/kernel/lead-magnets.ts) over scripts/in-memory-supabase.ts; the pure halves are
 * called directly. Every absence assertion carries a POSITIVE CONTROL (CLAUDE.md §2).
 *
 *   A. TENANT BUILDER — a draft is a real row: inactive, fields = canonical + the tenant's own, the
 *      list reads magnet_type from the COLUMN (control: a buyer guide with default fields no longer
 *      lists as a generic form), and a draft REFUSES a capture (control: no submission row lands).
 *   B. AI CREATION — draftLeadMagnetFromConcept: the entitlement gate runs FIRST (a refusal writes
 *      nothing — rows and ledger counted), the model seam's answer lands as a real draft row with
 *      settings.authoring.by = 'ai' and a ledger row marketing.lead_magnet.ai_draft, questions are
 *      ADDED never replacing canonical fields, a HIGH-severity fair-housing hit refuses the AI copy
 *      back to the deterministic baseline with the finding kept on the draft.
 *   C. HUMAN APPROVAL — publishLeadMagnet needs an approver (refused without), activates with a COUNTED
 *      tenant-pinned update, records settings.lifecycle.approved_by + a ledger row
 *      marketing.lead_magnet.publish, mints the QR through the ONE minter (label lead_magnet:<id>).
 *   D. ATTRIBUTION THROUGH INTAKE — a verified campaign stamps contacts.campaign_attribution_id, the
 *      contact-level TCPA consent + a contact_consent_events row, form_submissions.source and a
 *      marketing_campaign_touchpoints row (converted, external_table form_submissions); a FOREIGN
 *      tenant's campaign id is dropped and the capture still succeeds (control); dedup by phone;
 *      the paid-search blind spot is published; topSources is counted, never fabricated.
 *   E. CLONE PROVENANCE — same tenant → a new draft with settings.provenance; another tenant → refused.
 *   F. PROACTIVE IDEAS — the pure suggester (seasonal / local-market / audience gap / underperformer /
 *      test, each with its control) and the runner on the manager-signal bus (deduped on a re-run),
 *      the signal type registered with the coordination kind the feed classifies it as.
 *   G. ADS — the ONE query-string contract round-trips; resolveAdDestination(leadMagnetId) writes it
 *      and fails closed on a draft, another tenant's magnet, or no configured origin.
 *   H. WIRING (stripped source, with positive controls) — the builder passes its channels and uses the
 *      REAL slug, the public page parses + forwards attribution to both forms, the action forwards it,
 *      the ad creator passes lead_magnet_id + the creative, the routing row exists on MODEL_CONFIG keys
 *      and the draft names it literally, the proof is in package.json + MAINTENANCE_DOMAINS, the cron
 *      runs the sweep, the kernel's campaign check is tenant-pinned.
 *
 * BLIND SPOTS (published): the in-memory client models supabase-js grammar, not PostgREST / RLS / the
 * live CHECKs (vocabulary values are read from the vocabulary cache by scripts/check-vocabulary-guard.ts);
 * the model lane and the entitlement gate are seams here (their production survivors are proven by
 * test:ai-routing-coverage / test:cost-completeness and the billing proofs); the live touchpoint channel
 * CHECK has no paid-search value — asserted as a published blind spot, not mapped to a wrong channel.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { memSupabase } from "./in-memory-supabase"
import { blankComments, blankStrings } from "./strip-comments"
import {
  createLeadMagnet, publishLeadMagnet, captureFormSubmission, cloneLeadMagnet, listLeadMagnets, getMagnetPerformance, defaultFieldsForType,
} from "../lib/kernel/lead-magnets"
import {
  draftLeadMagnetFromConcept, classifyConceptMagnetType, composeMagnetDraft, draftFairHousingVerdict, mergeExtraQuestions, LEAD_MAGNET_DRAFT_FEATURE,
} from "../lib/lead-magnets/ai-draft"
import {
  parseLeadMagnetAttribution, leadMagnetLandingUrl, touchpointChannelFor, sourceChannelFor, sanitizeLeadMagnetAttribution, LEAD_MAGNET_ATTRIBUTION_PARAMS,
} from "../lib/lead-magnets/attribution"
import { suggestLeadMagnetIdeas, runLeadMagnetSuggestions, seasonFor, LEAD_MAGNET_SUGGESTION_SIGNAL } from "../lib/lead-magnets/suggestions"
import { resolveAdDestination } from "../lib/ads/ad-destination"
import { signalSpec } from "../lib/kernel/signal-registry"
import { classifyCoordination } from "../lib/kernel/coordination-kind"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}
const root = process.cwd()
const raw = (rel: string) => readFileSync(join(root, rel), "utf8")
const code = (rel: string) => blankComments(raw(rel))

const ORIGIN = "https://proof.lead-magnets.test"
process.env.NEXT_PUBLIC_APP_URL = ORIGIN

// ── Fixture (two tenants; uuid ids because the kernel's attribution parser requires uuid-shaped ids) ──
const A = "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa"
const B = "bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb"
const AGENT_A = "aaaaaaaa-1111-4aaa-8aaa-000000000a01"
const USER_A = "aaaaaaaa-1111-4aaa-8aaa-000000000u01"
const AGENT_B = "bbbbbbbb-2222-4bbb-8bbb-000000000b01"
const USER_B = "bbbbbbbb-2222-4bbb-8bbb-000000000u01"
const CAMP_A = "aaaaaaaa-1111-4aaa-8aaa-00000000ca01"
const CAMP_B = "bbbbbbbb-2222-4bbb-8bbb-00000000cb01"
const AD_CAMP = "aaaaaaaa-1111-4aaa-8aaa-00000000ad01"

function fixture() {
  const client = memSupabase({
    brokerages: [
      { id: A, name: "Alpha Realty", logo_url: null, license_number: "A-1", license_state: "TX" },
      { id: B, name: "Beta Homes", logo_url: null, license_number: "B-1", license_state: "FL" },
    ],
    users: [
      { id: USER_A, brokerage_id: A, first_name: "Ann", last_name: "Agent", email: "ann@alpha.test", phone: null },
      { id: USER_B, brokerage_id: B, first_name: "Bob", last_name: "Broker", email: "bob@beta.test", phone: null },
    ],
    agents: [
      { id: AGENT_A, user_id: USER_A, brokerage_id: A },
      { id: AGENT_B, user_id: USER_B, brokerage_id: B },
    ],
    marketing_campaigns: [
      { id: CAMP_A, brokerage_id: A, campaign_name: "Spring sellers", campaign_type: "ad", status: "active" },
      { id: CAMP_B, brokerage_id: B, campaign_name: "Beta buyers", campaign_type: "ad", status: "active" },
    ],
    lead_capture_forms: [], form_submissions: [], contacts: [], contact_consent_events: [], marketing_campaign_touchpoints: [],
    lifecycle_events: [], agent_action_ledger: [], qr_codes: [], qr_scan_events: [], manager_signals: [], farm_territories: [],
    remotion_composition_renders: [], notifications: [], campaign_sequences: [], sequence_enrollments: [],
  }, { uuidIds: true, stampCreatedAt: true })
  // The kernel's atomic counter is an RPC; the fake has none (its loss is a counter, never the capture).
  ;(client as any).rpc = async () => ({ data: null, error: null })
  return client
}
type Client = ReturnType<typeof fixture>
const rows = (c: Client, t: string) => (c.tables[t] ?? []) as Array<Record<string, any>>
const ledger = (c: Client, action: string) => rows(c, "agent_action_ledger").filter((r) => r.action === action)

// Quiet the kernel's best-effort warnings (every refusal is still asserted through the rows).
const realWarn = console.warn, realError = console.error
console.warn = () => {}
console.error = () => {}
// Background best-effort work the kernel fires and forgets (enrichment queue, delivery, handoff) reaches
// server-only modules that cannot load under tsx; Node 22 raises an UNHANDLED rejection as a crash. Each
// one is RECORDED here (and printed at the end) — a proof that dies on a background import proves nothing.
const backgroundRejections: string[] = []
process.on("unhandledRejection", (e) => { backgroundRejections.push(String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join(" | ")) })

async function main() {
  const c = fixture()

  // ── A. TENANT BUILDER ──────────────────────────────────────────────────────
  console.log("\n── A. a tenant builds its own lead magnet as a DRAFT (real row, inactive, own questions) ──")
  const extra = [{ label: "When are you planning to move?", type: "select", required: true, options: ["0-3 months", "3-6 months", "6-12 months"] }, { label: "Anything else?", type: "textarea" }]
  const ownFields = mergeExtraQuestions(defaultFieldsForType("buyer_guide"), extra)
  const a1 = await createLeadMagnet({ title: "First-time buyer guide", description: "d", magnetType: "buyer_guide", brokerageId: A, agentId: AGENT_A, createdBy: USER_A, fields: ownFields, publishState: "draft" }, { client: c })
  check("A1 createLeadMagnet(draft) succeeds with a real slug", a1.success && !!a1.magnetId && /^first-time-buyer-guide-[a-z0-9]+$/.test(a1.slug ?? ""), JSON.stringify(a1))
  const a1row = rows(c, "lead_capture_forms").find((r) => r.id === a1.magnetId)!
  check("A2 the draft row is INACTIVE with settings.lifecycle.state = draft and magnet_type stamped", a1row?.is_active === false && a1row?.settings?.lifecycle?.state === "draft" && a1row?.magnet_type === "buyer_guide")
  check("A3 fields = the canonical fields + the tenant's own (select carries its options; names derived from labels)",
    a1row.fields.length === defaultFieldsForType("buyer_guide").length + 2 && a1row.fields.some((f: any) => f.name === "when_are_you_planning_to_move" && f.type === "select" && f.options?.length === 3 && f.required === true))
  check("A4 mergeExtraQuestions never removes a canonical field and caps extras at 4",
    mergeExtraQuestions(defaultFieldsForType("home_valuation"), [1, 2, 3, 4, 5, 6].map((i) => ({ label: `Q${i}` }))).length === defaultFieldsForType("home_valuation").length + 4
    && mergeExtraQuestions(defaultFieldsForType("home_valuation"), [{ label: "Email" }]).filter((f) => f.name === "email").length === 1)
  const list1 = await listLeadMagnets({ brokerageId: A }, { client: c })
  const listed = list1.magnets?.find((m) => m.id === a1.magnetId)
  check("A5 listLeadMagnets reads magnet_type from the COLUMN (buyer_guide), lifecycleState draft, authoredBy human",
    listed?.magnetType === "buyer_guide" && listed?.lifecycleState === "draft" && listed?.authoredBy === "human" && listed?.clonedFromId === null)
  check("A5 control — the old first-field sniff would have called this buyer guide a generic form",
    (a1row.fields[0]?.name === "property_address" ? "home_valuation" : "generic_form") === "generic_form")
  const subsBefore = rows(c, "form_submissions").length
  const refused = await captureFormSubmission({ formId: a1.magnetId!, brokerageId: A, submissionData: { first_name: "Vi", last_name: "Sitor", email: "vi@visitor.test" }, tcpaConsentGiven: true }, { client: c })
  check("A6 a DRAFT refuses a capture (fail closed) and writes no submission row", !refused.success && /no longer accepting/.test(refused.error ?? "") && rows(c, "form_submissions").length === subsBefore)
  check("A7 createLeadMagnet without publishState stays the live one-shot create (programmatic callers unchanged)",
    await createLeadMagnet({ title: "Live legacy", description: "", magnetType: "generic_form", brokerageId: B, agentId: AGENT_B, createdBy: USER_B }, { client: c }).then((r) => r.lifecycleState === "published" && rows(c, "lead_capture_forms").find((x) => x.id === r.magnetId)?.is_active === true))

  // ── B. AI CREATION ─────────────────────────────────────────────────────────
  console.log("\n── B. the AI creates the ACTUAL draft (gate first, real row, ledger, fair housing) ──")
  check("B1 classifyConceptMagnetType routes concepts onto the canonical types",
    classifyConceptMagnetType("what is my home worth in a changing market") === "home_valuation"
    && classifyConceptMagnetType("a guide for first-time buyers") === "buyer_guide"
    && classifyConceptMagnetType("spring selling guide for homeowners") === "seller_guide"
    && classifyConceptMagnetType("monthly market report") === "market_report"
    && classifyConceptMagnetType("open house RSVP for Saturday") === "open_house"
    && classifyConceptMagnetType("be first to new listings") === "listing_alert"
    && classifyConceptMagnetType("ask us anything") === "generic_form")
  const baseline = composeMagnetDraft("seller_guide", "c", {}, null)
  check("B2 composeMagnetDraft(null) is the deterministic baseline (fromAi false, canonical fields only)",
    baseline.fromAi === false && baseline.spec.headline.length > 0 && baseline.spec.fields.length === defaultFieldsForType("seller_guide").length)
  check("B3 draftFairHousingVerdict passes clean copy and flags HIGH-severity steering (control)",
    draftFairHousingVerdict(baseline.spec).ok === true
    && draftFairHousingVerdict({ ...baseline.spec, subhead: "An exclusive neighborhood for the right people" }).ok === false)

  const rowsBefore = rows(c, "lead_capture_forms").length
  const refusedGate = await draftLeadMagnetFromConcept(
    { brokerageId: A, agentId: AGENT_A, createdBy: USER_A, concept: "A spring selling guide for homeowners thinking about listing" },
    { client: c, entitlement: async () => ({ allowed: false, reason: "ai_budget_exhausted", message: "AI budget used up" }), generator: async () => { throw new Error("the model must not be called after a refusal") } },
  )
  check("B4 an entitlement refusal writes NOTHING — no row, no ledger row, and the model is never called",
    !refusedGate.success && /AI budget used up/.test(refusedGate.error ?? "") && rows(c, "lead_capture_forms").length === rowsBefore && ledger(c, "marketing.lead_magnet.ai_draft").length === 0)

  let generatorCalls = 0
  const drafted = await draftLeadMagnetFromConcept(
    { brokerageId: A, agentId: AGENT_A, createdBy: USER_A, concept: "A spring selling guide for homeowners thinking about listing", area: "Austin, TX" },
    {
      client: c,
      entitlement: async (ask) => ({ allowed: ask.brokerageId === A && ask.estTokens > 0, reason: "subscription_current" }),
      generator: async (req) => {
        generatorCalls++
        return req.magnetType === "seller_guide" ? {
          name: "Sell smarter this spring", description: "Two sentences.", headline: "Sell smarter this spring", subhead: "Price, prep and marketing that gets homes sold.",
          cta: "Send me the guide", bullets: ["Pricing strategy", "Prep that pays", "Modern marketing"], thankYou: "Thanks — check your inbox.",
          questions: [{ label: "When are you planning to sell?", type: "select", options: ["0-3 months", "3-6 months"] }, { label: "What matters most to you?", type: "textarea" }],
          faq: [{ question: "How do I price my home?", answer: "To the market, not to a wish." }],
        } : null
      },
    },
  )
  check("B5 draftLeadMagnetFromConcept creates a REAL draft row from the concept (type classified, slug minted)",
    drafted.success && drafted.magnetType === "seller_guide" && !!drafted.magnetId && generatorCalls === 1 && drafted.fromAi === true, JSON.stringify(drafted))
  const draftRow = rows(c, "lead_capture_forms").find((r) => r.id === drafted.magnetId)!
  check("B6 the AI draft row is INACTIVE, authored by AI, with the model's landing copy and FAQ persisted",
    draftRow?.is_active === false && draftRow?.settings?.lifecycle?.state === "draft" && draftRow?.settings?.authoring?.by === "ai"
    && draftRow?.settings?.authoring?.feature === LEAD_MAGNET_DRAFT_FEATURE && draftRow?.landing_content?.headline === "Sell smarter this spring" && draftRow?.landing_content?.faq?.length === 1)
  check("B7 the AI's questions were ADDED to the canonical fields (never replacing them)",
    draftRow.fields.length === defaultFieldsForType("seller_guide").length + 2 && draftRow.fields.some((f: any) => f.name === "email") && draftRow.fields.some((f: any) => f.name === "when_are_you_planning_to_sell"))
  const aiLedger = ledger(c, "marketing.lead_magnet.ai_draft")
  check("B8 evidence: one ledger row marketing.lead_magnet.ai_draft, executed, actor the requesting user, risk LOW_RISK_WRITE",
    aiLedger.length === 1 && aiLedger[0].status === "executed" && aiLedger[0].actor_user_id === USER_A && aiLedger[0].risk_class === "LOW_RISK_WRITE" && aiLedger[0].outcome === "draft_created")
  check("B9 the list shows the AI draft as authoredBy ai", (await listLeadMagnets({ brokerageId: A }, { client: c })).magnets?.find((m) => m.id === drafted.magnetId)?.authoredBy === "ai")

  const fh = await draftLeadMagnetFromConcept(
    { brokerageId: A, agentId: AGENT_A, createdBy: USER_A, concept: "A buyer guide for families moving to the suburbs", magnetType: "buyer_guide" },
    { client: c, entitlement: async () => ({ allowed: true, reason: "subscription_current" }), generator: async () => ({ headline: "The exclusive neighborhood guide", subhead: "Perfect for families", bullets: ["x"] }) },
  )
  const fhRow = rows(c, "lead_capture_forms").find((r) => r.id === fh.magnetId)!
  check("B10 a HIGH-severity fair-housing hit refuses the AI copy: the draft lands on the baseline, with the finding kept on it",
    fh.success && fh.fromAi === false && /fair-housing/.test(fh.fallbackReason ?? "") && fhRow?.landing_content?.headline !== "The exclusive neighborhood guide"
    && Array.isArray(fhRow?.settings?.authoring?.fair_housing_flags) && fhRow.settings.authoring.fair_housing_flags.length > 0)

  // ── C. HUMAN APPROVAL ──────────────────────────────────────────────────────
  console.log("\n── C. publish is the HUMAN approval (approver required, counted, ledgered, QR through the one minter) ──")
  const noActor = await publishLeadMagnet({ magnetId: drafted.magnetId!, brokerageId: A, channels: ["landing_page"], actorUserId: "", baseUrl: ORIGIN }, { client: c })
  check("C1 publish without an approving user is refused and the row stays a draft", !noActor.success && rows(c, "lead_capture_forms").find((r) => r.id === drafted.magnetId)?.is_active === false)
  const foreign = await publishLeadMagnet({ magnetId: drafted.magnetId!, brokerageId: B, channels: ["landing_page"], actorUserId: USER_B, baseUrl: ORIGIN }, { client: c })
  check("C2 another tenant cannot publish this draft (absent for them)", !foreign.success && rows(c, "lead_capture_forms").find((r) => r.id === drafted.magnetId)?.is_active === false)
  // The real minter is server-only (lib/marketing/tracked-qr.ts); this fake writes the same row shape on
  // the same client so the publish → QR hook (label, purpose, tenant, target) is observable here.
  const fakeMinter: NonNullable<Parameters<typeof publishLeadMagnet>[1]>["mintTrackedQr"] = async (args, svc) => {
    const slug = `qr-${Math.random().toString(36).slice(2, 8)}`
    const { data, error } = await (svc as any).from("qr_codes").insert({ brokerage_id: args.brokerageId, agent_id: args.agentId, label: args.label, purpose: args.purpose, destination_type: args.destinationType, target_url: args.targetUrl, slug, is_active: true, scan_count: 0 }).select("id").maybeSingle()
    if (error || !data) return null
    return { qrCodeId: data.id, slug, scanUrl: `${ORIGIN}/api/qr/scan?slug=${slug}`, targetUrl: args.targetUrl, qrCodeDataUrl: "data:image/png;base64,AAAA" }
  }
  // WAVE 147 (lane 147E — owner ruling 5 / C11): a guide publishes only with its delivery asset READY. The real booklet producer
  // is server-only (it renders + hosts a PDF); this proof injects a ready one through the deliverable seam — the C11 rule itself
  // is proven by scripts/lead-magnet-asset-invariant-guard.ts. The rule asserted here (the human publish activates + records) is unchanged.
  const readyGuide = { produceGuide: async () => ({ status: "ready" as const, assetUrl: "https://cdn.example.com/guides/seller.pdf", documentId: null, title: "Sell for More", coverNote: { subject: "Your guide", title: "Sell for More", body: "Here is your guide." }, validation: { ok: true } }) }
  const pub = await publishLeadMagnet({ magnetId: drafted.magnetId!, brokerageId: A, channels: ["landing_page", "qr_code"], actorUserId: USER_A, baseUrl: ORIGIN }, { client: c, mintTrackedQr: fakeMinter, deliverable: readyGuide })
  const pubRow = rows(c, "lead_capture_forms").find((r) => r.id === drafted.magnetId)!
  check("C3b C11: the published guide's delivery asset is READY and approved by the publisher (C5 owner)", rows(c, "lead_magnet_deliverables").some((d) => d.form_id === drafted.magnetId && d.status === "ready" && d.approved_by === USER_A))
  check("C3 the human publish activates the row and records lifecycle published / approved_by / channels",
    pub.success && pubRow.is_active === true && pubRow.settings.lifecycle.state === "published" && pubRow.settings.lifecycle.approved_by === USER_A && pubRow.settings.lifecycle.channels.includes("qr_code")
    && pubRow.settings.authoring?.by === "ai", JSON.stringify(pub))
  const pubLedger = ledger(c, "marketing.lead_magnet.publish")
  check("C4 evidence: a ledger row marketing.lead_magnet.publish, executed, HUMAN_REQUESTED by the approver",
    pubLedger.length === 1 && pubLedger[0].status === "executed" && pubLedger[0].actor_user_id === USER_A && pubLedger[0].reason_code === "HUMAN_REQUESTED")
  const qr = rows(c, "qr_codes").find((r) => r.label === `lead_magnet:${drafted.magnetId}`)
  check("C5 the qr_code channel minted ONE tracked code through the one minter (label lead_magnet:<id>, purpose lead_magnet, tenant-pinned)",
    !!qr && qr.purpose === "lead_magnet" && qr.brokerage_id === A && pub.qrCodeId === qr.id && /\/lm\//.test(qr.target_url ?? ""), JSON.stringify(qr))
  // The audit echoes ride emitKernelEvent (server-only; unobservable here — lost echoes are logged by the
  // sentinel, never thrown). The rule asserted is on stripped source: each emits on the SAME client.
  const kernelSrc = blankComments(raw("lib/kernel/lead-magnets.ts"))
  const emitsOnClient = (event: string) => new RegExp(`event:\\s*"${event}"[\\s\\S]{0,900}?client:\\s*supabase`).test(kernelSrc)
  check("C6 the audit echo lead_magnet_published is emitted on the same client the row landed on (101C seam)", emitsOnClient("lead_magnet_published") && emitsOnClient("lead_magnet_created"))

  // ── D. ATTRIBUTION THROUGH INTAKE ──────────────────────────────────────────
  console.log("\n── D. an ad's attribution survives capture → consent → intake → dedup → the attribution spine ──")
  const adHit = parseLeadMagnetAttribution({ utm_source: "facebook", utm_medium: "paid_social", utm_campaign: "Spring sellers", campaign_id: CAMP_A, ad_campaign_id: AD_CAMP, creative: "Variant A" })
  const cap1 = await captureFormSubmission({
    formId: drafted.magnetId!, brokerageId: A, source: "landing_page", tcpaConsentGiven: true, ipAddress: "203.0.113.9", userAgent: "proof",
    submissionData: { first_name: "Sam", last_name: "Seller", email: "sam@seller.test", phone: "+15125550100" }, attribution: adHit,
  }, { client: c })
  check("D1 the capture succeeds and reports the VERIFIED campaign + its touchpoint", cap1.success && cap1.attribution?.campaignVerified === true && !!cap1.attribution?.touchpointId && cap1.attribution?.creative === "variant-a", JSON.stringify(cap1))
  const sam = rows(c, "contacts").find((r) => r.email === "sam@seller.test")!
  check("D2 the NEW contact carries campaign_attribution_id (the verified campaign), source_channel paid_ad, the seller intent, and the magnet's agent",
    sam?.campaign_attribution_id === CAMP_A && sam?.source_channel === "paid_ad" && sam?.contact_type === "seller" && sam?.agent_id === AGENT_A && sam?.brokerage_id === A)
  check("D3 CONSENT: the contact is stamped (tcpa_consent, source lead_magnet, ip) and a contact_consent_events row exists",
    sam?.tcpa_consent === true && sam?.tcpa_consent_source === "lead_magnet" && sam?.tcpa_consent_ip === "203.0.113.9"
    && rows(c, "contact_consent_events").some((e) => e.contact_id === sam.id && e.consent_source === "lead_magnet" && e.consented === true && e.brokerage_id === A))
  const tp = rows(c, "marketing_campaign_touchpoints").find((r) => r.id === cap1.attribution?.touchpointId)
  check("D4 the TOUCHPOINT lands on the existing spine: campaign, contact, converted, external_table form_submissions, creative + ad campaign in metadata",
    !!tp && tp.campaign_id === CAMP_A && tp.contact_id === sam.id && tp.status === "converted" && tp.channel === "social" && tp.external_table === "form_submissions"
    && tp.external_id === cap1.submissionId && tp.metadata?.creative === "variant-a" && tp.metadata?.ad_campaign_id === AD_CAMP && tp.source === "trigger" && typeof tp.metadata?.manager === "string")
  const sub1 = rows(c, "form_submissions").find((r) => r.id === cap1.submissionId)
  check("D5 form_submissions.source is WRITTEN (the live column had a reader and no writer) and tcpa_consent_given recorded", sub1?.source === "landing_page" && sub1?.tcpa_consent_given === true)
  check("D6 the audit echo form_submission_captured carries the VERIFIED attribution on the same client (stripped source)",
    emitsOnClient("form_submission_captured") && /event:\s*"form_submission_captured"[\s\S]{0,900}?attribution:\s*attribution\s*\?\s*\{[^}]*campaignId:\s*verifiedCampaignId/.test(kernelSrc))

  const contactsBefore = rows(c, "contacts").length
  const cap2 = await captureFormSubmission({
    formId: drafted.magnetId!, brokerageId: A, source: "landing_page", tcpaConsentGiven: true,
    submissionData: { first_name: "Sam", last_name: "Seller", phone: "+15125550100" }, attribution: { utmSource: "instagram", utmMedium: "paid_social", campaignId: CAMP_A },
  }, { client: c })
  check("D7 DEDUP by PHONE: a second submission with the same phone and no email resolves to the SAME contact (no new row); first-touch campaign kept",
    cap2.success && cap2.contactId === sam.id && rows(c, "contacts").length === contactsBefore && rows(c, "contacts").find((r) => r.id === sam.id)?.campaign_attribution_id === CAMP_A)

  const touchpointsBefore = rows(c, "marketing_campaign_touchpoints").length
  const capForeign = await captureFormSubmission({
    formId: drafted.magnetId!, brokerageId: A, source: "landing_page", tcpaConsentGiven: true,
    submissionData: { first_name: "Eve", last_name: "Else", email: "eve@else.test" }, attribution: { utmSource: "facebook", utmMedium: "paid_social", campaignId: CAMP_B, creative: "x" },
  }, { client: c })
  const eve = rows(c, "contacts").find((r) => r.email === "eve@else.test")
  check("D8 CONTROL — another tenant's campaign id is DROPPED: capture succeeds, no campaign stamp, no touchpoint, the rest of the attribution kept",
    capForeign.success && capForeign.attribution?.campaignVerified === false && capForeign.attribution?.campaignId === null && capForeign.attribution?.touchpointId === null
    && eve?.campaign_attribution_id === null && rows(c, "marketing_campaign_touchpoints").length === touchpointsBefore && capForeign.attribution?.creative === "x")
  check("D9 CONTROL — a submission that consented WITHOUT a phone stamps no TCPA consent on the contact (TCPA governs calls/texts) but still records the consent event",
    eve?.tcpa_consent !== true && rows(c, "contact_consent_events").some((e) => e.contact_id === eve?.id))

  const capSearch = await captureFormSubmission({
    formId: drafted.magnetId!, brokerageId: A, source: "landing_page", tcpaConsentGiven: false,
    submissionData: { first_name: "Gigi", last_name: "Google", email: "gigi@search.test" }, attribution: { utmSource: "google", utmMedium: "paid_search", campaignId: CAMP_A, adCampaignId: AD_CAMP },
  }, { client: c })
  const gigi = rows(c, "contacts").find((r) => r.email === "gigi@search.test")
  check("D10 PUBLISHED BLIND SPOT — a paid-search click keeps its contact-level campaign stamp but writes no touchpoint (no honest channel value in the live CHECK)",
    capSearch.success && capSearch.attribution?.campaignVerified === true && capSearch.attribution?.touchpointId === null && gigi?.campaign_attribution_id === CAMP_A && gigi?.source_channel === "paid_ad"
    && touchpointChannelFor({ utmSource: "google", utmMedium: "paid_search" }) === null)
  check("D11 the channel map: qr → qr_scan, social sources → social, email → email; source_channel qr → qr_code, paid → paid_ad, plain → online_form",
    touchpointChannelFor({ qr: "abc" }) === "qr_scan" && touchpointChannelFor({ utmSource: "instagram" }) === "social" && touchpointChannelFor({ utmMedium: "email" }) === "email"
    && sourceChannelFor({ qr: "abc" }) === "qr_code" && sourceChannelFor({ utmMedium: "cpc" }) === "paid_ad" && sourceChannelFor({ utmSource: "newsletter" }) === "online_form" && sourceChannelFor(null) === "online_form")
  const perf = await getMagnetPerformance({ magnetId: drafted.magnetId!, brokerageId: A }, { client: c })
  const landingCount = perf.performance?.topSources.find((s) => s.source === "landing_page")?.count ?? 0
  check("D12 topSources is COUNTED from recorded sources (4 landing_page submissions), never a fabricated 'direct = 50%' split",
    perf.success && landingCount === 4 && !perf.performance!.topSources.some((s) => s.source === "direct"))

  // ── E. CLONE PROVENANCE ────────────────────────────────────────────────────
  console.log("\n── E. tenants clone / customize an approved magnet (provenance kept; cross-tenant refused) ──")
  const clone = await cloneLeadMagnet({ sourceMagnetId: drafted.magnetId!, brokerageId: A, agentId: AGENT_A, createdBy: USER_A }, { client: c })
  const cloneRow = rows(c, "lead_capture_forms").find((r) => r.id === clone.magnetId)!
  check("E1 the clone is a NEW DRAFT row named 'Copy of …' with the source's fields, landing copy and consent text",
    clone.success && clone.clonedFromId === drafted.magnetId && cloneRow?.is_active === false && /^Copy of /.test(cloneRow?.name ?? "")
    && JSON.stringify(cloneRow.fields) === JSON.stringify(pubRow.fields) && cloneRow.landing_content?.headline === pubRow.landing_content?.headline && cloneRow.slug !== pubRow.slug)
  check("E2 provenance recorded: settings.provenance.cloned_from_id / slug / by / at, and the source's AI authoring noted",
    cloneRow.settings?.provenance?.cloned_from_id === drafted.magnetId && cloneRow.settings?.provenance?.cloned_from_slug === pubRow.slug && cloneRow.settings?.provenance?.cloned_by === USER_A
    && cloneRow.settings?.authoring?.cloned === true && cloneRow.settings?.authoring?.source_authoring?.by === "ai")
  const listC = (await listLeadMagnets({ brokerageId: A }, { client: c })).magnets?.find((m) => m.id === clone.magnetId)
  check("E3 the list shows the clone's provenance (clonedFromId + the source's name) and draft state", listC?.clonedFromId === drafted.magnetId && listC?.clonedFromName === pubRow.name && listC?.lifecycleState === "draft")
  check("E4 the audit echo lead_magnet_cloned is emitted (audit-only) on the same client", emitsOnClient("lead_magnet_cloned") && /event:\s*"lead_magnet_cloned"[\s\S]{0,300}?auditOnly:\s*true/.test(kernelSrc))
  const formsBefore = rows(c, "lead_capture_forms").length
  const xclone = await cloneLeadMagnet({ sourceMagnetId: drafted.magnetId!, brokerageId: B, agentId: AGENT_B, createdBy: USER_B }, { client: c })
  check("E5 CONTROL — another tenant cannot clone this magnet (refused, nothing written)", !xclone.success && /not found in this brokerage/.test(xclone.error ?? "") && rows(c, "lead_capture_forms").length === formsBefore)

  // ── F. PROACTIVE IDEAS ─────────────────────────────────────────────────────
  console.log("\n── F. proactive ideas: deterministic, evidence-bearing, on the manager-signal bus, deduped ──")
  const jan = new Date("2026-01-15T12:00:00Z")
  const ideas = suggestLeadMagnetIdeas({
    now: jan,
    magnets: [
      { id: "m-under", name: "Quiet page", magnetType: "buyer_guide", isActive: true, views30d: 60, submissions30d: 0 },
      { id: "m-test", name: "Busy page", magnetType: "seller_guide", isActive: true, views30d: 150, submissions30d: 9 },
      { id: "m-thin", name: "Thin page", magnetType: "open_house", isActive: true, views30d: 10, submissions30d: 0 },
    ],
    contactMix: { buyers: 2, sellers: 30 },
    territories: ["North Shore"],
  })
  const kinds = ideas.map((i) => i.kind)
  check("F1 underperformer (60 views, 0 submissions) and test (150 views) ideas name their magnet + evidence; a 10-view page is NOT an underperformer (control)",
    ideas.some((i) => i.kind === "underperformer" && i.magnetId === "m-under" && i.evidence.views30d === 60) && ideas.some((i) => i.kind === "test" && i.magnetId === "m-test") && !ideas.some((i) => i.magnetId === "m-thin"))
  check("F2 seasonal (January → home value check) when no live magnet of that type; local-market from the TENANT's territory; no audience-gap when the buyer side is already served",
    ideas.some((i) => i.kind === "seasonal" && i.magnetType === "home_valuation") && ideas.some((i) => i.kind === "local_market" && /North Shore/.test(i.concept)) && !kinds.includes("audience_gap"))
  const gap = suggestLeadMagnetIdeas({ now: jan, magnets: [{ id: "s", name: "Seller only", magnetType: "home_valuation", isActive: true, views30d: 0, submissions30d: 0 }], contactMix: { buyers: 1, sellers: 30 }, territories: [] })
  check("F3 audience gap: 30 sellers vs 1 buyer and no buyer-side magnet → a buyer guide; seasonal suppressed by the live home_valuation (control)",
    gap.some((i) => i.kind === "audience_gap" && i.magnetType === "buyer_guide") && !gap.some((i) => i.kind === "seasonal"))
  check("F4 local-market suppressed when a market report is live (control); at most 5 ideas; seasonFor is a calendar fact",
    !suggestLeadMagnetIdeas({ now: jan, magnets: [{ id: "r", name: "Report", magnetType: "market_report", isActive: true, views30d: 0, submissions30d: 0 }], contactMix: { buyers: 0, sellers: 0 }, territories: ["Anywhere"] }).some((i) => i.kind === "local_market")
    && ideas.length <= 5 && seasonFor(new Date("2026-07-01T00:00:00Z")).label === "summer" && seasonFor(new Date("2026-04-01T00:00:00Z")).magnetType === "seller_guide")
  const spec = signalSpec(LEAD_MAGNET_SUGGESTION_SIGNAL)
  check("F5 the signal type is registered feed-only with the kind the feed classifies it as (update)",
    !!spec && spec.disposition === "feed_only" && spec.kind === classifyCoordination(LEAD_MAGNET_SUGGESTION_SIGNAL) && spec.kind === "update")
  const r = fixture()
  r.tables.lead_capture_forms.push({ id: "f-under", brokerage_id: A, name: "Quiet page", magnet_type: "buyer_guide", is_active: true, slug: "quiet" })
  for (let i = 0; i < 60; i++) r.tables.lifecycle_events.push({ id: `v${i}`, brokerage_id: A, entity_id: "f-under", event_type: "lead_magnet_view", created_at: new Date().toISOString() })
  r.tables.farm_territories.push({ id: "t1", brokerage_id: A, name: "Riverbend", is_active: true }, { id: "t2", brokerage_id: B, name: "Other tenant", is_active: true })
  for (let i = 0; i < 20; i++) r.tables.contacts.push({ id: `c${i}`, brokerage_id: A, contact_type: "seller", created_at: new Date().toISOString() })
  const run1 = await runLeadMagnetSuggestions(r, A, { now: jan })
  const sigs = rows(r, "manager_signals").filter((s) => s.signal_type === LEAD_MAGNET_SUGGESTION_SIGNAL)
  check("F6 the runner reads the tenant's own evidence and publishes each idea ai_isa → campaign_orchestrator with its key (never another tenant's territory)",
    run1.ok && run1.published === run1.suggestions.length && run1.published >= 3 && sigs.every((s) => s.brokerage_id === A && s.from_manager === "ai_isa" && s.to_manager === "campaign_orchestrator" && typeof s.payload?.key === "string")
    && sigs.some((s) => s.payload.kind === "underperformer" && s.entity_id === "f-under") && !sigs.some((s) => /Other tenant/.test(String(s.payload?.concept ?? ""))), JSON.stringify(run1))
  // The live column manager_signals.status DEFAULTS to 'open' (CHECK consumed | expired | open); the fake has no
  // column defaults, so the default is applied to the rows the bus just wrote — the dedupe then reads what
  // the live table would hold. A consumed idea is NOT a duplicate (control below): it may legitimately recur.
  for (const s of sigs) s.status = "open"
  const run2 = await runLeadMagnetSuggestions(r, A, { now: jan })
  check("F7 a re-run publishes nothing new (deduped per idea key against OPEN signals)", run2.ok && run2.published === 0 && run2.deduped === run1.published && rows(r, "manager_signals").length === sigs.length)
  sigs[0].status = "consumed"
  const run3 = await runLeadMagnetSuggestions(r, A, { now: jan })
  check("F7 control — a CONSUMED idea is not a duplicate: it is raised again (one new signal, the rest deduped)", run3.ok && run3.published === 1 && run3.deduped === run1.published - 1)

  // ── G. ADS ─────────────────────────────────────────────────────────────────
  console.log("\n── G. the ad destination writes the ONE attribution contract and fails closed ──")
  const url = leadMagnetLandingUrl(ORIGIN, pubRow.slug, { campaignId: CAMP_A, adCampaignId: AD_CAMP, creative: "Variant A", utmSource: "facebook", utmMedium: "paid_social" })
  const back = parseLeadMagnetAttribution(new URL(url).searchParams)
  check("G1 leadMagnetLandingUrl ↔ parseLeadMagnetAttribution round-trips every parameter through the one vocabulary",
    url.startsWith(`${ORIGIN}/lm/${pubRow.slug}?`) && back?.campaignId === CAMP_A && back?.adCampaignId === AD_CAMP && back?.creative === "variant-a" && back?.utmSource === "facebook"
    && Object.values(LEAD_MAGNET_ATTRIBUTION_PARAMS).every((p) => /^[a-z_]+$/.test(p)))
  check("G2 sanitizing drops a non-uuid campaign id, strips markup, and yields null for an empty hit",
    sanitizeLeadMagnetAttribution({ campaignId: "not-a-uuid", utmCampaign: "<script>x</script>spring" })?.campaignId == null
    && sanitizeLeadMagnetAttribution({ campaignId: "not-a-uuid", utmCampaign: "<script>x</script>spring" })?.utmCampaign === "scriptx/scriptspring"
    && parseLeadMagnetAttribution({}) === null && parseLeadMagnetAttribution({ utm_source: "  " }) === null)
  const dest = await resolveAdDestination(c as any, { brokerageId: A, leadMagnetId: drafted.magnetId!, attribution: { campaignId: CAMP_A, adCampaignId: AD_CAMP, creative: "Variant B", utmSource: "facebook", utmMedium: "paid_social" } })
  check("G3 resolveAdDestination(leadMagnetId) → the PUBLISHED magnet's /lm page carrying campaign / ad campaign / creative",
    !!dest && dest.startsWith(`${ORIGIN}/lm/${pubRow.slug}?`) && /campaign_id=/.test(dest) && /creative=variant-b/.test(dest), dest ?? "null")
  check("G4 fails closed on a DRAFT magnet (control)", (await resolveAdDestination(c as any, { brokerageId: A, leadMagnetId: clone.magnetId! })) === null)
  check("G5 fails closed on another tenant's magnet (control)", (await resolveAdDestination(c as any, { brokerageId: B, leadMagnetId: drafted.magnetId! })) === null)
  const savedOrigin = process.env.NEXT_PUBLIC_APP_URL
  delete process.env.NEXT_PUBLIC_APP_URL
  check("G6 fails closed with no configured origin (never a placeholder host)", (await resolveAdDestination(c as any, { brokerageId: A, leadMagnetId: drafted.magnetId! })) === null)
  process.env.NEXT_PUBLIC_APP_URL = savedOrigin

  // ── H. WIRING (stripped source) ────────────────────────────────────────────
  console.log("\n── H. wiring, read from COMMENT-BLANKED source, each with a positive control ──")
  const builder = code("app/components/features/lead-magnets/MagnetBuilder.tsx")
  const passesChannels = /publishLeadMagnetAction\(\s*createdMagnet\.magnetId\s*,\s*channels\s*\)/
  check("H1 MagnetBuilder passes its channel checkboxes to publish (the QR branch is reachable)", passesChannels.test(builder))
  check("H1 control — the old call with no channels would not match", !passesChannels.test("publishLeadMagnetAction(createdMagnet.magnetId)"))
  check("H2 MagnetBuilder uses the REAL slug the kernel minted, never a client-side guess",
    /slug:\s*result\.slug/.test(builder) && !/title\.trim\(\)\.toLowerCase\(\)\.replace/.test(builder))
  check("H3 MagnetBuilder creates a DRAFT and calls the AI draft action; the notify switch stays wired (test:lead-magnet-flow's pin)",
    /publish_state:\s*"draft"/.test(builder) && /draftLeadMagnetWithAiAction\(/.test(builder) && /onCheckedChange=\{setNotifyByEmail\}/.test(raw("app/components/features/lead-magnets/MagnetBuilder.tsx")))
  const page = code("app/lm/[slug]/page.tsx")
  check("H4 the public page parses attribution from the query string and hands it to BOTH capture forms",
    /parseLeadMagnetAttribution\(sp\)/.test(page) && (page.match(/attribution=\{attribution\}/g) ?? []).length === 2)
  check("H5 a draft preview is served only to a member of the owning tenant (session brokerage === form brokerage), never by a query parameter",
    /ctx\.brokerageId === formBrokerageId/.test(page) && /viewerMayPreview\(draft\.brokerage_id\)/.test(page))
  const action = code("app/actions/lead-magnet-capture.ts")
  check("H6 the capture action sanitizes and forwards attribution into the kernel command", /sanitizeLeadMagnetAttribution\(input\.attribution\)/.test(action) && /attribution,\s*\}\)/.test(action))
  const creator = code("lib/ads/ad-creator.ts")
  check("H7 the ad creator reads targeting.lead_magnet_id and stamps the creative per variation", /targeting\.lead_magnet_id/.test(creator) && /attributionSlug\(variation\.variationName\)/.test(creator) && /destination_url:\s*variationDestination/.test(creator))
  const models = code("lib/ai/models.ts")
  const routingRow = /lead_magnet_draft:\s*\{\s*model:\s*"([a-z0-9-]+)",\s*fallback:\s*"([a-z0-9-]+)"/.exec(models)
  const modelKeys = new Set([...models.matchAll(/^\s{2}"([a-z0-9-]+)":\s*\{/gm)].map((m) => m[1]))
  check("H8 AI_TASK_ROUTING carries lead_magnet_draft on MODEL_CONFIG keys (the cheapest adequate lane), and the draft names it literally",
    !!routingRow && modelKeys.has(routingRow[1]) && modelKeys.has(routingRow[2]) && new RegExp(`feature:\\s*"${LEAD_MAGNET_DRAFT_FEATURE}"`).test(code("lib/lead-magnets/ai-draft.ts")))
  const pkg = raw("package.json")
  check("H9 the proof is registered and on the guard chain (membership, not position)", /"test:lead-magnet-creation":\s*"tsx scripts\/lead-magnet-creation-guard\.ts"/.test(pkg) && new RegExp("npm run test:lead-magnet-creation(\\s|&|$)").test(pkg))
  const registry = blankStrings(code("lib/kernel/manager-registry.ts"))
  check("H10 MAINTENANCE_DOMAINS owns the proof (campaign_orchestrator, co-owned by ai_isa + ads_manager)",
    /lead_magnet_creation:\s*\{\s*manager:\s*[^,]+,\s*proof:\s*[^,]+,\s*coOwners:\s*\[[^\]]*\]/.test(registry) && /lead_magnet_creation:\s*\{\s*manager:\s*"campaign_orchestrator"/.test(code("lib/kernel/manager-registry.ts")))
  check("H11 the geo-citation cron runs the suggestion sweep per tenant", /runLeadMagnetSuggestions\(supabase,\s*brokerageId/.test(code("app/api/cron/geo-citation-monitor/route.ts")))
  const kernel = code("lib/kernel/lead-magnets.ts")
  check("H12 the kernel verifies the attribution campaign against the magnet's tenant (brokerage-pinned read) before stamping",
    /from\("marketing_campaigns"\)[\s\S]{0,160}\.eq\("brokerage_id",\s*input\.brokerageId\)/.test(kernel) && /campaign_attribution_id:\s*verifiedCampaignId/.test(kernel))
  check("H12 control — an unpinned read would not satisfy the rule", !/from\("marketing_campaigns"\)[\s\S]{0,160}\.eq\("brokerage_id",\s*input\.brokerageId\)/.test('from("marketing_campaigns").select("id").eq("id", attribution.campaignId).maybeSingle()'))

  console.warn = realWarn
  console.error = realError
  if (backgroundRejections.length > 0) {
    console.log(`\n── background rejections observed (best-effort kernel work that cannot load under tsx; published, not asserted): ${backgroundRejections.length}`)
    for (const r of Array.from(new Set(backgroundRejections)).slice(0, 6)) console.log("   · " + r)
  }
  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ LEAD_MAGNET_CREATION_FAIL"); process.exit(1) }
  console.log(" ✅ LEAD_MAGNET_CREATION_PASS — tenant builder, AI draft → human approval, clone provenance, attribution through intake, proactive ideas")
}

main().catch((e) => {
  console.warn = realWarn
  console.error = realError
  console.error(e)
  console.log(" ❌ LEAD_MAGNET_CREATION_FAIL (threw)")
  process.exit(1)
})
