#!/usr/bin/env tsx
/**
 * scripts/buyer-portal-offer-intent-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OWNER RULING (2026-09-10): "when a buyer in their portal hits submit an offer on
 * one of our listings, there is notification to agent that their buyer wants to
 * submit an offer, the buyer doesn't have access to the proper forms to start an
 * offer."
 *
 * Proves three things, each a pure function of SOURCE TEXT (comments/strings
 * stripped via scripts/strip-comments.ts — CLAUDE.md §2 measurement discipline —
 * so a tombstone or a fixture string can never masquerade as a real call site):
 *
 *   SOURCE   — app/portal never imports the agent-side offer wizard / prefill /
 *              e-sign-send actions. The forms stay agent-side, always.
 *   ROUTING  — the portal's "submit an offer" control (requestOfferHelp) records
 *              the buyer's INTENT (offer_intents) and emits
 *              KernelEvent.BUYER_OFFER_SUBMIT_REQUESTED; the reactor routes it
 *              Deal Coordinator → Shopping Agent ALWAYS (the buyer's own agent),
 *              and a SECOND explicit case Deal Coordinator → Listing Concierge
 *              ONLY when the listing is confirmed in-house
 *              (listings.brokerage_id === the event's brokerageId).
 *   BEHAVIOR — the two new SIGNAL_HANDLERS, run against an in-memory Supabase
 *              stub: shopping_agent notifies the buyer's OWN assigned agent and
 *              opens a "Prepare offer for <buyer> on <address>" task carrying the
 *              agent-side wizard link; listing_concierge notifies the listing's
 *              agent that an offer is coming.
 *
 * Every "0 found" claim below is POSITIVE-CONTROLLED — proven against a
 * deliberately wrong fixture / a defect re-introduced into the real source, so a
 * broken scanner reads as a failure rather than a silent pass (CLAUDE.md §2).
 *
 * Run: npx tsx scripts/buyer-portal-offer-intent-simulator.ts
 *      npx tsx scripts/buyer-portal-offer-intent-simulator.ts --assert-only   (skip controls)
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { stripComments } from "./strip-comments"
import { SIGNAL_REGISTRY } from "../lib/kernel/signal-registry"
import { SIGNAL_HANDLERS } from "../lib/kernel/manager-signals"

const ROOT = process.cwd()
const CHILD = process.env.BPOI_SIM_CHILD === "1"

let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function src(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf8")
}
function stripped(relPath: string): string {
  return stripComments(src(relPath))
}

// ── walk app/portal for every .ts/.tsx file ─────────────────────────────────
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p)
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE — the forms/prefill/e-sign-send actions stay agent-side; the portal
// never imports them. Scanned on STRIPPED source (§2 — a tombstone comment
// naming these action names must never count as a call site).
// ─────────────────────────────────────────────────────────────────────────────
function sourceNoFormsInPortal() {
  console.log("\n[source · app/portal never reaches the offer forms/prefill/e-sign-send actions]")
  const portalDir = join(ROOT, "app/portal")
  const files = walk(portalDir)
  check("CONTROL — the portal walk actually found files", files.length > 20, `found ${files.length}`)

  // The agent-side-only surface: creating/prefilling/e-signing a REAL offer.
  // BuyerOfferToolsCard's OWN self-serve tools (affordability, offer-help-request)
  // are the sanctioned intent surface and are exempt by file path below.
  const FORBIDDEN_IMPORTS = [
    /from\s+["']@\/app\/actions\/buyer-offers["']/,          // createOffer, sendOfferForESign, startOfferDraft
    /from\s+["']@\/app\/actions\/buyer-offer\/prefill-offer["']/,
    /from\s+["']@\/app\/actions\/buyer-offer\/prefill-storage-form["']/,
    /from\s+["']@\/app\/actions\/buyer-offer\/esign-anchor-plan["']/,
    /from\s+["']@\/app\/actions\/buyer-offer\/submit-for-signature["']/,
    /from\s+["']@\/app\/crm\/contacts\/\[contactId\]\/offers\/new["']/,
  ]

  const offenders: string[] = []
  for (const file of files) {
    const text = stripComments(readFileSync(file, "utf8"))
    for (const re of FORBIDDEN_IMPORTS) {
      if (re.test(text)) offenders.push(`${file.replace(ROOT + "/", "")} :: ${re}`)
    }
  }
  check("0 portal files import an agent-side offer-creation/prefill/e-sign action",
    offenders.length === 0, offenders.join("; "))

  // POSITIVE CONTROL — the scanner recognizes the defect it was built to catch,
  // against a synthetic snippet (never against a real file, so this can never
  // regress into a self-fulfilling "0 found").
  const poison = `import { createOffer } from "@/app/actions/buyer-offers"\nexport const x = createOffer`
  const poisonStripped = stripComments(poison)
  check("CONTROL — the forbidden-import scanner still catches a planted violation",
    FORBIDDEN_IMPORTS.some((re) => re.test(poisonStripped)))
  // ...and a TOMBSTONE naming the same action must NOT count as a call site.
  const tombstonePoison = stripComments(
    `// TOMBSTONE: prefillOffer moved to the agent wizard — see app/actions/buyer-offer/prefill-offer.ts\nexport const y = 1`,
  )
  check("CONTROL — a comment naming the action is NOT mistaken for an import (stripped first)",
    !FORBIDDEN_IMPORTS.some((re) => re.test(tombstonePoison)))
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTING — the emitter + the reactor's two explicit cases + the registry
// ─────────────────────────────────────────────────────────────────────────────
function sourceRouting() {
  console.log("\n[source · the control records intent and routes via the kernel, never a direct DB write alone]")
  const tools = stripped("app/actions/buyer-offer-tools.ts")
  const fnStart = tools.indexOf("export async function requestOfferHelp")
  const fn = fnStart > 0 ? tools.slice(fnStart) : ""
  check("requestOfferHelp exists", fn.length > 0)

  check("the control writes to offer_intents (never a priced offers row for a bare click)",
    /\.from\("offer_intents"\)[\s\S]{0,20}\.insert\(/.test(tools))
  check("the offer_intents write carries NO offer_price / financing_type — this is intent, not a priced offer",
    !/offer_intents[\s\S]{0,400}offer_price/.test(tools) && !/offer_intents[\s\S]{0,400}financing_type/.test(tools))
  check("the control emits KernelEvent.BUYER_OFFER_SUBMIT_REQUESTED",
    /emitKernelEvent\(\{[\s\S]{0,400}KernelEvent\.BUYER_OFFER_SUBMIT_REQUESTED/.test(fn))
  check("the emit happens AFTER the agent has already been directly notified (best-effort second path, never instead of it)",
    fn.indexOf("notifyAgent(") > 0 && fn.indexOf("notifyAgent(") < fn.indexOf("BUYER_OFFER_SUBMIT_REQUESTED"))
  check("listingId is resolved from saved_properties.listing_id, never trusted from the client as-is",
    /saved_properties[\s\S]{0,150}listing_id/.test(fn))

  console.log("\n[source · the event-reactor routes TWO explicit cases, neither a self-loop]")
  const reactor = stripped("lib/kernel/event-reactor.ts")
  const caseStart = reactor.indexOf("KernelEvent.BUYER_OFFER_SUBMIT_REQUESTED")
  const kase = caseStart > 0 ? reactor.slice(caseStart, caseStart + 3000) : ""
  check("the reactor has a case for BUYER_OFFER_SUBMIT_REQUESTED", kase.length > 0)

  const alwaysMatch = kase.match(/fromManager:\s*"deal_coordinator"[\s\S]{0,200}toManager:\s*"shopping_agent"/)
  check("case A (ALWAYS) routes deal_coordinator → shopping_agent — the buyer's OWN agent, via the shopping_agent handler",
    !!alwaysMatch)

  const inHouseGuardIdx = kase.indexOf("listingBrokerageId === params.brokerageId")
  const secondCaseIdx = kase.indexOf('toManager:   "listing_concierge"')
  check("case B (listing_concierge) is gated behind an explicit listings.brokerage_id match — not unconditional",
    inHouseGuardIdx > 0 && secondCaseIdx > inHouseGuardIdx)
  check("case B is a SEPARATE publishManagerSignal call, not folded into case A (two cases, both explicit)",
    (kase.match(/publishManagerSignal\(/g) ?? []).length >= 2)
  check("neither case routes a manager to itself",
    !/fromManager:\s*"shopping_agent"[\s\S]{0,150}toManager:\s*"shopping_agent"/.test(kase) &&
    !/fromManager:\s*"deal_coordinator"[\s\S]{0,150}toManager:\s*"deal_coordinator"/.test(kase))

  console.log("\n[source · SIGNAL_REGISTRY + SIGNAL_HANDLERS are both updated]")
  const spec = SIGNAL_REGISTRY["buyer_offer_submit_requested"]
  check("SIGNAL_REGISTRY declares buyer_offer_submit_requested",
    !!spec, JSON.stringify(spec))
  check("…as handled, consumed by BOTH shopping_agent and listing_concierge",
    spec?.disposition === "handled" &&
    spec.consumers.includes("shopping_agent") && spec.consumers.includes("listing_concierge"))
  check("SIGNAL_HANDLERS has the shopping_agent handler (buyer's own agent, task + notification)",
    typeof SIGNAL_HANDLERS["shopping_agent:buyer_offer_submit_requested"] === "function")
  check("SIGNAL_HANDLERS has the listing_concierge handler (in-house case, listing's agent)",
    typeof SIGNAL_HANDLERS["listing_concierge:buyer_offer_submit_requested"] === "function")

  console.log("\n[source · the buyer is told the honest thing — never a forms promise]")
  const card = stripped("app/portal/[contactId]/properties/[propertyId]/BuyerOfferToolsCard.tsx")
  check("the button is 'Help me make an offer', not a form-opening CTA",
    /Help me make an offer/.test(card))
  check("the card never routes to /offers/new or any agent-wizard path",
    !/offers\/new/.test(card))
}

// ─────────────────────────────────────────────────────────────────────────────
// READER — app/actions/offer-intents.ts (this lane, wave 52). The kernel
// notification/task above was ALWAYS best-effort visibility; this is the
// durable queue the agent actually works from: see it, acknowledge it, start
// the real offer, or dismiss it. Structural (regex-on-stripped-source), same
// discipline as sourceRouting() above — every "0 found" is positive-controlled.
// ─────────────────────────────────────────────────────────────────────────────
function sourceReaderHalf() {
  console.log("\n[reader · app/actions/offer-intents.ts — the agent's durable offer_intents queue]")
  const reader = stripped("app/actions/offer-intents.ts")
  check("offer-intents.ts exists and is non-trivial", reader.length > 500)

  for (const fn of ["listPendingOfferIntentsForAgent", "listOfferIntentsForContact", "acknowledgeOfferIntent", "dismissOfferIntent"]) {
    check(`exports ${fn}`, new RegExp(`export async function ${fn}\\(`).test(reader))
  }

  check("the file marks itself \"use server\" (CLAUDE.md §4 — every export is a public endpoint)",
    /^"use server"/.test(src("app/actions/offer-intents.ts").trimStart()))

  // TENANCY (§4): the caller's brokerage/agent identity is resolved from the
  // SESSION (auth.getUser()), never accepted as a parameter on any export.
  check("resolves the caller from auth.getUser() (session, not a parameter)",
    /authClient\.auth\.getUser\(\)/.test(reader))
  const exportSignatures = [...reader.matchAll(/export async function \w+\(([^)]*)\)/g)].map((m) => m[1])
  check("no export takes a brokerageId/agentId/contactId=self parameter to widen its own scope",
    exportSignatures.every((sig) => !/brokerageId|agentId/i.test(sig)))

  // The agent branch is scoped to the CALLER's own agents.id; the admin branch
  // is scoped to the caller's own brokerage — the same two-tier shape m619's
  // UPDATE policy encodes (never trust a wider scope than the DB would grant).
  check("the agent branch filters by the caller's OWN resolved agent id (.eq(\"agent_id\", scope.agentId))",
    /\.eq\("agent_id",\s*scope\.agentId\)/.test(reader))
  check("every query is scoped to the caller's OWN brokerage (.eq(\"brokerage_id\", scope.brokerageId))",
    (reader.match(/\.eq\("brokerage_id",\s*scope\.brokerageId\)/g) ?? []).length >= 3)

  // §3 trap: an UPDATE matching nothing resolves exactly like one that worked —
  // must .select() and count rows, never trust a null error alone.
  check("transitionIntent .select()s the UPDATE and checks the row COUNT (CLAUDE.md §3 — a no-match UPDATE resolves clean)",
    /\.select\("id"\)[\s\S]{0,200}if\s*\(!data \|\| data\.length === 0\)/.test(reader))
  check("acknowledge/dismiss only move OPEN intents forward (fromStatuses gates the transition)",
    /acknowledgeOfferIntent[\s\S]{0,120}\["requested"\]/.test(reader) &&
    /dismissOfferIntent[\s\S]{0,150}\["requested",\s*"dismissed"|dismissOfferIntent[\s\S]{0,150}\["requested",\s*"acknowledged"\]/.test(reader))

  // POSITIVE CONTROLS for the two structural regexes above.
  const poisonNoSelect = stripComments(`
    export async function transitionIntent(id: string) {
      const { error } = await svc.from("offer_intents").update({ status: "x" }).eq("id", id)
      return { success: !error }
    }
  `)
  check("CONTROL — the §3 row-count scanner does NOT pass a bare update-with-no-select",
    !/\.select\("id"\)[\s\S]{0,200}if\s*\(!data \|\| data\.length === 0\)/.test(poisonNoSelect))
  const poisonWideScope = stripComments(`export async function listAll(brokerageId: string) { return brokerageId }`)
  check("CONTROL — the no-parameter-widening scanner catches a planted brokerageId parameter",
    !exportSignatures.concat([poisonWideScope.match(/export async function \w+\(([^)]*)\)/)?.[1] ?? "brokerageId"]).every((sig) => !/brokerageId|agentId/i.test(sig)))
}

// ─────────────────────────────────────────────────────────────────────────────
// BRIDGE — createOffer converts the intent (offer_id + status='converted')
// when the wizard was opened via "Start Offer". Structural, same discipline.
// ─────────────────────────────────────────────────────────────────────────────
function sourceBridge() {
  console.log("\n[bridge · app/actions/buyer-offers.ts::createOffer converts the intent on success]")
  const offers = stripped("app/actions/buyer-offers.ts")
  const fnStart = offers.indexOf("export async function createOffer(")
  const nextExportStart = fnStart > 0 ? offers.indexOf("\nexport async function", fnStart + 1) : -1
  const fn = fnStart > 0 ? offers.slice(fnStart, nextExportStart > 0 ? nextExportStart : fnStart + 20000) : ""
  check("createOffer exists", fn.length > 0)

  check("OfferFormData carries offer_intent_id",
    /offer_intent_id\??:\s*string \| null/.test(offers))
  check("the bridge only runs AFTER the offer row is successfully created (guarded on offerError/!offer above it)",
    fn.indexOf("if (offerError || !offer)") >= 0 &&
    fn.indexOf("if (offerError || !offer)") < fn.indexOf("form.offer_intent_id"))
  check("the bridge writes offer_id + status='converted' onto offer_intents",
    /\.from\("offer_intents"\)[\s\S]{0,120}\.update\(\{\s*offer_id:\s*offer\.id,\s*status:\s*"converted"/.test(fn))
  check("the bridge is scoped to THIS contact AND brokerage — a foreign/forged intent id cannot be converted",
    /\.eq\("contact_id",\s*contactId\)/.test(fn) && /\.eq\("brokerage_id",\s*brokerageId\)/.test(fn.slice(fn.indexOf("offer_intents"))))
  check("the bridge only converts an OPEN intent (requested/acknowledged), never re-converts a terminal one",
    /\.in\("status",\s*\["requested",\s*"acknowledged"\]\)/.test(fn))
  check("the bridge .select()s and checks the row count (§3 — an UPDATE matching nothing resolves clean)",
    /\.select\("id"\)[\s\S]{0,200}!bridged \|\| bridged\.length === 0/.test(fn))
  check("a refused/no-match bridge is LOUD (console.error) but never un-creates the offer (non-fatal)",
    (fn.match(/console\.error\(`\[createOffer\] offer \$\{offer\.id\} created but offer_intent/g) ?? []).length >= 2)

  console.log("\n[bridge · the wizard threads offer_intent_id end-to-end: URL -> page -> flow -> wizard -> createOffer]")
  const newPage = stripped("app/crm/contacts/[contactId]/offers/new/page.tsx")
  check("/offers/new reads ?intentId= from searchParams", /intentId/.test(newPage))
  const clientPage = stripped("app/crm/contacts/[contactId]/offers/new/new-offer-page-client.tsx")
  check("NewOfferPageClient forwards it as initialOfferIntentId to OfferInitiationFlow",
    /initialOfferIntentId=\{prefillOfferIntentId/.test(clientPage))
  const flow = stripped("app/crm/contacts/[contactId]/offers/components/offer-initiation-flow.tsx")
  check("OfferInitiationFlow forwards it to OfferFormWizard as offerIntentId",
    /offerIntentId=\{initialOfferIntentId\}/.test(flow))
  const wizard = stripped("app/crm/contacts/[contactId]/offers/components/offer-form-wizard.tsx")
  check("OfferFormWizard puts it on the submitted form as offer_intent_id",
    /offer_intent_id:\s*offerIntentId/.test(wizard))

  console.log("\n[bridge · the agent's queue UI links Start Offer with ?intentId= and exposes acknowledge/dismiss]")
  const list = stripped("app/components/offer/buyer-offer-requests-list.tsx")
  check("Start Offer link carries intentId=", /intentId=\$\{encodeURIComponent\(intent\.id\)\}/.test(list))
  check("acknowledge action is wired to acknowledgeOfferIntent", /acknowledgeOfferIntent\(intent\.id\)/.test(list))
  check("dismiss action is wired to dismissOfferIntent", /dismissOfferIntent\(intent\.id\)/.test(list))
  const dashboardPage = stripped("app/dashboard/offers/page.tsx")
  check("app/dashboard/offers is the agent's aggregate queue across all their buyers",
    /listPendingOfferIntentsForAgent/.test(dashboardPage))
  const contactOffersPage = stripped("app/crm/contacts/[contactId]/offers/page.tsx")
  check("the per-contact offers page also loads this buyer's intents",
    /listOfferIntentsForContact/.test(contactOffersPage))
  const navConfig = stripped("app/config/navigation-config.ts")
  check("the new /dashboard/offers route is reachable from nav (orphan-route-sweep)",
    /href:\s*'\/dashboard\/offers'/.test(navConfig))

  // POSITIVE CONTROL — the bridge regex catches a planted defect (status left unconverted).
  const poison = stripComments(`
    if (form.offer_intent_id) {
      await supabase.from("offer_intents").update({ offer_id: offer.id }).eq("id", form.offer_intent_id)
    }
  `)
  check("CONTROL — the bridge-write scanner does NOT pass an update missing status='converted'",
    !/\.from\("offer_intents"\)[\s\S]{0,120}\.update\(\{\s*offer_id:\s*offer\.id,\s*status:\s*"converted"/.test(poison))
}

// ─────────────────────────────────────────────────────────────────────────────
// BEHAVIOR — run the two real handlers against an in-memory Supabase stub
// ─────────────────────────────────────────────────────────────────────────────
type Row = Record<string, any>
function makeFakeSupabase(store: Record<string, Row[]>) {
  const inserted: Array<{ table: string; payload: Row }> = []
  function query(table: string) {
    const filters: Array<[string, any]> = []
    let mode: "select" | "insert" = "select"
    let payload: Row | null = null
    const rows = () => (store[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v))
    const settle = (kind: "one" | "list") => {
      if (mode === "insert") {
        inserted.push({ table, payload: payload ?? {} })
        const row = { id: `${table}_${(store[table] ?? []).length + 1}`, ...(payload ?? {}) }
        store[table] = [...(store[table] ?? []), row]
        return Promise.resolve({ data: row, error: null })
      }
      const found = rows()
      return Promise.resolve({ data: kind === "one" ? (found[0] ?? null) : found, error: null })
    }
    const api: any = {
      select: () => api,
      insert: (p: Row) => { mode = "insert"; payload = p; return api },
      eq: (c: string, v: any) => { filters.push([c, v]); return api },
      limit: () => api,
      maybeSingle: () => settle("one"),
      single: () => settle("one"),
      then: (res: any, rej: any) => settle("list").then(res, rej),
    }
    return api
  }
  return { client: { from: (t: string) => query(t) } as any, store, inserted }
}

const BROKERAGE = "b1111111-1111-4111-8111-111111111111"
const BUYER = "c2222222-2222-4222-8222-222222222222"
const AGENT_RECORD = "a3333333-3333-4333-8333-333333333333"
const AGENT_USER = "u4444444-4444-4444-8444-444444444444"
const LISTING = "l5555555-5555-4555-8555-555555555555"
const LISTING_AGENT_RECORD = "a6666666-6666-4666-8666-666666666666"
const LISTING_AGENT_USER = "u7777777-7777-4777-8777-777777777777"
const INTENT = "i8888888-8888-4888-8888-888888888888"

async function behaviorLayer() {
  console.log("\n[behavior · shopping_agent:buyer_offer_submit_requested — the buyer's OWN agent]")
  {
    const { client, store } = makeFakeSupabase({
      offer_intents: [{ id: INTENT, brokerage_id: BROKERAGE, contact_id: BUYER, agent_id: AGENT_RECORD, listing_id: LISTING, property_address: "9 Oak Lane" }],
      contacts: [{ id: BUYER, brokerage_id: BROKERAGE, first_name: "Rio", last_name: "Vance", agent_id: AGENT_RECORD }],
      agents: [{ id: AGENT_RECORD, user_id: AGENT_USER }],
    })
    const handler = SIGNAL_HANDLERS["shopping_agent:buyer_offer_submit_requested"]
    const result = await handler(
      { id: "sig1", fromManager: "deal_coordinator", toManager: "shopping_agent", signalType: "buyer_offer_submit_requested", message: "", entityType: "buyer_lifecycle", entityId: INTENT, contactId: BUYER, payload: {}, status: "open", createdAt: new Date().toISOString() } as any,
      { supabase: client, brokerageId: BROKERAGE } as any,
    )
    const notif = store.notifications?.[0]
    const task = store.tasks?.[0]
    check("the buyer's OWN assigned agent is notified (not the listing's)", notif?.user_id === AGENT_USER, JSON.stringify(notif))
    check("a task is opened for that same agent", task?.assigned_to_agent_id === AGENT_RECORD, JSON.stringify(task))
    check("the task title names the buyer and the address",
      typeof task?.title === "string" && task.title.includes("Rio Vance") && task.title.includes("9 Oak Lane"), task?.title)
    check("the task carries the agent-side wizard link, never a portal path", /offers\/new/.test(task?.description ?? ""))
    check("the handler reports what it did", typeof result === "string" && result.length > 0, String(result))
  }

  console.log("\n[behavior · listing_concierge:buyer_offer_submit_requested — the listing's agent]")
  {
    const { client, store } = makeFakeSupabase({
      listings: [{ id: LISTING, brokerage_id: BROKERAGE, agent_id: LISTING_AGENT_RECORD, address: "9 Oak Lane" }],
      agents: [{ id: LISTING_AGENT_RECORD, user_id: LISTING_AGENT_USER }],
    })
    const handler = SIGNAL_HANDLERS["listing_concierge:buyer_offer_submit_requested"]
    const result = await handler(
      { id: "sig2", fromManager: "deal_coordinator", toManager: "listing_concierge", signalType: "buyer_offer_submit_requested", message: "", entityType: "listing", entityId: LISTING, contactId: BUYER, payload: {}, status: "open", createdAt: new Date().toISOString() } as any,
      { supabase: client, brokerageId: BROKERAGE } as any,
    )
    const notif = store.notifications?.[0]
    check("the LISTING's agent is notified (different person from the buyer's own agent)",
      notif?.user_id === LISTING_AGENT_USER, JSON.stringify(notif))
    check("the handler reports what it did", typeof result === "string" && result.length > 0, String(result))
  }

  console.log("\n[behavior · no assigned agent — the handler names the gap rather than throwing]")
  {
    const { client } = makeFakeSupabase({
      offer_intents: [{ id: INTENT, brokerage_id: BROKERAGE, contact_id: BUYER, agent_id: null, listing_id: null, property_address: "external house" }],
      contacts: [{ id: BUYER, brokerage_id: BROKERAGE, first_name: "Rio", last_name: null, agent_id: null }],
    })
    const handler = SIGNAL_HANDLERS["shopping_agent:buyer_offer_submit_requested"]
    const result = await handler(
      { id: "sig3", fromManager: "deal_coordinator", toManager: "shopping_agent", signalType: "buyer_offer_submit_requested", message: "", entityType: "buyer_lifecycle", entityId: INTENT, contactId: BUYER, payload: {}, status: "open", createdAt: new Date().toISOString() } as any,
      { supabase: client, brokerageId: BROKERAGE } as any,
    )
    check("an unassigned buyer degrades honestly, never a throw", typeof result === "string" && /no assigned agent/i.test(result), String(result))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NEGATIVE CONTROLS — re-introduce each defect, confirm the patch applied, require RED
// ─────────────────────────────────────────────────────────────────────────────
interface Control { name: string; file: string; find: string; replace: string; expect: string }
const CONTROLS: Control[] = [
  {
    name: "the in-house gate is removed — listing_concierge fires unconditionally",
    file: "lib/kernel/event-reactor.ts",
    find: "if (listingBrokerageId === params.brokerageId) {",
    replace: "if (true) {",
    expect: "case B (listing_concierge) is gated behind an explicit listings.brokerage_id match — not unconditional",
  },
  {
    name: "shopping_agent is routed FROM itself (self-loop)",
    file: "lib/kernel/event-reactor.ts",
    find: 'fromManager: "deal_coordinator",\n          toManager:   "shopping_agent",',
    replace: 'fromManager: "shopping_agent",\n          toManager:   "shopping_agent",',
    expect: "neither case routes a manager to itself",
  },
]

function runChild(): { code: number; out: string } {
  const r = spawnSync("npx", ["tsx", "scripts/buyer-portal-offer-intent-simulator.ts", "--assert-only"], {
    cwd: ROOT, encoding: "utf8", env: { ...process.env, BPOI_SIM_CHILD: "1" },
  })
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }
}

function runControls(): boolean {
  console.log("\n" + "═".repeat(78))
  console.log("NEGATIVE CONTROLS — each defect re-introduced, patch confirmed, RED required")
  console.log("═".repeat(78))
  let allOk = true
  for (const c of CONTROLS) {
    const path = join(ROOT, c.file)
    const original = readFileSync(path, "utf8")
    if (!original.includes(c.find)) {
      console.log(`\n✗ ${c.name}\n   PATCH DID NOT APPLY — anchor not found in ${c.file}. Control proves nothing.`)
      allOk = false
      continue
    }
    writeFileSync(path, original.replace(c.find, c.replace))
    const patched = readFileSync(path, "utf8")
    const applied = patched.includes(c.replace) && !patched.includes(c.find)
    console.log(`\n· ${c.name}`)
    console.log(`   patch applied: ${applied ? "CONFIRMED" : "NOT CONFIRMED"}`)
    if (!applied) { writeFileSync(path, original); allOk = false; continue }

    const red = runChild()
    const named = red.out.split("\n").some((l) => l.startsWith("  ✗ ") && l.includes(c.expect))
    console.log(`   observed: ${red.code !== 0 ? "RED" : "GREEN"} (exit ${red.code})${named ? ` — assertion "${c.expect}" failed as designed` : ""}`)
    if (red.code === 0 || !named) { allOk = false; console.log("   ✗ control did not turn the intended assertion red") }

    writeFileSync(path, original)
    const restored = readFileSync(path, "utf8") === original
    const green = runChild()
    console.log(`   restored: ${restored ? "CONFIRMED" : "FAILED"} · observed: ${green.code === 0 ? "GREEN" : "RED"} (exit ${green.code})`)
    if (!restored || green.code !== 0) { allOk = false; console.log("   ✗ restore did not return the suite to green") }
  }
  return allOk
}

async function main() {
  console.log("═".repeat(78))
  console.log("BUYER PORTAL OFFER INTENT — the buyer signals, the agent starts the offer")
  console.log("═".repeat(78))
  sourceNoFormsInPortal()
  sourceRouting()
  sourceReaderHalf()
  sourceBridge()
  await behaviorLayer()

  console.log("\n" + "─".repeat(78))
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ✗ Failures:"); for (const f of fails) console.log(`   - ${f}`) }

  const assertOnly = CHILD || process.argv.includes("--assert-only")
  if (assertOnly) { process.exit(fail > 0 ? 1 : 0); return }
  if (fail > 0) { process.exit(1); return }

  const controlsOk = runControls()
  console.log("\n" + "─".repeat(78))
  if (!controlsOk) { console.log(" ✗ one or more negative controls did not behave — the proof is not trustworthy"); process.exit(1) }
  console.log(` ✅ ${pass} assertions green · ${CONTROLS.length} negative controls confirmed red-then-green`)
  console.log(" BUYER_PORTAL_OFFER_INTENT_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
