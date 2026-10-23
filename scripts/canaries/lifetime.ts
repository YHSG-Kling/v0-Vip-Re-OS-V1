/**
 * scripts/canaries/lifetime.ts — LIFETIME canary (wave 142, lane 142J):
 *   a verified closing converts the buyer AND the seller to lifetime_customer · the post-close touchpoint schedule
 *   starts · the listing reads sold · a wrong-tenant close converts NOBODY · the re-run is measured
 * through the ONE survivor at HEAD: lib/kernel/transactions.ts closeTransactionCommand (SURVIVORS142 §4 — the
 * conversion lives at :1366 (contact_type + lifecycle_state written together, the error READ) and the five-touchpoint
 * schedule at :1448; no `toLifetime*` function exists). Owner (wave 142): "Lifetime conversion after verified closing
 * + complete records; CLOSED / PAYOUT PENDING until payout verified where rules require; no duplicate conversions."
 *
 * MEASURED AT HEAD (the 142C hook): the command carries no payout-pending state, and a second close of the same
 * transaction inserts the touchpoint schedule AGAIN (the duplicate the ruling closes) — both printed as findings,
 * never asserted as the contract. In-memory only (transactions: 2 live rows, neither closed through this command).
 */
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, nowIso, setSvc, uuid } from "./_harness"
import { hooksFor, readRepo, strippedRepo } from "./_registry"

export async function run() {
  const c = canary("Lifetime: verified closing → buyer + seller lifetime_customer → touchpoint schedule → listing sold · wrong tenant converts nobody · re-run measured")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory only — a close is a financial event; the live table has 2 rows that are not the canary's")
  const B = uuid(), B2 = uuid(), AG_U = uuid(), AG = uuid(), BUYER = uuid(), SELLER = uuid(), BUYER2 = uuid(), L = uuid(), TX = uuid(), TX2 = uuid()
  const contact = (id: string, type: string, first: string) => ({ id, brokerage_id: B, agent_id: AG, contact_type: type, lifecycle_state: type, first_name: first, last_name: "Canary", email: `${first.toLowerCase()}@${CANARY_EMAIL_DOMAIN}`, created_at: nowIso(), updated_at: nowIso() })
  const svc = canaryClient({
    brokerages: [{ id: B, name: `${CANARY_TAG} Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-life` }, { id: B2, name: `${CANARY_TAG} Other`, plan_tier: "team", slug: `${CANARY_TAG}-life2` }],
    users: [{ id: AG_U, email: `agent@${CANARY_EMAIL_DOMAIN}`, user_type: "agent", brokerage_id: B, platform_role: null, first_name: "Canary", last_name: "Agent" }],
    agents: [{ id: AG, user_id: AG_U, brokerage_id: B, first_name: "Canary", last_name: "Agent", is_active: true }],
    contacts: [contact(BUYER, "buyer", "Blake"), contact(SELLER, "seller", "Sam"), contact(BUYER2, "buyer", "Bea")],
    listings: [{ id: L, brokerage_id: B, agent_id: AG, status: "pending", address: `1 ${CANARY_TAG} Way`, contact_id: SELLER, created_at: nowIso(), updated_at: nowIso() }],
    transactions: [
      { id: TX, brokerage_id: B, agent_id: AG, listing_id: L, buyer_contact_id: BUYER, seller_contact_id: SELLER, contact_id: BUYER, deal_type: "buyer", status: "under_contract", stage: "CLOSING_PREP", property_address: `1 ${CANARY_TAG} Way`, sales_price: 400_000, created_at: nowIso(), updated_at: nowIso() },
      { id: TX2, brokerage_id: B, agent_id: AG, listing_id: null, buyer_contact_id: BUYER2, seller_contact_id: null, contact_id: BUYER2, deal_type: "buyer", status: "under_contract", stage: "CLOSING_PREP", property_address: `2 ${CANARY_TAG} Way`, sales_price: 300_000, created_at: nowIso(), updated_at: nowIso() },
    ],
  })
  setSvc(svc)
  const contacts = () => svc.tables.contacts ?? []
  const touchpoints = () => (svc.tables.lifetime_customer_touchpoints ?? []).filter((t) => t.related_transaction_id === TX)

  const { closeTransactionCommand } = await import("../../lib/kernel/transactions")
  let first: { success: boolean; error?: string } = { success: false, error: "not run" }
  try { first = await closeTransactionCommand({ transactionId: TX, brokerageId: B, agentId: AG_U, reason: "canary close" }) } catch (e) { first = { success: false, error: `THREW: ${(e as Error).message}` } }
  const tx = (svc.tables.transactions ?? []).find((t) => t.id === TX)
  c.step("VERIFIED CLOSING: closeTransactionCommand (tenant + id pinned) closes the transaction — status closed, stage CLOSED, close_date today", first.success && tx?.status === "closed" && tx?.stage === "CLOSED" && tx?.close_date === nowIso().slice(0, 10), first.error ?? `${tx?.status}/${tx?.stage}/${tx?.close_date}`)
  const buyer = contacts().find((x) => x.id === BUYER), seller = contacts().find((x) => x.id === SELLER)
  c.step("CONTACT → LIFETIME: the buyer AND the seller read lifetime_customer on BOTH columns (contact_type + lifecycle_state — the invariant the dropped CHECK used to police, kept at the writer); the unrelated buyer of the other deal is untouched", buyer?.contact_type === "lifetime_customer" && buyer?.lifecycle_state === "lifetime_customer" && seller?.contact_type === "lifetime_customer" && seller?.lifecycle_state === "lifetime_customer" && contacts().find((x) => x.id === BUYER2)?.contact_type === "buyer", `${buyer?.contact_type}/${seller?.contact_type}`)
  const tp = touchpoints()
  const types = [...new Set(tp.map((t) => String(t.touchpoint_type)))].sort()
  c.step("FOLLOW-UP STARTS: the post-close schedule lands for each party — 5 touchpoints × 2 contacts (3-day video, 30-day sms, 6-month email, anniversary video, 18-month referral ask), every row scheduled, attributed to the closing agent (agents.id) and to this transaction", tp.length === 10 && types.join() === "home_anniversary,post_close_30_day,post_close_3_day,post_close_6_month,referral_request" && tp.every((t) => t.status === "scheduled" && t.agent_id === AG && t.brokerage_id === B) && new Set(tp.map((t) => t.contact_id)).size === 2, `${tp.length} rows: ${types.join(",")}`)
  c.step("THE LISTING READS SOLD (status mirror on close) and the deal's commission state was recalculated or honestly skipped (no throw)", (svc.tables.listings ?? []).find((l) => l.id === L)?.status === "sold", String((svc.tables.listings ?? []).find((l) => l.id === L)?.status))

  // ── THE REVIEW ASK AT THE VERIFIED CLOSING (wave 143, lane 143E — the review step of this canary) ──
  // Owner: "A review is always asked at closing." The close used to queue its own `scheduled` review_requests row for the buyer, which
  // made the autonomous review cron SKIP that client (its dedupe was "any row for this contact") — so the ask never went out. The ONE
  // engine (lib/reputation/review-ask.ts askForReviewAtClose, run by the review-request-on-close cron) asks once, after the tenant's delay,
  // on one platform with a real link, through the governed send. Models + sends are recorder seams here (in-memory canary).
  {
    const engine = await import("../../lib/reputation/review-ask")
    const draftMod = await import("../../lib/reputation/review-request-draft")
    const { REVIEW_REQUEST_DEFAULT_DELAY_DAYS } = await import("../../lib/reputation/review-request-delay")
    const GOOGLE = "https://g.page/r/CanaryPlace123/review"
    ;(svc.tables.brokerage_settings ??= []).push({ id: uuid(), brokerage_id: B, review_request_delay_days: null, settings: { reputation_profiles: { google: { url: GOOGLE } } }, created_at: nowIso() })
    const queuedByClose = (svc.tables.review_requests ?? []).filter((r) => r.brokerage_id === B).length
    const sentReviews: Array<Record<string, any>> = []
    const reviewDeps: import("../../lib/reputation/review-ask").ReviewAskDeps = {
      draft: (s, input) => draftMod.draftReviewRequest(s as never, input as never, { generate: async () => ({ object: { subject: "How was your move?", message: `It was a pleasure helping you. If you have a moment, an honest review of your experience would mean a lot: ${GOOGLE}`, keyPoints: [], personalizedOpener: "Hi", softAsk: "If you have a moment", directAsk: "An honest review" } }) }) as never,
      dispatchEmail: async (p: Record<string, any>) => { sentReviews.push(p); return { success: true } },
      dispatchSms: async () => ({ success: false, error: "canary: no sms" }),
      emit: async () => ({}), notifyAgent: async () => {}, notifyBrokerageAdmins: async () => 0,
    }
    const dayOfClose = await engine.askForReviewAtClose(svc as never, { brokerageId: B, transactionId: TX }, { ...reviewDeps, now: () => new Date() })
    const sentOnTheDay = sentReviews.length
    const afterDelay = () => new Date(Date.now() + (REVIEW_REQUEST_DEFAULT_DELAY_DAYS + 1) * 86_400_000)
    const asked = await engine.askForReviewAtClose(svc as never, { brokerageId: B, transactionId: TX }, { ...reviewDeps, now: afterDelay })
    const again = await engine.askForReviewAtClose(svc as never, { brokerageId: B, transactionId: TX }, { ...reviewDeps, now: afterDelay })
    const foreign = await engine.askForReviewAtClose(svc as never, { brokerageId: B2, transactionId: TX }, { ...reviewDeps, now: afterDelay })
    const reviewRows = (svc.tables.review_requests ?? []).filter((r) => r.brokerage_id === B)
    c.step("REVIEW ASK — the CLOSE queues NO review_requests row of its own (the old inline `scheduled` row made the autonomous ask skip the client), and the day it closes the tenant's delay says `not_due`: nothing drafted, nothing sent",
      queuedByClose === 0 && (dayOfClose.results[0] as { reason?: string }).reason === "not_due" && sentOnTheDay === 0, `queued by close: ${queuedByClose}; day-of-close: ${JSON.stringify(dayOfClose.results.map((r) => (r as { reason?: string }).reason ?? r.status))}`)
    c.step("REVIEW ASK — once the delay has elapsed the verified closing's CLIENT (the buyer — a buyer-side deal; not the other side) is asked ONCE: the governed email, the REAL link in the body, the at-most-once ledger cycle for (transaction, client), one platform, the row marked sent",
      asked.results.length === 1 && asked.results[0].status === "sent" && sentReviews.length === 1 && sentReviews[0].ledger.cycle === `review_ask:${TX}:${BUYER}` && String(sentReviews[0].text).includes(GOOGLE) && reviewRows.length === 1 && reviewRows[0].status === "sent" && reviewRows[0].platform === "google" && reviewRows[0].contact_id === BUYER, JSON.stringify(asked.results.map((r) => r.status)))
    c.step("REVIEW ASK — NO DUPLICATES: asking again (the cron re-run, any other caller) asks nobody; and another tenant cannot ask on this tenant's closing",
      again.results.every((r) => r.status === "skipped" && (r as { reason?: string }).reason === "already_asked") && sentReviews.length === 1 && (foreign.results[0] as { reason?: string }).reason === "transaction_not_found" && (svc.tables.review_requests ?? []).filter((r) => r.brokerage_id === B).length === 1)
  }

  // ── wrong tenant: nothing converts ──
  let wrong: { success: boolean; error?: string } = { success: false }
  try { wrong = await closeTransactionCommand({ transactionId: TX2, brokerageId: B2, agentId: AG_U }) } catch (e) { wrong = { success: false, error: `THREW: ${(e as Error).message}` } }
  const tx2 = (svc.tables.transactions ?? []).find((t) => t.id === TX2)
  c.step("WRONG TENANT CONVERTS NOBODY: closing B's deal as B2 touches nothing — the transaction stays under_contract, its buyer stays a buyer, no touchpoint row lands", tx2?.status === "under_contract" && contacts().find((x) => x.id === BUYER2)?.contact_type === "buyer" && (svc.tables.lifetime_customer_touchpoints ?? []).every((t) => t.related_transaction_id !== TX2), `command reported success=${wrong.success}${wrong.error ? ` (${wrong.error.slice(0, 80)})` : ""}`)
  if (wrong.success) console.log("    finding (CLAUDE.md §3, lane 142C): an UPDATE that matched nothing resolved — closeTransactionCommand reports success for a wrong-tenant close (error null, 0 rows); the caller is never told. Count the update's rows.")

  // ── the re-run (measured, the hook's subject) ──
  const before = touchpoints().length
  try { await closeTransactionCommand({ transactionId: TX, brokerageId: B, agentId: AG_U, reason: "canary re-run" }) } catch { /* measured below */ }
  const afterRerun = touchpoints().length
  // THE RULE (lane 142C landed): the ONE writer keys the schedule on the transaction — a re-run adds NOTHING.
  c.step("RE-RUN (142C landed — 'no duplicate conversions'): a second close of the same transaction is idempotent end to end — the contacts still read lifetime_customer, exactly one row each, and the touchpoint schedule is NOT inserted again (the ONE writer promoteDealContactsToLifetime guards on an existing schedule for related_transaction_id: 0 new rows)", contacts().filter((x) => x.id === BUYER || x.id === SELLER).every((x) => x.contact_type === "lifetime_customer") && contacts().filter((x) => x.email === buyer?.email).length === 1 && afterRerun === before && before === 10, `touchpoints ${before} → ${afterRerun}`)
  if (afterRerun > before) console.log(`    finding (lane 142C, 'no duplicate conversions'): a second close inserted ${afterRerun - before} more lifetime_customer_touchpoints rows (${before} → ${afterRerun})`)

  // ── the doors + proofs that exist at HEAD ──
  const pkg = readRepo("package.json") ?? ""
  const kernel = strippedRepo("lib/kernel/transactions.ts") ?? ""
  const writer = strippedRepo("lib/kernel/lifetime-conversion.ts") ?? ""
  c.step("the Lifetime doors and proofs exist: app/actions/lifetime-customers.ts + portal-lifetime.ts; test:lifetime-ledger + test:conversion-finality registered; the ONE writer (lib/kernel/lifetime-conversion.ts promoteDealContactsToLifetime — landed 142C) writes BOTH columns in ONE counted update (.select('id')) and READS its error; the close command imports it and no longer inline-writes contacts (the inline write + schedule are tombstoned)", !!readRepo("app/actions/lifetime-customers.ts") && !!readRepo("app/actions/portal-lifetime.ts") && /"test:lifetime-ledger":/.test(pkg) && /"test:conversion-finality":/.test(pkg) && /contact_type:\s*LIFETIME_CUSTOMER_TYPE,\s*lifecycle_state:\s*LIFETIME_CUSTOMER_TYPE/.test(writer) && /promoteErr/.test(writer) && /\.select\(\s*["']id["']\s*\)/.test(writer) && /lifetime-conversion/.test(kernel) && !/contact_type:\s*LIFETIME_CUSTOMER_TYPE/.test(kernel) && !/lifetime_customer_touchpoints/.test(kernel), "")

  // ── WAVE142 HOOK (integrator): 142C — wired 142K: CLOSED / PAYOUT PENDING on a tenant whose policy requires the payout; released by the payout. ──
  for (const h of hooksFor("lifetime")) {
    const at = h.probe()
    if (!at) { c.hook(h.lane, h.contract, `measured: no payout_pending state in lib/kernel/transactions.ts; the re-run inserted ${Math.max(0, afterRerun - before)} duplicate touchpoint rows`); continue }
    const L = await import("../../lib/kernel/lifetime-conversion")
    const B3 = uuid(), AG3_U = uuid(), AG3 = uuid(), BUYER3 = uuid(), SELLER3 = uuid(), TX3 = uuid()
    const c3row = (id: string, type: string, first: string) => ({ ...contact(id, type, first), brokerage_id: B3, agent_id: AG3 })
    ;(svc.tables.brokerages ??= []).push({ id: B3, name: `${CANARY_TAG} Holds`, plan_tier: "brokerage", slug: `${CANARY_TAG}-life3` })
    ;(svc.tables.users ??= []).push({ id: AG3_U, email: `agent3@${CANARY_EMAIL_DOMAIN}`, user_type: "agent", brokerage_id: B3, platform_role: null, first_name: "Canary", last_name: "Three" })
    ;(svc.tables.agents ??= []).push({ id: AG3, user_id: AG3_U, brokerage_id: B3, first_name: "Canary", last_name: "Three", is_active: true })
    ;(svc.tables.contacts ??= []).push(c3row(BUYER3, "buyer", "Bobbi"), c3row(SELLER3, "seller", "Sal"))
    ;(svc.tables.transactions ??= []).push({ id: TX3, brokerage_id: B3, agent_id: AG3, listing_id: null, buyer_contact_id: BUYER3, seller_contact_id: SELLER3, contact_id: BUYER3, deal_type: "buyer", status: "under_contract", stage: "CLOSING_PREP", property_address: `3 ${CANARY_TAG} Way`, sales_price: 350_000, created_at: nowIso(), updated_at: nowIso() })
    ;(svc.tables.brokerage_settings ??= []).push({ id: uuid(), brokerage_id: B3, settings: { [L.LIFETIME_CONVERSION_POLICY_KEY]: { require_payout_verified: true } }, created_at: nowIso() })
    const verdicts = [
      L.lifetimeConversionVerdict({ closed: false, requiredRecordsComplete: true, payoutVerified: true, requirePayoutVerified: true }),
      L.lifetimeConversionVerdict({ closed: true, requiredRecordsComplete: false, payoutVerified: true, requirePayoutVerified: true }),
      L.lifetimeConversionVerdict({ closed: true, requiredRecordsComplete: true, payoutVerified: false, requirePayoutVerified: true }),
      L.lifetimeConversionVerdict({ closed: true, requiredRecordsComplete: true, payoutVerified: false, requirePayoutVerified: false }),
      L.lifetimeConversionVerdict({ closed: true, requiredRecordsComplete: true, payoutVerified: true, requirePayoutVerified: true }),
    ].map((v) => v.action)
    const policy = await L.readLifetimeConversionPolicy(svc as never, B3)
    const c3 = (id: string) => contacts().find((x) => x.id === id)
    const held = () => (svc.tables.activities ?? []).filter((a) => a.brokerage_id === B3 && a.transaction_id === TX3 && a.activity_type === L.LIFETIME_HOLD_ACTIVITY_TYPE)
    const tp3 = () => (svc.tables.lifetime_customer_touchpoints ?? []).filter((t) => t.related_transaction_id === TX3)
    let closeHeld: { success: boolean; error?: string } = { success: false, error: "not run" }
    try { closeHeld = await closeTransactionCommand({ transactionId: TX3, brokerageId: B3, agentId: AG3_U, reason: "canary close (payout pending)" }) } catch (e) { closeHeld = { success: false, error: `THREW: ${(e as Error).message}` } }
    c.step(`${h.lane} landed (${at}) — CLOSED / PAYOUT PENDING: on a tenant whose policy (brokerage_settings.settings.lifetime_conversion.require_payout_verified) holds conversion until the agent is paid, the VERIFIED closing closes the transaction but converts NOBODY yet — ONE open hold activity (${L.LIFETIME_HOLD_ACTIVITY_TYPE}, the "${L.LIFETIME_HOLD_LABEL}" label on the deal), the buyer + seller still buyer / seller, 0 touchpoints; the pure verdict ladder reads not_closed → hold_records → hold_payout_pending → convert (and convert-at-close when the policy does not require it)`, closeHeld.success && policy.requirePayoutVerified && /brokerage_settings/.test(policy.source) && verdicts.join() === "not_closed,hold_records,hold_payout_pending,convert,convert" && (svc.tables.transactions ?? []).find((t) => t.id === TX3)?.status === "closed" && held().length === 1 && held()[0].status === "pending" && c3(BUYER3)?.contact_type === "buyer" && c3(SELLER3)?.contact_type === "seller" && tp3().length === 0, closeHeld.error ?? `hold ${held().length}; touchpoints ${tp3().length}`)
    const release = await L.releaseLifetimeConversionOnPayout(svc as never, { brokerageId: B3, transactionId: TX3, actorUserId: AG3_U })
    const releaseAgain = await L.releaseLifetimeConversionOnPayout(svc as never, { brokerageId: B3, transactionId: TX3, actorUserId: AG3_U })
    let rerun3: { success: boolean; error?: string } = { success: false }
    try { rerun3 = await closeTransactionCommand({ transactionId: TX3, brokerageId: B3, agentId: AG3_U, reason: "canary re-run after payout" }) } catch (e) { rerun3 = { success: false, error: `THREW: ${(e as Error).message}` } }
    const noHold = await L.releaseLifetimeConversionOnPayout(svc as never, { brokerageId: B, transactionId: TX, actorUserId: AG_U })
    // INTEGRATOR FINDING (RED at 28774bdc2, never relaxed): a re-run of closeTransactionCommand AFTER the payout released the
    // conversion opens a SECOND "CLOSED / PAYOUT PENDING" hold — lib/kernel/transactions.ts:1386 hard-codes payoutVerified:false
    // and lib/kernel/lifetime-conversion.ts:168 holdLifetimeConversionPendingPayout dedupes on a PENDING hold only, so a
    // completed hold (the released one) does not stop a new pending one; the contacts are already lifetime_customer, nobody
    // will ever release the duplicate. The owner's rule: no duplicate conversions OR accounting on a re-run. Lane 142C's file.
    c.step(`${h.lane} the PAYOUT VERIFIED releases it through the ONE writer (the path markCommissionPaid shares): both contacts → lifetime_customer on BOTH columns (COUNTED: 2 promoted), the 5×2 schedule lands ONCE, the hold activity completes; a second release promotes the same value and SKIPS the existing schedule (0 new rows); a re-run of the close after the payout adds nothing (still 10 rows, still ONE hold, completed — never re-opened); a convert-at-close tenant has nothing held (released false, by policy) — INTEGRATOR FINDING when red: transactions.ts:1386 + lifetime-conversion.ts:168 re-open a hold on a re-run after the payout`, release.released && release.promotion?.promoted === 2 && release.promotion?.touchpointsScheduled === 10 && release.promotion?.skippedExistingTouchpoints === false && c3(BUYER3)?.contact_type === "lifetime_customer" && c3(BUYER3)?.lifecycle_state === "lifetime_customer" && c3(SELLER3)?.contact_type === "lifetime_customer" && c3(SELLER3)?.lifecycle_state === "lifetime_customer" && held().length === 1 && held()[0]?.status === "completed" && releaseAgain.released && releaseAgain.promotion?.skippedExistingTouchpoints === true && releaseAgain.promotion?.touchpointsScheduled === 0 && tp3().length === 10 && rerun3.success && tp3().length === 10 && held().length === 1 && held().every((a) => a.status === "completed") && !noHold.released && /policy converts at close/.test(noHold.reason), `promoted ${release.promotion?.promoted}; touchpoints ${tp3().length}; holds ${held().map((a) => a.status).join(",")}; re-run ${rerun3.success ? "ok" : rerun3.error}`)
    const cl3 = await cleanupCanary(svc, B3)
    c.step("cleanup (the holding tenant): every tagged row deleted with .select() counts; residual 0", cl3.mismatches.length === 0 && cl3.residual === 0, cl3.cleanup.map((x) => `${x.table}:${x.deleted}`).join(" "))
  }
  c.blind("The close ran the real kernel command in memory: commission recalculation, the closing-gift task and the kernel events ran best-effort against the fake (refusals are theirs to log). The 'verified' in 'verified closing' is the close date + the executed contract the caller had — no settlement statement is checked here (the preliminary-cd canary).")
  const cl = await cleanupCanary(svc, B), cl2 = await cleanupCanary(svc, B2)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", cl.mismatches.length + cl2.mismatches.length === 0 && cl.residual + cl2.residual === 0, [...cl.cleanup, ...cl2.cleanup].map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report([...cl.cleanup, ...cl2.cleanup], cl.residual + cl2.residual)
}
