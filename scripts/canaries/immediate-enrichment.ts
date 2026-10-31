/**
 * scripts/canaries/immediate-enrichment.ts — INTELLIGENCE canary (wave 142, lane 142J):
 *   a new contact / form submission QUEUES enrichment on the insert · the capture is never blocked by the rail ·
 *   a duplicate capture queues nothing twice · Versium fails CLOSED without a key · no second rail
 * through the survivors at HEAD: lib/contact-pipeline/contact-capture.ts captureContact (every consented door's
 * chokepoint: dedup → contact → queueContactEnrichmentAndScore), lib/enrichment/contact-enrichment-core.ts
 * queueContactEnrichment (the ONE queue writer: already_queued / recently_enriched / live_deal refusals),
 * lib/external/versium-client.ts (isVersiumConfigured — no key, no call) and lib/kernel/cron-dispatch.ts (the
 * 15-minute drain). Owner (wave 142): "enrichment should happen as soon as a new contact or form submission comes in"
 * — the queue row lands on the insert; the PROVIDER CALL waits for the cron (SURVIVORS142 Part 2 §2: PARTIAL).
 *
 * MEASURED AT HEAD (the 142D hooks): queueContactEnrichment writes the row and returns — no inline drain through
 * processEnrichmentQueue / enrichContactRecord at any door; versium-client carries no B2B2C / Online-Presence
 * products. In-memory only (lead_enrichment_queue: 0 live rows). The REFUSED client (lead_enrichment_queue refused
 * RLS-style — the harness's `refuse` option) proves the rail is best-effort: the contact still lands.
 */
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, nowIso, setSvc, uuid } from "./_harness"
import { hooksFor, strippedRepo } from "./_registry"
import { exportedAsyncBodies } from "./crm-inbound"

export async function run() {
  const c = canary("Immediate enrichment: queued on the insert · capture never blocked by the rail · no duplicate queue row · Versium fails closed · one rail")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory only — lead_enrichment_queue holds 0 live rows and a live drain spends vendor credit")
  const B = uuid(), AG_U = uuid(), AG = uuid()
  const seed = () => ({
    brokerages: [{ id: B, name: `${CANARY_TAG} Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-enrich` }],
    users: [{ id: AG_U, email: `agent@${CANARY_EMAIL_DOMAIN}`, user_type: "agent", brokerage_id: B, platform_role: null, first_name: "Canary", last_name: "Agent" }],
    agents: [{ id: AG, user_id: AG_U, brokerage_id: B, first_name: "Canary", last_name: "Agent", is_active: true, created_at: nowIso() }],
  })
  const svc = canaryClient(seed())
  setSvc(svc)
  const { captureContact } = await import("../../lib/contact-pipeline/contact-capture")
  const queueFor = (client: typeof svc, contactId: string) => (client.tables.lead_enrichment_queue ?? []).filter((r) => JSON.stringify(r).includes(contactId))

  // ── 1 · the insert queues enrichment immediately ──
  const cap = await captureContact({ brokerageId: B, source: "web_form", ownerAgentId: AG, first_name: "Riley", last_name: "Canary", email: `riley@${CANARY_EMAIL_DOMAIN}`, phone: "5125550144", tcpa_consent: false } as never)
  const q1 = queueFor(svc, cap.contactId)
  c.step("QUEUED ON THE INSERT: a web-form capture creates the contact under the tenant AND lands exactly ONE lead_enrichment_queue row for it in the same request (brokerage pinned, pending) — no cron tick was needed to queue", cap.action === "created" && q1.length === 1 && q1[0].brokerage_id === B && /pending|queued/.test(String(q1[0].status ?? "pending")), `${q1.length} queue row(s); status ${String(q1[0]?.status)}`)
  const dup = await captureContact({ brokerageId: B, source: "qr_scan", ownerAgentId: AG, first_name: "Riley", last_name: "Canary", email: `riley@${CANARY_EMAIL_DOMAIN}`, tcpa_consent: false } as never)
  c.step("DEDUP BEFORE SPEND: the same person through a second door MERGES onto the same contact and queues NOTHING twice (already_queued) — one row per contact, never one per door", dup.action === "merged" && dup.contactId === cap.contactId && queueFor(svc, cap.contactId).length === 1, `${queueFor(svc, cap.contactId).length} queue row(s)`)

  // ── 2 · the rail is best-effort: a REFUSED queue never blocks the capture ──
  const refused = canaryClient(seed(), { refuse: { lead_enrichment_queue: "canary: lead_enrichment_queue refused (RLS-shaped)" } })
  setSvc(refused)
  const cap2 = await captureContact({ brokerageId: B, source: "web_form", ownerAgentId: AG, first_name: "Morgan", last_name: "Canary", email: `morgan@${CANARY_EMAIL_DOMAIN}`, phone: "5125550155", tcpa_consent: false } as never)
  c.step("NEVER BLOCKS THE FORM: with lead_enrichment_queue REFUSED (42501) the capture still succeeds — the contact lands, the caller gets its id, 0 queue rows (the refusal is the rail's to log, never the visitor's to see)", cap2.action === "created" && !!(refused.tables.contacts ?? []).find((x) => x.id === cap2.contactId) && (refused.tables.lead_enrichment_queue ?? []).length === 0, `contact ${cap2.action}; queue ${(refused.tables.lead_enrichment_queue ?? []).length}`)
  setSvc(svc)

  // ── 3 · the provider call: Versium fails CLOSED without a key; the cron is the drain at HEAD ──
  const { isVersiumConfigured } = await import("../../lib/external/versium-client")
  const key = process.env.VERSIUM_API_KEY
  delete process.env.VERSIUM_API_KEY
  const configured = isVersiumConfigured()
  if (key !== undefined) process.env.VERSIUM_API_KEY = key
  const versium = strippedRepo("lib/external/versium-client.ts") ?? ""
  const costCatalog = strippedRepo("lib/vendor-governance/cost-normalizer.ts") ?? ""
  const adapters = strippedRepo("lib/kernel/provider-adapters.ts") ?? ""
  c.step("VERSIUM FAILS CLOSED: with no VERSIUM_API_KEY the client reports not configured (no call, no invented fields); its products are routed as CAPABILITIES (person.enrich_contact / enrich_demographics / enrich_financial / property.enrich_facts) with a per-match credit price, and 'versium' is a vendor in the ONE cost catalog + adapter registry — never a second provider rail", configured === false && /person\.enrich_contact/.test(versium) && /VERSIUM_MATCH_CREDIT_USD/.test(versium) && /["']versium["']/.test(costCatalog) && /versium/i.test(adapters), "")
  const core = strippedRepo("lib/enrichment/contact-enrichment-core.ts") ?? ""
  const queueBody = exportedAsyncBodies(core).find((f) => f.name === "queueContactEnrichment")?.body ?? ""
  const dispatch = strippedRepo("lib/kernel/cron-dispatch.ts") ?? ""
  c.step("ONE RAIL: the queue writer refuses a duplicate (already_queued), a fresh enrichment (recently_enriched) and a live deal (live_deal) BEFORE any spend; the drain is the registered cron /api/cron/enrichment-processor (the backstop the ruling keeps)", /already_queued/.test(queueBody) && /recently_enriched/.test(queueBody) && /live_deal/.test(queueBody) && /enrichment-processor/.test(dispatch), "")
  const inlineDrain = /\b(processEnrichmentQueue|enrichContactRecord)\s*\(/.test(queueBody) || /\b(processEnrichmentQueue|enrichContactRecord|drainEnrichment\w*)\s*\(/.test(strippedRepo("lib/contact-pipeline/contact-capture.ts") ?? "")
  console.log(`    measured: inline drain at a capture door = ${inlineDrain ? "yes" : "NO — the queue row waits for the cron (the 142D contract)"}`)

  // ── WAVE142 HOOK (integrator): 142D — inline best-effort drain at every create door; Versium B2B2C / Online Presence. ──
  for (const h of hooksFor("immediate-enrichment")) {
    const at = h.probe()
    if (!at) { c.hook(h.lane, h.contract, /VERSIUM/.test(h.contract) ? "measured: versium-client.ts names no B2B2C / Online-Presence product (contact / demographic / financial / property append only)" : `measured above: the insert queues; the provider call waits for the 15-minute cron (inline drain = ${inlineDrain ? "present" : "absent"})`); continue }
    if (/VERSIUM/.test(h.contract)) {
      // WAVE142 HOOK (integrator): 142D — wired 142K: the two capabilities through the ONE rail, the provider a recorder.
      const rail = await import("../../lib/ai-isa/property-lookup-rail")
      const { versiumB2B2CQueryFor, VERSIUM_MATCH_CREDIT_USD, VERSIUM_B2B2C_OUTPUTS, VERSIUM_REACH_MCP } = await import("../../lib/external/versium-client")
      const calls: Array<{ output: string; query: Record<string, string> }> = []
      const meter: Array<Record<string, unknown>> = []
      // The legs' own dep types — the recorders are typed by the seams they fill, never cast.
      type LegDeps = NonNullable<Parameters<typeof rail.runVersiumBusinessIdentityLeg>[1]>
      type PresenceDeps = NonNullable<Parameters<typeof rail.runVersiumOnlinePresenceLeg>[1]>
      const base: Omit<LegDeps, "call"> = { meter: async (m) => { meter.push(m as unknown as Record<string, unknown>); return true }, checkBudget: async () => ({ allowed: true }), providerHealth: async () => ({ state: "healthy", routeAround: false, reason: "canary recorder — the vendor is not in a cool-down" }) }
      // 143D: the vendor's DOCUMENTED result row (api-documentation.versium.com/reference/b2b2c-output-sample, 2026-10-23) —
      // EmailAddrJSONB2C is an array of { EmailAddr }; the 142D fixture used a guessed "Consumer Email" key no real response carries.
      const b2b2cBody = { versium: { results: [{ EmailAddrJSONB2C: [{ EmailAddr: "Riley.Canary@example.test" }] }], match_counts: { consumer_email: 1, crosswalk: 1 } } }
      const b2b2cCall: NonNullable<LegDeps["call"]> = async (output, query) => { calls.push({ output, query }); return { ok: true, status: 200, data: b2b2cBody } }
      const identity = { firstName: "Riley", lastName: "Canary", city: "Pensacola", state: "fl" }
      const leg = await rail.runVersiumBusinessIdentityLeg({ brokerageId: B, identity, systemSource: "canary" }, { ...base, call: b2b2cCall })
      const noTenant = await rail.runVersiumBusinessIdentityLeg({ brokerageId: null, identity, systemSource: "canary" }, { ...base, call: b2b2cCall })
      const overBudget = await rail.runVersiumBusinessIdentityLeg({ brokerageId: B, identity, systemSource: "canary" }, { ...base, checkBudget: async () => ({ allowed: false }), call: b2b2cCall })
      const noIdentity = await rail.runVersiumBusinessIdentityLeg({ brokerageId: B, identity: { firstName: "Riley" }, systemSource: "canary" }, { ...base, call: b2b2cCall })
      const demoBody = { versium: { results: [{ "Online Presence Indicator - Real Estate": "Yes", "Home Own or Rent": "Home Owner", "Length of Residence": "15+ Years", "Mortgage Purchase Date": "20190614", "Ethnic Group": "canary-protected", "Age Range": "45-54" }], match_counts: { full_demographic: 1 } } }
      const presenceCall: NonNullable<PresenceDeps["call"]> = async (output, query) => { calls.push({ output, query }); return { ok: true, status: 200, data: demoBody } }
      // RE-ASSERTED (wave 145, lane 145Z): this step asserted the whole leg result never carried a protected value — the SHAPE of
      // the pre-ruling-12 adapter, which discarded them. Owner ruling 12 (wave 145) keeps them for research in ONE segregated field
      // bound for the firewalled store (lib/enrichment/protected-research-store.ts; the wave-145 canary holds the firewall). The RULE
      // is unchanged and is asserted here: nothing protected on `indicators` / `provenance` / any other key, every research field
      // vendor-modeled, and the two protected fixture values are found ONLY there (positive control: they are there).
      const presence = await rail.runVersiumOnlinePresenceLeg({ brokerageId: B, identity: { firstName: "Riley", lastName: "Canary", email: `riley@${CANARY_EMAIL_DOMAIN}`, address: "9 Outside Rd", city: "Pensacola", state: "FL", zip: "32501" }, systemSource: "canary" }, { ...base, call: presenceCall })
      const route = rail.routeCapability("business_identity", {}), routeP = rail.routeCapability("online_presence", {})
      const b2b2cMeter = meter.find((m) => m.usageType === "b2b2c_append")
      c.step(`${h.lane} landed (${at}) — VERSIUM through the EXISTING capability routing: business_identity and online_presence are capabilities on the ONE route table, each sold by versium at the one credit constant ($${VERSIUM_MATCH_CREDIT_USD}); the B2B2C crosswalk leg (first + last + city + state, or a LinkedIn URL; a name alone → no_identity, nothing asked) asks ONE documented output, parses the VERIFIED field map (EmailAddrJSONB2C[].EmailAddr, lower-cased — pinned 143D), books the vendor meter row (vendor versium, usage b2b2c_append, capability person.enrich_business_identity, credits = the output + the crosswalk) at $0.10 to the tenant; no tenant → no_brokerage (no call, no row); a refused budget → budget (no call); the online-presence leg reads the ALLOW-LISTED indicators only (online presence, own/rent, residence, mortgage date) and a protected-class field leaves the adapter ONLY in the segregated 'protectedResearch' field (wave 145 owner ruling 12 — stored for research, never an indicator, never provenance, each vendor-modeled); the REACH MCP is audited as a documented product, not a second rail`, leg.answered && leg.consumerEmails.join() === "riley.canary@example.test" && Math.abs(leg.cost - 0.1) < 1e-9 && calls.filter((x) => x.output === "consumer_email").length === 1 && calls[0]?.query.first === "Riley" && calls[0]?.query.state === "FL" && !!b2b2cMeter && b2b2cMeter.vendorName === "versium" && (b2b2cMeter.metadata as Record<string, unknown>)?.capability === "person.enrich_business_identity" && b2b2cMeter.brokerageId === B && Math.abs(Number(b2b2cMeter.cost) - 0.1) < 1e-9 && noTenant.skipped === "no_brokerage" && overBudget.skipped === "budget" && noIdentity.skipped === "no_identity" && calls.length === 2 && presence.answered && presence.indicators?.onlinePresenceRealEstate === true && presence.indicators?.homeOwnRent === "owner" && presence.indicators?.lengthOfResidence === "15+ Years" && presence.indicators?.mortgagePurchaseDate === "2019-06-14" && !JSON.stringify({ ...presence, protectedResearch: undefined }).includes("canary-protected") && !JSON.stringify({ ...presence, protectedResearch: undefined }).includes("45-54") && presence.protectedResearch.length === 2 && presence.protectedResearch.every((f) => f.basis === "vendor_modeled") && presence.protectedResearch.some((f) => f.value === "canary-protected" && f.protectedClass === "race_color_national_origin") && presence.protectedResearch.some((f) => f.value === "45-54" && f.protectedClass === "age") && meter.some((m) => m.usageType === "online_presence_append" && (m.metadata as Record<string, unknown>)?.capability === "person.enrich_online_presence" && Math.abs(Number(m.cost) - 3 * VERSIUM_MATCH_CREDIT_USD) < 1e-9) && route.providers.includes("versium") && routeP.providers.includes("versium") && versiumB2B2CQueryFor({ linkedinUrl: "https://www.linkedin.com/in/riley-canary" })?.li_url === "https://www.linkedin.com/in/riley-canary" && versiumB2B2CQueryFor({ firstName: "Riley" }) === null && VERSIUM_B2B2C_OUTPUTS.length === 4 && typeof VERSIUM_REACH_MCP === "object", `calls ${calls.map((x) => x.output).join(",")}; meter ${meter.map((m) => `${m.usageType}@$${m.cost}`).join(",")}; presence ${presence.skipped ?? "answered"}`)
      continue
    }
    // WAVE142 HOOK (integrator): 142D — wired 142K: the dispatch, not a second drainer — the row just written, fire-and-forget.
    const { queueContactEnrichment } = await import("../../lib/enrichment/contact-enrichment-core")
    const { dispatchInlineEnrichmentDrain } = await import("../../lib/enrichment/inline-drain")
    const JULES = uuid()
    ;(svc.tables.contacts ??= []).push({ id: JULES, brokerage_id: B, agent_id: AG, first_name: "Jules", last_name: "Canary", email: `jules@${CANARY_EMAIL_DOMAIN}`, phone: "5125550166", status: "new", contact_type: "lead", enriched_at: null, last_enriched_at: null, created_at: nowIso(), updated_at: nowIso() })
    const drained: Array<{ brokerageId: string; queueEntryId: string }> = []
    let drainStarted = false, drainDone = false
    const drain = async (target: { brokerageId: string; queueEntryId: string }) => { drainStarted = true; await new Promise((r) => setTimeout(r, 25)); drained.push(target); drainDone = true; return { processed: 1 } }
    const q = await queueContactEnrichment({ contactId: JULES, brokerageId: B, triggerType: "contact_captured", supabase: svc as never, inlineDrain: drain })
    const returnedFirst = drainStarted && !drainDone
    const queued = queueFor(svc, JULES)[0]
    await new Promise((r) => setTimeout(r, 80))
    const optOut = dispatchInlineEnrichmentDrain({ brokerageId: B, queueEntryId: "x" }, false)
    const prevEnv = process.env.ENRICHMENT_INLINE_DRAIN, prevRt = process.env.NEXT_RUNTIME
    delete process.env.NEXT_RUNTIME; delete process.env.ENRICHMENT_INLINE_DRAIN
    const outside = dispatchInlineEnrichmentDrain({ brokerageId: B, queueEntryId: "x" })
    process.env.ENRICHMENT_INLINE_DRAIN = "off"
    const off = dispatchInlineEnrichmentDrain({ brokerageId: B, queueEntryId: "x" })
    if (prevEnv === undefined) delete process.env.ENRICHMENT_INLINE_DRAIN; else process.env.ENRICHMENT_INLINE_DRAIN = prevEnv
    if (prevRt !== undefined) process.env.NEXT_RUNTIME = prevRt
    const leadCore = strippedRepo("lib/enrichment/lead-enrichment-core.ts") ?? "", drainSrc = strippedRepo("lib/enrichment/inline-drain.ts") ?? ""
    c.step(`${h.lane} landed (${at}) — IMMEDIATE ENRICHMENT, the DISPATCH not a second drainer: the queue writer hands the row it JUST wrote (its id) to the inline drain fire-and-forget — the capture's result returned while the drain was still running (reason injected), the drain then processed exactly that queue row on this tenant; the caller may opt out (caller_opted_out); outside the app runtime the default drain never runs (not_app_runtime — a script, a proof or a canary never reaches a provider by accident); ENRICHMENT_INLINE_DRAIN=off is the kill switch; BOTH queue writers (contact + lead tracks) dispatch after their write and the one drain is processEnrichmentQueue({ queueEntryId }) — the 15-minute cron stays the backstop`, q.queued && q.drain?.dispatched === true && q.drain?.reason === "injected" && returnedFirst && drainDone && drained.length === 1 && !!queued && drained[0].queueEntryId === queued.id && drained[0].brokerageId === B && !optOut.dispatched && optOut.reason === "caller_opted_out" && !outside.dispatched && outside.reason === "not_app_runtime" && !off.dispatched && off.reason === "env_off" && /dispatchInlineEnrichmentDrain\(/.test(core) && /dispatchInlineEnrichmentDrain\(/.test(leadCore) && /processEnrichmentQueue\([^)]*queueEntryId/.test(drainSrc), `queued ${q.queued} (${q.reason ?? "ok"}); drain ${JSON.stringify(q.drain)}; drained ${drained.length}`)
  }
  c.blind("No provider is called: Versium is asserted as fail-closed on configuration; the drain (processEnrichmentQueue) is not driven here (test:enrichment-one-rail / enrichment-retry hold it). RLS is not modelled — the refused client is the harness's refusal shape, which is what a tenant-mismatched insert would look like through supabase-js.")
  const a = await cleanupCanary(svc, B), b = await cleanupCanary(refused, B)
  c.step("cleanup: every tagged row deleted with .select() counts on both clients; residual 0", a.mismatches.length + b.mismatches.length === 0 && a.residual + b.residual === 0, [...a.cleanup, ...b.cleanup].map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report([...a.cleanup, ...b.cleanup], a.residual + b.residual)
}
