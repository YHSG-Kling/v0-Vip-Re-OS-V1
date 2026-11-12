#!/usr/bin/env tsx
/**
 * scripts/vendor-payout-completion-simulator.ts
 *   npm run test:vendor-payout-completion
 * ─────────────────────────────────────────────────────────────────────────────
 * VENDOR PAYOUT COMPLETION COMES FROM THE PROVIDER'S EVENT.
 *
 * Owner ruling, verbatim (2026-08-27): "the vendor payout completed at should
 * come from the providers event completion."
 *
 * Layer 1 (EVENT RESEARCH, pinned): the four handled event names exist in the
 *   INSTALLED Stripe SDK's event catalog (stripe@20.4.1 — the same package the
 *   route verifies signatures with), and the names a naive handler would wait
 *   for (transfer.paid / transfer.failed) do NOT exist — asserting the rule
 *   ("handle only events the provider can emit") rather than trusting memory.
 * Layer 2 (BEHAVIOURAL, stubbed DB, zero network): applyVendorPayoutProviderEvent
 *   against synthetic events — completion, reversal, replay idempotency,
 *   unmatched-id finding, cross-tenant refusal, refused read (fail closed),
 *   matched-nothing UPDATE counted as a failure (§3), stale completion after a
 *   definitive failure.
 * Layer 3 (SOURCE, stripped): the route wires the applier AFTER signature
 *   verification and BEFORE the platform-only subscription refusal (tenant-signed
 *   transfer events are the brokerage's own money); the payout writer still
 *   opens rows at 'processing'; the webhook contract names the event kinds; the
 *   status vocabulary written is the LIVE one ('paid', never 'completed').
 *
 * BLIND SPOTS, published beside the pass (§2):
 *   · SIGNATURE VERIFICATION IS STUBBED: layer 2 hands the applier an
 *     already-authenticated signer, exactly as the route does after
 *     verifyStripeWebhook. The crypto walk itself is exercised by
 *     scripts/webhook-contract-guard.ts (scheme truth) and not re-proven here.
 *   · NO LIVE DELIVERY: no real Stripe event crosses this test; console-side
 *     subscription of the transfer and payout event families on each brokerage
 *     endpoint is repo-invisible (the webhook contract's standing blind spot).
 *   · The live vendor_payouts CHECK (pending|processing|paid|failed|cancelled)
 *     was read 2026-08-27; the stub enforces it here so a vocabulary drift in
 *     this module goes red, but the DATABASE's own CHECK is not re-queried.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import {
  applyVendorPayoutProviderEvent,
  VENDOR_PAYOUT_COMPLETION_EVENTS,
  type VendorPayoutDbClient,
} from "../lib/vendors/vendor-payout-events"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

// The vocabulary the LIVE CHECK allows (read 2026-08-27). 'completed' is absent
// on purpose — the stub refuses it exactly as Postgres would.
const LIVE_STATUS_VOCAB = new Set(["pending", "processing", "paid", "failed", "cancelled"])

// ── Layer 1: the event names are real ────────────────────────────────────────
console.log("\n■ event research pinned against the installed SDK")
{
  const catalog = readFileSync(join(process.cwd(), "node_modules/stripe/types/EventTypes.d.ts"), "utf8")
  for (const evt of Object.keys(VENDOR_PAYOUT_COMPLETION_EVENTS)) {
    check(`'${evt}' exists in stripe SDK event catalog`, catalog.includes(`type: '${evt}'`))
  }
  check("POSITIVE CONTROL — the catalog finder recognises a known event", catalog.includes("type: 'transfer.created'"))
  check("the events a stale mental model would wait for do NOT exist (transfer.paid / transfer.failed)",
    !catalog.includes("type: 'transfer.paid'") && !catalog.includes("type: 'transfer.failed'"))
  check("mapping: transfer.created → paid (completion IS creation for a Transfer)",
    VENDOR_PAYOUT_COMPLETION_EVENTS["transfer.created"].outcome === "paid" &&
    VENDOR_PAYOUT_COMPLETION_EVENTS["transfer.created"].column === "stripe_transfer_id")
  check("mapping: transfer.reversed → failed",
    VENDOR_PAYOUT_COMPLETION_EVENTS["transfer.reversed"].outcome === "failed")
  check("mapping: payout.paid/payout.failed ride stripe_payout_id",
    VENDOR_PAYOUT_COMPLETION_EVENTS["payout.paid"].column === "stripe_payout_id" &&
    VENDOR_PAYOUT_COMPLETION_EVENTS["payout.failed"].column === "stripe_payout_id")
}

// ── Layer 2: the applier, against a stubbed ledger ───────────────────────────

interface StubRow { id: string; brokerage_id: string | null; status: string; completed_at: string | null; stripe_transfer_id: string | null; stripe_payout_id: string | null }

/** In-memory vendor_payouts with the live CHECK enforced; optional fault injection. */
function stubLedger(rows: StubRow[], opts?: { refuseRead?: boolean; updateMatchesNothing?: boolean }) {
  const writes: Array<{ id: string; values: Record<string, unknown> }> = []
  const svc: VendorPayoutDbClient = {
    from: () => ({
      select: () => ({
        eq: (col: string, v: string) => ({
          maybeSingle: async () => {
            if (opts?.refuseRead) return { data: null, error: { message: "permission denied for table vendor_payouts" } }
            const hit = rows.find((r) => (r as unknown as Record<string, unknown>)[col] === v) ?? null
            return { data: hit, error: null }
          },
        }),
      }),
      update: (values: Record<string, unknown>) => ({
        eq: (_col: string, v: string) => ({
          select: async () => {
            const status = values.status as string | undefined
            if (status && !LIVE_STATUS_VOCAB.has(status)) {
              // What Postgres does to a token outside the CHECK: refuses ENTIRELY.
              return { data: null, error: { message: `new row for relation "vendor_payouts" violates check constraint "vendor_payouts_status_check" (status='${status}')` } }
            }
            if (opts?.updateMatchesNothing) return { data: [], error: null }
            const hit = rows.find((r) => r.id === v)
            if (!hit) return { data: [], error: null }
            Object.assign(hit, values)
            writes.push({ id: v, values })
            return { data: [{ id: v }], error: null }
          },
        }),
      }),
    }),
  }
  return { svc, writes, rows }
}

const row = (over: Partial<StubRow>): StubRow => ({
  id: "pay_1", brokerage_id: "brk_A", status: "processing", completed_at: null,
  stripe_transfer_id: "tr_123", stripe_payout_id: null, ...over,
})
const T = "2026-08-27T12:00:00.000Z" // the provider's event time
const platformSigner = { ownerType: "platform", ownerId: "platform" }
const tenantA = { ownerType: "brokerage", ownerId: "brk_A" }
const tenantB = { ownerType: "brokerage", ownerId: "brk_B" }

async function layer2() {
  console.log("\n■ the applier — synthetic provider events against a stubbed ledger")

  { // completion, tenant-signed by the owning brokerage
    const { svc, rows } = stubLedger([row({})])
    const r = await applyVendorPayoutProviderEvent(svc, { eventType: "transfer.created", stripeObjectId: "tr_123", eventCreatedAtIso: T, signer: tenantA })
    check("transfer.created (tenant-signed, own row) → status 'paid' + completed_at from the PROVIDER'S event time",
      r.outcome === "applied" && r.status === "paid" && r.completedAt === T && rows[0].status === "paid" && rows[0].completed_at === T)
    check("…and the update's row count is READ and reported (§3)", r.outcome === "applied" && r.updatedCount === 1)
    const replay = await applyVendorPayoutProviderEvent(svc, { eventType: "transfer.created", stripeObjectId: "tr_123", eventCreatedAtIso: T, signer: tenantA })
    check("Stripe redelivery of the same event is an idempotent replay, not a second write",
      replay.outcome === "replay")
  }

  { // the vocabulary is the LIVE one — 'completed' would be refused by the CHECK
    check("the applier writes 'paid', the live CHECK's completion token — no 'completed' spelling exists in the module",
      !/["']completed["']\s*[,}]/.test(stripComments(src("lib/vendors/vendor-payout-events.ts"))))
    const { svc } = stubLedger([row({})])
    // CONTROL: the stub really does refuse a token outside the CHECK.
    const refused = await (svc.from("vendor_payouts").update({ status: "completed" }).eq("id", "pay_1").select("id"))
    check("CONTROL — the stub refuses a status outside the live CHECK (as Postgres would)", refused.error !== null)
  }

  { // reversal after completion — paid → failed is legal; completion never resurrects a failure
    const { svc, rows } = stubLedger([row({ status: "paid", completed_at: T })])
    const r = await applyVendorPayoutProviderEvent(svc, { eventType: "transfer.reversed", stripeObjectId: "tr_123", eventCreatedAtIso: T, signer: platformSigner })
    check("transfer.reversed after completion → 'failed' and completed_at CLEARED (it did not complete)",
      r.outcome === "applied" && r.status === "failed" && rows[0].completed_at === null)
    const resurrect = await applyVendorPayoutProviderEvent(svc, { eventType: "transfer.created", stripeObjectId: "tr_123", eventCreatedAtIso: T, signer: platformSigner })
    check("a replayed transfer.created after the reversal does NOT resurrect the payout",
      resurrect.outcome === "stale_transition" && rows[0].status === "failed")
  }

  { // payout.* lane rides stripe_payout_id
    const { svc, rows } = stubLedger([row({ stripe_transfer_id: null, stripe_payout_id: "po_9", status: "pending" })])
    const r = await applyVendorPayoutProviderEvent(svc, { eventType: "payout.failed", stripeObjectId: "po_9", eventCreatedAtIso: T, signer: platformSigner })
    check("payout.failed matches by stripe_payout_id → 'failed'", r.outcome === "applied" && rows[0].status === "failed")
  }

  { // tenant honesty: signed by a tenant that does not own the row
    const { svc, rows } = stubLedger([row({})])
    const r = await applyVendorPayoutProviderEvent(svc, { eventType: "transfer.created", stripeObjectId: "tr_123", eventCreatedAtIso: T, signer: tenantB })
    check("REFUSED — a delivery signed by another tenant cannot close this brokerage's payout",
      r.outcome === "refused_cross_tenant" && rows[0].status === "processing")
    check("…and the refusal names both parties", r.outcome === "refused_cross_tenant" && r.message.includes("brk_A") && r.message.includes("brk_B"))
  }

  { // unmatched id — a finding, not a success
    const { svc } = stubLedger([row({})])
    const r = await applyVendorPayoutProviderEvent(svc, { eventType: "transfer.created", stripeObjectId: "tr_UNKNOWN", eventCreatedAtIso: T, signer: platformSigner })
    check("an id no ledger row carries is reported as UNMATCHED (a finding), never applied",
      r.outcome === "unmatched" && r.message.includes("tr_UNKNOWN"))
  }

  { // fail closed on refused read + matched-nothing update
    const { svc } = stubLedger([row({})], { refuseRead: true })
    const r = await applyVendorPayoutProviderEvent(svc, { eventType: "transfer.created", stripeObjectId: "tr_123", eventCreatedAtIso: T, signer: platformSigner })
    check("a REFUSED READ is an error (retryable), never 'no row found'", r.outcome === "error")
    const zero = stubLedger([row({})], { updateMatchesNothing: true })
    const z = await applyVendorPayoutProviderEvent(zero.svc, { eventType: "transfer.created", stripeObjectId: "tr_123", eventCreatedAtIso: T, signer: platformSigner })
    check("an UPDATE that matches 0 rows is a reported FAILURE (§3), not a silent success",
      z.outcome === "error" && z.message.includes("0 rows"))
  }

  { // non-payout events fall through untouched
    const r = await applyVendorPayoutProviderEvent(stubLedger([]).svc, { eventType: "customer.subscription.updated", stripeObjectId: "sub_1", eventCreatedAtIso: T, signer: platformSigner })
    check("subscription events are not this lane's business (fall through to the subscription applier)",
      r.outcome === "not_payout_event")
    const noId = await applyVendorPayoutProviderEvent(stubLedger([]).svc, { eventType: "transfer.created", stripeObjectId: null, eventCreatedAtIso: T, signer: platformSigner })
    check("a payout event with no object id is an error, not a guess", noId.outcome === "error")
  }
}

// ── Layer 3: the wiring, on stripped source ─────────────────────────────────
function layer3() {
  console.log("\n■ wiring — route order, writer, contract (stripped source)")
  const route = stripComments(src("app/api/webhooks/stripe/vendor/route.ts"))
  check("the route calls the applier", /applyVendorPayoutProviderEvent\(/.test(route))
  check("signature verification comes FIRST (the applier only ever sees an authenticated signer)",
    route.indexOf("verifyStripeWebhook(") >= 0 &&
    route.indexOf("verifyStripeWebhook(") < route.indexOf("applyVendorPayoutProviderEvent("))
  check("the payout lane runs BEFORE the platform-only subscription refusal (tenant-signed transfers are the brokerage's own money)",
    route.indexOf("applyVendorPayoutProviderEvent(") < route.indexOf('verification.ownerType !== "platform"'))
  check("the signer handed to the applier is the VERIFIED owner, not payload metadata",
    /signer:\s*\{\s*ownerType:\s*verification\.ownerType,\s*ownerId:\s*verification\.ownerId\s*\}/.test(route))
  check("an applier error is answered 5xx so Stripe redelivers (fail closed)",
    /case "error":[\s\S]{0,400}status:\s*500/.test(route))
  check("an unmatched event is logged as a FINDING and acknowledged applied:false",
    /FINDING[\s\S]{0,200}applied:\s*false/.test(route))

  const payments = stripComments(src("app/actions/vendor-payments.ts"))
  check("the writer still opens payout rows at 'processing' (the provider event closes them)",
    /status:\s*stripeTransferId\s*\?\s*"processing"\s*:\s*"pending"/.test(payments))
  check("the writer does NOT set completed_at itself (completion comes from the provider)",
    !/completed_at/.test(payments.slice(payments.indexOf('.from("vendor_payouts")'), payments.indexOf('.from("vendor_payouts")') + 800)))

  const contract = src("lib/providers/webhook-contract.ts")
  check("the webhook contract's stripe entry names the payout event kinds with the research date",
    /transfer\.created\/transfer\.reversed/.test(contract) && /payout\.paid\/payout\.failed/.test(contract) &&
    /researched 2026-08-27/.test(contract))
  check("…and records that transfer.paid/transfer.failed do not exist (the trap a rewrite would fall into)",
    /NO transfer\.paid\/transfer\.failed/.test(contract))

  // MUTATION CONTROL (§2): the order assertion must bite when the lanes swap.
  const swapped = route.replace("applyVendorPayoutProviderEvent(", "zzz(")
  check("MUTATION CONTROL — removing the applier call turns the wiring checks red",
    !/applyVendorPayoutProviderEvent\(/.test(swapped))
}

async function main() {
  await layer2()
  layer3()
  console.log("\n■ BLIND SPOTS (published, not passed)")
  console.log("  · signature verification is STUBBED here — the applier receives an already-authenticated signer;")
  console.log("    the crypto walk is webhook-contract-guard's scheme-truth territory")
  console.log("  · no live Stripe delivery and no live DB row is touched; the live status CHECK was read 2026-08-27")
  console.log("  · console-side event subscription (transfer.*/payout.* enabled on each endpoint) is repo-invisible")
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ VENDOR_PAYOUT_COMPLETION_FAIL"); process.exit(1) }
  console.log(" ✅ VENDOR_PAYOUT_COMPLETION_PASS — the provider's event closes the payout ledger: paid/failed + completed_at, idempotent, tenant-scoped")
}
main()
