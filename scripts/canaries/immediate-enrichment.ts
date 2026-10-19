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
    c.step(`${h.lane} landed (${at}) — wire its export into this canary (WAVE142 HOOK (integrator): ${h.lane}): ${/VERSIUM/.test(h.contract) ? "call the B2B2C / Online-Presence capability through routeCapability with the provider stubbed and assert the verified-field map + the vendor meter row" : "capture with the provider stubbed and assert the SAME request drained the row (status processed, provenance stamped, no overwrite of a filled field) while the form result returned first"}`, false, h.contract.slice(0, 120))
  }
  c.blind("No provider is called: Versium is asserted as fail-closed on configuration; the drain (processEnrichmentQueue) is not driven here (test:enrichment-one-rail / enrichment-retry hold it). RLS is not modelled — the refused client is the harness's refusal shape, which is what a tenant-mismatched insert would look like through supabase-js.")
  const a = await cleanupCanary(svc, B), b = await cleanupCanary(refused, B)
  c.step("cleanup: every tagged row deleted with .select() counts on both clients; residual 0", a.mismatches.length + b.mismatches.length === 0 && a.residual + b.residual === 0, [...a.cleanup, ...b.cleanup].map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report([...a.cleanup, ...b.cleanup], a.residual + b.residual)
}
