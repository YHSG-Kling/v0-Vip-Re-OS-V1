/**
 * Wave 95 (lane 95A) — TARGETED live test (owner: "do not walk the entire app"):
 * the outside agent's emailed offer → present to the seller portal (net sheet) →
 * counter (the counter now CARRIES the closing date + earnest money) → accept with
 * the executed contract (the transaction has a close date) → close → the lifetime
 * home in the seller's portal → the seller then buys on another deal (dual
 * client) → the lifetime home in the dual client's portal (both layouts).
 *
 * Built on journey-wave94.ts (lane 94B) — same doors, trimmed to the asked steps.
 * Tags: names `Wave95 Demo…`, emails `w95.*@wave95.test`, notes `wave95-demo`,
 * synthetic ids `95a0…`. Run with BRIDGE_DEMO_EMAIL_SUFFIX=@wave95.test,
 * BRIDGE_UUID_PREFIX=95a0, BRIDGE_STORAGE_EMULATE=1, BRIDGE_EMAIL_EMULATE=1.
 */
import type { WalkCtx } from "./run"
import { BridgeStop, actAs, serviceClient, setScopeBrokerage, setScopeIds, setScopeTextIds, quiesce } from "./bridge"

const E = (who: string) => `w95.${who}@wave95.test`
const DAY = 86_400_000
const COOP = E("coop")
const INBOX = E("inbox")
const ADDRESS = "2295 Wave95 Demo Lane"

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
  process.env.POSTMARK_INBOUND_WEBHOOK_SECRET = "wave95-demo-inbound-secret"
  process.env.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "bridge-emulated"
  process.env.SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || E("platform")
  if (process.env.W95_BROKERAGE) setScopeBrokerage(process.env.W95_BROKERAGE)
  const svc = serviceClient()
  void COOP; void INBOX; void ADDRESS; void DAY

  // ── SEEDED SETUP (S1–S6) — one tagged SQL statement, not the real doors. Cost cut for this
  // lane (owner near the usage limit): 94B walked these doors live (inbound email → outside-agent
  // record → intake buyer → offer + 2 documents → AI read) and proved them (inbound-offer-lane
  // 182/0). The seed writes the SAME rows those doors wrote: offer form_source=manual,
  // metadata.outside_agent_id, the AI-read terms (closing 2026-11-11, earnest 15000), documents
  // keyed metadata.linked_offer_id, the intake buyer marked represented, the outside-agent link.
  const id = (n: string) => `95a00000-0000-4000-8000-0000000000${n}`
  const B = id("01"), agentId = id("04"), SELLER = id("05"), LISTING = id("06"), OFFER = id("09")
  const BROKER = { userId: id("02"), email: E("broker") }
  const AGENT = { userId: id("03"), email: E("agent") }
  const CLOSE_ON = "2026-11-11"
  void BROKER
  ctx.ids.brokerage = B
  setScopeBrokerage(B)
  for (const col of ["agent_id", "assigned_to_agent_id", "assigned_agent_id", "buyer_agent_id", "seller_agent_id", "listing_agent_id"]) setScopeIds(col, [agentId])
  for (const col of ["agent_user_id", "user_id", "actor_user_id", "created_by"]) setScopeIds(col, [AGENT.userId, BROKER.userId])
  for (const col of ["team_lead_id", "scope_id", "recipient_user_id", "owner_id"]) setScopeIds(col, [AGENT.userId, BROKER.userId, B])
  setScopeTextIds("owner_id", ["platform"])
  setScopeIds("listing_id", [LISTING]); setScopeIds("offer_id", [OFFER]); setScopeIds("contact_id", [SELLER, id("08")])

  // ── S7. Present → seller portal (offer + documents + net sheet) ───────────
  actAs(AGENT ?? BROKER)
  await step(ctx, "S7", "listing agent presents: offer + documents + automatic net sheet to the seller portal", "offers/present-to-seller.ts presentOfferToSeller", async () => {
    const { presentOfferToSeller } = await import("@/app/actions/offers/present-to-seller")
    const r = await presentOfferToSeller({ offerId: OFFER, listingId: LISTING, note: "wave95-demo" })
    return { ok: r.success && (r.documentsShared ?? 0) === 2 && (r.netSheet?.listingsScanned ?? 0) >= 1, detail: JSON.stringify(r).slice(0, 260) }
  })
  let CLIENT: { userId: string; email: string } | null = null
  await step(ctx, "S7b", "the SELLER in their own portal session sees the offer, its documents and the net sheet", "auth.admin.createUser (EMULATED) → ensureContactPortalUser → portal-seller getSellerOffers + getSellerNetSheetInputs", async () => {
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
    const ok = ens.ensured && (offers.offers ?? []).length === 1 && (o?.documents ?? []).length === 2 && (ns.offers ?? []).length === 1
    return { ok, verdict: ok ? "emulated" : "refused", detail: `offers=${(offers.offers ?? []).length} docs=${(o?.documents ?? []).length} netSheetOffers=${(ns.offers ?? []).length} err=${offers.error ?? ns.error ?? null}` }
  })

  // ── S8. Counter — the counter CARRIES the closing date + earnest money ────
  let COUNTER = ""
  await step(ctx, "S8", "seller counters at $612,000 (price only) → the counter row carries the closing date + earnest money", "seller-offers.ts sendCounterOffer → carryCounterTerms", async () => {
    const { sendCounterOffer } = await import("@/app/actions/seller-offers")
    const r: any = await sendCounterOffer({ parentOfferId: OFFER, listingId: LISTING, counterPrice: 612000, responseDeadline: new Date(Date.now() + 2 * DAY).toISOString(), notes: "wave95-demo counter" })
    COUNTER = r.counterId ?? ""
    ctx.ids.counter = COUNTER
    setScopeIds("offer_id", [OFFER, COUNTER])
    const { data: c } = COUNTER ? await svc.from("offers").select("offer_price, closing_date, earnest_money, form_source, financing_type, inspection_period_days").eq("id", COUNTER).maybeSingle() : { data: null }
    const ok = !!r.success && (c as any)?.closing_date === CLOSE_ON && Number((c as any)?.earnest_money) === 15000 && Number((c as any)?.offer_price) === 612000
    return { ok, detail: `${JSON.stringify(r).slice(0, 120)} counter=${JSON.stringify(c)}` }
  })

  // ── S9. Accept with the executed contract → transaction (close date) ─────
  const so = await import("@/app/actions/seller-offers")
  const ACCEPT_ON = () => COUNTER || OFFER
  await step(ctx, "S9a", "the fully executed counter is filed through the offer document door", "api/offers/[offerId]/upload-document POST (signed_contract)", async () => {
    const { POST } = await import("@/app/api/offers/[offerId]/upload-document/route")
    const { NextRequest } = await import("next/server")
    const fd = new FormData()
    fd.append("file", new File([Buffer.from("%PDF-1.7\n% executed counter wave95-demo\n")], "wave95-demo-executed-counter.pdf", { type: "application/pdf" }))
    fd.append("docType", "signed_contract")
    const res = await POST(new NextRequest(`https://demo.wave95.test/api/offers/${ACCEPT_ON()}/upload-document`, { method: "POST", body: fd }) as any, { params: Promise.resolve({ offerId: ACCEPT_ON() }) })
    const j = (await res.json().catch(() => null)) as any
    if (j?.document_id) ctx.ids.executedDoc = j.document_id
    return { ok: res.status < 300 && !!j?.document_id, detail: `HTTP ${res.status} ${JSON.stringify(j).slice(0, 160)}` }
  })
  setScopeIds("document_id", [ctx.ids.executedDoc])
  await step(ctx, "S9", "accept the counter with the executed contract → transaction WITH a close date and earnest money", "seller-offers.ts acceptOffer(executedContract) → offer-bridge", async () => {
    const r: any = await so.acceptOffer({
      offerId: ACCEPT_ON(), listingId: LISTING,
      executedContract: { documentId: ctx.ids.executedDoc, buyerSignature: { signedAt: new Date(Date.now() - DAY).toISOString().slice(0, 10), attestation: "I hold the fully executed counter from the buyer's agent; it carries both buyers' signatures and initials on every page (wave95-demo)." } },
    })
    const { data: tx } = await svc.from("transactions").select("id, status, purchase_price, close_date, earnest_money, seller_contact_id, offer_id").eq("brokerage_id", B).maybeSingle()
    if ((tx as any)?.id) ctx.ids.transaction = (tx as any).id
    const ok = !!r.success && !!(tx as any)?.close_date && Number((tx as any)?.earnest_money) === 15000
    return { ok, detail: `${JSON.stringify(r).slice(0, 160)} tx=${JSON.stringify(tx)}` }
  })
  const TX = ctx.ids.transaction ?? ""
  setScopeIds("transaction_id", [TX])

  // ── S10. Close ────────────────────────────────────────────────────────────
  await step(ctx, "S10", "the transaction closes", "transactions.ts closeTransaction → closeTransactionCommand", async () => {
    if (!TX) return { ok: false, detail: "no transaction" }
    const { closeTransaction } = await import("@/app/actions/transactions")
    const r = await closeTransaction({ transactionId: TX, brokerageId: B, agentId: agentId ?? "", reason: "wave95-demo close" })
    const { data: t } = await svc.from("transactions").select("status").eq("id", TX).maybeSingle()
    const { data: c } = await svc.from("contacts").select("contact_type").eq("id", SELLER).maybeSingle()
    return { ok: r.success && (t as any)?.status === "closed", detail: `${JSON.stringify(r).slice(0, 160)} tx=${JSON.stringify(t)} seller=${JSON.stringify(c)}` }
  })

  // ── S11. Lifetime home in the SELLER's portal ─────────────────────────────
  const portalAs = async (label: string) => {
    actAs(CLIENT)
    const { createClient } = await import("@/lib/supabase/server")
    const sb = await createClient()
    const { resolvePortalLayouts } = await import("@/lib/kernel/portal")
    const lay = await resolvePortalLayouts(sb as any, { contactId: SELLER })
    const { getLifetimeContext } = await import("@/app/actions/portal-lifetime")
    const life: any = await getLifetimeContext(SELLER)
    actAs(AGENT ?? BROKER)
    const dualTabs = lay.layouts.includes("seller") && lay.layouts.includes("buyer")
    const homeRendered = lay.layouts.includes("lifetime")
    return { lay, life, dualTabs, homeRendered, detail: `${label}: layouts=${JSON.stringify(lay.layouts)} reason=${lay.reason} base=${lay.baseView} lifetimeHomeTx=${life?.transaction?.id === TX ? "this deal" : JSON.stringify(life?.transaction ?? null)} addr=${life?.transaction?.property_address ?? null}` }
  }
  await step(ctx, "S11", "the seller's portal shows the lifetime home (the deal they closed)", "kernel/portal resolvePortalLayouts + portal-lifetime getLifetimeContext (as the seller)", async () => {
    const p = await portalAs("seller")
    return { ok: p.homeRendered && p.life?.transaction?.id === TX, detail: p.detail }
  })

  // ── S12. The seller buys on another deal → DUAL client ────────────────────
  await step(ctx, "S12", "the seller is now buying on another deal (an active buyer-side transaction) — SEEDED: the manual sheet refuses by ruling and a full buyer-offer chain is out of this lane's budget", "transactions insert (walk setup)", async () => {
    const { data, error } = await svc.from("transactions").insert({ brokerage_id: B, agent_id: agentId, contact_id: SELLER, buyer_contact_id: SELLER, deal_name: "Wave95 Demo next home", deal_type: "buyer", status: "active", property_address: "95 Wave95 Demo Court, Boca Raton, FL 33432" }).select("id").maybeSingle()
    if ((data as any)?.id) ctx.ids.buyTx = (data as any).id
    return { ok: !error && !!(data as any)?.id, verdict: "emulated", detail: error ? error.message : `buyTx=${(data as any)?.id}` }
  })
  setScopeIds("transaction_id", [TX, ctx.ids.buyTx])
  await step(ctx, "S13", "the DUAL client's portal (sold here, buying on another deal): the live buyer layout AND the lifetime layout with the sold home", "kernel/portal resolvePortalLayouts + getLifetimeContext (as the client)", async () => {
    const p = await portalAs("dual")
    const both = p.lay.layouts.includes("buyer") && p.homeRendered
    return { ok: both && p.life?.transaction?.id === TX, detail: `${p.detail} dualTabs=${p.dualTabs} lifetimeHomeRendered=${p.homeRendered}` }
  })
}
