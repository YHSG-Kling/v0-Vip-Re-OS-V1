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
  c.step("RE-RUN: the conversion itself is idempotent on the contact (still exactly one row each, still lifetime_customer) — the duplicate the ruling names is the touchpoint schedule (measured, printed as the 142C finding)", contacts().filter((x) => x.id === BUYER || x.id === SELLER).every((x) => x.contact_type === "lifetime_customer") && contacts().filter((x) => x.email === buyer?.email).length === 1, `touchpoints ${before} → ${afterRerun}`)
  if (afterRerun > before) console.log(`    finding (lane 142C, 'no duplicate conversions'): a second close inserted ${afterRerun - before} more lifetime_customer_touchpoints rows (${before} → ${afterRerun}) — the schedule is not keyed on (contact, transaction, touchpoint_type)`)

  // ── the doors + proofs that exist at HEAD ──
  const pkg = readRepo("package.json") ?? ""
  const kernel = strippedRepo("lib/kernel/transactions.ts") ?? ""
  c.step("the Lifetime doors and proofs exist: app/actions/lifetime-customers.ts + portal-lifetime.ts; test:lifetime-ledger + test:conversion-finality registered; the conversion writes both columns in ONE update and READS its error (no swallowed refusal)", !!readRepo("app/actions/lifetime-customers.ts") && !!readRepo("app/actions/portal-lifetime.ts") && /"test:lifetime-ledger":/.test(pkg) && /"test:conversion-finality":/.test(pkg) && /contact_type:\s*LIFETIME_CUSTOMER_TYPE,\s*lifecycle_state:\s*LIFETIME_CUSTOMER_TYPE/.test(kernel) && /lifetimePromotionError/.test(kernel), "")

  // ── WAVE142 HOOK (integrator): 142C — CLOSED / PAYOUT PENDING + the keyed (no-duplicate) schedule. ──
  for (const h of hooksFor("lifetime")) {
    const at = h.probe()
    if (!at) { c.hook(h.lane, h.contract, `measured: no payout_pending state in lib/kernel/transactions.ts; the re-run inserted ${Math.max(0, afterRerun - before)} duplicate touchpoint rows`); continue }
    c.step(`${h.lane} landed (${at}) — wire its export into this canary (WAVE142 HOOK (integrator): ${h.lane}): close with an unverified payout → CLOSED / PAYOUT PENDING (no lifetime conversion yet) → verify the payout → conversion + schedule once; re-run → 0 new rows`, false, h.contract.slice(0, 120))
  }
  c.blind("The close ran the real kernel command in memory: commission recalculation, the closing-gift task and the kernel events ran best-effort against the fake (refusals are theirs to log). The 'verified' in 'verified closing' is the close date + the executed contract the caller had — no settlement statement is checked here (the preliminary-cd canary).")
  const cl = await cleanupCanary(svc, B), cl2 = await cleanupCanary(svc, B2)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", cl.mismatches.length + cl2.mismatches.length === 0 && cl.residual + cl2.residual === 0, [...cl.cleanup, ...cl2.cleanup].map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report([...cl.cleanup, ...cl2.cleanup], cl.residual + cl2.residual)
}
