#!/usr/bin/env tsx
/**
 * scripts/stripe-webhook-events-guard.ts   (npm run test:stripe-webhook-events)
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 80A — owner verbatim (2026-09-23): "go ahead with the add event to
 * stripe webhook endpoint but remember we use stripe sdk." and "i do not want
 * to setup the packages yet in stripe until we are ready to push production
 * rollout."
 *
 * Proves, with no network:
 *   1 · ONE VOCABULARY — the events app/api/billing/webhook/route.ts handles
 *       (its `case` labels, from STRIPPED source) EQUAL
 *       TENANT_BILLING_WEBHOOK_EVENTS; the route imports the const; the launch
 *       checklist's instruction derives from it (control: an extra case, a
 *       stale literal list — each caught).
 *   2 · THE UNION IS PURE — planWebhookEventUnion keeps what is there, adds
 *       what is missing, leaves the wildcard alone, reports the extras.
 *   3 · THE SDK PATH — syncStripeWebhookEvents against an injected client:
 *       fail closed on no app URL / no endpoint / a Stripe refusal; a dry run
 *       never updates; apply writes the union ONCE through
 *       webhookEndpoints.update; nothing is CREATED (no endpoint, price,
 *       product); the URL match tolerates a trailing slash and host case.
 *   4 · NO RAW HTTP — the registration module reaches Stripe only through the
 *       SDK client (control: a fetch to api.stripe.com is caught).
 *   5 · MOUNTS — the platform action (providers gate, audited), the card, the
 *       checklist drift item naming real action exports, the importer roster.
 *   6 · registration.
 *
 * Run: npx tsx --conditions=react-server scripts/stripe-webhook-events-guard.ts
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function control(name: string, defectSeen: boolean) {
  if (defectSeen) { passed++; console.log(`  ↺ control: ${name}`) }
  else { failed++; failures.push(`CONTROL DID NOT GO RED: ${name}`); console.log(`  ✗ CONTROL DID NOT GO RED: ${name}`) }
}
const root = process.cwd()
const raw = (p: string) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : "")
const code = (p: string) => stripComments(raw(p))

const ROUTE = "app/api/billing/webhook/route.ts"
const SCOPE = "lib/billing/stripe-account-scope.ts"
const REG = "lib/billing/stripe-webhook-registration.ts"
const ACTION = "app/actions/superadmin/stripe-webhook-events.ts"
const CARD = "app/dashboard/superadmin/connectors/go-live-card.tsx"
const PAGE = "app/dashboard/superadmin/connectors/page.tsx"
const CHECKLIST = "lib/platform/launch-checklist.ts"
const ROSTER_PROOF = "scripts/stripe-account-scope-simulator.ts"

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[1 · ONE VOCABULARY — the route's switch equals the registration list]")
const { TENANT_BILLING_WEBHOOK_EVENTS, planWebhookEventUnion, STRIPE_WEBHOOK_ROUTES } = await import("../lib/billing/stripe-account-scope")
/** The event types a route source handles: every `case "<event>":` in the
 *  switch on event.type. Comments stripped (the header lists the events in
 *  prose) — strings are NOT blanked, the labels are the strings. */
const handledEvents = (src: string): string[] => [...new Set([...stripComments(src).matchAll(/case\s+"([a-z_]+\.[a-z_.]+)"\s*:/g)].map((m) => m[1]!))].sort()
const handled = handledEvents(raw(ROUTE))
const registered = [...TENANT_BILLING_WEBHOOK_EVENTS].sort()
console.log(`    route handles ${handled.length}: ${handled.join(", ")}`)
check(`the route's ${handled.length} handled events EQUAL TENANT_BILLING_WEBHOOK_EVENTS (${registered.length}) — an event handled but not registered is never delivered; one registered but not handled is a lie`,
  handled.length > 0 && handled.join() === registered.join(), `handled-not-registered: ${handled.filter((e) => !registered.includes(e)).join(",") || "none"}; registered-not-handled: ${registered.filter((e) => !handled.includes(e)).join(",") || "none"}`)
check("customer.subscription.created is on both sides (the event the owner asked to add — route.ts handled it at ~line 254 and the operator instruction omitted it)", handled.includes("customer.subscription.created") && registered.includes("customer.subscription.created"))
control("the finder sees a case the list lacks", handledEvents(raw(ROUTE) + '\ncase "charge.refunded": { break }').some((e) => !registered.includes(e)))
control("…and ignores a case named only in a comment", !handledEvents('// case "charge.refunded":\nswitch (x) { case "invoice.paid": break }').includes("charge.refunded"))
check("the route imports the const and treats a registered-but-unhandled delivery as DRIFT in its default branch", /TENANT_BILLING_WEBHOOK_EVENTS/.test(code(ROUTE)) && /default:[\s\S]{0,600}TENANT_BILLING_WEBHOOK_EVENTS\.includes\(event\.type\)/.test(code(ROUTE)))
check("the const is frozen, and it is the ONLY literal event list for this endpoint in lib/ + app/ (the checklist derives; no stale six-event literal remains)",
  /TENANT_BILLING_WEBHOOK_EVENTS: readonly string\[\] = Object\.freeze\(/.test(code(SCOPE)) && !/customer\.subscription\.updated, customer\.subscription\.deleted, account\.updated\)/.test(raw(CHECKLIST)) && /TENANT_BILLING_WEBHOOK_EVENTS\.join\(", "\)/.test(code(CHECKLIST)))
control("the stale checklist literal would be caught", /customer\.subscription\.updated, customer\.subscription\.deleted, account\.updated\)/.test("(events: checkout.session.completed, invoice.paid, invoice.payment_failed, customer.subscription.updated, customer.subscription.deleted, account.updated)"))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[1b · THE VENDOR ENDPOINT'S VOCABULARY IS DERIVED — payout map ∪ subscription lane (lane 81E)]")
const VENDOR_ROUTE = "app/api/webhooks/stripe/vendor/route.ts"
const VENDOR_EVENTS_MOD = "lib/vendors/vendor-webhook-events.ts"
const SUBS = "lib/kernel/vendor-subscription.ts"
const { VENDOR_MARKETPLACE_WEBHOOK_EVENTS } = await import("../lib/vendors/vendor-webhook-events")
const { VENDOR_PAYOUT_COMPLETION_EVENTS } = await import("../lib/vendors/vendor-payout-events")
const { VENDOR_SUBSCRIPTION_WEBHOOK_EVENTS } = await import("../lib/kernel/vendor-subscription")
{
  const payoutKeys = Object.keys(VENDOR_PAYOUT_COMPLETION_EVENTS).sort()
  const union = [...new Set([...payoutKeys, ...VENDOR_SUBSCRIPTION_WEBHOOK_EVENTS])].sort()
  console.log(`    vendor endpoint handles ${VENDOR_MARKETPLACE_WEBHOOK_EVENTS.length}: ${VENDOR_MARKETPLACE_WEBHOOK_EVENTS.join(", ")}`)
  check("VENDOR_MARKETPLACE_WEBHOOK_EVENTS EQUALS payout-map keys ∪ VENDOR_SUBSCRIPTION_WEBHOOK_EVENTS (derived, never a third spelling)",
    [...VENDOR_MARKETPLACE_WEBHOOK_EVENTS].sort().join() === union.join(), `derived: ${VENDOR_MARKETPLACE_WEBHOOK_EVENTS.join(",")}; expected: ${union.join(",")}`)
  check("the module derives from BOTH data maps in code (no literal event in the derivation file)",
    /Object\.keys\(VENDOR_PAYOUT_COMPLETION_EVENTS\)/.test(code(VENDOR_EVENTS_MOD)) && /VENDOR_SUBSCRIPTION_WEBHOOK_EVENTS/.test(code(VENDOR_EVENTS_MOD))
    && !/"[a-z_]+\.[a-z_.]+"/.test(code(VENDOR_EVENTS_MOD)))
  // The subscription list ⊇ mapStripeEventToStatus's `case` labels; the one
  // event it carries beyond the switch is customer.subscription.updated, which
  // the route header names and the mapper resolves on the object's status.
  const subsSwitch = handledEvents(raw(SUBS))
  check(`the subscription list (${VENDOR_SUBSCRIPTION_WEBHOOK_EVENTS.length}) carries every case label of mapStripeEventToStatus (${subsSwitch.length}) and exactly customer.subscription.updated beyond them`,
    subsSwitch.length > 0 && subsSwitch.every((e) => VENDOR_SUBSCRIPTION_WEBHOOK_EVENTS.includes(e))
    && VENDOR_SUBSCRIPTION_WEBHOOK_EVENTS.filter((e) => !subsSwitch.includes(e)).join() === "customer.subscription.updated",
    `switch: ${subsSwitch.join(",")}; list-only: ${VENDOR_SUBSCRIPTION_WEBHOOK_EVENTS.filter((e) => !subsSwitch.includes(e)).join(",")}`)
  check("the subscription list is frozen in the mapper's own module", /VENDOR_SUBSCRIPTION_WEBHOOK_EVENTS: readonly string\[\] = Object\.freeze\(/.test(code(SUBS)))
  control("a case the subscription list lacks is seen", handledEvents(raw(SUBS) + '\ncase "charge.refunded": { break }').some((e) => !VENDOR_SUBSCRIPTION_WEBHOOK_EVENTS.includes(e)))
  check("the vendor route dispatches the payout lane through the SAME map the derivation reads, and its subscription lane through mapStripeEventToStatus's applier",
    /VENDOR_PAYOUT_COMPLETION_EVENTS\[String\(event\.type\)\]/.test(code(VENDOR_ROUTE)) && /applyVendorSubscriptionEvent\(/.test(code(VENDOR_ROUTE)))
  // The resolution is module-private (an exported resolver with no product
  // reader is an orphan export); its behaviour is proven by the injected-client
  // runs in section 3, and its SOURCE is held here so a third list cannot creep in.
  check("the registration module resolves each endpoint to ITS list (tenant → TENANT_BILLING_WEBHOOK_EVENTS, vendor → VENDOR_MARKETPLACE_WEBHOOK_EVENTS) and plans the union from that resolution",
    /case "tenant_billing": return TENANT_BILLING_WEBHOOK_EVENTS/.test(code(REG)) && /case "vendor_marketplace": return VENDOR_MARKETPLACE_WEBHOOK_EVENTS/.test(code(REG))
    && /const required = requiredWebhookEvents\(endpoint\)/.test(code(REG)) && /planWebhookEventUnion\(before, required\)/.test(code(REG)))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[2 · THE UNION IS PURE]")
{
  const empty = planWebhookEventUnion([], ["a.b", "c.d"])
  check("nothing enabled → everything missing, nothing extra, not in sync", !empty.inSync && empty.missing.join() === "a.b,c.d" && empty.extra.length === 0 && empty.enabledAfter.join() === "a.b,c.d")
  const partial = planWebhookEventUnion(["c.d", "x.y"], ["a.b", "c.d"])
  check("a partial list keeps x.y (another consumer's event), adds a.b, reports x.y as extra — the write is current ∪ required, never required alone",
    !partial.inSync && partial.missing.join() === "a.b" && partial.extra.join() === "x.y" && partial.enabledAfter.join() === "c.d,x.y,a.b")
  control("a 'missing only' write would have dropped x.y — what the union rule prevents", !partial.missing.includes("x.y"))
  const sup = planWebhookEventUnion(["a.b", "c.d", "e.f"], ["a.b", "c.d"])
  check("a superset is in sync with the extras reported and nothing to write", sup.inSync && sup.extra.join() === "e.f" && sup.missing.length === 0)
  const wild = planWebhookEventUnion(["*"], ["a.b"])
  check("the wildcard is in sync, flagged, and left alone", wild.inSync && wild.wildcard && wild.enabledAfter.join() === "*" && wild.missing.length === 0)
  check("duplicates and blanks are folded", planWebhookEventUnion(["a.b", "a.b", " "], ["a.b"]).enabledAfter.join() === "a.b")
  check("the default required list is the endpoint's vocabulary", planWebhookEventUnion([]).missing.length === TENANT_BILLING_WEBHOOK_EVENTS.length)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[3 · THE SDK PATH — fail closed, dry run never writes, apply writes the union once, creates nothing]")
const { syncStripeWebhookEvents, expectedWebhookUrl, sameWebhookUrl } = await import("../lib/billing/stripe-webhook-registration")
function fakeStripe(endpoints: Array<{ id: string; url: string; enabled_events: string[]; status?: string; livemode?: boolean }>, opts: { listThrows?: string; updateThrows?: string } = {}) {
  const calls: Array<{ op: string; args: unknown[] }> = []
  const stripe = {
    calls,
    webhookEndpoints: {
      list(params: unknown) {
        calls.push({ op: "webhookEndpoints.list", args: [params] })
        if (opts.listThrows) throw new Error(opts.listThrows)
        return { async *[Symbol.asyncIterator]() { for (const e of endpoints) yield { status: "enabled", livemode: false, ...e } } }
      },
      async update(id: string, params: { enabled_events: string[] }) {
        calls.push({ op: "webhookEndpoints.update", args: [id, params] })
        if (opts.updateThrows) throw new Error(opts.updateThrows)
        const e = endpoints.find((x) => x.id === id)!
        e.enabled_events = [...params.enabled_events]
        return { status: "enabled", livemode: false, ...e }
      },
      async create() { calls.push({ op: "webhookEndpoints.create", args: [] }); throw new Error("must never be called") },
    },
    prices: { async create() { calls.push({ op: "prices.create", args: [] }); throw new Error("must never be called") } },
    products: { async create() { calls.push({ op: "products.create", args: [] }); throw new Error("must never be called") } },
  }
  return stripe as any
}
const APP = "https://os.example.com"
const OURS = `${APP}${STRIPE_WEBHOOK_ROUTES.tenant_billing}`
{
  check("expectedWebhookUrl joins the app URL and the route, trims a trailing slash, and is null on an unset URL", expectedWebhookUrl("https://x.test/") === `https://x.test${STRIPE_WEBHOOK_ROUTES.tenant_billing}` && expectedWebhookUrl("") === null && expectedWebhookUrl(undefined) === null)
  check("sameWebhookUrl: host case and a trailing slash do not matter; a different path does", sameWebhookUrl("https://OS.Example.com/api/billing/webhook/", OURS) && !sameWebhookUrl(`${APP}/api/webhooks/stripe/vendor`, OURS))

  const s0 = fakeStripe([{ id: "we_1", url: OURS, enabled_events: ["invoice.paid"] }])
  const noUrl = await syncStripeWebhookEvents({ apply: true, stripe: s0, appUrl: null })
  check("NO APP URL → app_url_unset, and Stripe is never even listed (nothing read, nothing written)", !noUrl.ok && noUrl.reason === "app_url_unset" && s0.calls.length === 0)

  const s1 = fakeStripe([{ id: "we_v", url: `${APP}/api/webhooks/stripe/vendor`, enabled_events: ["*"] }])
  const absent = await syncStripeWebhookEvents({ apply: true, stripe: s1, appUrl: APP })
  check("ENDPOINT ABSENT → endpoint_not_registered naming the expected URL and the others; no update, no CREATE", !absent.ok && absent.reason === "endpoint_not_registered" && absent.expectedUrl === OURS && absent.otherEndpointUrls?.length === 1 && s1.calls.every((c: { op: string; args?: unknown }) => c.op === "webhookEndpoints.list"))

  const s2 = fakeStripe([{ id: "we_1", url: `${OURS}/`, enabled_events: ["invoice.paid", "charge.refunded"] }, { id: "we_v", url: `${APP}/api/webhooks/stripe/vendor`, enabled_events: ["*"] }])
  const dry = await syncStripeWebhookEvents({ apply: false, stripe: s2, appUrl: APP })
  check("DRY RUN on a drifted endpoint (matched through the trailing slash) → ok, drift planned, applied:false, NO update call, before === after",
    dry.ok && !dry.plan.inSync && dry.plan.missing.length === TENANT_BILLING_WEBHOOK_EVENTS.length - 1 && dry.plan.extra.join() === "charge.refunded" && dry.applied === false && dry.before.join() === dry.after.join() && !s2.calls.some((c: { op: string; args?: unknown }) => c.op === "webhookEndpoints.update") && dry.otherEndpointUrls.length === 1)
  const applied = await syncStripeWebhookEvents({ apply: true, stripe: s2, appUrl: APP })
  const upd = s2.calls.filter((c: { op: string; args?: unknown }) => c.op === "webhookEndpoints.update")
  check("APPLY → exactly ONE webhookEndpoints.update on OUR endpoint id with the UNION (charge.refunded kept, every handled event added); before/after reported; applied:true",
    applied.ok && applied.applied && upd.length === 1 && (upd[0]!.args[0] as string) === "we_1"
    && [...(upd[0]!.args[1] as { enabled_events: string[] }).enabled_events].sort().join() === [...new Set(["invoice.paid", "charge.refunded", ...TENANT_BILLING_WEBHOOK_EVENTS])].sort().join()
    && applied.before.length === 2 && applied.after.length === TENANT_BILLING_WEBHOOK_EVENTS.length + 1)
  check("NOTHING IS PUBLISHED — no endpoint, price or product create was ever called across every run", [s0, s1, s2].every((s) => !s.calls.some((c: { op: string; args?: unknown }) => /create$/.test(c.op))))
  const again = await syncStripeWebhookEvents({ apply: true, stripe: s2, appUrl: APP })
  check("a second APPLY on the now-synced endpoint is idempotent: in sync, applied:false, no further update", again.ok && again.plan.inSync && !again.applied && s2.calls.filter((c: { op: string; args?: unknown }) => c.op === "webhookEndpoints.update").length === 1)
  const s3 = fakeStripe([{ id: "we_1", url: OURS, enabled_events: ["*"] }])
  const wild = await syncStripeWebhookEvents({ apply: true, stripe: s3, appUrl: APP })
  check("a wildcard endpoint is reported in sync and never rewritten", wild.ok && wild.plan.wildcard && !wild.applied && !s3.calls.some((c: { op: string; args?: unknown }) => c.op === "webhookEndpoints.update"))
  const s4 = fakeStripe([], { listThrows: "Invalid API Key provided" })
  const refusedList = await syncStripeWebhookEvents({ apply: true, stripe: s4, appUrl: APP })
  check("a Stripe refusal on list is reported with Stripe's own sentence (stripe_refused)", !refusedList.ok && refusedList.reason === "stripe_refused" && /Invalid API Key/.test(refusedList.error))
  const s5 = fakeStripe([{ id: "we_1", url: OURS, enabled_events: [] }], { updateThrows: "rate_limit" })
  const refusedUpd = await syncStripeWebhookEvents({ apply: true, stripe: s5, appUrl: APP })
  check("a Stripe refusal on update is reported and says how many events the endpoint STILL enables", !refusedUpd.ok && refusedUpd.reason === "stripe_refused" && /still enables 0 event/.test(refusedUpd.error))
  // THE VENDOR ENDPOINT (lane 81E): same SDK path, its own URL, its own derived list.
  const VOURS = `${APP}${STRIPE_WEBHOOK_ROUTES.vendor_marketplace}`
  const s6 = fakeStripe([{ id: "we_1", url: OURS, enabled_events: ["*"] }, { id: "we_v", url: `${VOURS}/`, enabled_events: ["transfer.created", "charge.refunded"] }])
  const vdry = await syncStripeWebhookEvents({ apply: false, stripe: s6, appUrl: APP, endpoint: "vendor_marketplace" })
  check("VENDOR dry run matches the VENDOR url (through its trailing slash), plans its OWN missing list, never touches the billing endpoint, no update",
    vdry.ok && vdry.endpoint === "vendor_marketplace" && vdry.webhookEndpointId === "we_v" && vdry.plan.missing.length === VENDOR_MARKETPLACE_WEBHOOK_EVENTS.length - 1
    && vdry.plan.extra.join() === "charge.refunded" && !vdry.applied && vdry.otherEndpointUrls.join() === OURS && !s6.calls.some((c: { op: string }) => c.op === "webhookEndpoints.update"))
  const vapplied = await syncStripeWebhookEvents({ apply: true, stripe: s6, appUrl: APP, endpoint: "vendor_marketplace" })
  const vupd = s6.calls.filter((c: { op: string; args?: unknown }) => c.op === "webhookEndpoints.update")
  check("VENDOR apply → exactly ONE update on we_v with current ∪ VENDOR_MARKETPLACE_WEBHOOK_EVENTS (charge.refunded kept)",
    vapplied.ok && vapplied.applied && vupd.length === 1 && (vupd[0]!.args[0] as string) === "we_v"
    && [...(vupd[0]!.args[1] as { enabled_events: string[] }).enabled_events].sort().join() === [...new Set(["transfer.created", "charge.refunded", ...VENDOR_MARKETPLACE_WEBHOOK_EVENTS])].sort().join())
  const s7 = fakeStripe([{ id: "we_1", url: OURS, enabled_events: ["*"] }])
  const vabsent = await syncStripeWebhookEvents({ apply: true, stripe: s7, appUrl: APP, endpoint: "vendor_marketplace" })
  check("VENDOR endpoint absent → endpoint_not_registered naming the VENDOR url and ITS env var (STRIPE_VENDOR_WEBHOOK_SECRET), never created",
    !vabsent.ok && vabsent.reason === "endpoint_not_registered" && vabsent.expectedUrl === VOURS && /STRIPE_VENDOR_WEBHOOK_SECRET/.test(vabsent.error) && !s7.calls.some((c: { op: string }) => /create$/.test(c.op)))
  const s8 = fakeStripe([{ id: "we_1", url: OURS, enabled_events: [] }])
  const unknown = await syncStripeWebhookEvents({ apply: true, stripe: s8, appUrl: APP, endpoint: "made_up" as unknown as "tenant_billing" })
  check("an endpoint outside STRIPE_WEBHOOK_ROUTES is refused BY NAME before Stripe is listed (the name arrives over HTTP)", !unknown.ok && /Unknown webhook endpoint "made_up"/.test(unknown.error) && s8.calls.length === 0)
  check("NOTHING IS PUBLISHED on the vendor runs either", [s6, s7, s8].every((s) => !s.calls.some((c: { op: string }) => /create$/.test(c.op))))
  check("without an injected client the module resolves the PLATFORM client (getPlatformStripe) and turns a throw into stripe_unconfigured — fail closed when Stripe is unconfigured",
    /opts\.stripe \?\? \(await getPlatformStripe\(\)\)/.test(code(REG)) && /reason: "stripe_unconfigured"/.test(code(REG)))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[4 · NO RAW HTTP — the SDK only]")
{
  const reg = blankStrings(code(REG))
  const RAW_HTTP = /\bfetch\s*\(|api\.stripe\.com|callConnector\(/
  check("the registration module never calls fetch, names api.stripe.com or rides the connector gateway — Stripe is reached only through stripe.webhookEndpoints.*", !RAW_HTTP.test(reg) && /stripe\.webhookEndpoints\.list\(/.test(code(REG)) && /stripe\.webhookEndpoints\.update\(/.test(code(REG)))
  control("the finder sees a raw call", RAW_HTTP.test(blankStrings(stripComments('const r = await fetch("https://api.stripe.com/v1/webhook_endpoints")'))))
  check("the module is server-only and never creates an endpoint, a price or a product", /^import "server-only"/m.test(raw(REG)) && !/webhookEndpoints\.create|prices\.create|products\.create/.test(code(REG)))
  control("…the finder would see a create", /webhookEndpoints\.create|prices\.create|products\.create/.test("await stripe.prices.create({})"))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[5 · MOUNTS — the platform action, the card, the checklist item, the importer roster]")
{
  const action = code(ACTION)
  check("the action file is 'use server', exports exactly the check + register actions (both async), gates on the providers capability, audits the register",
    /^"use server"/.test(raw(ACTION)) && /export async function checkStripeWebhookEventsAction\(/.test(action) && /export async function registerStripeWebhookEventsAction\(/.test(action)
    && (action.match(/^export /gm) ?? []).length === 2 && /platformStaffCan\(role, "providers"\)/.test(action) && /"stripe_webhook\.events_registered"/.test(action)
    && /syncStripeWebhookEvents\(\{ apply: false, endpoint: ep \}\)/.test(action) && /syncStripeWebhookEvents\(\{ apply: true, endpoint: ep \}\)/.test(action))
  check("both actions take the endpoint BY NAME and admit it by membership in STRIPE_WEBHOOK_ROUTES (fail closed — the argument arrives over HTTP)",
    /checkStripeWebhookEventsAction\(endpoint: StripeWebhookEndpoint = "tenant_billing"\)/.test(action) && /registerStripeWebhookEventsAction\(endpoint: StripeWebhookEndpoint = "tenant_billing"\)/.test(action)
    && /endpoint in STRIPE_WEBHOOK_ROUTES/.test(action) && (action.match(/if \(!ep\) return \{ ok: false, reason: "forbidden"/g) ?? []).length === 2)
  check("the go-live card imports BOTH actions and renders the drift widget under the checklist's driftChecks for BOTH endpoints (no orphan action)",
    /checkStripeWebhookEventsAction, registerStripeWebhookEventsAction/.test(code(CARD)) && /checklist\.driftChecks\.map/.test(code(CARD)) && /function StripeWebhookEventsDrift\(\{ endpoint \}/.test(code(CARD))
    && /<StripeWebhookEventsDrift endpoint="tenant_billing" \/>/.test(code(CARD)) && /<StripeWebhookEventsDrift endpoint="vendor_marketplace" \/>/.test(code(CARD))
    && /checkStripeWebhookEventsAction\(endpoint\)/.test(code(CARD)) && /registerStripeWebhookEventsAction\(endpoint\)/.test(code(CARD)))
  check("the connectors page still mounts <LaunchChecklistCard checklist={buildLaunchChecklist()} /> — the drift item rides the existing mount", /<LaunchChecklistCard checklist=\{buildLaunchChecklist\(\)\} \/>/.test(code(PAGE)))
  const { buildLaunchChecklist } = await import("../lib/platform/launch-checklist")
  const cl = buildLaunchChecklist()
  const drift = cl.driftChecks.find((d) => d.key === "stripe_webhook_events")
  check("the launch checklist carries the 'webhook events drift' item, launch-blocking, whose check/repair actions are REAL exports of the action file",
    !!drift && drift.tier === "launch-blocking" && new RegExp(`export async function ${drift.checkAction}\\(`).test(action) && new RegExp(`export async function ${drift.repairAction}\\(`).test(action))
  check("the drift item and the stripe_webhook env row both quote every handled event (derived, one vocabulary)",
    !!drift && TENANT_BILLING_WEBHOOK_EVENTS.every((e) => drift.whatDrifts.includes(e)) && TENANT_BILLING_WEBHOOK_EVENTS.every((e) => (cl.items.find((i) => i.key === "stripe_webhook")?.whatLightsUp ?? "").includes(e)))
  check("the drift item carries no value-bearing field (metadata only: key/capability/whatDrifts/checkAction/repairAction/tier)", !!drift && Object.keys(drift).sort().join() === "capability,checkAction,key,repairAction,tier,whatDrifts")
  const vdrift = cl.driftChecks.find((d) => d.key === "stripe_vendor_webhook_events")
  check("the checklist carries the VENDOR drift item too, naming the same two real actions, and quoting every derived vendor event (one vocabulary)",
    !!vdrift && vdrift.checkAction === drift!.checkAction && vdrift.repairAction === drift!.repairAction
    && VENDOR_MARKETPLACE_WEBHOOK_EVENTS.every((e) => vdrift.whatDrifts.includes(e)) && vdrift.whatDrifts.includes(STRIPE_WEBHOOK_ROUTES.vendor_marketplace)
    && Object.keys(vdrift).sort().join() === "capability,checkAction,key,repairAction,tier,whatDrifts")
  check("the stripe-account-scope importer roster names the registration module as connect_admin (it may import the platform client and must move no money)",
    /"lib\/billing\/stripe-webhook-registration\.ts": \{ kind: "connect_admin"/.test(raw(ROSTER_PROOF)))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[6 · registration]")
{
  const pkg = raw("package.json")
  check(`"test:stripe-webhook-events" is registered`, /"test:stripe-webhook-events":\s*"tsx --conditions=react-server scripts\/stripe-webhook-events-guard\.ts"/.test(pkg))
  const guardLine = /"guard":\s*"([^"]+)"/.exec(pkg)?.[1] ?? ""
  check("the guard chain runs it AFTER test:scrapers (ordering only)", guardLine.indexOf("npm run test:scrapers") >= 0 && guardLine.indexOf("npm run test:stripe-webhook-events") > guardLine.indexOf("npm run test:scrapers"))
  check("MAINTENANCE_DOMAINS carries stripe_webhook_event_registration with proof test:stripe-webhook-events and a structured co-owner", /stripe_webhook_event_registration:\s*\{\s*manager:\s*"finance_manager",\s*proof:\s*"test:stripe-webhook-events",\s*coOwners:\s*\["data_steward"\]/.test(code("lib/kernel/manager-registry.ts")))
}

console.log("\n" + "─".repeat(60))
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  ✗ ${f}`)
  console.log("\n❌ STRIPE_WEBHOOK_EVENTS — see failures above")
  process.exit(1)
}
console.log(`\n✅ STRIPE_WEBHOOK_EVENTS — the billing route handles ${handled.length} events and the vendor route ${VENDOR_MARKETPLACE_WEBHOOK_EVENTS.length} (derived); the SDK registration writes exactly each union onto the existing endpoint, and nothing is published`)
