/**
 * Wave 91 (lane 91D) — the full-platform walkthrough, prospect → lifetime
 * customer, driven through the REAL functions over the MCP replay bridge.
 * Every row is tagged: names `Wave91 Demo…`, emails `w91d.*@wave91.test`,
 * notes `wave91-demo`. Cleanup is a separate counted SQL pass (lane notes).
 */
import type { WalkCtx } from "./run"
import { BridgeStop, actAs, serviceClient, setScopeBrokerage, quiesce } from "./bridge"

const E = (who: string) => `w91d.${who}@wave91.test`

async function step(ctx: WalkCtx, stepName: string, capability: string, via: string, fn: () => Promise<{ ok: boolean; detail: string; verdict?: "works" | "refused" | "error" | "not reachable" | "emulated" }>) {
  try {
    const r = await fn()
    ctx.row({ step: stepName, capability, via, verdict: r.verdict ?? (r.ok ? "works" : "refused"), detail: r.detail })
  } catch (e) {
    if (e instanceof BridgeStop) throw e
    ctx.row({ step: stepName, capability, via, verdict: "error", detail: String((e as Error)?.message ?? e).slice(0, 300) })
  }
  // Background chains the step started drain before the next step (replay order).
  await quiesce()
}

export async function journey(ctx: WalkCtx) {
  // Shadow answers for the walk's own tenant (bridge.ts setScopeBrokerage).
  if (process.env.W91_BROKERAGE) setScopeBrokerage(process.env.W91_BROKERAGE)
  // ── 1. Platform prospect → qualification → subscriber ─────────────────────
  actAs(null)
  const { buildPlatformProspectTools } = await import("@/lib/platform/prospect-agent-tools")
  const toolCtx = { source: "web:prospect_chat" as const, phone: null, prospectId: null as string | null, callId: null, brand: { name: "VIP Agents" } as never, hasLiveTransfer: false }
  const tools = (await buildPlatformProspectTools(toolCtx)) as Record<string, { execute: (a: any, o?: any) => Promise<any> }>

  await step(ctx, "1a", "prospect chat captures qualification facts", "prospect-agent-tools save_prospect → upsertPlatformProspect", async () => {
    const r = await tools.save_prospect.execute({
      name: "Wave91 Demo Broker", email: E("broker"), company: "Wave91 Demo Realty", role_interest: "brokerage",
      size_seats: 8, producers_count: 6, role_title: "broker-owner", current_tools: "spreadsheets + a legacy CRM",
      pain: "leads go cold before an agent calls", timeline: "1-3_months", territory: "Boca Raton, FL 33431",
      preferred_path: "trial", note: "wave91-demo",
    })
    if (toolCtx.prospectId) ctx.ids.prospect = toolCtx.prospectId
    return { ok: r?.success === true, detail: JSON.stringify(r) + ` prospect=${toolCtx.prospectId}` }
  })

  await step(ctx, "1b", "prospect says yes → trial subscriber (no card, no Stripe)", "start_subscription → convertProspectToSubscriber → createTenantCore", async () => {
    const r = await tools.start_subscription.execute({
      email: E("broker"), name: "Wave91 Demo Broker", company: "Wave91 Demo Realty", plan: null,
      activation: "trial", billing_cycle: null, wants_custom_pricing: false,
    })
    return { ok: r?.success === true, detail: JSON.stringify(r) }
  })
  const svc = serviceClient()
  const { data: conv } = await svc.from("platform_prospects").select("converted_brokerage_id, status").eq("email", E("broker")).maybeSingle()
  const B = (conv?.converted_brokerage_id ?? "") as string
  const { data: brokerSeat } = await svc.from("users").select("id").eq("email", E("broker")).maybeSingle()
  const BROKER = { userId: (brokerSeat?.id ?? "") as string, email: E("broker") }
  ctx.ids.brokerage = B; ctx.ids.brokerUser = BROKER.userId
  ctx.row({ step: "1c", capability: "prospect row carries the conversion + broker seat exists", via: "platform_prospects.converted_brokerage_id / users", verdict: B && BROKER.userId ? "works" : "refused", detail: `prospect.status=${conv?.status} brokerage=${B} brokerUser=${BROKER.userId}` })
  if (!B || !BROKER.userId) return
  setScopeBrokerage(B)

  // ── 2. Brokerage management ───────────────────────────────────────────────
  actAs(BROKER)
  const { inviteUser } = await import("@/app/actions/admin/invite-user")
  await step(ctx, "2a", "broker invites an agent", "app/actions/admin/invite-user.ts inviteUser", async () => {
    const r = await inviteUser({ email: E("agent"), firstName: "Wave91", lastName: "Demo Agent", userType: "agent" })
    return { ok: r.success, detail: JSON.stringify(r) }
  })
  await step(ctx, "2b", "broker invites a team lead", "inviteUser (team_lead)", async () => {
    const r = await inviteUser({ email: E("teamlead"), firstName: "Wave91", lastName: "Demo TeamLead", userType: "team_lead" })
    return { ok: r.success, detail: JSON.stringify(r) }
  })
  const { data: seats } = await svc.from("users").select("id, email, user_type").in("email", [E("agent"), E("teamlead")])
  const agentUser = (seats ?? []).find((u: any) => u.email === E("agent")) as { id: string } | undefined
  const tlUser = (seats ?? []).find((u: any) => u.email === E("teamlead")) as { id: string } | undefined
  const { data: agentRow } = agentUser ? await svc.from("agents").select("id").eq("user_id", agentUser.id).maybeSingle() : { data: null }
  const agentId: string | null = (agentRow as any)?.id ?? null
  ctx.ids.agentUser = agentUser?.id ?? ""; ctx.ids.teamLeadUser = tlUser?.id ?? ""; ctx.ids.agent = agentId ?? ""

  const { createTeam } = await import("@/app/actions/multi-persona")
  await step(ctx, "2c", "broker creates a team led by the team lead", "app/actions/multi-persona.ts createTeam", async () => {
    if (!tlUser?.id) return { ok: false, detail: "no team-lead seat to lead the team" }
    const t = await createTeam({ teamName: "Wave91 Demo Team", teamLeaderId: tlUser.id })
    ctx.ids.team = (t as any)?.id ?? ""
    return { ok: !!(t as any)?.id, detail: JSON.stringify(t) }
  })
  const { saveAssignmentRuleAction } = await import("@/app/actions/admin/assignment-rules")
  await step(ctx, "2d", "lead assignment rule (round robin → the agent)", "app/actions/admin/assignment-rules.ts saveAssignmentRuleAction", async () => {
    const r = await saveAssignmentRuleAction({ name: "Wave91 Demo round robin", ruleType: "round_robin", conditions: {}, agentIds: agentId ? [agentId] : [], teamId: null, priority: 1, isActive: true } as any)
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

  // ── 3. Recruiting ─────────────────────────────────────────────────────────
  actAs(null)
  await step(ctx, "3a", "recruit sourcing (Reddit/review scrape)", "lib/recruit-pipeline/recruit-sourcer.ts sourceRecruitProspects", async () => {
    const { sourceRecruitProspects } = await import("@/lib/recruit-pipeline/recruit-sourcer")
    const r = await sourceRecruitProspects({ supabase: svc, marketId: "00000000-0000-0000-0000-000000000000", state: "FL", reviewUrls: [] })
    return { ok: false, verdict: "not reachable", detail: `paid scrape refused in the walkthrough (no Apify call): ${JSON.stringify(r)}` }
  })
  let rawRecruitId: string | null = null
  await step(ctx, "3b", "raw recruit lands (seeded: the sourcer's own insert shape — scrape stubbed)", "raw_recruit_prospects insert (sourcer shape)", async () => {
    const { data, error } = await svc.from("raw_recruit_prospects").insert({
      brokerage_id: B, market_id: null, source: "wave91_demo", source_record_id: "wave91-demo-recruit-1",
      raw_data: { note: "wave91-demo", matched_term: "thinking of switching brokerage" },
      normalized_preview: { firstName: "Wave91", lastName: "Demo Recruit", email: E("recruit"), state: "FL", currentBrokerage: "Other Realty", switchSignal: "thinking of switching brokerage" },
      processing_status: "pending",
    }).select("id").single()
    rawRecruitId = data?.id ?? null
    return { ok: !error && !!rawRecruitId, verdict: error ? "error" : "emulated", detail: error ? error.message : `raw ${rawRecruitId}` }
  })
  await step(ctx, "3c", "recruit pipeline promotes the raw prospect to a recruit", "lib/recruit-pipeline/recruit-processor.ts processRawRecruit", async () => {
    if (!rawRecruitId) return { ok: false, detail: "no raw recruit" }
    const { processRawRecruit } = await import("@/lib/recruit-pipeline/recruit-processor")
    const r = await processRawRecruit(rawRecruitId, B)
    if ((r as any).recruitId) ctx.ids.recruit = (r as any).recruitId
    return { ok: r.success, detail: JSON.stringify(r) }
  })
  await step(ctx, "3d", "fatigue / retention radar scores the brokerage's agents", "lib/recruiting/retention-radar.ts runRetentionRadar", async () => {
    const { runRetentionRadar } = await import("@/lib/recruiting/retention-radar")
    const r = await runRetentionRadar(svc, { brokerageId: B })
    return { ok: r.scanned >= 1 && r.scored >= 1, detail: JSON.stringify(r) }
  })

  // ── 4. Marketing / campaigns / ads / websites ─────────────────────────────
  actAs(BROKER)
  await step(ctx, "4a", "brand kit (colors + voice) saved and published", "app/actions/onboarding/brand.ts saveBrandColors + saveBrandVoice + publishBrand", async () => {
    const brand = await import("@/app/actions/onboarding/brand")
    const a = await brand.saveBrandColors({ primaryColor: "#0B3D91", secondaryColor: "#F2A900", tagline: "Wave91 Demo — home, handled" })
    const b = await brand.saveBrandVoice({ tone: "warm", formalityLevel: "conversational", prohibitedWords: ["guarantee"], signaturePhrases: ["home, handled"] })
    const c = await brand.publishBrand()
    return { ok: a.success && b.success && c.success, detail: JSON.stringify({ colors: a, voice: b, publish: c }) }
  })
  await step(ctx, "4b", "campaign sequence created, step added, launched (compliance precheck)", "app/actions/campaign-sequences.ts createCampaignSequence + createSequenceStep + launchCampaignSequence", async () => {
    const cs = await import("@/app/actions/campaign-sequences")
    const s = await cs.createCampaignSequence({ brokerageId: B, name: "Wave91 Demo seller nurture", description: "wave91-demo", sequence_type: "nurture", trigger_event: "contact_created" })
    if (!s.sequence) return { ok: false, detail: `create: ${s.error}` }
    ctx.ids.sequence = (s.sequence as any).id
    const st = await cs.createSequenceStep({ sequence_id: (s.sequence as any).id, step_number: 1, step_name: "Welcome", channel: "email", delay_days: 0, delay_hours: 1, subject: "Thinking about selling?", body: "Hi {{first_name}}, here is what homes near you sold for this month. Reply any time — we are happy to help." })
    const l = await cs.launchCampaignSequence((s.sequence as any).id)
    return { ok: !!st.step && l.success, detail: JSON.stringify({ step: st.error ?? (st.step as any)?.id, launch: l }) }
  })
  await step(ctx, "4c", "ads campaign draft (no platform call)", "lib/ads/ad-creator.ts createAdCampaign", async () => {
    const { createAdCampaign } = await import("@/lib/ads/ad-creator")
    const r = await createAdCampaign(BROKER.userId, { brokerageId: B, agentUserId: BROKER.userId, campaignName: "Wave91 Demo seller leads", platform: "facebook", objective: "leads", dailyBudget: 20, targetingConfig: { locations: ["Boca Raton, FL"], age_min: 25, age_max: 65 } as any })
    if (r.campaignId) ctx.ids.adCampaign = r.campaignId
    return { ok: r.success, detail: JSON.stringify(r) }
  })
  await step(ctx, "4d", "tenant website resolves for the brokerage slug", "app/site/[slug]/page.tsx generateMetadata + page render", async () => {
    const page: any = await import("@/app/site/[slug]/page")
    const { data: bRow } = await svc.from("brokerages").select("slug").eq("id", B).maybeSingle()
    const slug = (bRow as any)?.slug ?? ""
    const meta = page.generateMetadata ? await page.generateMetadata({ params: Promise.resolve({ slug }) }) : null
    let rendered = false
    try { const el = await page.default({ params: Promise.resolve({ slug }) }); rendered = !!el } catch (e) { if ((e as Error).message === "BRIDGE_STOP") throw e; return { ok: false, detail: `render threw: ${(e as Error).message} meta=${JSON.stringify(meta)}` } }
    return { ok: rendered, detail: `rendered=${rendered} title=${JSON.stringify((meta as any)?.title ?? null)}` }
  })
  actAs(agentUser ? { userId: agentUser.id, email: E("agent") } : BROKER)
  await step(ctx, "4e", "lead magnet form created + published (agent)", "app/actions/lead-magnets-actions.ts createLeadMagnetAction + publishLeadMagnetAction", async () => {
    const lm = await import("@/app/actions/lead-magnets-actions")
    const c: any = await lm.createLeadMagnetAction({ name: "Wave91 Demo home value report", magnet_type: "home_valuation", description: "wave91-demo" })
    if (!c.success) return { ok: false, detail: `create: ${c.error}` }
    ctx.ids.magnet = c.magnetId
    const p: any = await lm.publishLeadMagnetAction(c.magnetId, ["landing_page"])
    return { ok: !!p?.success, detail: JSON.stringify({ create: { id: c.magnetId, slug: c.slug }, publish: p }) }
  })
}
