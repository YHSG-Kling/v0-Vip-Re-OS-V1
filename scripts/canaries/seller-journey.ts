/**
 * scripts/canaries/seller-journey.ts — SELLER JOURNEY canary (wave 144, lane 144J; owner ruling 19, the canonical SELLER path):
 *   motivated-seller signal → raw lead → dedup / identity / territory gate → lead → AI qualification → contact → listing
 *   appointment → confirmation / reschedule / follow-up loop → listing intake with planned MLS live date → listing agreement →
 *   e-sign ladder → compliance → fully executed agreement → coming-soon eligibility / policy gate → VERIFIED MLS live → offers
 *   and counters → final executed terms → transaction → closing compliance → preliminary settlement / commission → CDA if the
 *   brokerage requires → VERIFIED closing → review request → lifetime relationship → post-close touchpoints.
 *   Every promotion guarded at its AUTHORITATIVE WRITE (not only in the UI); review requests fire at the VERIFIED closing,
 *   never on a scheduled date alone; managers detect stalls and recommend next steps but never skip a gate.
 * One synthetic tenant, in memory, through the survivors at 967a4866 (each arrow names its writer / gate on the step):
 * lib/lead-pipeline/canonical-lead-eligibility.ts, lib/kernel/crm.ts convertLeadToContact, lib/ai-isa/listing-appointment.ts,
 * lib/kernel/listings.ts createListingRecord, lib/listings/mls-live-date.ts (plannedMlsLiveDateLaunchBlocker,
 * recordVerifiedMlsLive), lib/listings/listing-activation-gate.ts, lib/transactions/offer-bridge.ts →
 * transaction-creation-gate.ts, lib/transactions/cda-closing-policy.ts resolveCdaMode, lib/reputation/review-ask.ts
 * askForReviewAtClose, lib/kernel/transactions.ts closeTransactionCommand. The arrows the other wave-144 canaries drive in
 * depth (counter → ONE transaction, first touch, money) are asserted there and named here. Nothing is sent or published.
 *
 * FOLDED IN (lane 144B `## Canary requirements`, $S/lane144B-notes.md, landed 2026-10-25): the verified-closing tail (SELLER 10–13 —
 * the gated close, CDA-if-required, closing compliance at the close, stage order, contingency types, the verified date, the
 * close events, BOTH parties to lifetime, the payout hold), the close-button door (11b → lane 144I), the coming-soon door
 * (7b → integrator) and the lead → contact event on every door (3) — driven in scripts/canaries/_verified-closing.ts.
 */
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, nowIso, setSvc, uuid } from "./_harness"
import { strippedRepo } from "./_registry"
// STATIC on purpose: this module installs lane 144B's recorder stubs at load, before anything reaches stage-progression.
import { driveVerifiedClosing } from "./_verified-closing"

export async function run() {
  const c = canary("Seller journey: signal → raw → gate → lead → qualification → contact → appointment loop → intake + planned MLS date → agreement → compliance → coming soon → VERIFIED live → offers → executed → transaction → closing → CDA-if-required → VERIFIED closing → review → lifetime")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory only")
  const B = uuid(), U = uuid(), AG = uuid()
  const svc = canaryClient({
    brokerages: [{ id: B, name: `${CANARY_TAG} Seller Journey`, plan_tier: "brokerage", slug: `${CANARY_TAG}-sj`, state: "FL" }],
    users: [{ id: U, email: `agent@${CANARY_EMAIL_DOMAIN}`, user_type: "agent", brokerage_id: B, first_name: "Sam", last_name: "Lister" }],
    agents: [{ id: AG, user_id: U, brokerage_id: B, first_name: "Sam", last_name: "Lister", is_active: true }],
  })
  setSvc(svc)

  // ── 1 · motivated-seller signal → raw lead → identity gate → lead ──
  const { evaluateCanonicalLeadEligibility, isLeadEligibleIdentity } = await import("../../lib/lead-pipeline/canonical-lead-eligibility")
  const raw = { first_name: "Morgan", last_name: "Seller", email: `morgan.seller@${CANARY_EMAIL_DOMAIN}`, phone: "8505550142" }
  const placeholder = evaluateCanonicalLeadEligibility({ first_name: "Homeowner", last_name: "Unknown", email: null, phone: null } as never)
  c.rule("144B", "RAW → LEAD IS GATED (identity): a real, reachable person passes the canonical eligibility gate; a placeholder identity with no channel is REFUSED before any lead row exists (the raw_scraped_leads → leads promotion runs the same predicate)", isLeadEligibleIdentity(raw as never) && !(placeholder as { eligible?: boolean }).eligible, JSON.stringify(placeholder).slice(0, 140))
  const { data: ins } = await svc.from("leads").insert({ brokerage_id: B, ...raw, phone_digits: raw.phone, lead_type: "seller", source: "seller_signal", source_family: "acquisition", source_channel: "digital", lifecycle_state: "raw", lead_stage: "new", is_active: true, ai_isa_owner: true, lead_score: 0, notes: CANARY_TAG, created_at: nowIso() }).select("id").single()
  const L = (ins as { id: string } | null)?.id ?? ""

  // ── 2 · lead → AI qualification → contact (guarded at the conversion write) ──
  const { convertLeadToContact } = await import("../../lib/kernel/crm")
  const early = await convertLeadToContact({ leadId: L, brokerageId: B, agentId: AG, tcpaConsent: true, consentSource: CANARY_TAG })
  await svc.from("leads").update({ lead_stage: "qualified", lead_score: 82, lead_temperature: "hot", updated_at: nowIso() }).eq("id", L).eq("brokerage_id", B).select("id")
  const conv = await convertLeadToContact({ leadId: L, brokerageId: B, agentId: AG, tcpaConsent: true, consentSource: CANARY_TAG })
  const CT = conv.contactId ?? ""
  c.rule("144B", "LEAD → CONTACT IS GUARDED AT ITS WRITE: the conversion door refuses the unqualified lead and converts it only after the AI qualification verdict, under the tenant, to the assigned agent (leads belong to the brokerage until then)", !early.success && conv.success && (svc.tables.contacts ?? []).some((x) => x.id === CT && x.brokerage_id === B && x.agent_id === AG), early.error ?? "")
  const sellerContact = (svc.tables.contacts ?? []).find((x) => x.id === CT)
  if (sellerContact) sellerContact.contact_type = "seller"

  // ── 3 · listing appointment → confirmation / reminder loop (pure) ──
  const appt = await import("../../lib/ai-isa/listing-appointment")
  const in5 = new Date(Date.now() + 5 * 86_400_000 + 3_600_000).toISOString()
  const in2 = new Date(Date.now() + 2 * 86_400_000 + 3_600_000).toISOString()
  c.rule("144B", "APPOINTMENT → CONFIRMATION / REMINDER LOOP (green — preserve): a listing appointment carries the confirm-needed → confirmed event pair and the 5-day / 2-day / morning-of reminder tiers that drive confirmation, reschedule and follow-up", appt.reminderTierForAppointment(in5) === "5_day" && appt.reminderTierForAppointment(in2) === "2_day" && !!appt.LISTING_APPOINTMENT_CONFIRM_EVENT_TYPE && !!appt.LISTING_APPOINTMENT_CONFIRMED_EVENT_TYPE, `${appt.reminderTierForAppointment(in5)}/${appt.reminderTierForAppointment(in2)}`)

  // ── 4 · listing intake WITH a planned MLS live date → coming soon until it arrives ──
  const { createListingRecord } = await import("../../lib/kernel/listings")
  const created = await createListingRecord({ agentId: AG, sellerContactId: CT, brokerageId: B, address: "44 Journey Ln", city: "Pensacola", state: "FL", zip: "32501", listPrice: 525_000, bedrooms: 3, bathrooms: 2, sqft: 1900, propertyType: "single_family" })
  const listing = created.success ? (created as unknown as { listing: Record<string, unknown> }).listing : null
  const LI = String(listing?.id ?? "")
  const row = (svc.tables.listings ?? []).find((x) => x.id === LI)
  const future = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10)
  if (row) Object.assign(row, { go_live_date: future, mls_live_timezone: "America/Chicago" })
  const { plannedMlsLiveDateLaunchBlocker, recordVerifiedMlsLive } = await import("../../lib/listings/mls-live-date")
  const blocker = LI ? await plannedMlsLiveDateLaunchBlocker(svc as never, LI) : null
  c.rule("144B", "INTAKE WITH A PLANNED MLS LIVE DATE (green — preserve): the listing is written against THIS tenant + seller, and while its planned live date is in the future it is COMING SOON — the launch gate refuses to make it active ('cannot be launched as active')", created.success && !!blocker && /coming soon/i.test(blocker), blocker ?? (created.success ? "no blocker" : String((created as { error?: string }).error)))

  // ── 5 · VERIFIED MLS live — a syndication feed, never a claim ──
  const claimed = LI ? await recordVerifiedMlsLive(svc as never, { brokerageId: B, listingId: LI, source: "agent_says" as never, feedListDate: future, actorUserId: U }) : { ok: false, reason: "no listing" }
  c.rule("144B", "VERIFIED MLS LIVE (green — preserve): 'live' is recorded only from a syndication feed that saw the listing — an agent's say-so is refused by name", !claimed.ok && /syndication feed/i.test(String((claimed as { reason?: string }).reason)), String((claimed as { reason?: string }).reason))

  // ── 5b · the COMING-SOON eligibility / policy gate ──
  const { getStageDefinition } = await import("../../lib/listing-lifecycle/lifecycle-definitions")
  const cs = getStageDefinition("COMING_SOON_ACTIVE" as never)
  const checks = (cs?.readinessChecks ?? []) as string[]
  // Lane 144B (Still open 2 / Outside-lane 4): the coming-soon POLICY is MLS / jurisdiction-specific — lane 144A registers it as a
  // versioned, sourced, compliance-approved policy key and 144B reads it at this door. The canary asserts only that A CONFIGURED
  // POLICY IS CONSULTED at the door — it states no rule of its own (never invented).
  // Re-tagged after lanes 144A (policy key + evaluateComingSoonReadiness, its Outside-lane 5) and 144B (landed without the door read)
  // reported: the policy is lane A's, the door read is in lane B's file and neither lane closes it this wave — integrator.
  c.rule("defect", "COMING-SOON ELIGIBILITY / POLICY GATE (ruling 19: 'fully executed agreement → coming-soon eligibility/policy gate → verified MLS live'): publicly marketing a listing as Coming Soon requires the compliance-approved agreement AND consults the tenant / MLS coming-soon policy configured through the adaptive-vocabulary path (versioned, official MLS source cited, compliance-approved — its contents are the MLS's, never a universal default) as a readiness check at the COMING_SOON_ACTIVE door (the agreement half is the stage order — COMING_SOON_ACTIVE is reachable only from the compliance-gated COMING_SOON_PREP, lane 144B); at HEAD that door's readiness checks are repairs only", (cs?.allowedFrom ?? []).every((s) => s === "COMING_SOON_PREP" || s === "REPAIRS_IN_PROGRESS") && (checks.some((k) => /policy|consent|coming_soon|mls_submission|cooperation/.test(k)) || /evaluateComingSoonReadiness\s*\(/.test(strippedRepo("lib/listing-lifecycle/readiness-checker.ts") ?? "")), `HEAD COMING_SOON_ACTIVE readinessChecks: [${checks.join(", ")}]; readiness-checker reads evaluateComingSoonReadiness: ${/evaluateComingSoonReadiness\s*\(/.test(strippedRepo("lib/listing-lifecycle/readiness-checker.ts") ?? "")}`)

  // ── 6 · the authoritative WRITES call their gates (stripped source — the UI is never the only guard) ──
  const kl = strippedRepo("lib/kernel/listings.ts") ?? "", bridge = strippedRepo("lib/transactions/offer-bridge.ts") ?? ""
  const gates: Array<[string, boolean]> = [
    ["listing activation → assertListingActivationAllowed (agreement compliance + documents + signatures + initials)", /assertListingActivationAllowed\s*\(/.test(kl)],
    ["listing launch → plannedMlsLiveDateLaunchBlocker (coming soon until the planned date)", /plannedMlsLiveDateLaunchBlocker\s*\(/.test(kl)],
    ["offer → transaction → assertTransactionCreationAllowed before the insert", (() => { const g = bridge.search(/assertTransactionCreationAllowed\s*\(/), ins = bridge.search(/\.from\(\s*["']transactions["']\s*\)\s*\.insert/); return g >= 0 && ins > g })()],
  ]
  c.rule("144B", "EVERY PROMOTION IS GUARDED AT ITS AUTHORITATIVE WRITE (ruling 19): the kernel's listing activation and launch, and the offer bridge's transaction insert, each call their gate in the writer itself", gates.every(([, ok]) => ok), gates.filter(([, ok]) => !ok).map(([n]) => n).join("; ") || `${gates.length} writers gated`)

  // ── 7 · CDA only when the brokerage requires it (pure, green — preserve) ──
  const { resolveCdaMode } = await import("../../lib/transactions/cda-closing-policy")
  const noCda = resolveCdaMode({ offersCda: false, nonCdaPayoutDefault: "check" }), cda = resolveCdaMode({ offersCda: true })
  c.rule("144B", "CDA IF THE BROKERAGE REQUIRES IT (green — preserve): offers_cda false → no CDA, nothing blocks closing, payout after receipt by check; offers_cda true → CDA mode — a missing CDA never blocks the closing itself", noCda.mode === "no_cda" && !noCda.cdaRequired && noCda.payoutMethodDefault === "check" && cda.mode === "cda" && cda.blocksClosing === false, `${noCda.mode}/${cda.mode}`)

  // ── 8 · the review request fires at the VERIFIED closing ──
  const TX = uuid(), past = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10)
  ;(svc.tables.transactions ??= []).push({ id: TX, brokerage_id: B, agent_id: AG, status: "pending", stage: "UNDER_CONTRACT", close_date: past, deal_type: "seller", contact_id: CT, seller_contact_id: CT, buyer_contact_id: null, property_address: "44 Journey Ln", notes: CANARY_TAG })
  ;(svc.tables.brokerage_settings ??= []).push({ id: uuid(), brokerage_id: B, review_request_delay_days: 3, settings: {} })
  const { askForReviewAtClose } = await import("../../lib/reputation/review-ask")
  const noDispatch = { dispatchEmail: async () => { throw new Error("canary: no send") }, dispatchSms: async () => { throw new Error("canary: no send") }, draft: async () => ({ ok: false, error: "canary: no draft" }), emit: async () => ({}), notifyAgent: async () => {} } as never
  const notVerified = await askForReviewAtClose(svc as never, { brokerageId: B, transactionId: TX, source: "cron" }, noDispatch)
  c.rule("144B", "REVIEW REQUESTS FIRE AT THE VERIFIED CLOSING, NOT A SCHEDULED DATE (green — preserve): a deal whose scheduled close date passed 20 days ago but is NOT verified closed (status pending) gets NO review ask (not_closed) — the verified closing is the trigger, the tenant's delay only spaces it", notVerified.results.length === 1 && notVerified.results[0].status === "skipped" && (notVerified.results[0] as { reason?: string }).reason === "not_closed", JSON.stringify(notVerified.results[0]))

  // ── 9 · lifetime after the verified closing; stall detection through the managers ──
  const kt = strippedRepo("lib/kernel/transactions.ts") ?? ""
  const reg = await import("../../lib/kernel/manager-registry")
  const plays = ["listing_launch_play", "closing_money_and_risk", "long_horizon_nurture"].filter((p) => (strippedRepo("lib/kernel/mission-controller.ts") ?? "").includes(p))
  c.rule("144B", "LIFETIME AFTER THE VERIFIED CLOSING + MANAGERS WATCH FOR STALLS (green — preserve): the close command converts the deal's client(s) to the lifetime type (closeTransactionCommand), and the mission controller carries the listing-launch, closing money-and-risk and long-horizon-nurture plays that detect stalls and recommend the next step under authority — none of them writes past a gate", /export\s+async\s+function\s+closeTransactionCommand\b/.test(kt) && /lifetime/i.test(kt) && plays.length === 3 && Object.keys(reg.MANAGERS).length > 0, `plays ${plays.join(",")}`)
  // WAVE144 WIRE (integrator): 144B — fold the lane's `## Canary requirements` (per-arrow writer / event / reader / manager / exception
  // / recovery) here as each arrow's assertion lands; arrows driven in depth elsewhere: counter-offer (offer → executed → ONE
  // transaction), first-touch (contact → invite + welcome), financials / concessions (settlement → commission → payout).

  // ── 10 · lane 144B's canary requirements: the VERIFIED CLOSING tail, driven (scripts/canaries/_verified-closing.ts) ──
  const closing = await driveVerifiedClosing((owner, step, ok, evidence) => c.rule(owner, step, ok, evidence ?? ""))

  c.blind("The e-sign ladder and the listing compliance loop (agreement → all signed → compliance → fully executed) are the listing-lifecycle canary's chain; the offer → counter → transaction arrow is the counter-offer canary's; the closing money is the financials canary's. Territory gating is not exercised (no territory is seeded). The appointment loop is asserted on its pure tiers, not a calendar.")
  const cl = await cleanupCanary(svc, B)
  const residual = cl.residual + closing.residual
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", cl.mismatches.length + closing.mismatches.length === 0 && residual === 0, [...cl.cleanup, ...closing.cleanup].map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report([...cl.cleanup, ...closing.cleanup], residual)
}
