/**
 * Wave 93 (lane 93D) — the full-platform walkthrough, prospect → lifetime
 * customer, driven through the REAL functions over the MCP replay bridge.
 * Extends journey-wave91.ts (steps 1–4, same survivors) with steps 5–8.
 * Every row is tagged: names `Wave93 Demo…`, emails `w93d.*@wave93.test`,
 * notes `wave93-demo`. Run with BRIDGE_DEMO_EMAIL_SUFFIX=@wave93.test,
 * BRIDGE_UUID_PREFIX=93d0, BRIDGE_STORAGE_EMULATE=1. Cleanup is a separate
 * counted SQL pass (cleanup-template.sql with the wave-93 tags).
 */
import type { WalkCtx } from "./run"
import { BridgeStop, actAs, serviceClient, currentUserClient, setScopeBrokerage, setScopeIds, setScopeTextIds, quiesce } from "./bridge"

const E = (who: string) => `w93d.${who}@wave93.test`
const DAY = 86_400_000

async function step(ctx: WalkCtx, stepName: string, capability: string, via: string, fn: () => Promise<{ ok: boolean; detail: string; verdict?: "works" | "refused" | "error" | "not reachable" | "emulated" }>) {
  try {
    const r = await fn()
    ctx.row({ step: stepName, capability, via, verdict: r.verdict ?? (r.ok ? "works" : "refused"), detail: r.detail })
  } catch (e) {
    if (e instanceof BridgeStop) throw e
    ctx.row({ step: stepName, capability, via, verdict: "error", detail: String((e as Error)?.stack ?? e).slice(0, 400) })
  }
  // Background chains the step started drain before the next step (replay order).
  await quiesce()
}

export async function journey(ctx: WalkCtx) {
  if (process.env.W93_BROKERAGE) setScopeBrokerage(process.env.W93_BROKERAGE)
  const svc = serviceClient()

  // ── 1. Platform prospect → qualification → subscriber ─────────────────────
  actAs(null)
  const { buildPlatformProspectTools } = await import("@/lib/platform/prospect-agent-tools")
  const toolCtx = { source: "web:prospect_chat" as const, phone: null, prospectId: null as string | null, callId: null, brand: { name: "VIP Agents" } as never, hasLiveTransfer: false }
  const tools = (await buildPlatformProspectTools(toolCtx)) as Record<string, { execute: (a: any, o?: any) => Promise<any> }>

  await step(ctx, "1a", "prospect chat captures qualification facts", "prospect-agent-tools save_prospect → upsertPlatformProspect", async () => {
    const r = await tools.save_prospect.execute({
      name: "Wave93 Demo Broker", email: E("broker"), company: "Wave93 Demo Realty", role_interest: "brokerage",
      size_seats: 8, producers_count: 6, role_title: "broker-owner", current_tools: "spreadsheets + a legacy CRM",
      pain: "leads go cold before an agent calls", timeline: "1-3_months", territory: "Boca Raton, FL 33431",
      preferred_path: "trial", note: "wave93-demo",
    })
    if (toolCtx.prospectId) ctx.ids.prospect = toolCtx.prospectId
    return { ok: r?.success === true, detail: JSON.stringify(r) + ` prospect=${toolCtx.prospectId}` }
  })
  await step(ctx, "1b", "prospect says yes → trial subscriber (no card, no Stripe)", "start_subscription → convertProspectToSubscriber → createTenantCore", async () => {
    const r = await tools.start_subscription.execute({
      email: E("broker"), name: "Wave93 Demo Broker", company: "Wave93 Demo Realty", plan: null,
      activation: "trial", billing_cycle: null, wants_custom_pricing: false,
    })
    return { ok: r?.success === true, detail: JSON.stringify(r) }
  })
  const { data: conv } = await svc.from("platform_prospects").select("converted_brokerage_id, status").eq("email", E("broker")).maybeSingle()
  const B = (conv?.converted_brokerage_id ?? "") as string
  const { data: brokerSeat } = await svc.from("users").select("id, user_type").eq("email", E("broker")).maybeSingle()
  const BROKER = { userId: (brokerSeat?.id ?? "") as string, email: E("broker") }
  ctx.ids.brokerage = B; ctx.ids.brokerUser = BROKER.userId
  ctx.row({ step: "1c", capability: "prospect row carries the conversion + broker seat exists", via: "platform_prospects.converted_brokerage_id / users", verdict: B && BROKER.userId ? "works" : "refused", detail: `prospect.status=${conv?.status} brokerage=${B} brokerUser=${BROKER.userId} user_type=${(brokerSeat as any)?.user_type}` })
  if (!B || !BROKER.userId) return
  setScopeBrokerage(B)
  await step(ctx, "1d", "conversion audit rows land (system actor, m681)", "superadmin_audit_log read-back", async () => {
    const { data, error } = await svc.from("superadmin_audit_log").select("action, actor_user_id, actor_email").eq("details->>brokerage_id", B)
    const rows = (data ?? []) as any[]
    return { ok: !error && rows.length >= 1, detail: error ? error.message : `${rows.length} rows: ${rows.map((r) => `${r.action}/${r.actor_email}`).join("; ")}` }
  })
  const { data: bRow } = await svc.from("brokerages").select("slug, name").eq("id", B).maybeSingle()
  const SLUG = ((bRow as any)?.slug ?? "") as string

  // ── 2. Brokerage management ───────────────────────────────────────────────
  actAs(BROKER)
  const { inviteUser } = await import("@/app/actions/admin/invite-user")
  await step(ctx, "2a", "broker invites an agent", "app/actions/admin/invite-user.ts inviteUser", async () => {
    const r = await inviteUser({ email: E("agent"), firstName: "Wave93", lastName: "Demo Agent", userType: "agent" })
    return { ok: r.success, detail: JSON.stringify(r) }
  })
  await step(ctx, "2b", "broker invites a team lead", "inviteUser (team_lead)", async () => {
    const r = await inviteUser({ email: E("teamlead"), firstName: "Wave93", lastName: "Demo TeamLead", userType: "team_lead" })
    return { ok: r.success, detail: JSON.stringify(r) }
  })
  const { data: seats } = await svc.from("users").select("id, email, user_type").in("email", [E("agent"), E("teamlead")])
  const agentUser = (seats ?? []).find((u: any) => u.email === E("agent")) as { id: string } | undefined
  const tlUser = (seats ?? []).find((u: any) => u.email === E("teamlead")) as { id: string } | undefined
  const { data: agentRow } = agentUser ? await svc.from("agents").select("id").eq("user_id", agentUser.id).maybeSingle() : { data: null }
  const agentId: string | null = (agentRow as any)?.id ?? null
  ctx.ids.agentUser = agentUser?.id ?? ""; ctx.ids.teamLeadUser = tlUser?.id ?? ""; ctx.ids.agent = agentId ?? ""
  const AGENT = agentUser ? { userId: agentUser.id, email: E("agent") } : null
  // id-scoped shadow census (bridge.ts idCensus): the walk's own fresh ids.
  const { data: tlAgentRow } = tlUser ? await svc.from("agents").select("id").eq("user_id", tlUser.id).maybeSingle() : { data: null }
  for (const col of ["agent_id", "assigned_to_agent_id", "from_agent_id", "to_agent_id", "assigned_agent_id", "buyer_agent_id", "seller_agent_id", "listing_agent_id", "mentee_agent_id", "mentor_agent_id"]) setScopeIds(col, [agentId, (tlAgentRow as any)?.id])
  for (const col of ["agent_user_id", "user_id", "actor_user_id", "created_by"]) setScopeIds(col, [agentUser?.id, tlUser?.id, BROKER.userId])
  // provider_overrides.scope_id (user | brokerage) and teams.team_lead_id are read on every send / route.
  for (const col of ["team_lead_id", "scope_id", "recipient_user_id", "owner_id"]) setScopeIds(col, [agentUser?.id, tlUser?.id, BROKER.userId, B])
  // platform_credentials.owner_id is TEXT and also holds the literal 'platform' (the provider
  // credential chain reads agent → brokerage → platform for every e-sign/TC provider).
  setScopeTextIds("owner_id", ["platform"])

  const { createTeam } = await import("@/app/actions/multi-persona")
  await step(ctx, "2c", "broker creates a team led by the team lead", "app/actions/multi-persona.ts createTeam", async () => {
    if (!tlUser?.id) return { ok: false, detail: "no team-lead seat to lead the team" }
    const t = await createTeam({ teamName: "Wave93 Demo Team", teamLeaderId: tlUser.id })
    ctx.ids.team = (t as any)?.id ?? ""
    return { ok: !!(t as any)?.id, detail: JSON.stringify(t) }
  })
  const { saveAssignmentRuleAction } = await import("@/app/actions/admin/assignment-rules")
  await step(ctx, "2d", "lead assignment rule (round robin → the agent)", "app/actions/admin/assignment-rules.ts saveAssignmentRuleAction", async () => {
    const r = await saveAssignmentRuleAction({ name: "Wave93 Demo round robin", ruleType: "round_robin", conditions: {}, agentIds: agentId ? [agentId] : [], teamId: null, priority: 1, isActive: true } as any)
    if ((r as any).ok) ctx.ids.rule = (r as any).id
    return { ok: (r as any).ok === true, detail: JSON.stringify(r) }
  })
  const routing = await import("@/app/actions/admin/lead-routing-settings")
  await step(ctx, "2e", "routing settings: default method + mailbox-owner switch (settings merge)", "lead-routing-settings setDefaultAssignmentMethod + setMailboxOwnerPreference → mergeBrokerageSettings", async () => {
    const a = await routing.setDefaultAssignmentMethod("round_robin")
    const b = await routing.setMailboxOwnerPreference(false)
    const c = await routing.getMailboxOwnerPreference()
    return { ok: a.success && (b as any).success !== false && c.enabled === false, detail: JSON.stringify({ a, b, readBack: c }) }
  })
  await step(ctx, "2f", "broker claims the territory (ZIP 33431) → scraping market", "app/actions/settings/territories.ts addTerritoryZips", async () => {
    const { addTerritoryZips } = await import("@/app/actions/settings/territories")
    const r = await addTerritoryZips({ zips: "33431", grain: "brokerage", city: "Boca Raton", state: "FL" })
    return { ok: !(r as any).error, detail: JSON.stringify(r) }
  })

  // ── 3. Recruiting ─────────────────────────────────────────────────────────
  actAs(null)
  await step(ctx, "3a", "recruit sourcing (Reddit/review scrape) — paid, refused by the harness", "lib/recruit-pipeline/recruit-sourcer.ts sourceRecruitProspects", async () => {
    const { sourceRecruitProspects } = await import("@/lib/recruit-pipeline/recruit-sourcer")
    const r = await sourceRecruitProspects({ supabase: svc, marketId: "00000000-0000-0000-0000-000000000000", state: "FL", reviewUrls: [] } as any)
    return { ok: false, verdict: "not reachable", detail: `paid scrape refused in the walkthrough (no vendor call): ${JSON.stringify(r).slice(0, 200)}` }
  })
  await step(ctx, "3b", "manual recruit enters the pipeline (public recruiting page)", "app/recruiting/[brokerageSlug]/actions.ts submitRecruitInquiry", async () => {
    const { submitRecruitInquiry } = await import("@/app/recruiting/[brokerageSlug]/actions")
    const r = await submitRecruitInquiry({ brokerageSlug: SLUG, firstName: "Wave93", lastName: "Demo Recruit", email: E("recruit"), licenseState: "FL", currentBrokerage: "Other Realty", yearsExperience: 6, annualVolume: 4_200_000, notes: "wave93-demo — thinking of switching brokerage" })
    if (r.recruitId) ctx.ids.recruit = r.recruitId
    return { ok: r.success, detail: JSON.stringify(r) }
  })
  actAs(BROKER)
  await step(ctx, "3c", "broker advances the recruit (prospect → contacted)", "app/api/recruiting/advance-stage/route.ts POST", async () => {
    if (!ctx.ids.recruit) return { ok: false, detail: "no recruit" }
    const { POST } = await import("@/app/api/recruiting/advance-stage/route")
    const res = await POST(new Request("https://demo.wave93.test/api/recruiting/advance-stage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recruitId: ctx.ids.recruit, toStatus: "contacted", note: "wave93-demo intro call booked" }) }))
    const body = await res.json().catch(() => null)
    return { ok: res.status === 200, detail: `HTTP ${res.status} ${JSON.stringify(body)}` }
  })
  actAs(null)
  await step(ctx, "3d", "fatigue / retention radar scores the brokerage's agents", "lib/recruiting/retention-radar.ts runRetentionRadar", async () => {
    const { runRetentionRadar } = await import("@/lib/recruiting/retention-radar")
    const r = await runRetentionRadar(svc, { brokerageId: B })
    return { ok: r.scanned >= 1 && r.scored >= 1, detail: JSON.stringify(r).slice(0, 400) }
  })

  // ── 4. Marketing / campaigns / ads / websites ─────────────────────────────
  actAs(BROKER)
  await step(ctx, "4a", "brand kit (colors + voice) saved and published", "app/actions/onboarding/brand.ts saveBrandColors + saveBrandVoice + publishBrand", async () => {
    const brand = await import("@/app/actions/onboarding/brand")
    const a = await brand.saveBrandColors({ primaryColor: "#0B3D91", secondaryColor: "#F2A900", tagline: "Wave93 Demo — home, handled" })
    const b = await brand.saveBrandVoice({ tone: "warm", formalityLevel: "semi-formal" /* the wizard's old default spelling — proves the normalizer */, prohibitedWords: ["guarantee"], signaturePhrases: ["home, handled"] })
    // publishBrand requires a logo (its own gate) — upload one first (Storage EMULATED: no bytes stored).
    const fd = new FormData()
    fd.append("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "wave93-demo-logo.png", { type: "image/png" }))
    const logo = await brand.uploadLogo(fd)
    const c = await brand.publishBrand()
    return { ok: a.success && b.success && logo.success && c.success, detail: JSON.stringify({ colors: a, voice: b, logo, publish: c }) }
  })
  await step(ctx, "4b", "campaign sequence created, step added, launched (compliance precheck)", "app/actions/campaign-sequences.ts createCampaignSequence + createSequenceStep + launchCampaignSequence", async () => {
    const cs = await import("@/app/actions/campaign-sequences")
    const s = await cs.createCampaignSequence({ brokerageId: B, name: "Wave93 Demo seller nurture", description: "wave93-demo", sequence_type: "nurture", trigger_event: "contact_created" })
    if (!s.sequence) return { ok: false, detail: `create: ${s.error}` }
    ctx.ids.sequence = (s.sequence as any).id
    const st = await cs.createSequenceStep({ sequence_id: (s.sequence as any).id, step_number: 1, step_name: "Welcome", channel: "email", delay_days: 0, delay_hours: 1, subject: "Thinking about selling?", body: "Hi {{first_name}}, here is what homes near you sold for this month. Reply any time — we are happy to help." })
    const l = await cs.launchCampaignSequence((s.sequence as any).id)
    return { ok: !!st.step && l.success, detail: JSON.stringify({ step: st.error ?? (st.step as any)?.id, launch: l }) }
  })
  await step(ctx, "4c", "ads campaign draft (no platform call)", "lib/ads/ad-creator.ts createAdCampaign", async () => {
    const { createAdCampaign } = await import("@/lib/ads/ad-creator")
    const r = await createAdCampaign(BROKER.userId, { brokerageId: B, agentUserId: BROKER.userId, campaignName: "Wave93 Demo seller leads", platform: "facebook", objective: "leads", dailyBudget: 20, targetingConfig: { locations: ["Boca Raton, FL"], age_min: 25, age_max: 65 } as any })
    if (r.campaignId) ctx.ids.adCampaign = r.campaignId
    return { ok: r.success, detail: JSON.stringify(r) }
  })
  await step(ctx, "4d", "tenant website resolves for the brokerage slug", "app/site/[slug]/page.tsx generateMetadata + page render", async () => {
    const page: any = await import("@/app/site/[slug]/page")
    const meta = page.generateMetadata ? await page.generateMetadata({ params: Promise.resolve({ slug: SLUG }) }) : null
    let rendered = false
    try { const el = await page.default({ params: Promise.resolve({ slug: SLUG }) }); rendered = !!el } catch (e) { if ((e as Error).message === "BRIDGE_STOP") throw e; return { ok: false, detail: `render threw: ${(e as Error).message} meta=${JSON.stringify(meta)}` } }
    return { ok: rendered, detail: `slug=${SLUG} rendered=${rendered} title=${JSON.stringify((meta as any)?.title ?? null)}` }
  })
  actAs(AGENT ?? BROKER)
  await step(ctx, "4e", "lead magnet form created + published (agent)", "app/actions/lead-magnets-actions.ts createLeadMagnetAction + publishLeadMagnetAction", async () => {
    const lm = await import("@/app/actions/lead-magnets-actions")
    const c: any = await lm.createLeadMagnetAction({ name: "Wave93 Demo home value report", magnet_type: "home_valuation", description: "wave93-demo" })
    if (!c.success) return { ok: false, detail: `create: ${c.error}` }
    ctx.ids.magnet = c.magnetId
    const p: any = await lm.publishLeadMagnetAction(c.magnetId, ["landing_page"])
    return { ok: !!p?.success, detail: JSON.stringify({ create: { id: c.magnetId, slug: c.slug }, publish: p }) }
  })
  actAs(null)
  await step(ctx, "4f", "lead magnet form submission (public visitor)", "app/actions/lead-magnets-actions.ts captureFormSubmissionAction → captureFormSubmission", async () => {
    if (!ctx.ids.magnet) return { ok: false, detail: "no magnet" }
    const lm = await import("@/app/actions/lead-magnets-actions")
    const r: any = await lm.captureFormSubmissionAction({ formId: ctx.ids.magnet, brokerageId: B, source: "website", submissionData: { first_name: "Wave93", last_name: "Demo Visitor", email: E("visitor") } })
    if (r.contactId) ctx.ids.magnetContact = r.contactId
    return { ok: !!r.success, detail: JSON.stringify(r) }
  })

  // ── 5. Acquisition → lead (raw → dedup → enrichment → gates → lead) ────────
  // Live finding (first pass): the 2f territory claim (subscriber_service_areas) does NOT create a
  // lead_scraping_markets row — the scrape pipeline's territory source of truth. Market → service
  // areas is synced (syncServiceAreasForMarket); service area → market is not. The broker opens the
  // market through the real admin action.
  actAs(BROKER)
  await step(ctx, "5·m", "broker opens the scraping market for the claimed territory", "app/actions/lead-scraping-config.ts createScrapingMarket → syncServiceAreasForMarket", async () => {
    const lsc = await import("@/app/actions/lead-scraping-config")
    const r: any = await lsc.createScrapingMarket({ name: "Wave93 Demo Boca Raton", city: "Boca Raton", state: "FL", zip_codes: ["33431"], priority: 5 })
    return { ok: !!r.success && r.market?.brokerage_id === B, detail: JSON.stringify({ success: r.success, id: r.market?.id, brokerage: r.market?.brokerage_id, territory: r.territory, error: r.error }).slice(0, 400) }
  })
  actAs(null)
  const { data: market } = await svc.from("lead_scraping_markets").select("id, city, state, zip_codes").eq("brokerage_id", B).limit(1).maybeSingle()
  ctx.ids.market = (market as any)?.id ?? ""
  // One ingest+promote helper, run twice: the PLATFORM pool (owner round-39 ruling: born parked,
  // brokerage_id NULL until Engine 1 distributes) and a BROKERAGE-origin scrape (owned at birth).
  const { ingestRawSourceBatch } = await import("@/lib/kernel/scraping")
  const ingestOne = async (brokerageId: string | null, rec: { id: string; first: string; last: string; email: string }) => {
    const r = await ingestRawSourceBatch({
      brokerageId, marketId: (market as any).id, source: "batchdata_motivated", sourceFamily: "motivated_seller", sourceChannel: "batchdata", sourceSubtype: "high_equity",
      executionId: null, marketGeo: { city: (market as any).city, state: (market as any).state, zip_codes: (market as any).zip_codes },
      records: [{
        sourceRecordId: rec.id, source: "batchdata_motivated", behaviorType: "property_signal", intentType: "seller", intentSignals: ["high_equity", "long_tenure"],
        firstName: rec.first, lastName: rec.last, email: rec.email, city: "Boca Raton", state: "FL", zip: "33431",
        propertyAddress: "1193 Wave93 Demo Way, Boca Raton, FL 33431", mailingAddress: "1193 Wave93 Demo Way, Boca Raton, FL 33431", motivationScore: 72, paidPersonData: true,
        rawPayload: { note: "wave93-demo" },
      } as any],
    } as any)
    return r
  }
  let rawId: string | null = null
  let parkedRawId: string | null = null
  await step(ctx, "5a", "raw record ingested for the active territory (platform pool)", "lib/kernel/scraping.ts ingestRawSourceBatch", async () => {
    if (!market) return { ok: false, detail: "no scraping market for the brokerage" }
    const r = await ingestOne(null, { id: "wave93-demo-parked-1", first: "Dorothy", last: "Wavedemo", email: E("parked") })
    parkedRawId = r.rawIds[0] ?? null
    ctx.ids.parkedRaw = parkedRawId ?? ""
    return { ok: r.inserted === 1, detail: JSON.stringify(r) }
  })
  await step(ctx, "5b", "platform-pool pipeline: territory → identity → dedup → enrichment → lead born PARKED (brokerage_id NULL) → Engine 1", "lib/lead-pipeline/pipeline-processor.ts processRawRecord", async () => {
    if (!parkedRawId) return { ok: false, detail: "no raw record" }
    const { processRawRecord } = await import("@/lib/lead-pipeline/pipeline-processor")
    try {
      const r: any = await processRawRecord(parkedRawId)
      if (r.leadId) ctx.ids.parkedLead = r.leadId
      return { ok: r.success === true && !!r.leadId, detail: JSON.stringify(r).slice(0, 500) }
    } catch (e: any) {
      return { ok: false, detail: `THREW: ${String(e?.message ?? e).slice(0, 300)} — m684 written (leads.brokerage_id NOT NULL contradicts the parked-lead ruling)` }
    }
  })
  await step(ctx, "5a2", "raw record ingested by a BROKERAGE-origin scrape (owned at birth)", "lib/kernel/scraping.ts ingestRawSourceBatch", async () => {
    if (!market) return { ok: false, detail: "no scraping market for the brokerage" }
    const r = await ingestOne(B, { id: "wave93-demo-seller-1", first: "Marisol", last: "Wavedemo", email: E("seller") })
    rawId = r.rawIds[0] ?? null
    ctx.ids.raw = rawId ?? ""
    return { ok: r.inserted === 1, detail: JSON.stringify(r) }
  })
  await step(ctx, "5b2", "brokerage-origin pipeline → lead owned by the brokerage", "lib/lead-pipeline/pipeline-processor.ts processRawRecord", async () => {
    if (!rawId) return { ok: false, detail: "no raw record" }
    const { processRawRecord } = await import("@/lib/lead-pipeline/pipeline-processor")
    try {
      const r: any = await processRawRecord(rawId)
      if (r.leadId) ctx.ids.lead = r.leadId
      return { ok: r.success === true && !!r.leadId, detail: JSON.stringify(r).slice(0, 500) }
    } catch (e: any) {
      return { ok: false, detail: `THREW: ${String(e?.message ?? e).slice(0, 300)}` }
    }
  })
  if (!ctx.ids.lead) {
    const { data: l } = await svc.from("leads").select("id").eq("brokerage_id", B).eq("email", E("seller")).maybeSingle()
    if ((l as any)?.id) ctx.ids.lead = (l as any).id
  }
  const LEAD = ctx.ids.lead ?? ""
  setScopeIds("lead_id", [LEAD])
  await step(ctx, "5c", "RLS: the lead belongs to the brokerage — agent seat sees 0 leads, broker sees it", "leads SELECT as authenticated (RLS)", async () => {
    if (!AGENT || !LEAD) return { ok: false, detail: `agent=${!!AGENT} lead=${LEAD}` }
    actAs(AGENT)
    const a = await currentUserClient().from("leads").select("id", { count: "exact", head: true }).eq("brokerage_id", B)
    actAs(BROKER)
    const b = await currentUserClient().from("leads").select("id", { count: "exact", head: true }).eq("brokerage_id", B)
    return { ok: !a.error && !b.error && a.count === 0 && (b.count ?? 0) >= 1, detail: `agent count=${a.count} err=${a.error?.message ?? "-"} · broker count=${b.count} err=${b.error?.message ?? "-"}` }
  })
  actAs(null)
  await step(ctx, "5d", "lead channel rule: SMS + voice to the LEAD refused; ISA picker collapses sms → email", "dispatchSms + runOutboundCallGates + pickLeadOutreachChannel", async () => {
    if (!LEAD) return { ok: false, detail: "no lead" }
    const { dispatchSms } = await import("@/lib/providers/dispatch")
    const { runOutboundCallGates } = await import("@/lib/voice/outbound-call-gates")
    const { pickLeadOutreachChannel } = await import("@/lib/ai-isa/lead-channel-policy")
    const sms = await dispatchSms({ brokerageId: B, leadId: LEAD, to: "+15615550193", message: "wave93-demo — must never send", systemSource: "ai_isa" })
    const voice = await runOutboundCallGates({ brokerageId: B, toNumber: "+15615550193", contactId: null, leadId: LEAD, systemSource: "ai_isa" })
    const pick = pickLeadOutreachChannel({ requestedChannel: "sms", emailUsable: true, mailingVerified: true })
    const { data: ledger, error: lErr } = await svc.from("isa_outreach_log").select("channel").eq("lead_id", LEAD).in("channel", ["sms", "voice"])
    const ok = sms.success === false && !!voice && pick === "email" && !lErr && (ledger ?? []).length === 0
    return { ok, detail: `sms=${JSON.stringify({ ok: sms.success, by: (sms as any).providerKey, err: sms.error })} voice=${JSON.stringify(voice)} pick(sms)=${pick} isa_outreach sms/voice rows=${(ledger ?? []).length}${lErr ? " err " + lErr.message : ""}` }
  })

  // ── 6. Callback ask = positive intent → contact → assigned agent ──────────
  await step(ctx, "6a", "lead asks for a callback → converts → callback task on the agent's contact", "lib/ai-isa/callback-task.ts createCallbackTask → convertLeadOnCallbackIntent → convertSellerLeadOnIntent", async () => {
    if (!LEAD) return { ok: false, detail: "no lead" }
    const { createCallbackTask } = await import("@/lib/ai-isa/callback-task")
    const r: any = await createCallbackTask(svc, { brokerageId: B, contactId: null, leadId: LEAD, phone: "+15615550193", whenPhrase: "tomorrow afternoon", reason: "wants to talk about listing", voiceCallId: null })
    if (r.contactId) ctx.ids.contact = r.contactId
    if (r.taskId) ctx.ids.callbackTask = r.taskId
    return { ok: r.ok === true && !!r.contactId, detail: JSON.stringify(r).slice(0, 500) }
  })
  if (!ctx.ids.contact) {
    const { data: c } = await svc.from("contacts").select("id").eq("brokerage_id", B).eq("email", E("seller")).maybeSingle()
    if ((c as any)?.id) ctx.ids.contact = (c as any).id
  }
  const CONTACT = ctx.ids.contact ?? ""
  setScopeIds("contact_id", [CONTACT])
  await step(ctx, "6b", "assignment rule put the contact + callback on the agent; the agent sees the contact (RLS)", "contacts/tasks read-back + contacts SELECT as the agent", async () => {
    if (!CONTACT || !AGENT) return { ok: false, detail: `contact=${CONTACT}` }
    const { data: c } = await svc.from("contacts").select("agent_id, contact_type, status, source_family").eq("id", CONTACT).maybeSingle()
    const { data: t } = await svc.from("tasks").select("id, assigned_to_agent_id, assignee_type, status, due_date").eq("contact_id", CONTACT).eq("source", "ai_callback")
    actAs(AGENT)
    const seen = await currentUserClient().from("contacts").select("id").eq("id", CONTACT)
    actAs(null)
    const ok = (c as any)?.agent_id === agentId && (t ?? []).length === 1 && (t as any[])[0].assigned_to_agent_id === agentId && (seen.data ?? []).length === 1
    return { ok, detail: `contact=${JSON.stringify(c)} tasks=${JSON.stringify(t)} agentSees=${(seen.data ?? []).length} ${seen.error?.message ?? ""}` }
  })

  // ── 7. Contact → listing appointment → listing → offer → transaction → close
  await step(ctx, "7a", "seller books the listing appointment with the agent", "app/actions/home-value.ts scheduleSellerListingAppointment", async () => {
    if (!CONTACT || !agentId) return { ok: false, detail: "no contact/agent" }
    const { scheduleSellerListingAppointment } = await import("@/app/actions/home-value")
    // the listing-appointment rule (first live pass refused +4d): at least 7 days of prep lead time
    const start = new Date(Math.ceil((Date.now() + 8 * DAY) / DAY) * DAY + 15 * 3_600_000)
    const r = await scheduleSellerListingAppointment({ contactId: CONTACT, agentId, brokerageId: B, startAt: start.toISOString(), endAt: new Date(start.getTime() + 3_600_000).toISOString(), propertyAddress: "1193 Wave93 Demo Way", contactName: "Marisol Wavedemo" })
    if (r.calendarEventId) ctx.ids.calendarEvent = r.calendarEventId
    return { ok: r.success, detail: JSON.stringify(r) }
  })
  actAs(AGENT ?? BROKER)
  await step(ctx, "7b", "agent opens the listing (draft until the agreement is signed)", "app/actions/listings-kernel.ts createListingWithSellerContact → createListingRecord", async () => {
    const lk = await import("@/app/actions/listings-kernel")
    const r: any = await lk.createListingWithSellerContact({ sellerFirstName: "Marisol", sellerLastName: "Wavedemo", sellerEmail: E("seller"), address: "1193 Wave93 Demo Way", city: "Boca Raton", state: "FL", zip: "33431", listPrice: 625000, bedrooms: 3, bathrooms: 2, sqft: 1850, propertyType: "Single Family" /* display spelling: proves the canonicalizer folds it (was "residential" → 23514) */ })
    const id = r.listingId ?? r.listing?.id ?? r.data?.listing?.id
    if (id) ctx.ids.listing = id
    return { ok: !!r.success && !!id, detail: JSON.stringify(r).slice(0, 400) }
  })
  const LISTING = ctx.ids.listing ?? ""
  setScopeIds("listing_id", [LISTING])
  await step(ctx, "7c", "launch is refused while the listing agreement is unsigned (activation gate)", "app/actions/listings-kernel.ts launchListingAction → launchListing", async () => {
    if (!LISTING) return { ok: false, detail: "no listing" }
    const lk = await import("@/app/actions/listings-kernel")
    const r: any = await lk.launchListingAction({ listingId: LISTING, mlsNumber: "W93DEMO1" })
    return { ok: r.success === false, verdict: r.success === false ? "works" : "refused", detail: `gate ${r.success === false ? "held" : "DID NOT HOLD"}: ${JSON.stringify(r).slice(0, 300)}` }
  })
  // offers.contact_id is the offer's BUYER (seller-offers.ts embeds it as `buyer:contacts`); the first
  // live pass passed the listing's SELLER there and the seller was told "Your offer was uploaded".
  await step(ctx, "7d0", "agent files the offering buyer as a contact", "app/actions/contacts.ts createContact", async () => {
    const { createContact } = await import("@/app/actions/contacts")
    const r: any = await createContact({ first_name: "Theo", last_name: "Wavedemo", email: E("buyer"), contact_type: "buyer", notes: "wave93-demo" })
    const id = r.contact?.id ?? r.contactId ?? r.data?.id ?? r.id
    if (id) ctx.ids.buyer = id
    return { ok: !!r.success && !!id, detail: JSON.stringify(r).slice(0, 300) }
  })
  const BUYER = ctx.ids.buyer ?? ""
  setScopeIds("contact_id", [BUYER])
  await step(ctx, "7d", "buyer's agent offer arrives on the listing (PDF upload; extraction = AI, refused); the seller as buyer is refused", "app/api/offers/upload/route.ts POST", async () => {
    if (!LISTING || !BUYER) return { ok: false, detail: "no listing/buyer" }
    const { POST } = await import("@/app/api/offers/upload/route")
    const { NextRequest } = await import("next/server")
    const post = async (contactId: string) => {
      const fd = new FormData()
      fd.append("file", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a])], "wave93-demo-offer.pdf", { type: "application/pdf" }))
      fd.append("listing_id", LISTING)
      fd.append("contact_id", contactId)
      const res = await POST(new NextRequest("https://demo.wave93.test/api/offers/upload", { method: "POST", body: fd }) as any)
      return { status: res.status, body: (await res.json().catch(() => null)) as any }
    }
    // positive control for the role guard: the listing's own seller is not the offer's buyer
    const asSeller = await post(CONTACT)
    const r = await post(BUYER)
    const id = r.body?.offer_id ?? r.body?.offerId ?? r.body?.offer?.id ?? r.body?.id
    if (id) ctx.ids.offer = id
    return { ok: asSeller.status === 400 && r.status < 300 && !!id, detail: `seller-as-buyer HTTP ${asSeller.status} ${JSON.stringify(asSeller.body)} | buyer HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 260)}` }
  })
  await step(ctx, "7e", "seller counters at $618,000 (agent)", "app/actions/seller-offers.ts sendCounterOffer", async () => {
    if (!ctx.ids.offer) return { ok: false, detail: "no offer" }
    const so = await import("@/app/actions/seller-offers")
    const r: any = await so.sendCounterOffer({ parentOfferId: ctx.ids.offer, listingId: LISTING, counterPrice: 618000, responseDeadline: new Date(Date.now() + 2 * DAY).toISOString(), notes: "wave93-demo counter" })
    if (r.counterId) ctx.ids.counter = r.counterId
    return { ok: !!r.success, detail: JSON.stringify(r) }
  })
  actAs(BROKER)
  await step(ctx, "7f", "compliance review passes the accepted terms (broker)", "app/actions/compliance-bridge-actions.ts emitCompliancePassedAction", async () => {
    const id = ctx.ids.counter ?? ctx.ids.offer
    if (!id) return { ok: false, detail: "no offer" }
    const { emitCompliancePassedAction } = await import("@/app/actions/compliance-bridge-actions")
    const r: any = await emitCompliancePassedAction({ offerId: id, userId: BROKER.userId })
    return { ok: !!r.success, detail: JSON.stringify(r) }
  })
  actAs(AGENT ?? BROKER)
  await step(ctx, "7g", "offer accepted → transaction created", "app/actions/seller-offers.ts acceptOffer → createTransactionFromOffer", async () => {
    const id = ctx.ids.counter ?? ctx.ids.offer
    if (!id) return { ok: false, detail: "no offer" }
    const so = await import("@/app/actions/seller-offers")
    const r: any = await so.acceptOffer({ offerId: id, listingId: LISTING })
    const { data: tx } = await svc.from("transactions").select("id, status, deal_type, sale_price, contact_id, seller_contact_id, buyer_contact_id").eq("brokerage_id", B).limit(1).maybeSingle()
    if ((tx as any)?.id) ctx.ids.transaction = (tx as any).id
    return { ok: !!r.success && !!(tx as any)?.id, detail: `${JSON.stringify(r).slice(0, 200)} tx=${JSON.stringify(tx)}` }
  })
  await step(ctx, "7h", "transaction closes", "app/actions/transactions.ts closeTransaction → closeTransactionCommand", async () => {
    if (!ctx.ids.transaction) return { ok: false, detail: "no transaction" }
    const { closeTransaction } = await import("@/app/actions/transactions")
    const r = await closeTransaction({ transactionId: ctx.ids.transaction, brokerageId: B, agentId: agentId ?? "", reason: "wave93-demo close" })
    return { ok: r.success, detail: JSON.stringify(r) }
  })

  // ── 8. Closed client → lifetime customer ─────────────────────────────────
  actAs(null)
  await step(ctx, "8a", "client promoted to lifetime customer + anniversary/home-value touches scheduled", "closeTransactionCommand side effects (contacts, lifetime_customer_touchpoints)", async () => {
    if (!CONTACT) return { ok: false, detail: "no contact" }
    const { data: c } = await svc.from("contacts").select("contact_type, lifecycle_state, status").eq("id", CONTACT).maybeSingle()
    const { data: tps, error } = await svc.from("lifetime_customer_touchpoints").select("touchpoint_type, channel, scheduled_for, status").eq("contact_id", CONTACT)
    const types = ((tps ?? []) as any[]).map((t) => `${t.touchpoint_type}/${t.channel}`)
    return { ok: !error && types.length >= 1, detail: `contact=${JSON.stringify(c)} touchpoints=${types.join(", ")}${error ? " err " + error.message : ""}` }
  })
  await step(ctx, "8b", "portal access granted to the client (invite, no mail)", "lib/contact-promotion/portal-access.ts grantPortalAccessForPromotedContact", async () => {
    if (!CONTACT || !agentId) return { ok: false, detail: "no contact/agent" }
    const { grantPortalAccessForPromotedContact } = await import("@/lib/contact-promotion/portal-access")
    const r = await grantPortalAccessForPromotedContact(svc, { contactId: CONTACT, agentId, contactType: "seller", sendMagicLink: false } as any)
    return { ok: r.granted, detail: JSON.stringify(r).slice(0, 400) }
  })
  let CLIENT: { userId: string; email: string } | null = null
  await step(ctx, "8c", "client signs into the portal (OTP emulated) → users row + link-back + first access", "auth.admin.createUser (emulated) + ensureContactPortalUser + recordPortalFirstAccess (portal layout hook chain)", async () => {
    if (!CONTACT) return { ok: false, detail: "no contact" }
    const u = await svc.auth.admin.createUser({ email: E("seller"), email_confirm: true })
    if (u.error || !u.data?.user) return { ok: false, detail: `auth: ${u.error?.message}` }
    CLIENT = { userId: u.data.user.id, email: E("seller") }
    ctx.ids.clientUser = CLIENT.userId
    const { data: c } = await svc.from("contacts").select("id, email, first_name, last_name, brokerage_id, agent_id, metadata").eq("id", CONTACT).maybeSingle()
    const { ensureContactPortalUser } = await import("@/lib/portal/portal-invite-core")
    const ens = await ensureContactPortalUser({ authUserId: CLIENT.userId, authEmail: CLIENT.email, contact: c as any })
    const { recordPortalFirstAccess } = await import("@/lib/portal/portal-first-access")
    const fa = await recordPortalFirstAccess({ contactId: CONTACT, brokerageId: (c as any)?.brokerage_id ?? null, agentId: (c as any)?.agent_id ?? null, contactFirstName: (c as any)?.first_name ?? null, existingMetadata: (c as any)?.metadata ?? null, capturedLanguage: null })
    return { ok: ens.ensured && fa.accepted, verdict: ens.ensured && fa.accepted ? "emulated" : "refused", detail: JSON.stringify({ ensure: ens, firstAccess: fa }) }
  })
  actAs(AGENT ?? BROKER)
  await step(ctx, "8d", "agent files a 30-day follow-up task on the client", "app/actions/tasks.ts createTask", async () => {
    if (!CONTACT) return { ok: false, detail: "no contact" }
    const { createTask } = await import("@/app/actions/tasks")
    const r: any = await createTask({ title: "Wave93 Demo 30-day post-close check-in", description: "wave93-demo", dueDate: new Date(Date.now() + 30 * DAY).toISOString(), contactId: CONTACT, priority: "medium" })
    return { ok: !!r.success, detail: JSON.stringify(r).slice(0, 300) }
  })
  await step(ctx, "8e", "client asks the home assistant a question; the follow-up is filed", "app/actions/portal-lifetime.ts askHomeAssistant", async () => {
    if (!CLIENT || !CONTACT) return { ok: false, detail: "no portal user" }
    actAs(CLIENT)
    const { askHomeAssistant } = await import("@/app/actions/portal-lifetime")
    const r = await askHomeAssistant({ contactId: CONTACT, question: "Can you recommend a roofer? I think the roof needs an inspection before hurricane season." })
    actAs(null)
    return { ok: r.ok && !!r.followUp?.filed, detail: JSON.stringify(r).slice(0, 500) }
  })
}
