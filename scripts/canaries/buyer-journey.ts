/**
 * scripts/canaries/buyer-journey.ts — BUYER JOURNEY canary (wave 144, lane 144J; owner ruling 19, the canonical BUYER path):
 *   lead acquisition → raw lead → gate → lead → AI qualification → contact / agent handoff → buyer criteria → cash
 *   verification OR financing pre-approval → intelligent property matching / lists → showings → offer (gates bound at the
 *   write) → outside-listing negotiation loop when needed → final executed terms → compliance → transaction → closing
 *   compliance → preliminary settlement / commission → CDA if required → VERIFIED closing → review request → lifetime →
 *   post-close touchpoints. The buyer path NEVER assumes the seller's listing is in VIPAgents.
 * One synthetic tenant, in memory, through the survivors at 967a4866: lib/buyer-lifecycle (isSearchAllowed,
 * checkFinancialVerification — the wave-140 buyer canary's gate), lib/buyer-search/fair-housing.ts scanFairHousing (no
 * steering in criteria), lib/compliance/checklist-dimensions.ts rowApplicability (pre-approval vs proof of funds by
 * financing kind), lib/transactions/offer-bridge.ts (listing optional), lib/offers/outside-offer-loop.ts pickOutsideTarget,
 * lib/transactions/closing-compliance-core.ts compareClosingTerms, lib/reputation/review-ask.ts. Nothing is sent.
 *
 * FOLDED IN (lane 144B `## Canary requirements`, $S/lane144B-notes.md): BUYER 4–10 as writer → gate assertions; the shared tail
 * (BUYER 11–15) is driven once on a DUAL deal by the seller-journey canary (scripts/canaries/_verified-closing.ts).
 */
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, nowIso, setSvc, uuid } from "./_harness"
import { strippedRepo } from "./_registry"

export async function run() {
  const c = canary("Buyer journey: lead → gate → qualification → contact → criteria → cash or pre-approval → matching → showings → offer (gated at the write) → outside loop → executed → compliance → transaction → closing → review → lifetime")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory only")
  const B = uuid(), U = uuid(), AG = uuid(), CT = uuid()
  const svc = canaryClient({
    brokerages: [{ id: B, name: `${CANARY_TAG} Buyer Journey`, plan_tier: "brokerage", slug: `${CANARY_TAG}-bj`, state: "FL" }],
    users: [{ id: U, email: `agent@${CANARY_EMAIL_DOMAIN}`, user_type: "agent", brokerage_id: B }],
    agents: [{ id: AG, user_id: U, brokerage_id: B, is_active: true }],
    contacts: [{ id: CT, brokerage_id: B, agent_id: AG, first_name: "Riley", last_name: "Buyer", email: `riley@${CANARY_EMAIL_DOMAIN}`, contact_type: "buyer", tcpa_consent: true, notes: CANARY_TAG }],
  })
  setSvc(svc)

  // ── 1 · buyer criteria carry no steering (pure, green — preserve) ──
  const { scanFairHousing } = await import("../../lib/buyer-search/fair-housing")
  const steer = scanFairHousing("3 bed near good schools, in a neighborhood with no kids and a church nearby")
  const plain = scanFairHousing("3 bed, 2 bath, under $450k, garage, within 20 minutes of downtown")
  c.rule("144B", "BUYER CRITERIA CARRY NO STEERING (green — preserve): protected-class phrasing in a buyer's stated criteria is neutralized before it reaches matching (flagged for audit); plain home criteria pass untouched", steer.flagged.length > 0 && plain.flagged.length === 0, `flagged ${steer.flagged.join(", ")}`)

  // ── 2 · cash verification OR pre-approval before search (the wave-140 gate, in memory) ──
  const { isSearchAllowed } = await import("../../lib/buyer-lifecycle/gating-helpers")
  const { checkFinancialVerification } = await import("../../lib/buyer-lifecycle/financial-verification")
  const blocked = await isSearchAllowed(CT)
  await svc.from("activities").insert({ brokerage_id: B, entity_type: "contact", entity_id: CT, activity_type: "buyer.proof_of_funds.uploaded", agent_user_id: U, metadata: { tag: CANARY_TAG }, created_at: nowIso() })
  const fv = await checkFinancialVerification({ contactId: CT })
  c.rule("144B", "CASH VERIFICATION OR PRE-APPROVAL BEFORE MATCHING (green — preserve): an unverified buyer is held out of search; a CASH buyer's proof of funds is read back as the financial verification (not only a lender's pre-approval)", !blocked.allowed && fv.isVerified, `blocked: ${blocked.reason}; verified via ${String((fv as { verificationType?: string }).verificationType)}`)

  // ── 3 · the offer's checklist follows the financing (pure, green — preserve) ──
  const { rowApplicability } = await import("../../lib/compliance/checklist-dimensions")
  const preApprovalRow = { required_stage: "offer", financing_kind: "financed" }, pofRow = { required_stage: "offer", financing_kind: "cash" }
  c.rule("144B", "THE OFFER'S GATE FOLLOWS THE FINANCING (green — preserve): at the offer stage a FINANCED offer needs the pre-approval row and not proof of funds; a CASH offer the reverse; an offer whose financing is unknown applies both as WARNINGS (nobody checked ≠ fine)", rowApplicability(preApprovalRow, { stage: "offer", financing: "financed" }).applies && !rowApplicability(pofRow, { stage: "offer", financing: "financed" }).applies && rowApplicability(pofRow, { stage: "offer", financing: "cash" }).applies && rowApplicability(preApprovalRow, { stage: "offer", financing: null }).unresolved.includes("financing_kind"), "")

  // ── 4 · the buyer path never assumes the listing is in VIPAgents ──
  const bridge = strippedRepo("lib/transactions/offer-bridge.ts") ?? "", gate = strippedRepo("lib/transactions/transaction-creation-gate.ts") ?? ""
  c.rule("144B", "THE BUYER PATH NEVER ASSUMES THE SELLER'S LISTING IS IN VIPAGENTS (green — preserve): the offer → transaction bridge carries listing_id as OPTIONAL (null for an outside property, the address on the row) and the creation gate's listingId is optional — an outside-property offer reaches compliance and a transaction with no internal listing", /listing_id:\s*\(offer as any\)\.listing_id \?\? null/.test(bridge) && /listingId\?:\s*string \| null/.test(gate), "")

  // ── 4b · representation is a gate AT THE OFFER WRITE (NAR 2024 written buyer agreement) ──
  const offersSrc = strippedRepo("app/actions/buyer-offers.ts") ?? ""
  const at = offersSrc.search(/export\s+async\s+function\s+createOffer\s*\(/)
  const next = at < 0 ? -1 : offersSrc.indexOf("\nexport ", at + 1)
  const createOfferBody = at < 0 ? "" : offersSrc.slice(at, next < 0 ? undefined : next)
  const showingGated = /requireActiveBBA\s*\(/.test(strippedRepo("app/actions/showings.ts") ?? "")
  // Re-tagged after lane 144B landed (its map rates J19 BUILT on the lifecycle + financial gates; the BBA half is unowned and the
  // file is lane 144C's domain) — a red-defect for the integrator, not an awaiting lane.
  c.rule("defect", "REPRESENTATION IS BOUND AT THE OFFER WRITE (ruling 19: 'never skip … representation'; the NAR 2024 settlement practice the BBA gate's own header cites — a signed buyer agreement before a home is shown AND before an offer is drafted): the buyer offer writer (app/actions/buyer-offers.ts createOffer) runs the ONE BBA gate (lib/buyer-broker/gate.ts requireActiveBBA) beside its lifecycle + financial gates — at HEAD the showing door runs it but the offer writer does not (the gate's header names a caller, app/actions/buyer-offer/create-offer.ts, that does not exist); the file is lane 144C's domain", showingGated && /requireActiveBBA\s*\(|readBuyerRepresentation\s*\(|activeRepresentation\w*\s*\(/.test(createOfferBody) && /checkBuyerOfferEligibility\s*\(/.test(createOfferBody), `showing door gated: ${showingGated}; createOffer gates: ${["checkBuyerOfferEligibility", "buyer_financial_profiles", "requireActiveBBA"].filter((g) => createOfferBody.includes(g)).join(", ")}`)

  // ── 5 · the outside-listing negotiation loop matches replies safely (pure, green — preserve) ──
  const { pickOutsideTarget } = await import("../../lib/offers/outside-offer-loop")
  const byToken = pickOutsideTarget({ byToken: "root-1", byThread: "root-2", bySender: ["root-3"] })
  const amb = pickOutsideTarget({ byToken: null, byThread: null, bySender: ["root-1", "root-2"] })
  c.rule("144B", "OUTSIDE-LISTING LOOP (green — preserve): a reply attaches to the offer by its reference token first, then its thread, then the sender; a sender matching TWO open offers is AMBIGUOUS — a human confirms, nothing is guessed", byToken.kind === "matched" && byToken.rootId === "root-1" && byToken.how === "token" && amb.kind === "ambiguous", `${JSON.stringify(byToken)} · ${amb.kind}`)

  // ── 6 · closing compliance compares the statement with the executed terms (pure, green — preserve) ──
  const { compareClosingTerms } = await import("../../lib/transactions/closing-compliance-core")
  const fact = (value: number) => ({ unit: "usd" as const, value, confidence: "record" as const, source: "canary" })
  const cmp = compareClosingTerms({ purchase_price: fact(400_000), seller_credit: fact(5_000) } as never, { purchase_price: fact(400_000), seller_credit: fact(3_000) } as never)
  const credit = cmp.findings.find((f) => f.term === "seller_credit")
  c.rule("144B", "CLOSING COMPLIANCE AGAINST THE EXECUTED TERMS (green — preserve): the settlement statement's $3,000 seller credit against the executed $5,000 is a BLOCKING mismatch; the matching price is a match", credit?.verdict === "mismatch" && credit.blocking === true && cmp.findings.find((f) => f.term === "purchase_price")?.verdict === "match", JSON.stringify(cmp.counts))

  // ── 7 · review at the VERIFIED closing → the BUYER is the client asked ──
  const TX = uuid()
  ;(svc.tables.transactions ??= []).push({ id: TX, brokerage_id: B, agent_id: AG, status: "closed", stage: "CLOSED", close_date: new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10), deal_type: "buyer", contact_id: CT, buyer_contact_id: CT, seller_contact_id: null, property_address: `9 Outside Rd ${CANARY_TAG}` })
  ;(svc.tables.brokerage_settings ??= []).push({ id: uuid(), brokerage_id: B, review_request_delay_days: 1, settings: {} })
  const { askForReviewAtClose } = await import("../../lib/reputation/review-ask")
  const sent: string[] = []
  const deps = { dispatchEmail: async () => { sent.push("email"); return { success: false, error: "canary" } }, dispatchSms: async () => { sent.push("sms"); return { success: false, error: "canary" } }, draft: async () => ({ ok: false, error: "canary: no draft" }), emit: async () => ({}), notifyAgent: async () => {} } as never
  const run1 = await askForReviewAtClose(svc as never, { brokerageId: B, transactionId: TX, source: "cron" }, deps)
  c.rule("144B", "REVIEW AT THE VERIFIED CLOSING, ONE PLATFORM WITH A REAL LINK (green — preserve): a verified-closed buyer deal reaches the review engine for its BUYER client; with no real review link in the tenant's reputation policy NOTHING is sent (the broker is told) — never a placeholder link to a real client", run1.results.length >= 1 && run1.results.every((r) => r.status === "skipped" || r.status === "staged") && sent.length === 0, JSON.stringify(run1.results).slice(0, 200))
  // ── 8 · lane 144B's BUYER canary requirements (FOLDED IN): each buyer writer reaches its gate in the writer itself ──
  const { fnBody } = await import("./_verified-closing")
  const arrows: Array<[string, string, string, RegExp]> = [
    ["B4 handoff refuses an unconsented lead", "lib/kernel/lead-acquisition-handlers.ts", "handleLeadAssigned", /assertValidTransition\('consented', 'assigned'/],
    ["B7 matching: contact access BEFORE the paid search", "app/actions/buyer-property-search.ts", "searchPropertiesWithNaturalLanguage", /requireContactAccess\([\s\S]*searchPropertiesCore\(/],
    ["B8 showings: the tenant setting, then the buyer's financial verification", "lib/buyer-execution/showing-financial-policy.ts", "guardShowingFinancialGate", /isFinancialGateRequiredForShowings\([\s\S]*checkBuyerCanPerformAction\(/],
    ["B6/B9 offer: lifecycle + financial gate BEFORE the offers insert", "app/actions/buyer-offers.ts", "createOffer", /checkBuyerOfferEligibility\([\s\S]*\.from\("offers"\)/],
    ["B10 outside reply: the session caller + tenant-pinned reply + chain authority (the agent's act)", "app/actions/buyer-offer/outside-offer-loop.ts", "confirmOutsideReply", /requireCaller\(\)[\s\S]*\.eq\("brokerage_id", caller\.brokerageId\)[\s\S]*authorize\(svc, caller/],
  ]
  const missingArrows = arrows.filter(([, file, fn, re]) => !re.test(fnBody(strippedRepo(file) ?? "", fn)))
  c.rule("144B", "EVERY BUYER PROMOTION IS GUARDED AT ITS WRITE (lane 144B req BUYER 4–10, green — preserve): the handoff refuses an unconsented lead, matching checks contact access before any paid search, showings read the tenant's financial-gate setting, the offer writer runs its lifecycle + financial gates before the insert, and an outside reply is confirmed only by the session's agent under chain authority — an email is never acceptance", missingArrows.length === 0, missingArrows.map(([n]) => n).join("; ") || `${arrows.length} writers gated`)
  // The shared tail (BUYER 11–15 = SELLER 10–15 on a buyer-side deal) is driven ONCE, on a DUAL deal, by the seller-journey canary
  // (scripts/canaries/_verified-closing.ts): the gated close converts the BUYER too and the buyer is the review-ask client.
  // Matching's financial block is an OWNER QUESTION (lane 144B Still open 3) — published here, never asserted:
  console.log("    owner question (lane 144B Still open 3): JOURNEY_PROGRESS_CONTRACT.md:120 blocks search until verified; m377 made the showing gate a tenant setting — whether matching follows the same toggle is not asserted")

  c.blind("Property MATCHING and the listing feed are not executed (the wave-140 buyer canary's blind spot, kept); showings are asserted on the financial gate, not a booked tour; the offer → counter → ONE transaction arrow is the counter-offer canary's and the closing money the financials canary's.")
  const cl = await cleanupCanary(svc, B)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", cl.mismatches.length === 0 && cl.residual === 0, cl.cleanup.map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report(cl.cleanup, cl.residual)
}
