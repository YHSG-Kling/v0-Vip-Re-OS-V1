/**
 * Wave 93 follow-up (lane 93D2) — the walk RESUMED FROM ACCEPTANCE on a FRESH
 * tagged dataset, through the real functions over the MCP replay bridge.
 *
 *   setup  — prospect → trial tenant, agent seat, a seller-only nurture, listing
 *            with its seller, the outside buyer's offer
 *   walk   — accept is refused until the executed contract is filed (positive
 *            control) → signed PDF through the offer document door → accept with
 *            the executed contract → the ONE compliance gate (owner 2026-09-04:
 *            compliance runs once the offer is fully executed) → transaction (a
 *            gate block falls back to the broker's staff override, then accept
 *            again — both arms are recorded) → milestones → close → lifetime
 *            customer → portal access + first sign-in (m684 applied) → touches →
 *            follow-up task → the home assistant answers and files its follow-up
 *
 * Tags: names `Wave93c Demo…`, emails `w93c.*@wave93c.test`, notes `wave93c-demo`,
 * synthetic ids `93dc0000-…`. Run with BRIDGE_DEMO_EMAIL_SUFFIX=@wave93c.test,
 * BRIDGE_UUID_PREFIX=93dc, BRIDGE_STORAGE_EMULATE=1 (scratchpad w93c.sh).
 */
import type { WalkCtx } from "./run"
import { BridgeStop, actAs, serviceClient, setScopeBrokerage, setScopeIds, setScopeTextIds, quiesce } from "./bridge"

const E = (who: string) => `w93c.${who}@wave93c.test`
const DAY = 86_400_000

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

export async function journey(ctx: WalkCtx) {
  if (process.env.W93_BROKERAGE) setScopeBrokerage(process.env.W93_BROKERAGE)
  const svc = serviceClient()

  // ── S1. Fresh tenant (same survivors as wave 93 steps 1a/1b) ───────────────
  actAs(null)
  const { buildPlatformProspectTools } = await import("@/lib/platform/prospect-agent-tools")
  const toolCtx = { source: "web:prospect_chat" as const, phone: null, prospectId: null as string | null, callId: null, brand: { name: "VIP Agents" } as never, hasLiveTransfer: false }
  const tools = (await buildPlatformProspectTools(toolCtx)) as Record<string, { execute: (a: any, o?: any) => Promise<any> }>
  await step(ctx, "S1", "fresh tenant: prospect → trial subscriber", "prospect-agent-tools save_prospect + start_subscription → createTenantCore", async () => {
    const a = await tools.save_prospect.execute({
      name: "Wave93c Demo Broker", email: E("broker"), company: "Wave93c Demo Realty", role_interest: "brokerage",
      size_seats: 5, producers_count: 4, role_title: "broker-owner", current_tools: "spreadsheets", pain: "offers stall before contract",
      timeline: "1-3_months", territory: "Boca Raton, FL 33432", preferred_path: "trial", note: "wave93c-demo",
    })
    const b = await tools.start_subscription.execute({ email: E("broker"), name: "Wave93c Demo Broker", company: "Wave93c Demo Realty", plan: null, activation: "trial", billing_cycle: null, wants_custom_pricing: false })
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
    const r = await inviteUser({ email: E("agent"), firstName: "Wave93c", lastName: "Demo Agent", userType: "agent" })
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

  // ── S3. A SELLER-ONLY nurture on contact_created (lane 93D2 audience fix) ──
  await step(ctx, "S3", "seller-only nurture (audience = seller) on contact_created, launched", "app/actions/campaign-sequences.ts createCampaignSequence(contact_type) + createSequenceStep + launchCampaignSequence", async () => {
    const cs = await import("@/app/actions/campaign-sequences")
    const s = await cs.createCampaignSequence({ brokerageId: B, name: "Wave93c Demo seller nurture", description: "wave93c-demo", sequence_type: "nurture", trigger_event: "contact_created", contact_type: "seller" })
    if (!s.sequence) return { ok: false, detail: `create: ${s.error}` }
    ctx.ids.sequence = (s.sequence as any).id
    const st = await cs.createSequenceStep({ sequence_id: (s.sequence as any).id, step_number: 1, step_name: "Welcome", channel: "email", delay_days: 0, delay_hours: 1, subject: "What your home could sell for", body: "Hi {{first_name}}, here is what homes near you sold for this month." })
    const l = await cs.launchCampaignSequence((s.sequence as any).id)
    return { ok: !!st.step && l.success && (s.sequence as any).contact_type === "seller", detail: JSON.stringify({ audience: (s.sequence as any).contact_type, step: st.error ?? "ok", launch: l }) }
  })

  // ── S4. Listing with its seller (the client) ──────────────────────────────
  actAs(AGENT ?? BROKER)
  await step(ctx, "S4", "agent opens the listing with the seller", "app/actions/listings-kernel.ts createListingWithSellerContact", async () => {
    const lk = await import("@/app/actions/listings-kernel")
    const r: any = await lk.createListingWithSellerContact({ sellerFirstName: "Lucia", sellerLastName: "Wavedemo", sellerEmail: E("seller"), address: "2293 Wave93c Demo Lane", city: "Boca Raton", state: "FL", zip: "33432", listPrice: 540000, bedrooms: 3, bathrooms: 2, sqft: 1640, propertyType: "Single Family" })
    const id = r.listingId ?? r.listing?.id ?? r.data?.listing?.id
    if (id) ctx.ids.listing = id
    return { ok: !!r.success && !!id, detail: JSON.stringify(r).slice(0, 300) }
  })
  const LISTING = ctx.ids.listing ?? ""
  setScopeIds("listing_id", [LISTING])
  const { data: lst } = LISTING ? await svc.from("listings").select("seller_contact_id").eq("id", LISTING).maybeSingle() : { data: null }
  const SELLER = ((lst as any)?.seller_contact_id ?? "") as string
  ctx.ids.seller = SELLER
  setScopeIds("contact_id", [SELLER])

  // ── S5. The outside buyer, filed as a contact ─────────────────────────────
  await step(ctx, "S5", "agent files the outside buyer as a contact (email only)", "app/actions/contacts.ts createContact → createContactManually → CONTACT_CREATED", async () => {
    const { createContact } = await import("@/app/actions/contacts")
    const r: any = await createContact({ first_name: "Owen", last_name: "Wavedemo", email: E("buyer"), contact_type: "buyer", notes: "wave93c-demo" })
    const id = r.contact?.id ?? r.contactId ?? r.data?.id ?? r.id
    if (id) ctx.ids.buyer = id
    return { ok: !!r.success && !!id, detail: JSON.stringify(r).slice(0, 200) }
  })
  // Checked AFTER quiesce: the enrichment queue + its echo run in background chains.
  await step(ctx, "S5b", "ONE human-worded alert per person; the seller-only nurture does not enrol the buyer; no phone lookup queued for an email-only contact", "notifications / sequence_enrollments / lead_enrichment_queue read-back", async () => {
    const id = ctx.ids.buyer
    if (!id) return { ok: false, detail: "no buyer contact" }
    const { data: notes, error: nErr } = await svc.from("notifications").select("title, body, user_id").eq("entity_id", id)
    const { data: enr, error: eErr } = await svc.from("sequence_enrollments").select("id, sequence_id").eq("contact_id", id)
    const { data: q, error: qErr } = await svc.from("lead_enrichment_queue").select("enrichments_needed").eq("contact_id", id)
    const n = (notes ?? []) as any[]
    const raw = n.filter((x) => /^\w+: \w+$/.test(String(x.body ?? "")) || /^[a-z]+(_[a-z]+)+$/.test(String(x.title ?? "")))
    const perUser = new Map<string, number>(); for (const x of n) perUser.set(x.user_id, (perUser.get(x.user_id) ?? 0) + 1)
    const phoneLookups = ((q ?? []) as any[]).filter((r) => (r.enrichments_needed ?? []).includes("phone_append")).length
    const ok = !nErr && !eErr && !qErr && n.length >= 1 && raw.length === 0 && [...perUser.values()].every((c) => c === 1) && (enr ?? []).length === 0 && phoneLookups === 0
    return { ok, detail: `alerts=${n.length} (${n.map((x) => `${x.title} — ${x.body}`).join(" | ")}) maxPerUser=${Math.max(0, ...perUser.values())} rawText=${raw.length} buyerEnrolments=${(enr ?? []).length} enrichmentQueue=${JSON.stringify(q)} phoneLookups=${phoneLookups}${nErr ? " nErr " + nErr.message : ""}${eErr ? " eErr " + eErr.message : ""}${qErr ? " qErr " + qErr.message : ""}` }
  })
  const BUYER = ctx.ids.buyer ?? ""
  setScopeIds("contact_id", [SELLER, BUYER])

  // ── S6. The outside buyer's agent's offer arrives (PDF upload) ────────────
  await step(ctx, "S6", "the outside buyer's agent's offer arrives on the listing (PDF upload)", "app/api/offers/upload/route.ts POST", async () => {
    if (!LISTING || !BUYER) return { ok: false, detail: "no listing/buyer" }
    const { POST } = await import("@/app/api/offers/upload/route")
    const { NextRequest } = await import("next/server")
    const fd = new FormData()
    fd.append("file", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a])], "wave93c-demo-offer.pdf", { type: "application/pdf" }))
    fd.append("listing_id", LISTING)
    fd.append("contact_id", BUYER)
    const res = await POST(new NextRequest("https://demo.wave93c.test/api/offers/upload", { method: "POST", body: fd }) as any)
    const body = (await res.json().catch(() => null)) as any
    const id = body?.offer_id ?? body?.offerId ?? body?.offer?.id ?? body?.id
    if (id) ctx.ids.offer = id
    return { ok: res.status < 300 && !!id, detail: `HTTP ${res.status} ${JSON.stringify(body).slice(0, 260)}` }
  })
  const OFFER = ctx.ids.offer ?? ""
  setScopeIds("offer_id", [OFFER])

  // ── 7g. ACCEPT → the executed contract → TRANSACTION (lane 93D2 build) ─────
  actAs(AGENT ?? BROKER)
  const so = await import("@/app/actions/seller-offers")
  await step(ctx, "7g0", "POSITIVE CONTROL — accept is refused while the executed contract is not on file, and says what to supply", "app/actions/seller-offers.ts acceptOffer (no executedContract)", async () => {
    if (!OFFER) return { ok: false, detail: "no offer" }
    const r: any = await so.acceptOffer({ offerId: OFFER, listingId: LISTING })
    const ok = r.success === false && r.needs_executed_contract === true && r.needs_buyer_signature_attestation === true
    return { ok, verdict: ok ? "works" : "refused", detail: `gate ${ok ? "held" : "DID NOT HOLD as expected"}: ${JSON.stringify(r).slice(0, 300)}` }
  })
  await step(ctx, "7g1", "the fully executed contract (signed PDF) is filed through the offer document door", "app/api/offers/[offerId]/upload-document/route.ts POST (docType signed_contract)", async () => {
    if (!OFFER) return { ok: false, detail: "no offer" }
    const { POST } = await import("@/app/api/offers/[offerId]/upload-document/route")
    const { NextRequest } = await import("next/server")
    const fd = new FormData()
    fd.append("file", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a])], "wave93c-demo-executed-contract.pdf", { type: "application/pdf" }))
    fd.append("docType", "signed_contract")
    const res = await POST(new NextRequest(`https://demo.wave93c.test/api/offers/${OFFER}/upload-document`, { method: "POST", body: fd }) as any, { params: Promise.resolve({ offerId: OFFER }) })
    const body = (await res.json().catch(() => null)) as any
    if (body?.document_id) ctx.ids.executedDoc = body.document_id
    return { ok: res.status < 300 && !!body?.document_id, detail: `HTTP ${res.status} ${JSON.stringify(body).slice(0, 260)}` }
  })
  setScopeIds("document_id", [ctx.ids.executedDoc])
  const readTx = async () => {
    const { data: tx } = await svc.from("transactions").select("id, status, stage, deal_type, purchase_price, contact_id, seller_contact_id, buyer_contact_id, contract_date, close_date").eq("brokerage_id", B).eq("offer_id", OFFER).maybeSingle()
    const { data: off } = await svc.from("offers").select("buyer_signed_at, seller_response_type, fully_signed_contract_received_at, compliance_passed_at, is_winning_offer, status, transaction_id, metadata").eq("id", OFFER).maybeSingle()
    if ((tx as any)?.id) ctx.ids.transaction = (tx as any).id
    const gate = (off as any)?.metadata?.compliance_gate ?? null
    const ev = (off as any)?.metadata?.buyer_signature_evidence ?? null
    return { tx, off: off ? { ...(off as any), metadata: undefined, compliance_gate: gate && { state: gate.state, reason: gate.reason }, buyer_signature_evidence: ev && { source: ev.source, attested_by_name: ev.attested_by_name, document_id: ev.document_id } } : null }
  }
  let gateBlocked = false
  await step(ctx, "7g", "offer accepted WITH the executed contract (buyer signature attested by the listing agent) → the ONE compliance gate → transaction", "app/actions/seller-offers.ts acceptOffer(executedContract) → recordSellerResponse → runOfferComplianceLoop → submitOfferToCompliance → createTransactionFromOffer", async () => {
    if (!OFFER || !ctx.ids.executedDoc) return { ok: false, detail: "no offer / executed contract" }
    const signedAt = new Date(Date.now() - DAY).toISOString().slice(0, 10)
    const r: any = await so.acceptOffer({
      offerId: OFFER, listingId: LISTING,
      executedContract: {
        documentId: ctx.ids.executedDoc,
        buyerSignature: { signedAt, attestation: "I hold the fully executed contract from the buyer's agent; it carries the buyer's signature and initials on every page (wave93c-demo)." },
      },
    })
    const { tx, off } = await readTx()
    gateBlocked = !r.success && r.needs_compliance === true
    return { ok: !!r.success && !!(tx as any)?.id, detail: `${JSON.stringify(r).slice(0, 300)} tx=${JSON.stringify(tx)} offer=${JSON.stringify(off)}` }
  })
  // The gate's block arm, if it fired: the broker's staff override, then accept again (no
  // second execution — the contract is already on file). Recorded so both arms are visible.
  if (gateBlocked && !ctx.ids.transaction) {
    actAs(BROKER)
    await step(ctx, "7f", "compliance gate blocked → broker's staff override (manual compliance pass)", "app/actions/compliance-bridge-actions.ts emitCompliancePassedAction", async () => {
      const { emitCompliancePassedAction } = await import("@/app/actions/compliance-bridge-actions")
      const r: any = await emitCompliancePassedAction({ offerId: OFFER, userId: BROKER.userId })
      return { ok: !!r.success, detail: JSON.stringify(r) }
    })
    actAs(AGENT ?? BROKER)
    await step(ctx, "7g'", "accept again after the override → transaction", "app/actions/seller-offers.ts acceptOffer → assertOfferReadyForTransaction → createTransactionFromOffer", async () => {
      const r: any = await so.acceptOffer({ offerId: OFFER, listingId: LISTING })
      const { tx, off } = await readTx()
      return { ok: !!r.success && !!(tx as any)?.id, detail: `${JSON.stringify(r).slice(0, 300)} tx=${JSON.stringify(tx)} offer=${JSON.stringify(off)}` }
    })
  }
  const TX = ctx.ids.transaction ?? ""
  setScopeIds("transaction_id", [TX])
  await step(ctx, "7g2", "the listing moved UNDER_CONTRACT only once the transaction existed", "listings read-back", async () => {
    const { data: l } = await svc.from("listings").select("status, lifecycle_stage").eq("id", LISTING).maybeSingle()
    return { ok: !!TX && /under_contract|pending/i.test(`${(l as any)?.status} ${(l as any)?.lifecycle_stage}`), detail: JSON.stringify(l) }
  })

  // ── 7m. Milestones ────────────────────────────────────────────────────────
  await step(ctx, "7m", "milestones seeded on the seller-side deal; the agent completes the first one", "transaction_milestones read + app/actions/transaction-milestones.ts completeMilestoneAction", async () => {
    if (!TX) return { ok: false, detail: "no transaction" }
    const { data: ms, error } = await svc.from("transaction_milestones").select("milestone_name, status, target_date").eq("transaction_id", TX).order("target_date", { ascending: true })
    const rows = (ms ?? []) as any[]
    if (error || rows.length === 0) return { ok: false, detail: `milestones=${rows.length} ${error?.message ?? ""}` }
    const first = rows.find((m) => m.status !== "completed") ?? rows[0]
    const { completeMilestoneAction } = await import("@/app/actions/transaction-milestones")
    const r = await completeMilestoneAction({ transactionId: TX, brokerageId: B, milestoneName: first.milestone_name })
    const { data: after } = await svc.from("transaction_milestones").select("status").eq("transaction_id", TX).eq("milestone_name", first.milestone_name).maybeSingle()
    return { ok: r.success && (after as any)?.status === "completed", detail: `seeded=${rows.length} [${rows.slice(0, 8).map((m) => m.milestone_name).join(", ")}${rows.length > 8 ? ", …" : ""}] completed "${first.milestone_name}" → ${JSON.stringify(r)} status=${(after as any)?.status}` }
  })

  // ── 7h. Close ─────────────────────────────────────────────────────────────
  await step(ctx, "7h", "transaction closes", "app/actions/transactions.ts closeTransaction → closeTransactionCommand", async () => {
    if (!TX) return { ok: false, detail: "no transaction" }
    const { closeTransaction } = await import("@/app/actions/transactions")
    const r = await closeTransaction({ transactionId: TX, brokerageId: B, agentId: agentId ?? "", reason: "wave93c-demo close" })
    const { data: t } = await svc.from("transactions").select("status, stage, close_date").eq("id", TX).maybeSingle()
    return { ok: r.success && (t as any)?.status === "closed", detail: `${JSON.stringify(r)} tx=${JSON.stringify(t)}` }
  })

  // ── 8. Closed client → lifetime customer, with follow-up ──────────────────
  actAs(null)
  await step(ctx, "8a", "the seller becomes a lifetime customer; anniversary / home-value touches scheduled", "closeTransactionCommand side effects (contacts, lifetime_customer_touchpoints)", async () => {
    if (!SELLER) return { ok: false, detail: "no seller" }
    const { data: c } = await svc.from("contacts").select("contact_type, lifecycle_state, status").eq("id", SELLER).maybeSingle()
    const { data: tps, error } = await svc.from("lifetime_customer_touchpoints").select("touchpoint_type, channel, scheduled_date, status").eq("contact_id", SELLER)
    const types = ((tps ?? []) as any[]).map((t) => `${t.touchpoint_type}/${t.channel}@${String(t.scheduled_date).slice(0, 10)}`)
    return { ok: !error && (c as any)?.contact_type === "lifetime_customer" && types.length >= 1, detail: `contact=${JSON.stringify(c)} touchpoints=${types.join(", ")}${error ? " err " + error.message : ""}` }
  })
  await step(ctx, "8b", "portal access granted to the client (invite, no mail)", "lib/contact-promotion/portal-access.ts grantPortalAccessForPromotedContact", async () => {
    if (!SELLER || !agentId) return { ok: false, detail: "no seller/agent" }
    const { grantPortalAccessForPromotedContact } = await import("@/lib/contact-promotion/portal-access")
    const r = await grantPortalAccessForPromotedContact(svc, { contactId: SELLER, agentId, contactType: "lifetime_customer", sendMagicLink: false } as any)
    return { ok: r.granted, detail: JSON.stringify(r).slice(0, 400) }
  })
  let CLIENT: { userId: string; email: string } | null = null
  await step(ctx, "8c", "the client's FIRST portal sign-in (OTP, no name in metadata — m684 §2) → users row seated as the contact + first access", "auth.admin.createUser (emulated) → handle_new_auth_user + ensureContactPortalUser + recordPortalFirstAccess", async () => {
    if (!SELLER) return { ok: false, detail: "no seller" }
    const u = await svc.auth.admin.createUser({ email: E("seller"), email_confirm: true })
    if (u.error || !u.data?.user) return { ok: false, detail: `auth: ${u.error?.message}` }
    CLIENT = { userId: u.data.user.id, email: E("seller") }
    ctx.ids.clientUser = CLIENT.userId
    setScopeIds("user_id", [AGENT?.userId, BROKER.userId, CLIENT.userId])
    const { data: c } = await svc.from("contacts").select("id, email, first_name, last_name, brokerage_id, agent_id, metadata").eq("id", SELLER).maybeSingle()
    const { ensureContactPortalUser } = await import("@/lib/portal/portal-invite-core")
    const ens = await ensureContactPortalUser({ authUserId: CLIENT.userId, authEmail: CLIENT.email, contact: c as any })
    const { recordPortalFirstAccess } = await import("@/lib/portal/portal-first-access")
    const fa = await recordPortalFirstAccess({ contactId: SELLER, brokerageId: (c as any)?.brokerage_id ?? null, agentId: (c as any)?.agent_id ?? null, contactFirstName: (c as any)?.first_name ?? null, existingMetadata: (c as any)?.metadata ?? null, capturedLanguage: null })
    const { data: seat } = await svc.from("users").select("user_type, brokerage_id, is_contact, first_name").eq("id", CLIENT.userId).maybeSingle()
    const ok = ens.ensured && fa.accepted && (seat as any)?.user_type === "contact" && (seat as any)?.brokerage_id === B
    return { ok, verdict: ok ? "emulated" : "refused", detail: JSON.stringify({ ensure: ens, firstAccess: fa, seat }).slice(0, 500) }
  })
  actAs(AGENT ?? BROKER)
  await step(ctx, "8d", "agent files a 30-day post-close follow-up task on the client", "app/actions/tasks.ts createTask", async () => {
    if (!SELLER) return { ok: false, detail: "no seller" }
    const { createTask } = await import("@/app/actions/tasks")
    const r: any = await createTask({ title: "Wave93c Demo 30-day post-close check-in", description: "wave93c-demo", dueDate: new Date(Date.now() + 30 * DAY).toISOString(), contactId: SELLER, priority: "medium" })
    return { ok: !!r.success, detail: JSON.stringify(r).slice(0, 300) }
  })
  await step(ctx, "8e", "the client asks the home assistant a question; the answer comes back and the follow-up is filed", "app/actions/portal-lifetime.ts askHomeAssistant", async () => {
    if (!CLIENT || !SELLER) return { ok: false, detail: "no portal user" }
    actAs(CLIENT)
    const { askHomeAssistant } = await import("@/app/actions/portal-lifetime")
    const r = await askHomeAssistant({ contactId: SELLER, question: "Can you recommend a roofer? The roof needs an inspection before hurricane season." })
    actAs(null)
    return { ok: r.ok && !!r.followUp?.filed, detail: JSON.stringify(r).slice(0, 500) }
  })
}
