// lib/intent/movement-source-watcher.ts
//
// THE POLL-AND-DIFF WATCHER for movement sources that have NO PUSH (wave 147, lane 147B — owner ruling 3: "SIGNALLED to the
// manager/arbiter when an outside provider or scrape changes — including providers that have no push signal (poll-and-diff is the
// fallback, with its freshness published)"; requirement 3 of the brief).
//
// WHY IT EXISTS (audited 2026-10-31). The sweeps that poll the no-push sources STORE what they find and tell nobody:
//   · lib/external/permit-signals.ts (Socrata / ArcGIS, daily) and lib/external/batchdata-seller-signals.ts (quickLists) write
//     motivated_seller_signals — no manager is signalled when a known owner pulls a permit or lands on a pre-foreclosure list;
//   · app/actions/calculators.ts saveCalculatorResult writes calculator_history (seller net, moving cost, neighbourhood compare …)
//     and its only reader is the portal's own history panel — a seller working out their net proceeds triggered nothing;
//   · the acquisition lanes (lib/kernel/scraping.ts) write raw_scraped_leads for 'looking for an agent' / relocation posts — the
//     pipeline promotes them, but nothing reads the POST as a movement signal about a person we may already know.
// This watcher does not re-poll the vendors (no new spend, no new egress). It polls what their sweeps stored, DIFFS each item
// against its own last-seen digest (m894 movement_source_items), and raises ONE C9 movement signal per material TRANSITION
// (lib/intent/movement-signals.ts recordMovementSignal → the manager's decision → the bus / the ONE responder). The ledger key is
// the change (`<item>:<digest>:<observed_at>`), so a retry, a second run, an overlapping cursor or a LOST item state never raises
// twice, while a return to an earlier value (a new observation) is raised again.
//
// HONEST FRESHNESS (m893 movement_source_polls): per source it records when it last polled, when it last SUCCEEDED, and the
// freshness it can promise = its own cadence + the upstream sweep's lag; a source whose upstream lag is not published promises
// nothing (null) rather than a number it cannot keep. A failed poll keeps the last success, so staleness shows.
//
// BASELINE: the first successful poll of a source records every item's digest and raises only items whose own observation sits
// inside the source's half-life (a decade of history is not "new"). An UNREAD state (a refused read) is never treated as a baseline
// — the source is skipped that tick (fail closed: "nobody checked" never renders as "nothing changed").
//
// Cron is the tick here because these sources have no event (ruling 13: cron is recovery / reconciliation — and the ONLY door for a
// source that cannot push). One-line wiring on the 15-minute enrichment-processor tick is under the lane notes' Outside-lane.

import {
  classifyPublicMovementText, movementDigest, movementSignalFromCalculatorRow, movementSignalFromFirstPartyChange, movementSignalFromIntentFact,
  movementSignalFromLifeEvent, movementSignalFromPublicPost, movementSignalFromSellerSignalRow, movementSource, recordMovementSignal, reconcileMovementOutcomes, CALCULATOR_MOVEMENT_SOURCE,
  type MovementBuild, type MovementClassify, type MovementDeps, type MovementRecordResult, type MovementSignalRecord, type MovementSubject,
} from "@/lib/intent/movement-signals"

type Svc = { from: (t: string) => any }
const MIN_MS = 60_000
const DAY_MS = 86_400_000

export interface PolledItem {
  itemKey: string
  /** The fields whose change is MATERIAL (anything else may change without raising). */
  material: Record<string, unknown>
  observedAt: string | null
  /** The item as a C9 record (built lazily: an unchanged item is never classified or built). */
  toSignal: () => Promise<MovementBuild> | MovementBuild
}

export type PollFetch = (ctx: { svc: Svc; brokerageId: string; now: Date; lastSuccessAt: string | null }) =>
  Promise<{ ok: true; items: PolledItem[] } | { ok: false; error: string }>

export interface MovementPollSource {
  /** The watcher-state key (m893 / m894 source_key). */
  key: string
  /** The movement registry rows this poll serves (freshness + licence come from them). */
  registryKeys: readonly string[]
  cadenceMinutes: number
  fetch: PollFetch
  /** false = the source's facts were already answered by their own door: record the C9 row, do not decide / route again. */
  route?: false
}

export interface PollState { cadence_minutes: number | null; last_polled_at: string | null; last_success_at: string | null; last_error: string | null; promised_freshness_minutes: number | null }

export interface WatchStore {
  loadPoll(brokerageId: string, sourceKey: string): Promise<{ ok: true; row: PollState | null } | { ok: false; error: string }>
  savePoll(brokerageId: string, sourceKey: string, patch: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>
  loadItems(brokerageId: string, sourceKey: string, itemKeys: string[]): Promise<{ ok: true; digests: Map<string, string> } | { ok: false; error: string }>
  saveItem(brokerageId: string, sourceKey: string, item: { item_key: string; digest: string; last_seen_at: string; last_changed_at?: string; last_signal_id?: string | null; first_seen_at?: string }): Promise<{ ok: boolean; error?: string }>
}

/** The m893 / m894 store over a supabase-shaped client (every error read; an upsert keyed on the unique constraint). */
function supabaseWatchStore(svc: Svc): WatchStore {
  return {
    async loadPoll(b, k) {
      const { data, error } = await svc.from("movement_source_polls").select("cadence_minutes, last_polled_at, last_success_at, last_error, promised_freshness_minutes").eq("brokerage_id", b).eq("source_key", k).maybeSingle()
      return error ? { ok: false, error: error.message } : { ok: true, row: (data ?? null) as PollState | null }
    },
    async savePoll(b, k, patch) {
      const { error } = await svc.from("movement_source_polls").upsert({ brokerage_id: b, source_key: k, ...patch, updated_at: new Date().toISOString() }, { onConflict: "brokerage_id,source_key" })
      return error ? { ok: false, error: error.message } : { ok: true }
    },
    async loadItems(b, k, keys) {
      const digests = new Map<string, string>()
      for (let i = 0; i < keys.length; i += 200) {
        const { data, error } = await svc.from("movement_source_items").select("item_key, digest").eq("brokerage_id", b).eq("source_key", k).in("item_key", keys.slice(i, i + 200))
        if (error) return { ok: false, error: error.message }
        for (const r of (data ?? []) as Array<{ item_key: string; digest: string }>) digests.set(r.item_key, r.digest)
      }
      return { ok: true, digests }
    },
    async saveItem(b, k, item) {
      const { error } = await svc.from("movement_source_items").upsert({ brokerage_id: b, source_key: k, ...item }, { onConflict: "brokerage_id,source_key,item_key" })
      return error ? { ok: false, error: error.message } : { ok: true }
    },
  }
}

/** PURE. A stable digest of an item's material fields (key order never matters). */
function materialDigest(material: Record<string, unknown>): string {
  const stable = (v: unknown): unknown => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])])) : Array.isArray(v) ? v.map(stable) : v ?? null)
  return movementDigest(JSON.stringify(stable(material)))
}

/** PURE. What a poll source can promise: its cadence + the slowest upstream lag among its registry rows (null when any is unpublished). */
function pollFreshnessPromise(src: Pick<MovementPollSource, "registryKeys" | "cadenceMinutes">): number | null {
  let lag = 0
  for (const k of src.registryKeys) {
    const r = movementSource(k)
    if (!r || r.providerLatencyMinutes === null) return null
    lag = Math.max(lag, r.providerLatencyMinutes)
  }
  return src.cadenceMinutes + lag
}

export interface SourceWatchResult {
  key: string
  status: "polled" | "not_due" | "fetch_failed" | "state_unread" | "not_live"
  items: number
  raised: number
  replayed: number
  unchanged: number
  baselineSilent: number
  refused: number
  errors: string[]
  freshness: { lastSuccessAt: string | null; promisedFreshnessMinutes: number | null; stale: boolean; note: string }
}

export interface MovementWatchDeps {
  store?: WatchStore
  record?: (svc: Svc, r: MovementSignalRecord, deps: MovementDeps & { route?: boolean }) => Promise<MovementRecordResult>
  movement?: MovementDeps
}

/**
 * THE WATCHER. Tenant-pinned (the brokerage is the cron's scanned row); never throws; never calls a vendor; every refused read is
 * counted and named. `force` ignores the cadence (a proof / an operator's manual run).
 */
async function watchMovementSources(
  svc: Svc,
  brokerageId: string,
  opts: { now?: Date; sources?: readonly MovementPollSource[]; force?: boolean } = {},
  deps: MovementWatchDeps = {},
): Promise<{ sources: SourceWatchResult[]; raised: number; errors: string[] }> {
  const now = opts.now ?? new Date()
  const store = deps.store ?? supabaseWatchStore(svc)
  const record = deps.record ?? ((s: Svc, r: MovementSignalRecord, d: MovementDeps & { route?: boolean }) => recordMovementSignal(s, r, d))
  const sources = opts.sources ?? movementPollSources()
  const out = { sources: [] as SourceWatchResult[], raised: 0, errors: [] as string[] }
  if (!brokerageId) return { ...out, errors: ["no brokerage"] }
  for (const ps of sources) {
    const promised = pollFreshnessPromise(ps)
    const res: SourceWatchResult = { key: ps.key, status: "polled", items: 0, raised: 0, replayed: 0, unchanged: 0, baselineSilent: 0, refused: 0, errors: [], freshness: { lastSuccessAt: null, promisedFreshnessMinutes: promised, stale: true, note: "" } }
    out.sources.push(res)
    try {
      const live = ps.registryKeys.map((k) => movementSource(k)).filter((r) => r && r.status === "live")
      if (live.length === 0) { res.status = "not_live"; res.freshness.note = "no live registry row — configuration-only / waiting-external sources are never polled"; continue }
      const st = await store.loadPoll(brokerageId, ps.key)
      if (!st.ok) { res.status = "state_unread"; res.errors.push(`poll state read refused: ${st.error} — skipped (an unread state is never a baseline)`); continue }
      const lastSuccess = st.row?.last_success_at ?? null
      const freshnessOf = (success: string | null) => ({
        lastSuccessAt: success, promisedFreshnessMinutes: promised,
        stale: !success || (promised !== null && now.getTime() - Date.parse(success) > (promised + ps.cadenceMinutes) * MIN_MS),
        note: promised === null ? "upstream lag not published — no freshness is promised" : `fresh within ${promised} min of the upstream event (cadence ${ps.cadenceMinutes} min + upstream lag)`,
      })
      res.freshness = freshnessOf(lastSuccess)
      const lastPolled = st.row?.last_polled_at ? Date.parse(st.row.last_polled_at) : NaN
      if (!opts.force && Number.isFinite(lastPolled) && now.getTime() - lastPolled < ps.cadenceMinutes * MIN_MS) { res.status = "not_due"; continue }
      const fetched = await ps.fetch({ svc, brokerageId, now, lastSuccessAt: lastSuccess })
      if (!fetched.ok) {
        res.status = "fetch_failed"; res.errors.push(fetched.error)
        await store.savePoll(brokerageId, ps.key, { cadence_minutes: ps.cadenceMinutes, last_polled_at: now.toISOString(), last_error: fetched.error.slice(0, 500), promised_freshness_minutes: promised })
        continue
      }
      const byKey = new Map<string, PolledItem>()
      for (const it of fetched.items) if (it.itemKey) byKey.set(it.itemKey, it)
      res.items = byKey.size
      const prev = await store.loadItems(brokerageId, ps.key, [...byKey.keys()])
      if (!prev.ok) { res.status = "state_unread"; res.errors.push(`item state read refused: ${prev.error} — skipped`); continue }
      const baseline = !lastSuccess
      const halfLife = Math.max(...live.map((r) => r!.halfLifeDays))
      let blocked = false
      for (const [itemKey, it] of byKey) {
        const digest = materialDigest(it.material)
        const before = prev.digests.get(itemKey) ?? null
        const at = now.toISOString()
        if (before === digest) { res.unchanged++; await store.saveItem(brokerageId, ps.key, { item_key: itemKey, digest, last_seen_at: at }); continue }
        const observed = it.observedAt ? Date.parse(it.observedAt) : NaN
        if (baseline && before === null && !(Number.isFinite(observed) && now.getTime() - observed <= halfLife * DAY_MS)) {
          res.baselineSilent++
          await store.saveItem(brokerageId, ps.key, { item_key: itemKey, digest, first_seen_at: at, last_seen_at: at })
          continue
        }
        const built = await it.toSignal()
        if (!built.ok) {
          // A record the rules refuse (privacy / licence / not a movement item) is SEEN — remembered, so it is not re-judged every tick.
          res.refused++; res.errors.push(`${itemKey}: ${built.code} — ${built.reason}`.slice(0, 300))
          await store.saveItem(brokerageId, ps.key, { item_key: itemKey, digest, last_seen_at: at, last_changed_at: at, ...(before === null ? { first_seen_at: at } : {}) })
          continue
        }
        // The raise is keyed on WHAT changed and WHEN it was observed (item + digest + observation) — never on the previous digest,
        // so a lost item state replays instead of re-raising, while a return to an earlier value is a NEW observation and is raised.
        const transition: MovementSignalRecord = { ...built.record, idempotencyKey: `movement_poll:${brokerageId}:${ps.key}:${movementDigest(itemKey)}:${digest}:${it.observedAt ?? "undated"}` }
        const r = await record(svc, transition, { ...(deps.movement ?? {}), ...(ps.route === false ? { route: false } : {}) })
        if (r.status === "refused") {
          // Not remembered: the change was not raised, so the next tick tries again (never "seen" without being signalled).
          res.refused++; res.errors.push(`${itemKey}: ${r.code} — ${r.reason}`.slice(0, 300)); blocked = true
          continue
        }
        if (r.status === "recorded") res.raised++
        else res.replayed++
        const saved = await store.saveItem(brokerageId, ps.key, { item_key: itemKey, digest, last_seen_at: at, last_changed_at: at, last_signal_id: r.id ?? null, ...(before === null ? { first_seen_at: at } : {}) })
        if (!saved.ok) res.errors.push(`${itemKey}: item state not saved (${saved.error}) — the ledger key keeps the next run from raising it again`)
      }
      // A poll whose raises were refused did not fully succeed: last_success_at stays put so the freshness tells the truth.
      await store.savePoll(brokerageId, ps.key, {
        cadence_minutes: ps.cadenceMinutes, last_polled_at: now.toISOString(), promised_freshness_minutes: promised,
        last_item_count: res.items, last_change_count: res.raised,
        ...(blocked ? { last_error: `${res.refused} change(s) not raised this tick` } : { last_success_at: now.toISOString(), last_error: null }),
      })
      if (!blocked) res.freshness = freshnessOf(now.toISOString())
      out.raised += res.raised
    } catch (e) {
      res.errors.push(`threw: ${e instanceof Error ? e.message : String(e)}`)
    }
    out.errors.push(...res.errors.map((e) => `${ps.key}: ${e}`))
  }
  return out
}

// ── the shipped poll sources — each reads what an existing no-push sweep STORED (no vendor call, no new egress) ────────────────

/** How far back a poll reads: since the last success with a 6-hour overlap (the transition key makes the overlap free); 30 days on a baseline. */
function readSince(now: Date, lastSuccessAt: string | null): string {
  const t = lastSuccessAt ? Date.parse(lastSuccessAt) - 6 * 3_600_000 : now.getTime() - 30 * DAY_MS
  return new Date(Number.isFinite(t) ? t : now.getTime() - 30 * DAY_MS).toISOString()
}

/** motivated_seller_signals — the stored output of the permit / violation (Socrata, ArcGIS) and BatchData quickList sweeps. */
export const STORED_SELLER_SIGNALS_SOURCE: MovementPollSource = {
  key: "stored:motivated_seller_signals", registryKeys: ["pr_permit_activity", "pr_code_violation", "pr_batchdata_quicklist"], cadenceMinutes: 60,
  async fetch({ svc, brokerageId, now, lastSuccessAt }) {
    const { data, error } = await svc.from("motivated_seller_signals").select("id, lead_id, contact_id, signal_type, signal_strength, detected_via, detected_at, signal_details")
      .eq("brokerage_id", brokerageId).gte("detected_at", readSince(now, lastSuccessAt)).order("detected_at", { ascending: true }).limit(500)
    if (error) return { ok: false, error: `motivated_seller_signals read refused: ${error.message}` }
    return {
      ok: true,
      items: ((data ?? []) as Array<Record<string, any>>).filter((r) => r.lead_id || r.contact_id).map((r) => {
        const d = (r.signal_details ?? {}) as Record<string, unknown>
        return {
          itemKey: `${r.contact_id ? `contact:${r.contact_id}` : `lead:${r.lead_id}`}:${String(r.signal_type ?? "")}`,
          material: { strength: r.signal_strength ?? null, via: r.detected_via ?? null, record: d.dedupe_key ?? d.permit_id ?? d.case_number ?? null },
          observedAt: typeof r.detected_at === "string" ? r.detected_at : null,
          toSignal: () => movementSignalFromSellerSignalRow(brokerageId, r as never),
        }
      }),
    }
  },
}

/** calculator_history — the person's own calculator runs (tenant stamped by calculator_history_set_brokerage_trg). */
export const STORED_CALCULATOR_SOURCE: MovementPollSource = {
  key: "stored:calculator_history", registryKeys: Object.values(CALCULATOR_MOVEMENT_SOURCE), cadenceMinutes: 15,
  async fetch({ svc, brokerageId, now, lastSuccessAt }) {
    const { data, error } = await svc.from("calculator_history").select("id, contact_id, lead_id, calculator_type, inputs, created_at")
      .eq("brokerage_id", brokerageId).gte("created_at", readSince(now, lastSuccessAt)).order("created_at", { ascending: true }).limit(500)
    if (error) return { ok: false, error: `calculator_history read refused: ${error.message}` }
    return {
      ok: true,
      items: ((data ?? []) as Array<Record<string, any>>).filter((r) => (r.contact_id || r.lead_id) && CALCULATOR_MOVEMENT_SOURCE[String(r.calculator_type ?? "")]).map((r) => {
        const inputs = (r.inputs && typeof r.inputs === "object" ? r.inputs : {}) as Record<string, unknown>
        // A NEW destination / area compared is material; a re-run of the same sum is not.
        const area = inputs.destination ?? inputs.destination_city ?? inputs.to_city ?? inputs.city ?? inputs.zip ?? inputs.neighborhood ?? null
        return {
          itemKey: `${r.contact_id ? `contact:${r.contact_id}` : `lead:${r.lead_id}`}:${String(r.calculator_type)}`,
          material: { calculator: r.calculator_type, area: typeof area === "string" ? area.trim().toLowerCase() : area },
          observedAt: typeof r.created_at === "string" ? r.created_at : null,
          toSignal: () => movementSignalFromCalculatorRow(brokerageId, r as never),
        }
      }),
    }
  },
}

/** The acquisition SourceKeys whose POSTS bear on a move → their registry rows. */
export const POST_SOURCE_REGISTRY: Readonly<Record<string, string>> = Object.freeze({
  agent_seeking_phrase_intent: "pp_agent_seeking_phrase", facebook_recommend_realtor: "pp_facebook_recommend_realtor",
  reddit_relocation: "pp_reddit_relocation", linkedin_relocation: "pp_linkedin_relocation", review_acquisition_intent: "pp_tenant_own_pages",
})

/** PURE. The post text a vendor payload carries (the actors name it differently). */
function postTextOf(raw: unknown): string {
  if (!raw || typeof raw !== "object") return ""
  const r = raw as Record<string, unknown>
  const parts = ["title", "text", "body", "selftext", "content", "postText", "message", "snippet", "description", "comment"].map((k) => r[k]).filter((v): v is string => typeof v === "string" && v.trim().length > 0)
  return [...new Set(parts)].join("\n").slice(0, 4000)
}

/**
 * raw_scraped_leads posts from the agent-seeking / relocation lanes → the AI classifier (expert prompt; a verbatim quote or nothing)
 * → C9. The subject is the lead it was promoted to (C2 resolves a converted lead to its contact) or the raw lead itself (no
 * outreach: a raw lead consented to nothing). Classification is capped per tick (`maxClassifications`) — the rest wait, never drop.
 */
function acquisitionPostsSource(opts: { maxClassifications?: number; classify?: MovementClassify } = {}): MovementPollSource {
  return {
    key: "stored:raw_scraped_leads.posts", registryKeys: Object.values(POST_SOURCE_REGISTRY), cadenceMinutes: 60,
    async fetch({ svc, brokerageId, now, lastSuccessAt }) {
      const { data, error } = await svc.from("raw_scraped_leads").select("id, lead_id, source, raw_data, normalized_preview, city, state, created_at")
        .eq("brokerage_id", brokerageId).in("source", Object.keys(POST_SOURCE_REGISTRY)).gte("created_at", readSince(now, lastSuccessAt)).order("created_at", { ascending: true }).limit(200)
      if (error) return { ok: false, error: `raw_scraped_leads read refused: ${error.message}` }
      let budget = opts.maxClassifications ?? 20
      return {
        ok: true,
        items: ((data ?? []) as Array<Record<string, any>>).map((r) => ({
          itemKey: `raw:${r.id}`,
          material: { source: r.source, lead: r.lead_id ?? null },
          observedAt: typeof r.created_at === "string" ? r.created_at : null,
          toSignal: async (): Promise<MovementBuild> => {
            const sourceKey = POST_SOURCE_REGISTRY[String(r.source)]
            if (budget <= 0) return { ok: false, code: "bad_evidence", reason: "classification budget for this tick is spent — read next tick" }
            budget--
            const text = postTextOf(r.raw_data)
            const reading = await classifyPublicMovementText({ brokerageId, text, territory: [r.city, r.state].filter(Boolean).join(", ") || null, sourceKey }, { classify: opts.classify })
            const subject: MovementSubject = r.lead_id ? { type: "lead", id: String(r.lead_id) } : { type: "raw_lead", id: String(r.id) }
            const preview = (r.normalized_preview ?? {}) as Record<string, unknown>
            return movementSignalFromPublicPost({
              brokerageId, subject, sourceKey, postId: `raw_scraped_leads:${r.id}`, url: typeof preview.sourceUrl === "string" ? preview.sourceUrl : null,
              postedAt: String(r.created_at), retrievedAt: String(r.created_at), reading,
              keywordBasis: Array.isArray(preview.intentSignals) ? (preview.intentSignals as unknown[]).map(String).slice(0, 5) : [],
            })
          },
        })),
      }
    },
  }
}

/**
 * The durable events of the two doors that ALREADY answer a fact (wave 145F provider facts — `enrichment.intent_fact.observed`;
 * wave 146D first-party changes — `customer360.first_party_action.observed`) → C9 records, RECORD-ONLY (`route: false`): those
 * doors routed the fact to the ONE responder already, so a second route would be a second door onto one fact. Reading their ledger
 * rows (not editing their code) keeps the proven survivors untouched and gives the combination, the arbiter hook and the outcome
 * loop every movement fact in ONE store. A provider life event is expanded per element from contacts.life_events.
 */
const ROUTED_FACT_ACTIONS = ["enrichment.intent_fact.observed", "customer360.first_party_action.observed"] as const

const LEDGER_ROUTED_FACTS_SOURCE: MovementPollSource = {
  key: "ledger:routed_intent_facts", registryKeys: ["fp_saved_homes", "fp_portal_resumed", "po_online_real_estate_activity", "pp_web_mention_life_event"], cadenceMinutes: 15, route: false,
  async fetch({ svc, brokerageId, now, lastSuccessAt }) {
    const { data, error } = await svc.from("agent_action_ledger").select("id, action, subject_type, subject_id, idempotency_key, detail, created_at, status")
      .eq("brokerage_id", brokerageId).in("action", [...ROUTED_FACT_ACTIONS]).eq("status", "executed").gte("created_at", readSince(now, lastSuccessAt)).order("created_at", { ascending: true }).limit(500)
    if (error) return { ok: false, error: `agent_action_ledger read refused: ${error.message}` }
    const rows = ((data ?? []) as Array<Record<string, any>>).filter((ev) => (ev.subject_type === "contact" || ev.subject_type === "lead") && ev.subject_id)
    const lifeContacts = [...new Set(rows.filter((ev) => ev.detail?.key === "public_life_event" && ev.subject_type === "contact").map((ev) => String(ev.subject_id)))]
    const lifeEvents = new Map<string, { events: unknown[]; detectedAt: string | null }>()
    if (lifeContacts.length > 0) {
      const { data: cs, error: cErr } = await svc.from("contacts").select("id, life_events, last_life_event_detected").eq("brokerage_id", brokerageId).in("id", lifeContacts)
      if (cErr) return { ok: false, error: `contacts (life events) read refused: ${cErr.message}` }
      for (const c of (cs ?? []) as Array<Record<string, any>>) lifeEvents.set(String(c.id), { events: Array.isArray(c.life_events) ? c.life_events : [], detectedAt: c.last_life_event_detected ?? null })
    }
    const items: PolledItem[] = []
    for (const ev of rows) {
      const d = (ev.detail ?? {}) as Record<string, any>
      const party = { type: ev.subject_type as "contact" | "lead", id: String(ev.subject_id) }
      if (ev.action === "customer360.first_party_action.observed") {
        items.push({
          itemKey: `fp:${ev.idempotency_key ?? ev.id}`, material: { family: d.family ?? null, change: d.change ?? null }, observedAt: d.latest_at ?? ev.created_at ?? null,
          toSignal: () => movementSignalFromFirstPartyChange({ brokerageId, party, family: d.family === "portal" ? "portal" : "search", tables: Array.isArray(d.tables) ? d.tables.map(String) : [], latestAt: String(d.latest_at ?? ev.created_at), change: d.change === "resumed" ? "resumed" : "started" }),
        })
        continue
      }
      if (d.key === "public_life_event") {
        const life = lifeEvents.get(party.id)
        for (const lifeRaw of life?.events ?? []) {
          const e = (lifeRaw && typeof lifeRaw === "object" ? lifeRaw : { event: String(lifeRaw) }) as Record<string, any>
          const token = String(e.event ?? e.type ?? "")
          items.push({
            itemKey: `life:${party.id}:${token}:${movementDigest(String(e.url ?? e.details ?? e.source ?? ""))}`, material: { token, url: e.url ?? null }, observedAt: e.publishedDate ?? e.date ?? life?.detectedAt ?? ev.created_at ?? null,
            toSignal: () => movementSignalFromLifeEvent({ brokerageId, contactId: party.id, event: e, detectedAt: String(life?.detectedAt ?? ev.created_at) }),
          })
        }
        continue
      }
      const fact = { key: String(d.key ?? ""), intents: Array.isArray(d.intents) ? d.intents : [], provider: d.provenance?.provider ?? "versium", field: String(d.provenance?.field ?? d.key ?? ""), value: String(d.fact_key ?? ev.idempotency_key ?? ev.id), observedAt: d.freshness?.observedAt ?? null, monthsSince: null, sensitivity: String(d.sensitivity ?? "behaviour") }
      items.push({
        itemKey: `fact:${ev.idempotency_key ?? ev.id}`, material: { fact: d.fact_key ?? null }, observedAt: fact.observedAt ?? ev.created_at ?? null,
        toSignal: () => movementSignalFromIntentFact(fact as never, { brokerageId, subject: party, writtenAt: String(ev.created_at) }),
      })
    }
    return { ok: true, items }
  },
}

/** The sources the watcher polls by default — every one reads a stored sweep output or a door's durable event; none calls a vendor. */
function movementPollSources(opts: { classify?: MovementClassify } = {}): MovementPollSource[] {
  return [STORED_SELLER_SIGNALS_SOURCE, STORED_CALCULATOR_SOURCE, acquisitionPostsSource({ classify: opts.classify }), LEDGER_ROUTED_FACTS_SOURCE]
}

/**
 * THE MOVEMENT TICK — the one entry the 15-minute enrichment-processor tick calls (Outside-lane one-liner): poll-and-diff every
 * no-push source (watchMovementSources), then close open movement records by what actually happened (reconcileMovementOutcomes —
 * the loop that re-weights the sources). Tenant-pinned; never throws.
 */
export async function runMovementTick(
  svc: Svc,
  brokerageId: string,
  opts: { now?: Date; sources?: readonly MovementPollSource[]; force?: boolean; classify?: MovementClassify; reconcile?: boolean } = {},
  deps: MovementWatchDeps = {},
): Promise<{ watch: Awaited<ReturnType<typeof watchMovementSources>>; outcomes: Awaited<ReturnType<typeof reconcileMovementOutcomes>> | null }> {
  const watch = await watchMovementSources(svc, brokerageId, { now: opts.now, force: opts.force, sources: opts.sources ?? movementPollSources({ classify: opts.classify }) }, deps)
  const outcomes = opts.reconcile === false ? null : await reconcileMovementOutcomes(svc, brokerageId, { ...(deps.movement ?? {}), now: opts.now ?? deps.movement?.now })
  return { watch, outcomes }
}
