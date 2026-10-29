// lib/enrichment/first-party-intent-watcher.ts
//
// THE FIRST-PARTY INTENT WATCHER (wave 146, lane 146D; owner ruling 11, 2026-10-29: "Enrichment should be customer360 which drives
// the outreach … a changed eligible attribute / first-party action → change detected → canonical record matched → gap / freshness /
// provenance check → record updated → intent context reassessed → arbiter / manager → action or no action → evidence").
//
// The PROVIDER half of the watcher is wave 145F's (lib/enrichment/intent-signal-sources.ts watchEnrichmentFactChanges). This is the
// FIRST-PARTY half, for the two first-party families that had a vocabulary and no writer (audited, wave 146):
//   · search / view engagement — saved_properties, property_views, website_visitors → `search_portal_activity`
//   · portal activity          — client_portal_activity, portal_access_logs          → `portal_activity_resumed`
// Both spellings are ALREADY in the ONE responder's vocabulary (lib/ai-isa/followup-arbiter.ts LIFE_CHANGE_SIGNAL_KINDS) and had no
// writer anywhere (a vocabulary with no writer — §1). No new spelling is minted (§6).
//
// What is NOT re-built here (survivors, audited): form conversions (the capture door's welcome — lib/kernel/event-reactor.ts
// FORM_SUBMISSION_RECEIVED — and the promised-deliverable ledger, contract C4, lane 146F); tours (the showing workflow and
// `buyer_stall_predicted`, shopping_agent); communications (inbound → contract C1 + lib/ai-isa/inbound-intent-classifier.ts, our
// own email opens / clicks → `contact_email_reengage`); a home-value request (`home_value_seller_intent`); a lifetime client's "Your
// Next Move" tap (`next_move_intent`). Routing any of those again from here would be a second door onto one interaction.
//
// THE CHANGE IS A START OR A RESUMPTION, NEVER EVERY CLICK. A family is routed for a party only when the party had NO activity in
// that family within its DORMANCY window before the cursor — the tenant's own `followup_policy.reengagement.staleDays`
// (`lifetimeStaleDays` for a lifetime client); no window is invented here. A portal family additionally needs activity OLDER than
// the window (the first portal visit belongs to the welcome journey, lane 146C). Each routed change is ONE durable, consumed-once
// ledger event (`customer360.first_party_action.observed`, Data Steward; idempotent per party / signal / UTC day) that reads the
// party's Customer 360 (contract C6 — consent + intent context, append ≠ intent) and hands the change to the ONE life-change
// responder, which routes by subject class (lead → the ISA's lead loops, email / mail only; contact → the governed NBA → arbiter;
// lifetime → the Sphere). The arbiter decides — "wait" is an answer.
//
// HONEST FRESHNESS: the rows are written in REAL TIME at the person's action; this sweep reads them on the 15-minute
// enrichment-processor tick (app/api/cron/enrichment-processor) with a 6-hour overlapping cursor — so a change reaches the arbiter
// within one tick, not "instantly". No provider is called; nothing is bought.

import { customer360For, CUSTOMER_360_SOURCES } from "@/lib/enrichment/customer-360"
import { canonicalPartyFor } from "@/lib/contact-promotion/lead-domain-boundary"
import { isLifetimeRelationshipType } from "@/lib/contact-types"

type Svc = { from: (t: string) => any }
type Family = "search" | "portal"
type Party = { type: "contact" | "lead"; id: string }

const DAY_MS = 86_400_000

/** The family → the responder's existing spelling (LIFE_CHANGE_SIGNAL_KINDS) and the ledger WHY (m693 vocabulary). */
const FAMILY_SIGNAL: Readonly<Record<Family, { signalType: string; reasonCode: "BUYER_PROPERTY_MATCH" | "NURTURE_TOUCH" }>> = Object.freeze({
  search: { signalType: "search_portal_activity", reasonCode: "BUYER_PROPERTY_MATCH" },
  portal: { signalType: "portal_activity_resumed", reasonCode: "NURTURE_TOUCH" },
})

/** Where each family's rows live: table · party key · the time column the cursor reads (scripts/schema-snapshot.ts columns). */
const FAMILY_TABLES: Readonly<Record<Family, ReadonlyArray<{ table: string; ts: string; keys: ReadonlyArray<"contact_id" | "lead_id">; extra?: string }>>> = Object.freeze({
  search: [
    { table: "saved_properties", ts: "saved_at", keys: ["contact_id"], extra: "dismissed" },
    { table: "property_views", ts: "last_viewed_at", keys: ["contact_id"] },
    { table: "website_visitors", ts: "last_seen_at", keys: ["contact_id", "lead_id"] },
  ],
  portal: [
    { table: "client_portal_activity", ts: "created_at", keys: ["contact_id"] },
    { table: "portal_access_logs", ts: "accessed_at", keys: ["contact_id"] },
  ],
})

export interface FirstPartyWatchResult {
  /** Rows read since the cursor, per family. */
  scanned: Record<Family, number>
  /** (party, family) pairs with activity since the cursor. */
  candidates: number
  /** Engaged inside the dormancy window before the cursor — continuing, not a start / resumption (not routed). */
  continuing: number
  /** A first-ever portal visit — the welcome journey's, not routed. */
  firstPortalVisit: number
  /** Leads out of every domain (inactive, no contact) or rows outside this tenant. */
  outOfDomain: number
  routed: number
  replayed: number
  refused: number
  /** Changes left for the next tick by the per-tick cap (never dropped: the cursor overlaps). */
  capped: number
  errors: string[]
}

export interface FirstPartyWatchDeps {
  respond?: typeof import("@/lib/ai-isa/followup-arbiter").respondToLifeChangeSignal
  ledger?: typeof import("@/lib/kernel/action-ledger").withActionLedger
  /** The tenant's dormancy windows (default: loadFollowupPolicy's reengagement.staleDays / lifetimeStaleDays). */
  dormancy?: { staleDays: number; lifetimeStaleDays: number }
}

const newer = (a: string | null, b: string | null): string | null => (!a ? b : !b ? a : a > b ? a : b)

/**
 * THE SWEEP. Tenant-pinned (the brokerage is the cron's scanned row, never a payload); never throws; never calls a provider; every
 * refused read is counted and named.
 */
export async function watchFirstPartyIntent(
  svc: Svc,
  brokerageId: string,
  opts: { now?: Date; windowMinutes?: number; limit?: number; maxRoutes?: number } = {},
  deps: FirstPartyWatchDeps = {},
): Promise<FirstPartyWatchResult> {
  const out: FirstPartyWatchResult = { scanned: { search: 0, portal: 0 }, candidates: 0, continuing: 0, firstPortalVisit: 0, outOfDomain: 0, routed: 0, replayed: 0, refused: 0, capped: 0, errors: [] }
  if (!brokerageId) return { ...out, errors: ["no brokerage"] }
  const now = opts.now ?? new Date()
  const since = new Date(now.getTime() - (opts.windowMinutes ?? 360) * 60_000).toISOString()
  const limit = opts.limit ?? 500
  const maxRoutes = opts.maxRoutes ?? 25
  try {
    // ── 1. what happened since the cursor, per family ──
    type Hit = { family: Family; key: "contact_id" | "lead_id"; id: string; at: string; table: string }
    const hits: Hit[] = []
    for (const family of ["search", "portal"] as const) {
      for (const src of FAMILY_TABLES[family]) {
        const cols = [src.ts, ...src.keys, ...(src.extra ? [src.extra] : [])].join(", ")
        const { data, error } = await svc.from(src.table).select(cols).eq("brokerage_id", brokerageId).gte(src.ts, since).limit(limit)
        if (error) { out.errors.push(`${src.table} read refused: ${error.message}`); continue }
        for (const r of (data ?? []) as Array<Record<string, any>>) {
          if (src.extra === "dismissed" && r.dismissed === true) continue
          const key = src.keys.find((k) => typeof r[k] === "string" && r[k]) // contact first: a visitor tied to a contact is the contact
          if (!key || typeof r[src.ts] !== "string") continue
          out.scanned[family]++
          hits.push({ family, key, id: String(r[key]), at: r[src.ts], table: src.table })
        }
      }
    }
    if (hits.length === 0) return out

    // ── 2. the canonical party (C2) and the subject class — tenant-pinned reads ──
    const contactIds = [...new Set(hits.filter((h) => h.key === "contact_id").map((h) => h.id))]
    const leadIds = [...new Set(hits.filter((h) => h.key === "lead_id").map((h) => h.id))]
    const leadParty = new Map<string, Party | null>()
    if (leadIds.length > 0) {
      const { data, error } = await svc.from("leads").select("id, contact_id, is_active").eq("brokerage_id", brokerageId).in("id", leadIds)
      if (error) out.errors.push(`leads read refused: ${error.message}`)
      for (const l of (error ? [] : (data ?? [])) as Array<Record<string, any>>) {
        const p = canonicalPartyFor({ id: String(l.id), contact_id: l.contact_id ?? null })
        if (p.type === "contact") { leadParty.set(String(l.id), { type: "contact", id: p.id }); contactIds.push(p.id) }
        else if (p.type === "lead" && l.is_active !== false) leadParty.set(String(l.id), { type: "lead", id: p.id })
        else leadParty.set(String(l.id), null)
      }
    }
    const contactType = new Map<string, string | null>()
    const uniqContacts = [...new Set(contactIds)]
    if (uniqContacts.length > 0) {
      const { data, error } = await svc.from("contacts").select("id, contact_type, deleted_at").eq("brokerage_id", brokerageId).in("id", uniqContacts)
      if (error) out.errors.push(`contacts read refused: ${error.message}`)
      for (const c of (error ? [] : (data ?? [])) as Array<Record<string, any>>) if (!c.deleted_at) contactType.set(String(c.id), c.contact_type ?? null)
    }
    const partyOf = (h: Hit): Party | null => {
      if (h.key === "contact_id") return contactType.has(h.id) ? { type: "contact", id: h.id } : null
      const p = leadParty.get(h.id) ?? null
      if (p?.type === "contact" && !contactType.has(p.id)) return null
      return p
    }
    type Cand = { family: Family; party: Party; latestAt: string; tables: Set<string>; lifetime: boolean }
    const cands = new Map<string, Cand>()
    for (const h of hits) {
      const party = partyOf(h)
      if (!party) { out.outOfDomain++; continue }
      const k = `${h.family}:${party.type}:${party.id}`
      const c = cands.get(k) ?? { family: h.family, party, latestAt: h.at, tables: new Set<string>(), lifetime: party.type === "contact" && isLifetimeRelationshipType(contactType.get(party.id) ?? null) }
      c.latestAt = newer(c.latestAt, h.at) ?? c.latestAt
      c.tables.add(h.table)
      cands.set(k, c)
    }
    out.candidates = cands.size
    if (cands.size === 0) return out

    // ── 3. a START or a RESUMPTION only — the tenant's dormancy window, read once ──
    const dormancy = deps.dormancy ?? await (async () => {
      const { loadFollowupPolicy } = await import("@/lib/ai-isa/followup-policy")
      const p = (await loadFollowupPolicy(svc as never, brokerageId)).policy.reengagement
      return { staleDays: p.staleDays, lifetimeStaleDays: p.lifetimeStaleDays }
    })()
    const daysFor = (c: Cand) => (c.lifetime ? dormancy.lifetimeStaleDays : dormancy.staleDays)
    // `lo` = the widest window's start: one bounded read per source table finds the newest prior row inside [lo, cursor); only the
    // parties with none there get the second, existence-only read below it (was there ANY older activity — a resumption — or none —
    // a start / a first portal visit).
    const lo = new Date(Date.parse(since) - Math.max(dormancy.staleDays, dormancy.lifetimeStaleDays) * DAY_MS).toISOString()
    const partyKey = (family: Family, key: "contact_id" | "lead_id", id: string) => `${family}:${key === "contact_id" ? "contact" : "lead"}:${id}`
    const prior = new Map<string, string>()
    const everOlder = new Set<string>()
    const held = new Set<string>()
    const priorRead = async (family: Family, src: (typeof FAMILY_TABLES)[Family][number], key: "contact_id" | "lead_id", ids: string[], band: "window" | "older") => {
      if (ids.length === 0) return
      let q = svc.from(src.table).select(`${src.ts}, ${key}`).eq("brokerage_id", brokerageId).in(key, ids)
      q = band === "window" ? q.gte(src.ts, lo).lt(src.ts, since) : q.lt(src.ts, lo)
      const { data, error } = await q.order(src.ts, { ascending: false }).limit(limit)
      if (error) { out.errors.push(`${src.table} prior read refused: ${error.message} — its candidates are held this tick`); for (const id of ids) held.add(partyKey(family, key, id)); return }
      for (const r of (data ?? []) as Array<Record<string, any>>) {
        const at = typeof r[src.ts] === "string" ? r[src.ts] : null
        if (!at) continue
        const k = partyKey(family, key, String(r[key]))
        if (band === "older") everOlder.add(k)
        else prior.set(k, newer(prior.get(k) ?? null, at) ?? at)
      }
    }
    for (const band of ["window", "older"] as const) {
      for (const family of ["search", "portal"] as const) {
        const fam = [...cands.values()].filter((c) => c.family === family && (band === "window" || !prior.has(`${family}:${c.party.type}:${c.party.id}`)))
        for (const src of FAMILY_TABLES[family]) {
          for (const key of src.keys) {
            await priorRead(family, src, key, fam.filter((c) => (key === "contact_id" ? c.party.type === "contact" : c.party.type === "lead")).map((c) => c.party.id), band)
          }
        }
      }
    }

    // ── 4. route each start / resumption: ONE durable event → the party's Customer 360 → the ONE responder ──
    const ledger = deps.ledger ?? (await import("@/lib/kernel/action-ledger")).withActionLedger
    const respond = deps.respond ?? (await import("@/lib/ai-isa/followup-arbiter")).respondToLifeChangeSignal
    let routedThisTick = 0
    for (const [k, c] of cands) {
      if (held.has(k)) { out.refused++; continue } // fail closed: an unread history is not "dormant"
      const p = prior.get(k) ?? null
      const windowStart = new Date(Date.parse(since) - daysFor(c) * DAY_MS).toISOString()
      if (p && p >= windowStart) { out.continuing++; continue }
      const older = (!!p && p < windowStart) || everOlder.has(k)
      if (c.family === "portal" && !older) { out.firstPortalVisit++; continue }
      if (routedThisTick >= maxRoutes) { out.capped++; continue }
      routedThisTick++
      const change: "resumed" | "started" = older ? "resumed" : "started"
      const sig = FAMILY_SIGNAL[c.family]
      const day = c.latestAt.slice(0, 10)
      // THE INTENT CONTEXT, reassessed on the canonical record (C6) — consent + intent only; a refused read refuses the route.
      const view = await customer360For(svc, brokerageId, c.party, { now, slices: ["consent", "intent"] })
      if (!view.ok) { out.refused++; out.errors.push(`${c.party.type} ${c.party.id}: customer 360 refused (${view.reason})`); continue }
      const v = view.view
      const context = {
        subject_class: v.subjectClass, allowed_channels: v.consent?.allowedChannels ?? [], confirmed: v.intent?.confirmed ?? [],
        observed_not_confirmed: v.intent?.observedNotConfirmed ?? [], gaps: v.gaps.length, stale: v.stale.length, unread: v.unread,
      }
      // Set inside the ledger's callbacks (run / replay) — typed wide so the closure assignments are not narrowed away.
      let result = "replayed" as "routed" | "replayed" | "refused"
      try {
        await ledger<"routed" | "replayed" | "refused">(
          {
            brokerageId, action: "customer360.first_party_action.observed", actor: { type: "manager", managerKey: "data_steward" },
            subject: { type: v.party.type, id: v.party.id }, idempotencyKey: `first_party:${brokerageId}:${v.party.type}:${v.party.id}:${sig.signalType}:${day}`,
            reasonCode: sig.reasonCode, reasonDetail: `${c.family} engagement ${change} after ≥ ${daysFor(c)} quiet days (${[...c.tables].join(", ")}) → ${sig.signalType}`.slice(0, 500),
            systemSource: "first_party_intent_watcher",
            detail: { family: c.family, change, signal_type: sig.signalType, latest_at: c.latestAt, tables: [...c.tables], dormancy_days: daysFor(c), freshness: { mode: "realtime_write", cadence: CUSTOMER_360_SOURCES[c.family].cadence }, customer_360: context, door: "first_party_sweep" },
          },
          async () => {
            const r = await respond(svc as never, {
              brokerageId, subject: { type: v.party.type, id: v.party.id }, signalType: sig.signalType, source: `first_party:${c.family}`, now,
              detail: { change, tables: [...c.tables], latest_at: c.latestAt, customer_360: context },
            })
            if (r.action === "refused") out.errors.push(`${v.party.type} ${v.party.id}: responder refused (${r.reason})`)
            return (result = r.action === "refused" ? "refused" : "routed")
          },
          {
            settle: (r) => ({ status: r === "routed" ? "executed" : r === "refused" ? "failed" : "skipped", outcome: r, error: r === "refused" ? "the responder refused (see the sweep's errors)" : null }),
            replay: () => (result = "replayed"),
          },
          { client: svc as never },
        )
      } catch (e) {
        result = "refused"
        out.errors.push(`${v.party.type} ${v.party.id}: route threw (${e instanceof Error ? e.message : String(e)})`)
      }
      if (result === "routed") out.routed++
      else if (result === "replayed") out.replayed++
      else out.refused++
    }
  } catch (e) {
    out.errors.push(`sweep threw: ${e instanceof Error ? e.message : String(e)}`)
  }
  return out
}
