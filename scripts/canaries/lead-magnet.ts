/**
 * scripts/canaries/lead-magnet.ts — LEAD MAGNET canary (wave 141, lane 141J):
 *   tenant builds → (AI draft) → human approves/publishes → QR/landing distribution → submission →
 *   attribution → canonical contact pipeline
 * through lib/kernel/lead-magnets.ts (createLeadMagnet → publishLeadMagnet → generateQRCode via the ONE
 * QR minter lib/marketing/tracked-qr.ts → captureFormSubmission). Owner (wave 141): "tenants create their
 * own lead magnets … AI builds the ACTUAL draft → human preview/edit/approve → publish → ads/QR/social/
 * website distribution → capture → attribution → outcome → learning." The AI draft, the ad attribution
 * columns (lane 141E) and the QR destination allow-list (lane 141F) are WAVE141 HOOKS.
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, setSvc, uuid } from "./_harness"
import { ROOT, hooksFor, strippedRepo } from "./_registry"

export async function run() {
  const c = canary("Lead magnet: tenant builds → AI draft → human approves → QR/landing publish → submission → attribution → canonical pipeline")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: a submission creates a contact and enqueues enrichment — in-memory only")
  const B = uuid(), B2 = uuid(), U = uuid(), AG = uuid()
  const svc = canaryClient({
    brokerages: [{ id: B, name: `${CANARY_TAG} Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-lm` }, { id: B2, name: `${CANARY_TAG} Other`, plan_tier: "team", slug: `${CANARY_TAG}-lm2` }],
    users: [{ id: U, email: `agent@${CANARY_EMAIL_DOMAIN}`, user_type: "agent", brokerage_id: B }],
    agents: [{ id: AG, user_id: U, brokerage_id: B, first_name: "Canary", last_name: "Agent", is_active: true }],
  })
  setSvc(svc)
  const { createLeadMagnet, publishLeadMagnet, captureFormSubmission, leadMagnetQrLabel } = await import("../../lib/kernel/lead-magnets")
  // WAVE 147 (lane 147E — owner ruling 5 / C11): a guide publishes only with its delivery asset READY. The in-memory booklet render
  // cannot host a PDF, so the canary injects a ready asset through the deliverable seam (the C11 rule itself is
  // test:lead-magnet-asset-invariant). The journey this canary walks is unchanged.
  const READY_GUIDE_147E = { produceGuide: async () => ({ status: "ready" as const, assetUrl: "https://canary.example/guides/buyer.pdf", documentId: null, title: "Buyer Guide", coverNote: { subject: "Your guide", title: "Buyer Guide", body: "Here is your guide." }, validation: { ok: true } }) }
  const created = await createLeadMagnet({ title: `${CANARY_TAG} Buyer Guide`, description: "first-time buyer guide", magnetType: "buyer_guide", brokerageId: B, agentId: AG, createdBy: U }, { deliverable: READY_GUIDE_147E })
  c.step("tenant builder: createLeadMagnet writes the tenant's OWN lead_capture_forms record (canonical schema, default fields for the type)", created.success && !!created.magnetId && (svc.tables.lead_capture_forms ?? []).some((f) => f.id === created.magnetId && f.brokerage_id === B && Array.isArray(f.fields) && f.fields.length > 0 && f.magnet_type === "buyer_guide"), created.error ?? `magnet ${created.magnetId} slug ${created.slug}`)
  const M = created.magnetId ?? ""
  c.step("evidence: lead_magnet_created is emitted on THIS tenant (lifecycle_events)", (svc.tables.lifecycle_events ?? []).some((e) => e.brokerage_id === B && /lead_magnet_created/.test(String(e.event_type))), "")
  const base = "https://canary.example"
  const pub = await publishLeadMagnet({ magnetId: M, brokerageId: B, channels: ["qr_code", "landing_page"], actorUserId: U, baseUrl: base })
  c.step("human approves → publish: publishLeadMagnet activates the form and returns the landing URL", pub.success && pub.urls?.landing === `${base}/lm/${created.slug}` && (svc.tables.lead_capture_forms ?? []).find((f) => f.id === M)?.is_active === true, pub.error ?? JSON.stringify(pub.urls))
  const qr = (svc.tables.qr_codes ?? []).filter((q) => q.label === leadMagnetQrLabel(M))
  c.step("QR distribution: ONE tracked qr_codes row under the tenant (purpose lead_magnet, destination landing_page, target = the landing URL) through the one minter", qr.length === 1 && qr[0].brokerage_id === B && qr[0].purpose === "lead_magnet" && qr[0].destination_type === "landing_page" && qr[0].target_url === pub.urls?.landing && !!qr[0].slug, `qr ${qr[0]?.slug}`)
  const again = await publishLeadMagnet({ magnetId: M, brokerageId: B, channels: ["qr_code"], actorUserId: U, baseUrl: base })
  c.step("idempotency: republishing reuses the same tracked code (one row for the magnet's key, never a split scan count)", again.success && (svc.tables.qr_codes ?? []).filter((q) => q.label === leadMagnetQrLabel(M)).length === 1, "")
  const stolen = await publishLeadMagnet({ magnetId: M, brokerageId: B2, channels: ["landing_page"], actorUserId: U, baseUrl: base })
  c.step("POSITIVE CONTROL (tenant boundary): another tenant cannot publish this magnet (brokerage predicate on the read)", !stolen.success, stolen.error ?? "published")
  const email = `jordan@${CANARY_EMAIL_DOMAIN}`
  const sub1 = await captureFormSubmission({ formId: M, brokerageId: B, submissionData: { first_name: "Jordan", last_name: "Canary", email, phone: "5125550123" }, tcpaConsentGiven: true, ipAddress: "203.0.113.9", userAgent: "canary" })
  const contact = (svc.tables.contacts ?? []).find((x) => x.id === sub1.contactId)
  c.step("submission → canonical pipeline: a NEW contact lands under the tenant, owned by the magnet's agent (agents.id), source lead_magnet / online_form, intent stamped from the magnet (buyer)", sub1.success && !!contact && contact.brokerage_id === B && contact.agent_id === AG && contact.source === "lead_magnet" && contact.source_channel === "online_form" && contact.contact_type === "buyer", sub1.error ?? `contact ${sub1.contactId}`)
  const rows = (svc.tables.form_submissions ?? []).filter((s) => s.form_id === M)
  c.step("attribution: the form_submissions row links form → contact and carries the consent record + provenance (ip, ua)", rows.length === 1 && rows[0].contact_id === sub1.contactId && rows[0].tcpa_consent_given === true && rows[0].ip_address === "203.0.113.9", "")
  const sub2 = await captureFormSubmission({ formId: M, brokerageId: B, submissionData: { first_name: "Jordan", last_name: "Canary", email }, tcpaConsentGiven: true })
  c.step("dedup: the same person again resolves to the SAME contact (one contacts row, two submissions)", sub2.success && sub2.contactId === sub1.contactId && (svc.tables.contacts ?? []).filter((x) => x.brokerage_id === B).length === 1 && (svc.tables.form_submissions ?? []).filter((s) => s.form_id === M).length === 2, sub2.error ?? "")
  const wrongTenant = await captureFormSubmission({ formId: M, brokerageId: B2, submissionData: { first_name: "X", last_name: "Y", email: `x@${CANARY_EMAIL_DOMAIN}` }, tcpaConsentGiven: true })
  c.step("POSITIVE CONTROL (tenant boundary): a submission naming a tenant that does not own the form is refused", !wrongTenant.success, wrongTenant.error ?? "accepted")
  const noConsent = await captureFormSubmission({ formId: M, brokerageId: B, submissionData: { first_name: "Sam", last_name: "Canary", email: `sam@${CANARY_EMAIL_DOMAIN}`, property_address: "9 Canary Way" }, tcpaConsentGiven: false })
  c.step("POSITIVE CONTROL (consent): a home-value submission without TCPA consent is refused by the kernel, not only by the HTTP door", !noConsent.success && /TCPA/i.test(noConsent.error ?? ""), noConsent.error ?? "accepted")
  // The hooks run AFTER the submission / dedup steps above on purpose: the attribution hook captures two more people under this tenant and the dedup step counts contacts under B.
  // WAVE141 HOOKS (integrator): 141E — the AI draft (lib/lead-magnets/ai-draft.ts, wired at integration) and ad
  // attribution (lib/lead-magnets/attribution.ts + lib/ads/ad-destination.ts, wired at integration); 141F — the QR
  // allow-list (lib/marketing/qr-contract.ts), wired 141K against the row just minted.
  const CAMP = uuid(), CAMP_FOREIGN = uuid(), AD_CAMP = uuid()
  for (const h of hooksFor("lead-magnet")) {
    const at = h.probe()
    if (!at) { c.hook(h.lane, h.contract); continue }
    if (h.lane === "141E" && /AI CREATION/.test(h.contract)) {
      const { draftLeadMagnetFromConcept, LEAD_MAGNET_DRAFT_FEATURE } = await import("../../lib/lead-magnets/ai-draft")
      const formsBefore = (svc.tables.lead_capture_forms ?? []).length
      const ledgerFor = (action: string) => (svc.tables.agent_action_ledger ?? []).filter((r) => r.action === action)
      let modelCalls = 0
      const concept = "A spring selling guide for homeowners thinking about listing"
      const refused = await draftLeadMagnetFromConcept(
        { brokerageId: B, agentId: AG, createdBy: U, concept },
        { client: svc as never, entitlement: async () => ({ allowed: false, reason: "ai_budget_exhausted", message: "AI budget used up" }), generator: async () => { modelCalls++; return null } },
      )
      c.step(`${h.lane} landed (${at}) — POSITIVE CONTROL (entitlement first): a refused mayUseAndAfford writes NOTHING — no draft row, no ledger row, the model never called, the tenant told why`, !refused.success && /AI budget used up/.test(refused.error ?? "") && (svc.tables.lead_capture_forms ?? []).length === formsBefore && ledgerFor("marketing.lead_magnet.ai_draft").length === 0 && modelCalls === 0, refused.error ?? "drafted")
      const drafted = await draftLeadMagnetFromConcept(
        { brokerageId: B, agentId: AG, createdBy: U, concept, area: "Austin, TX" },
        {
          client: svc as never,
          entitlement: async (ask) => ({ allowed: ask.brokerageId === B && ask.estTokens > 0, reason: "subscription_current" }),
          generator: async (req) => {
            modelCalls++
            return req.magnetType === "seller_guide" ? {
              name: `${CANARY_TAG} Sell smarter this spring`, description: "Two sentences.", headline: "Sell smarter this spring", subhead: "Price, prep and marketing that gets homes sold.",
              cta: "Send me the guide", bullets: ["Pricing strategy", "Prep that pays", "Modern marketing"], thankYou: "Thanks — check your inbox.",
              questions: [{ label: "When are you planning to sell?", type: "select", options: ["0-3 months", "3-6 months"] }],
              faq: [{ question: "How do I price my home?", answer: "To the market, not to a wish." }],
            } : null
          },
        },
      )
      const draftRow = (svc.tables.lead_capture_forms ?? []).find((r) => r.id === drafted.magnetId)
      c.step(`${h.lane} the AI produces the ACTUAL draft: concept → type classified (seller_guide) → ONE real lead_capture_forms record under THIS tenant, INACTIVE (lifecycle draft), authored by ai through the routed feature, the model's copy/questions/FAQ persisted on it — through the same createLeadMagnet the human builder uses`, drafted.success && drafted.fromAi === true && drafted.magnetType === "seller_guide" && modelCalls === 1 && !!draftRow && draftRow.brokerage_id === B && draftRow.is_active === false && draftRow.settings?.lifecycle?.state === "draft" && draftRow.settings?.authoring?.by === "ai" && draftRow.settings?.authoring?.feature === LEAD_MAGNET_DRAFT_FEATURE && draftRow.landing_content?.headline === "Sell smarter this spring" && Array.isArray(draftRow.fields) && draftRow.fields.some((f: { name?: string }) => f.name === "email") && draftRow.fields.some((f: { name?: string }) => f.name === "when_are_you_planning_to_sell"), JSON.stringify({ success: drafted.success, error: drafted.error, type: drafted.magnetType, fromAi: drafted.fromAi, fallback: drafted.fallbackReason }))
      const aiLedger = ledgerFor("marketing.lead_magnet.ai_draft")
      c.step(`${h.lane} evidence: ONE ledger row marketing.lead_magnet.ai_draft, executed, actor the requesting human, LOW_RISK_WRITE, outcome draft_created`, aiLedger.length === 1 && aiLedger[0].status === "executed" && aiLedger[0].actor_user_id === U && aiLedger[0].risk_class === "LOW_RISK_WRITE" && aiLedger[0].outcome === "draft_created", JSON.stringify(aiLedger.map((r) => ({ status: r.status, outcome: r.outcome, risk: r.risk_class }))))
      const approved = await publishLeadMagnet({ magnetId: drafted.magnetId ?? "", brokerageId: B, channels: ["landing_page"], actorUserId: U, baseUrl: base }, { deliverable: READY_GUIDE_147E })
      const approvedRow = (svc.tables.lead_capture_forms ?? []).find((r) => r.id === drafted.magnetId)
      c.step(`${h.lane} human preview → approve: publishLeadMagnet IS the approval — the draft becomes the live landing (/lm/<slug>) only when a human publishes it; nothing auto-publishes an AI draft`, approved.success && approvedRow?.is_active === true && approved.urls?.landing === `${base}/lm/${drafted.slug}`, approved.error ?? String(approved.urls?.landing))
      continue
    }
    if (h.lane === "141E" && /ATTRIBUTION/.test(h.contract)) {
      const { resolveAdDestination } = await import("../../lib/ads/ad-destination")
      const { parseLeadMagnetAttribution } = await import("../../lib/lead-magnets/attribution")
      const { getMagnetPerformance } = await import("../../lib/kernel/lead-magnets")
      ;(svc.tables.marketing_campaigns ??= []).push(
        { id: CAMP, brokerage_id: B, campaign_name: `${CANARY_TAG} Spring sellers`, campaign_type: "ad", status: "active" },
        { id: CAMP_FOREIGN, brokerage_id: B2, campaign_name: `${CANARY_TAG} Foreign`, campaign_type: "ad", status: "active" },
      )
      const prevOrigin = process.env.NEXT_PUBLIC_APP_URL
      process.env.NEXT_PUBLIC_APP_URL = base
      try {
        const attribution = { campaignId: CAMP, adCampaignId: AD_CAMP, creative: "Variant B", utmSource: "facebook", utmMedium: "paid_social" }
        const dest = await resolveAdDestination(svc as never, { brokerageId: B, leadMagnetId: M, attribution })
        c.step(`${h.lane} landed (${at}): the ad writer's destination for a lead-magnet campaign is the PUBLISHED magnet's own /lm page carrying campaign_id / ad_campaign_id / creative (one query-string vocabulary) — never the brand site`, !!dest && dest.startsWith(`${base}/lm/${created.slug}?`) && /campaign_id=/.test(dest) && /creative=variant-b/.test(dest) && /utm_source=facebook/.test(dest), dest ?? "null")
        const foreignDest = await resolveAdDestination(svc as never, { brokerageId: B2, leadMagnetId: M, attribution })
        c.step(`${h.lane} POSITIVE CONTROL (tenant boundary): another tenant's campaign cannot point an ad at this magnet — null, never a cross-tenant landing`, foreignDest === null, String(foreignDest))
      } finally {
        if (prevOrigin === undefined) delete process.env.NEXT_PUBLIC_APP_URL; else process.env.NEXT_PUBLIC_APP_URL = prevOrigin
      }
      const adHit = parseLeadMagnetAttribution({ utm_source: "facebook", utm_medium: "paid_social", utm_campaign: "Spring sellers", campaign_id: CAMP, ad_campaign_id: AD_CAMP, creative: "Variant B" })
      const touchpointsBefore = (svc.tables.marketing_campaign_touchpoints ?? []).length
      const cap = await captureFormSubmission({ formId: M, brokerageId: B, source: "landing_page", tcpaConsentGiven: true, ipAddress: "203.0.113.9", userAgent: "canary", submissionData: { first_name: "Sam", last_name: "Canary", email: `sam.seller@${CANARY_EMAIL_DOMAIN}`, phone: "+15125550100" }, attribution: adHit })
      const sam = (svc.tables.contacts ?? []).find((x) => x.id === cap.contactId)
      const tp = (svc.tables.marketing_campaign_touchpoints ?? []).find((r) => r.id === cap.attribution?.touchpointId)
      c.step(`${h.lane} capture keeps the attribution through intake → consent → dedup → contact: the campaign is VERIFIED against the magnet's tenant, the new contact carries campaign_attribution_id + source_channel paid_ad + the consent stamp, and ONE touchpoint lands on the existing spine (converted, external_table form_submissions, creative + ad campaign in metadata)`, cap.success && cap.attribution?.campaignVerified === true && !!tp && sam?.campaign_attribution_id === CAMP && sam?.source_channel === "paid_ad" && sam?.tcpa_consent === true && sam?.brokerage_id === B && tp.campaign_id === CAMP && tp.contact_id === sam?.id && tp.status === "converted" && tp.external_table === "form_submissions" && tp.external_id === cap.submissionId && tp.metadata?.creative === "variant-b" && tp.metadata?.ad_campaign_id === AD_CAMP && (svc.tables.marketing_campaign_touchpoints ?? []).length === touchpointsBefore + 1, JSON.stringify({ success: cap.success, error: cap.error, attribution: cap.attribution }))
      const foreignCap = await captureFormSubmission({ formId: M, brokerageId: B, source: "landing_page", tcpaConsentGiven: true, submissionData: { first_name: "Eve", last_name: "Canary", email: `eve.else@${CANARY_EMAIL_DOMAIN}` }, attribution: { utmSource: "facebook", utmMedium: "paid_social", campaignId: CAMP_FOREIGN, creative: "x" } })
      const eve = (svc.tables.contacts ?? []).find((x) => x.id === foreignCap.contactId)
      c.step(`${h.lane} POSITIVE CONTROL (tenant boundary): a campaign_id belonging to ANOTHER tenant is dropped — the capture still succeeds, the contact carries NO campaign_attribution_id, no touchpoint is written, the inert utm/creative strings survive`, foreignCap.success && foreignCap.attribution?.campaignVerified === false && eve?.campaign_attribution_id == null && (svc.tables.marketing_campaign_touchpoints ?? []).length === touchpointsBefore + 1 && foreignCap.attribution?.creative === "x", JSON.stringify({ success: foreignCap.success, verified: foreignCap.attribution?.campaignVerified }))
      const perf = await getMagnetPerformance({ magnetId: M, brokerageId: B })
      c.step(`${h.lane} outcome → learning: getMagnetPerformance reads the converted touchpoints back as attributedConversions per campaign (the reader the spine's converted_at column needed)`, perf.success === true && perf.performance?.attributedConversions?.total === 1 && perf.performance?.attributedConversions?.byCampaign?.[0]?.campaignId === CAMP && perf.performance?.attributedConversions?.byCampaign?.[0]?.count === 1, JSON.stringify(perf.performance?.attributedConversions ?? perf.error))
      continue
    }
    if (h.lane !== "141F") { c.step(`${h.lane} landed (${at}) — wire its export into this canary and assert the contract (WAVE141 HOOK (integrator): ${h.lane})`, false, h.contract.slice(0, 120)); continue }
    const { resolveQrScanDestination, isQrInAppPublicPath, QR_IN_APP_PUBLIC_PREFIXES, qrEncodeOptions, QR_RENDER_DEFAULTS } = await import("../../lib/marketing/qr-contract")
    const origins = [base]
    const slug = String(qr[0]?.slug ?? "")
    const dest = resolveQrScanDestination({ slug, targetUrl: String(qr[0]?.target_url ?? ""), appOrigins: origins })
    c.step(`${h.lane} landed (${at}): a scan of the magnet's code goes WHERE THE CODE SAYS — the allow-listed IN-APP landing (/lm/<slug>, same host as the app) with the code's slug appended once as qr= for attribution; never a raw redirect`, dest.kind === "in_app" && dest.path === `/lm/${created.slug}?qr=${slug}` && dest.reason === "allow_listed", JSON.stringify(dest))
    const foreign = resolveQrScanDestination({ slug: "s1", targetUrl: "https://evil.example/phish", appOrigins: origins })
    const js = resolveQrScanDestination({ slug: "s1", targetUrl: "javascript:alert(1)", appOrigins: origins })
    const proto = resolveQrScanDestination({ slug: "s1", targetUrl: "//evil.example/x", appOrigins: origins })
    const dots = resolveQrScanDestination({ slug: "s1", targetUrl: "/listings/../dashboard/admin", appOrigins: origins })
    const dash = resolveQrScanDestination({ slug: "s1", targetUrl: `${base}/dashboard/admin`, appOrigins: origins })
    const self = resolveQrScanDestination({ slug: "s1", targetUrl: `${base}/qr/s1`, appOrigins: origins })
    c.step("141F no open redirect, by construction: an https host we do not own is OFFERED on the landing as a tap-through (never followed); javascript:, protocol-relative, dot-segment and dashboard targets all land on the code's own landing with NO offer; the landing itself is not re-routed", foreign.kind === "landing" && foreign.external?.host === "evil.example" && js.kind === "landing" && js.external === null && js.reason === "unsafe_target" && proto.kind === "landing" && proto.external === null && dots.kind === "landing" && dots.external === null && dots.reason === "not_allow_listed" && dash.kind === "landing" && dash.reason === "not_allow_listed" && self.kind === "landing" && self.reason === "landing_is_target", "")
    const prefixDirs = QR_IN_APP_PUBLIC_PREFIXES.map((p) => p.slice(1, -1))
    c.step("141F the allow-list is REAL routes: every prefix is a real app/<segment> directory, none is /api/ or /dashboard/ (a scanner has no session — a redirect there is a login wall), and each is in-app by the resolver", prefixDirs.every((d) => existsSync(join(ROOT, "app", d))) && !QR_IN_APP_PUBLIC_PREFIXES.some((p) => /^\/(api|dashboard)\//.test(p)) && QR_IN_APP_PUBLIC_PREFIXES.every((p) => isQrInAppPublicPath(`${p}x`)) && !isQrInAppPublicPath("/dashboard/x"), prefixDirs.join(","))
    const scan = strippedRepo("app/api/qr/scan/route.ts") ?? ""
    c.step("141F the scan door uses it: app/api/qr/scan resolves the row by SLUG — the tenant is the ROW's brokerage_id, never a request value — decides through resolveQrScanDestination and redirects to destination.path only (a same-origin path), recording where the scan went in the event", /resolveQrScanDestination\(/.test(scan) && /new URL\(destination\.path/.test(scan) && /qr\.brokerage_id/.test(scan) && !/searchParams\.get\(\s*["']brokerage/.test(scan) && !/redirect\([^)]*target_url/.test(scan) && /routed_reason/.test(scan), "")
    const enc = qrEncodeOptions()
    c.step("141F one encoding (phone-camera readable, ISO/IEC 18004): quiet zone 4 modules, error correction M, black on white, print 600px — and the one minter encodes through it", enc.margin === 4 && enc.errorCorrectionLevel === "M" && enc.width === QR_RENDER_DEFAULTS.printWidth && enc.color.dark === "#000000" && /qrEncodeOptions\(/.test(strippedRepo("lib/marketing/tracked-qr.ts") ?? ""), JSON.stringify(enc))
  }
  c.blind("The deliverable copy, the sequence enrollment and contact enrichment are best-effort rails after the capture (stubbed by absence here); the ad/QR SCAN hop (app/api/qr/scan) is HTTP and not driven — the row the scanner resolves is asserted.")
  c.blind("The PNG is rendered by the vendored `qrcode` package through the one encoding contract; the 360–430px render of the scan landing and the HTTP scan hop itself are lane 141F's test:qr-and-card-scanner (react-dom/server), not driven here.")
  const a = await cleanupCanary(svc, B), b = await cleanupCanary(svc, B2)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", a.mismatches.length + b.mismatches.length === 0 && a.residual + b.residual === 0, [...a.cleanup, ...b.cleanup].map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report([...a.cleanup, ...b.cleanup], a.residual + b.residual)
}
