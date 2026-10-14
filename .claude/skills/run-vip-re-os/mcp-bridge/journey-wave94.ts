/**
 * Wave 94 (lane 94B) — THE OUTSIDE BUYER'S AGENT'S EMAILED OFFER, end to end,
 * through the real functions over the MCP replay bridge.
 *
 *   setup — prospect → trial tenant → agent seat → listing with its seller
 *           (the seller's portal invite is RECORDED, not built here: lane 94A)
 *   walk  — the brokerage's inbound mailbox (postmark) → the outside agent emails
 *           an offer PDF + pre-approval to the REAL inbound-mail handler (signed
 *           webhook, no external mail) → outside_agents record + intake buyer +
 *           offer + documents → AI read (the MODEL is stubbed; everything after
 *           it is the real applyExtractedOfferData) → listing agent notified →
 *           the agent's ONE release (offer + documents + net sheet) → the seller
 *           sees it in their own portal session → counter (outside agent copied
 *           by email) → accept with the executed contract → transaction (the
 *           cooperating agent on the roster, emailed the terms ONCE) → milestone
 *           (copied) → close (copied ONCE across both close spellings) → lifetime
 *           customer → follow-up task
 *
 * Tags: names `Wave94 Demo…`, emails `w94.*@wave94.test`, notes `wave94-demo`,
 * synthetic ids `94b0…`. Run with BRIDGE_DEMO_EMAIL_SUFFIX=@wave94.test,
 * BRIDGE_UUID_PREFIX=94b0, BRIDGE_STORAGE_EMULATE=1, BRIDGE_EMAIL_EMULATE=1.
 */
import { createHmac } from "node:crypto"
import type { WalkCtx } from "./run"
import { BridgeStop, actAs, serviceClient, setScopeBrokerage, setScopeIds, setScopeTextIds, quiesce, emailsEmulated, externalCalls } from "./bridge"

const E = (who: string) => `w94.${who}@wave94.test`
const DAY = 86_400_000
const COOP = E("coop")
const INBOX = E("inbox")
const ADDRESS = "2294 Wave94 Demo Lane"

async function step(ctx: WalkCtx, stepName: string, capability: string, via: string, fn: () => Promise<{ ok: boolean; detail: string; verdict?: "works" | "refused" | "error" | "not reachable" | "emulated" }>) {
  try {
    const r = await fn()
    ctx.row({ step: stepName, capability, via, verdict: r.verdict ?? (r.ok ? "works" : "refused"), detail: r.detail })
  } catch (e) {
    if (e instanceof BridgeStop) throw e
    ctx.row({ step: stepName, capability, via, verdict: "error", detail: String((e as Error)?.stack ?? e).slice(0, 400) })
  }
  await quiesce()
}

const pdf = (tag: string) => Buffer.from(`%PDF-1.4\n% ${tag} wave94-demo\n`).toString("base64")

export async function journey(ctx: WalkCtx) {
  // In-process configuration only — nothing leaves the sandbox (fetch is refused; SendGrid is emulated).
  process.env.POSTMARK_INBOUND_WEBHOOK_SECRET = "wave94-demo-inbound-secret"
  process.env.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "bridge-emulated"
  process.env.SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || E("platform")
  if (process.env.W94_BROKERAGE) setScopeBrokerage(process.env.W94_BROKERAGE)
  const svc = serviceClient()

  // ── S1. Fresh tenant ───────────────────────────────────────────────────────
  actAs(null)
  const { buildPlatformProspectTools } = await import("@/lib/platform/prospect-agent-tools")
  const toolCtx = { source: "web:prospect_chat" as const, phone: null, prospectId: null as string | null, callId: null, brand: { name: "VIP Agents" } as never, hasLiveTransfer: false }
  const tools = (await buildPlatformProspectTools(toolCtx)) as Record<string, { execute: (a: any, o?: any) => Promise<any> }>
  await step(ctx, "S1", "prospect → trial subscriber → tenant", "prospect-agent-tools save_prospect + start_subscription → createTenantCore", async () => {
    const a = await tools.save_prospect.execute({
      name: "Wave94 Demo Broker", email: E("broker"), company: "Wave94 Demo Realty", role_interest: "brokerage",
      size_seats: 5, producers_count: 4, role_title: "broker-owner", current_tools: "spreadsheets", pain: "outside offers get lost in email",
      timeline: "1-3_months", territory: "Boca Raton, FL 33432", preferred_path: "trial", note: "wave94-demo",
    })
    const b = await tools.start_subscription.execute({ email: E("broker"), name: "Wave94 Demo Broker", company: "Wave94 Demo Realty", plan: null, activation: "trial", billing_cycle: null, wants_custom_pricing: false })
    return { ok: a?.success === true && b?.success === true, detail: JSON.stringify({ save: a?.success, start: b }).slice(0, 300) }
  })
  const { data: conv } = await svc.from("platform_prospects").select("converted_brokerage_id").eq("email", E("broker")).maybeSingle()
  const B = (conv?.converted_brokerage_id ?? "") as string
  const { data: brokerSeat } = await svc.from("users").select("id").eq("email", E("broker")).maybeSingle()
  const BROKER = { userId: (brokerSeat?.id ?? "") as string, email: E("broker") }
  ctx.ids.brokerage = B; ctx.ids.brokerUser = BROKER.userId
  if (!B || !BROKER.userId) { ctx.row({ step: "S1b", capability: "tenant exists", via: "read-back", verdict: "refused", detail: `brokerage=${B} broker=${BROKER.userId}` }); return }
  setScopeBrokerage(B)

  // ── S2. Agent seat ─────────────────────────────────────────────────────────
  actAs(BROKER)
  const { inviteUser } = await import("@/app/actions/admin/invite-user")
  await step(ctx, "S2", "broker invites the listing agent", "app/actions/admin/invite-user.ts inviteUser", async () => {
    const r = await inviteUser({ email: E("agent"), firstName: "Wave94", lastName: "Demo Agent", userType: "agent" })
    return { ok: r.success, detail: JSON.stringify(r) }
  })
  const { data: agentUser } = await svc.from("users").select("id").eq("email", E("agent")).maybeSingle()
  const { data: agentRow } = agentUser ? await svc.from("agents").select("id").eq("user_id", (agentUser as any).id).maybeSingle() : { data: null }
  const agentId: string | null = (agentRow as any)?.id ?? null
  const AGENT = agentUser ? { userId: (agentUser as any).id as string, email: E("agent") } : null
  ctx.ids.agent = agentId ?? ""; ctx.ids.agentUser = AGENT?.userId ?? ""
  for (const col of ["agent_id", "assigned_to_agent_id", "assigned_agent_id", "buyer_agent_id", "seller_agent_id", "listing_agent_id"]) setScopeIds(col, [agentId])
  for (const col of ["agent_user_id", "user_id", "actor_user_id", "created_by"]) setScopeIds(col, [AGENT?.userId, BROKER.userId])
  for (const col of ["team_lead_id", "scope_id", "recipient_user_id", "owner_id"]) setScopeIds(col, [AGENT?.userId, BROKER.userId, B])
  setScopeTextIds("owner_id", ["platform"])

  // ── S3. The brokerage's inbound mailbox (transactional, brokerage domain) ──
  actAs(BROKER)
  await step(ctx, "S3", "broker connects the brokerage inbound mailbox (postmark routing address)", "app/actions/settings/integrations.ts upsertPlatformCredential", async () => {
    const { upsertPlatformCredential } = await import("@/app/actions/settings/integrations")
    const r = await upsertPlatformCredential({ platform: "postmark", scope: "brokerage", account_id: INBOX, account_name: "Wave94 Demo inbound", config: { purpose: "inbound_email", note: "wave94-demo" } })
    return { ok: r.success, detail: JSON.stringify(r) }
  })
  const { data: credRows } = await svc.from("platform_credentials").select("id").eq("brokerage_id", B).eq("platform", "postmark")
  if ((credRows ?? []).length === 0) {
    // The settings door refused postmark for a brokerage — RECORDED (S3 row above) and the
    // mailbox seeded directly so the inbound handler can still be walked.
    await step(ctx, "S3'", "inbound mailbox SEEDED (the settings door refused postmark)", "platform_credentials insert (walk setup)", async () => {
      const { error } = await svc.from("platform_credentials").insert({ brokerage_id: B, owner_type: "brokerage", owner_id: B, platform: "postmark", scope: "brokerage", account_id: INBOX, account_name: "Wave94 Demo inbound", config: { purpose: "inbound_email", note: "wave94-demo" }, is_active: true })
      return { ok: !error, verdict: "emulated", detail: error ? error.message : "seeded" }
    })
  }

  // ── S4. Listing with its seller ────────────────────────────────────────────
  actAs(AGENT ?? BROKER)
  await step(ctx, "S4", "agent opens the listing with the seller", "app/actions/listings-kernel.ts createListingWithSellerContact", async () => {
    const lk = await import("@/app/actions/listings-kernel")
    const r: any = await lk.createListingWithSellerContact({ sellerFirstName: "Marisol", sellerLastName: "Wavedemo", sellerEmail: E("seller"), address: ADDRESS, city: "Boca Raton", state: "FL", zip: "33432", listPrice: 615000, bedrooms: 3, bathrooms: 2, sqft: 1720, propertyType: "Single Family" })
    const id = r.listingId ?? r.listing?.id ?? r.data?.listing?.id
    if (id) ctx.ids.listing = id
    return { ok: !!r.success && !!id, detail: JSON.stringify(r).slice(0, 300) }
  })
  const LISTING = ctx.ids.listing ?? ""
  setScopeIds("listing_id", [LISTING])
  const { data: lst } = LISTING ? await svc.from("listings").select("seller_contact_id, status").eq("id", LISTING).maybeSingle() : { data: null }
  const SELLER = ((lst as any)?.seller_contact_id ?? "") as string
  ctx.ids.seller = SELLER
  setScopeIds("contact_id", [SELLER])
  await step(ctx, "S4b", "the seller's portal invite on contact creation (lane 94A builds it — RECORDED here)", "portal_contact_invites read-back", async () => {
    const { data, error } = await svc.from("portal_contact_invites").select("id, status, created_at").eq("contact_id", SELLER)
    const n = (data ?? []).length
    return { ok: !error, verdict: n > 0 ? "works" : "refused", detail: `invites=${n} ${JSON.stringify(data)}${error ? " err " + error.message : ""} — ${n > 0 ? "automatic" : "NOT automatic on this base (94A's lane)"}` }
  })
  await step(ctx, "S4c", "listing goes coming-soon (offers may arrive)", "app/actions/listings-kernel.ts updateListingStatus", async () => {
    const lk = await import("@/app/actions/listings-kernel")
    const r: any = await lk.updateListingStatus(LISTING, "coming_soon")
    return { ok: !!r.success, detail: JSON.stringify(r).slice(0, 200) }
  })

  // ── S5. The outside buyer's agent EMAILS the offer → the REAL inbound handler ──
  const body = [
    "Hi,",
    "",
    `Please find attached an offer from my buyers, Nadia and Omar Wavedemo, on ${ADDRESS}, Boca Raton, FL 33432.`,
    "Their pre-approval letter is attached as well. Happy to answer anything.",
    "",
    "Best regards,",
    "Dana Wavedemo",
    "Coastal Wave94 Realty",
    "(561) 555-0194",
    "Lic # SL9400194",
    "wave94-demo",
  ].join("\n")
  const payload = JSON.stringify({
    From: `Dana Wavedemo <${COOP}>`, FromFull: { Email: COOP, Name: "Dana Wavedemo" },
    To: INBOX, ToFull: [{ Email: INBOX, Name: "Wave94 Demo Realty" }],
    Subject: `Offer — ${ADDRESS}`, TextBody: body,
    Attachments: [
      { Name: "wave94-demo-purchase-contract.pdf", ContentType: "application/pdf", Content: pdf("contract") },
      { Name: "wave94-demo-pre-approval.pdf", ContentType: "application/pdf", Content: pdf("pre-approval") },
    ],
  })
  actAs(null)
  await step(ctx, "S5", "the outside agent's email (offer PDF + pre-approval) hits the real inbound-mail handler", "app/api/webhooks/inbound-mail/route.ts POST (postmark, HMAC-signed in-process)", async () => {
    const { POST } = await import("@/app/api/webhooks/inbound-mail/route")
    const { NextRequest } = await import("next/server")
    const sig = createHmac("sha256", process.env.POSTMARK_INBOUND_WEBHOOK_SECRET as string).update(payload, "utf-8").digest("base64")
    const res = await POST(new NextRequest("https://demo.wave94.test/api/webhooks/inbound-mail", { method: "POST", body: payload, headers: { "x-postmark-webhook-signature": sig, "content-type": "application/json" } }) as any)
    const json = (await res.json().catch(() => null)) as any
    return { ok: res.status < 300, detail: `HTTP ${res.status} ${JSON.stringify(json).slice(0, 300)}` }
  })
  const { data: offRow } = LISTING ? await svc.from("offers").select("id, contact_id, metadata, form_source, status, offer_price, ai_extraction_status").eq("listing_id", LISTING).eq("brokerage_id", B).order("created_at", { ascending: true }).limit(1).maybeSingle() : { data: null }
  const OFFER = ((offRow as any)?.id ?? "") as string
  const BUYER = ((offRow as any)?.contact_id ?? "") as string
  const OA = (((offRow as any)?.metadata ?? {}).outside_agent_id ?? "") as string
  ctx.ids.offer = OFFER; ctx.ids.buyer = BUYER; ctx.ids.outsideAgent = OA
  setScopeIds("offer_id", [OFFER]); setScopeIds("contact_id", [SELLER, BUYER])
  await step(ctx, "S5b", "outside agent RECORD created (name/email/phone/brokerage/licence from the email) and linked; intake buyer; offer + documents on the listing", "outside_agents / outside_agent_contact_links / contacts / offers / documents read-back", async () => {
    const { data: oa } = await svc.from("outside_agents").select("full_name, email, phone, phone_digits, outside_brokerage_name, license_number, source").eq("brokerage_id", B)
    const { data: links } = await svc.from("outside_agent_contact_links").select("contact_id, link_role, listing_id").eq("brokerage_id", B)
    const { data: buyer } = BUYER ? await svc.from("contacts").select("first_name, last_name, contact_type, status, source, agent_id").eq("id", BUYER).maybeSingle() : { data: null }
    const { data: docs } = OFFER ? await svc.from("documents").select("id, document_type, metadata").eq("brokerage_id", B).filter("metadata->>linked_offer_id", "eq", OFFER) : { data: [] }
    const { data: seats } = await svc.from("users").select("id").eq("email", COOP)
    const { data: asContact } = await svc.from("contacts").select("id").eq("brokerage_id", B).eq("email", COOP)
    const rec = ((oa ?? []) as any[])[0]
    const ok = (oa ?? []).length === 1 && rec?.email === COOP && rec?.full_name === "Dana Wavedemo" && !!rec?.phone && !!rec?.outside_brokerage_name && !!rec?.license_number
      && !!OFFER && OA !== "" && (links ?? []).length === 1 && (docs ?? []).length === 2 && (seats ?? []).length === 0 && (asContact ?? []).length === 0
      && (buyer as any)?.source === "outside_offer_intake" && (buyer as any)?.agent_id === null
    return { ok, detail: `record=${JSON.stringify(oa)} links=${JSON.stringify(links)} buyer=${JSON.stringify(buyer)} offer=${JSON.stringify({ id: OFFER, form_source: (offRow as any)?.form_source, status: (offRow as any)?.status, ai: (offRow as any)?.ai_extraction_status, outside_agent_id: OA })} docs=${(docs ?? []).length} coopUserSeats=${(seats ?? []).length} coopAsContact=${(asContact ?? []).length}` }
  })
  await step(ctx, "S5c", "the listing agent is told when the AI read settles (in the sandbox the PDF fetch is refused → the honest 'could not read' notice)", "offer-intake afterInboundOfferRead → notifications read-back", async () => {
    const { data: n } = AGENT ? await svc.from("notifications").select("title, body, type").eq("user_id", AGENT.userId).eq("entity_id", OFFER) : { data: [] }
    return { ok: (n ?? []).length === 1, detail: `${(n ?? []).length} notice(s): ${JSON.stringify(n).slice(0, 400)}` }
  })

  // ── S6. The AI read — MODEL STUBBED, everything after it real ─────────────
  const READ = {
    offer_price: 605000, earnest_money: 15000, closing_date: new Date(Date.now() + 40 * DAY).toISOString().slice(0, 10),
    financing_type: "conventional", down_payment_amount: 121000, down_payment_percent: 20,
    appraisal_contingency_days: 17, financing_contingency_days: 30, inspection_period_days: 10,
    escalation_clause: false, escalation_cap: null, appraisal_gap: null, closing_cost_contribution: 6000,
    due_diligence_fee: null, possession_terms: "at closing", contingencies: ["inspection", "financing", "appraisal"], buyer_notes: "wave94-demo",
    buyer_names: ["Nadia Wavedemo", "Omar Wavedemo"], buyer_agent_name: "Dana Wavedemo", buyer_agent_email: COOP,
    buyer_agent_phone: "(561) 555-0194", buyer_agent_brokerage: "Coastal Wave94 Realty", buyer_agent_license: "SL9400194",
  }
  await step(ctx, "S6", "AI read applied (model output STUBBED) → offer terms written → listing agent notified with the terms; intake buyer named from the contract", "lib/offers/offer-extractor.ts applyExtractedOfferData + lib/inbound-mail/offer-intake.ts afterInboundOfferRead", async () => {
    const { applyExtractedOfferData } = await import("@/lib/offers/offer-extractor")
    await applyExtractedOfferData(svc, { offerId: OFFER, brokerageId: B, listingId: LISTING, extracted: READ as any })
    const { afterInboundOfferRead } = await import("@/lib/inbound-mail/offer-intake")
    const r = await afterInboundOfferRead(svc, { brokerageId: B, offerId: OFFER, listing: { id: LISTING, address: ADDRESS, agent_id: agentId } as any, buyerContactId: BUYER, outsideAgentId: OA, outsideAgentLabel: "Dana Wavedemo, Coastal Wave94 Realty", fromEmail: COOP, documentCount: 2, read: { success: true, data: READ as any } })
    const { data: o } = await svc.from("offers").select("offer_price, financing_type, closing_date, ai_extraction_status").eq("id", OFFER).maybeSingle()
    const { data: b } = await svc.from("contacts").select("first_name, last_name").eq("id", BUYER).maybeSingle()
    return { ok: r.notified && (o as any)?.offer_price == 605000, verdict: "emulated", detail: `notice=${JSON.stringify(r)} offer=${JSON.stringify(o)} buyer=${JSON.stringify(b)}` }
  })

  // ── S7. The listing agent's ONE action → seller portal ────────────────────
  actAs(AGENT ?? BROKER)
  await step(ctx, "S7", "listing agent presents the offer: offer + documents + automatic net sheet to the seller's portal (one click)", "app/actions/offers/present-to-seller.ts presentOfferToSeller", async () => {
    const { presentOfferToSeller } = await import("@/app/actions/offers/present-to-seller")
    const r = await presentOfferToSeller({ offerId: OFFER, listingId: LISTING, note: "wave94-demo: strong conventional offer, let's discuss" })
    const { data: card } = await svc.from("transparency_updates").select("title, update_type, metadata").eq("contact_id", SELLER).eq("update_type", "offer_net_sheet")
    const { data: banner } = await svc.from("activities").select("id").eq("entity_id", OFFER).eq("activity_type", "portal_offer_notification")
    return { ok: r.success && (r.documentsShared ?? 0) === 2 && (r.netSheet?.listingsScanned ?? 0) >= 1, detail: `${JSON.stringify(r).slice(0, 400)} sellerNetCards=${(card ?? []).length} ${JSON.stringify(card).slice(0, 200)} banner=${(banner ?? []).length}` }
  })
  let CLIENT: { userId: string; email: string } | null = null
  await step(ctx, "S7b", "the SELLER, in their own portal session, sees the offer, its two documents and the net sheet inputs", "auth.admin.createUser (EMULATED) → ensureContactPortalUser → portal-seller.ts getSellerOffers + getSellerNetSheetInputs as the seller", async () => {
    const u = await svc.auth.admin.createUser({ email: E("seller"), email_confirm: true })
    if (u.error || !u.data?.user) return { ok: false, detail: `auth: ${u.error?.message}` }
    CLIENT = { userId: u.data.user.id, email: E("seller") }
    ctx.ids.clientUser = CLIENT.userId
    setScopeIds("user_id", [AGENT?.userId, BROKER.userId, CLIENT.userId])
    const { data: c } = await svc.from("contacts").select("id, email, first_name, last_name, brokerage_id, agent_id, metadata").eq("id", SELLER).maybeSingle()
    const { ensureContactPortalUser } = await import("@/lib/portal/portal-invite-core")
    const ens = await ensureContactPortalUser({ authUserId: CLIENT.userId, authEmail: CLIENT.email, contact: c as any })
    actAs(CLIENT)
    const ps = await import("@/app/actions/portal-seller")
    const offers: any = await ps.getSellerOffers(SELLER)
    const ns: any = await ps.getSellerNetSheetInputs(SELLER)
    actAs(AGENT ?? BROKER)
    const o = (offers.offers ?? [])[0]
    const ok = ens.ensured && (offers.offers ?? []).length === 1 && (o?.documents ?? []).length === 2 && !o?.buyer?.email && (ns.offers ?? []).length === 1
    return { ok, verdict: ok ? "emulated" : "refused", detail: `ensure=${ens.ensured} offers=${(offers.offers ?? []).length} docs=${JSON.stringify((o?.documents ?? []).map((d: any) => d.name))} buyerLabel=${o?.buyer?.first_name} ${o?.buyer?.last_name} buyerEmailHidden=${!o?.buyer?.email} netSheetOffers=${(ns.offers ?? []).length} commission=${JSON.stringify(ns.commission)} err=${offers.error ?? ns.error ?? null}` }
  })

  // ── S8. Counter → the outside agent is copied BY EMAIL ─────────────────────
  const sentBefore = () => emailsEmulated.filter((m) => m.to.includes(COOP)).length
  let COUNTER = ""
  await step(ctx, "S8", "seller counters at $612,000 → the cooperating agent is copied by email (one, no SMS)", "app/actions/seller-offers.ts sendCounterOffer → OFFER_COUNTER_SENT → event-reactor → copyCooperatingAgentOnDealMoment → dispatchEmail", async () => {
    const before = sentBefore()
    const { sendCounterOffer } = await import("@/app/actions/seller-offers")
    const r: any = await sendCounterOffer({ parentOfferId: OFFER, listingId: LISTING, counterPrice: 612000, responseDeadline: new Date(Date.now() + 2 * DAY).toISOString(), notes: "wave94-demo counter" })
    COUNTER = r.counterId ?? ""
    ctx.ids.counter = COUNTER
    setScopeIds("offer_id", [OFFER, COUNTER])
    const { data: led } = await svc.from("activities").select("title, metadata").eq("brokerage_id", B).eq("activity_type", "outside_agent_copied")
    const mails = emailsEmulated.filter((m) => m.to.includes(COOP)).slice(before)
    return { ok: !!r.success && mails.length === 1 && (led ?? []).length === 1, verdict: "emulated", detail: `${JSON.stringify(r)} coopEmails=${JSON.stringify(mails)} ledger=${JSON.stringify(led).slice(0, 300)}` }
  })

  // ── S9. Accept with the executed contract → transaction ───────────────────
  const so = await import("@/app/actions/seller-offers")
  const ACCEPT_ON = () => COUNTER || OFFER
  await step(ctx, "S9a", "the fully executed counter (signed PDF) is filed through the offer document door", "app/api/offers/[offerId]/upload-document/route.ts POST (signed_contract)", async () => {
    const { POST } = await import("@/app/api/offers/[offerId]/upload-document/route")
    const { NextRequest } = await import("next/server")
    const fd = new FormData()
    fd.append("file", new File([Buffer.from("%PDF-1.7\n% executed counter wave94-demo\n")], "wave94-demo-executed-counter.pdf", { type: "application/pdf" }))
    fd.append("docType", "signed_contract")
    const res = await POST(new NextRequest(`https://demo.wave94.test/api/offers/${ACCEPT_ON()}/upload-document`, { method: "POST", body: fd }) as any, { params: Promise.resolve({ offerId: ACCEPT_ON() }) })
    const j = (await res.json().catch(() => null)) as any
    if (j?.document_id) ctx.ids.executedDoc = j.document_id
    return { ok: res.status < 300 && !!j?.document_id, detail: `HTTP ${res.status} ${JSON.stringify(j).slice(0, 200)}` }
  })
  setScopeIds("document_id", [ctx.ids.executedDoc])
  const coopBeforeAccept = sentBefore()
  await step(ctx, "S9", "accept with the executed contract → the ONE compliance gate → transaction; the cooperating agent is on the roster and emailed the terms ONCE", "seller-offers.ts acceptOffer(executedContract) → offer-bridge → participant-populator → notifyTransactionParties", async () => {
    const r: any = await so.acceptOffer({
      offerId: ACCEPT_ON(), listingId: LISTING,
      executedContract: { documentId: ctx.ids.executedDoc, buyerSignature: { signedAt: new Date(Date.now() - DAY).toISOString().slice(0, 10), attestation: "I hold the fully executed counter from the buyer's agent; it carries both buyers' signatures and initials on every page (wave94-demo)." } },
    })
    const { data: tx } = await svc.from("transactions").select("id, status, stage, deal_type, purchase_price, buyer_contact_id, seller_contact_id, offer_id").eq("brokerage_id", B).maybeSingle()
    if ((tx as any)?.id) ctx.ids.transaction = (tx as any).id
    const { data: roster } = (tx as any)?.id ? await svc.from("transaction_participants").select("role, name, company, email").eq("transaction_id", (tx as any).id) : { data: [] }
    const mails = emailsEmulated.filter((m) => m.to.includes(COOP)).slice(coopBeforeAccept)
    const { data: acceptCopies } = await svc.from("activities").select("id").eq("brokerage_id", B).eq("activity_type", "outside_agent_copied").filter("metadata->>event", "eq", "offer_accepted")
    return { ok: !!r.success && !!(tx as any)?.id && ((roster ?? []) as any[]).some((p) => p.role === "buyer_agent" && p.email === COOP) && mails.length === 1 && (acceptCopies ?? []).length === 0,
      detail: `${JSON.stringify(r).slice(0, 250)} tx=${JSON.stringify(tx)} roster=${JSON.stringify(roster)} coopEmailsAtAccept=${JSON.stringify(mails)} reactorAcceptCopies=${(acceptCopies ?? []).length}` }
  })
  const TX = ctx.ids.transaction ?? ""
  setScopeIds("transaction_id", [TX])

  // ── S10. Transaction activity → copied ─────────────────────────────────────
  await step(ctx, "S10", "a milestone completes → the cooperating agent is copied by email", "transaction-milestones.ts completeMilestoneAction → MILESTONE_COMPLETED → event-reactor copy", async () => {
    if (!TX) return { ok: false, detail: "no transaction" }
    const before = sentBefore()
    const { data: ms } = await svc.from("transaction_milestones").select("milestone_name, status, target_date").eq("transaction_id", TX).order("target_date", { ascending: true })
    const first = ((ms ?? []) as any[]).find((m) => m.status !== "completed")
    if (!first) return { ok: false, detail: `milestones=${(ms ?? []).length}` }
    const { completeMilestoneAction } = await import("@/app/actions/transaction-milestones")
    const r = await completeMilestoneAction({ transactionId: TX, brokerageId: B, milestoneName: first.milestone_name })
    const mails = emailsEmulated.filter((m) => m.to.includes(COOP)).slice(before)
    return { ok: r.success && mails.length >= 1, verdict: "emulated", detail: `completed "${first.milestone_name}" ${JSON.stringify(r)} coopEmails=${JSON.stringify(mails)}` }
  })
  await step(ctx, "S11", "the transaction closes → the cooperating agent is copied ONCE (TRANSACTION_CLOSED + DEAL_CLOSED are one moment)", "transactions.ts closeTransaction → closeTransactionCommand → event-reactor copy (dedupe on the moment)", async () => {
    if (!TX) return { ok: false, detail: "no transaction" }
    const before = sentBefore()
    const { closeTransaction } = await import("@/app/actions/transactions")
    const r = await closeTransaction({ transactionId: TX, brokerageId: B, agentId: agentId ?? "", reason: "wave94-demo close" })
    const { data: t } = await svc.from("transactions").select("status, stage").eq("id", TX).maybeSingle()
    const mails = emailsEmulated.filter((m) => m.to.includes(COOP)).slice(before)
    const closing = mails.filter((m) => /^Closed/.test(m.subject))
    return { ok: r.success && (t as any)?.status === "closed" && closing.length === 1, verdict: "emulated", detail: `${JSON.stringify(r)} tx=${JSON.stringify(t)} coopEmails=${JSON.stringify(mails)}` }
  })
  await step(ctx, "S11b", "the cooperating agent was never sent an SMS or a call; ONE copy ledger row per moment", "emailsEmulated / externalCalls / activities read-back", async () => {
    const { data: led } = await svc.from("activities").select("metadata").eq("brokerage_id", B).eq("activity_type", "outside_agent_copied")
    const keys = ((led ?? []) as any[]).map((l) => l.metadata?.copy_key)
    const dupKeys = keys.filter((k, i) => keys.indexOf(k) !== i)
    const twilio = externalCalls.filter((u) => /twilio/i.test(u))
    return { ok: dupKeys.length === 0 && twilio.length === 0 && keys.length >= 3, detail: `copyKeys=${JSON.stringify(keys)} duplicates=${dupKeys.length} twilioCalls=${twilio.length} allCoopEmails=${JSON.stringify(emailsEmulated.filter((m) => m.to.includes(COOP)).map((m) => m.subject))}` }
  })
  await step(ctx, "S11c", "RECORDED for lane 94A: notifications per person at accept and at close", "notifications read-back", async () => {
    const { data: n } = await svc.from("notifications").select("user_id, contact_id, title, created_at").eq("brokerage_id", B)
    const per = new Map<string, number>()
    for (const x of (n ?? []) as any[]) { const k = x.user_id ?? `c:${x.contact_id}`; per.set(k, (per.get(k) ?? 0) + 1) }
    return { ok: true, verdict: "works", detail: `total=${(n ?? []).length} perRecipient=${JSON.stringify([...per.entries()])} titles=${JSON.stringify(((n ?? []) as any[]).map((x) => x.title)).slice(0, 600)}` }
  })

  // ── S12. Lifetime customer + follow-up ─────────────────────────────────────
  await step(ctx, "S12", "the seller becomes a lifetime customer; touches scheduled", "closeTransactionCommand side effects", async () => {
    const { data: c } = await svc.from("contacts").select("contact_type, status").eq("id", SELLER).maybeSingle()
    const { data: tps, error } = await svc.from("lifetime_customer_touchpoints").select("touchpoint_type, channel, scheduled_date").eq("contact_id", SELLER)
    return { ok: !error && (c as any)?.contact_type === "lifetime_customer" && (tps ?? []).length >= 1, detail: `contact=${JSON.stringify(c)} touchpoints=${((tps ?? []) as any[]).map((t) => `${t.touchpoint_type}/${t.channel}`).join(", ")}` }
  })
  await step(ctx, "S13", "agent files a 30-day post-close follow-up task", "app/actions/tasks.ts createTask", async () => {
    const { createTask } = await import("@/app/actions/tasks")
    const r: any = await createTask({ title: "Wave94 Demo 30-day post-close check-in", description: "wave94-demo", dueDate: new Date(Date.now() + 30 * DAY).toISOString(), contactId: SELLER, priority: "medium" })
    return { ok: !!r.success, detail: JSON.stringify(r).slice(0, 200) }
  })
}
