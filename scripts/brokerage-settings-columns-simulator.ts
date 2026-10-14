/**
 * scripts/brokerage-settings-columns-simulator.ts   (npm run test:brokerage-settings-columns)
 *
 * TWO brokerage_settings COLUMNS THAT WERE READ AND NEVER WRITTEN NOW HAVE ONE WRITER EACH
 * (wave 86, lane 86H — owner ruling: BUILD, not default-only).
 *
 * THE DEFECT. Lane 86C's settings-writer conversion removed the opaque whole-row writes that
 * had masked them, and opposite-missing 1b went 1 → 3:
 *   · review_request_delay_days (INTEGER NULL, m061) — read by the review-request cron, so
 *     every brokerage asked for reviews on the hard-coded day 5;
 *   · live_agent_face_provider_order (TEXT[] NOT NULL DEFAULT {did,simli}, m627) — read by
 *     both live session doors through resolveFaceRenderProvider; nobody could turn the backup
 *     face leg off.
 * Both are REAL COLUMNS (read live 2026-09-27), not settings-jsonb keys, so each is written by
 * a counted upsert naming only its own column (lib/settings/brokerage-settings-columns.ts),
 * behind a session-gated tenant-admin action, from a card on the surface beside its feature.
 *
 * WHAT THIS PROVES (no network; positive controls on every absence claim):
 *   1 VOCABULARY — the delay bounds are DERIVED from the cron's own window, and every delay
 *     the writer accepts is one the cron (modelled on its daily schedule) actually sends on;
 *     the face order the writer accepts is one the doors honour (primary first; backups the
 *     doors really consult). Control: a delay = the lookback sends on ZERO runs; a backup the
 *     doors never consult is flagged.
 *   2 WRITER — first save creates the row, a later save touches only its column (settings
 *     jsonb + the other column carried), invalid values write NOTHING, a refused or ZERO-row
 *     write is a refusal. Control: the uncounted shape reports "saved" in the same zero-row
 *     fixture. A jsonb merge racing a column save re-reads (the version moved) and both land.
 *   3 GATE (stripped source) — "use server", every export async, no export takes a tenant id,
 *     each save gates on the WRITE context + resolveTenantAdmin before the service client.
 *   4 ONE WRITER PER COLUMN (stripped, app/ + lib/) — and the readers use the shared
 *     vocabulary (no local default). Control: the finder flags a writer specimen.
 *   5 MOUNTED — both cards render on their surfaces and call the save actions.
 *
 * Run: npx tsx --conditions=react-server scripts/brokerage-settings-columns-simulator.ts
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"
import { walkTs } from "./runtime-roots"
import {
  normalizeReviewRequestDelay,
  validateReviewRequestDelay,
  REVIEW_REQUEST_DEFAULT_DELAY_DAYS,
  REVIEW_REQUEST_DELAY_MAX_DAYS,
  REVIEW_REQUEST_DELAY_MIN_DAYS,
  REVIEW_REQUEST_LOOKBACK_DAYS,
  REVIEW_REQUEST_MIN_AGE_DAYS,
} from "../lib/reputation/review-request-delay"
import {
  FACE_RENDER_PROVIDERS,
  normalizeProviderOrder,
  validateFaceProviderOrder,
} from "../lib/live-agent/face-render"
import { saveLiveFaceProviderOrder, saveReviewRequestDelayDays } from "../lib/settings/brokerage-settings-columns"
import { mergeBrokerageSettings } from "../lib/settings/brokerage-settings-merge"

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const root = process.cwd()
const raw = (rel: string) => readFileSync(join(root, rel), "utf8")
const code = (rel: string) => stripComments(raw(rel))
const B = "bbbbbbbb-0000-4000-8000-000000000086"

// ─── in-memory brokerage_settings (live columns, defaults, UNIQUE (brokerage_id)) ───────────
type Row = Record<string, any> & { id: string; brokerage_id: string; settings: Record<string, unknown>; updated_at: string }
function world(opts: { rows?: Row[]; writeMode?: "ok" | "error" | "zero"; onFirstRead?: () => Promise<void> } = {}) {
  const table: Row[] = (opts.rows ?? []).map((r) => JSON.parse(JSON.stringify(r)))
  let seq = 0
  let hookFired = false
  const writes: string[] = []
  const from = (t: string) => {
    // Wave 101 (m696): a policy-column save also appends a version through lib/kernel/tenant-policy.ts.
    // These checks are about the column write, so the version table answers as NOT YET APPLIED
    // (42P01) — the write must still land (test:tenant-policy-versions proves the versions).
    if (t === "tenant_policy_versions") {
      const v: any = {}
      for (const m of ["select", "eq", "order", "limit", "insert"]) v[m] = () => v
      v.then = (res: any, rej: any) => Promise.resolve({ data: null, error: { code: "42P01", message: "relation \"public.tenant_policy_versions\" does not exist" } }).then(res, rej)
      return v
    }
    if (t !== "brokerage_settings") throw new Error(`unexpected table ${t}`)
    const preds: Array<(r: Row) => boolean> = []
    let op: "select" | "update" | "insert" | "upsert" = "select"
    let payload: any = null
    let conflict: string | null = null
    const q: any = {}
    q.select = () => q
    q.eq = (k: string, v: any) => { preds.push((r) => r[k] === v); return q }
    q.is = (k: string, v: any) => { preds.push((r) => (r[k] ?? null) === v); return q }
    q.update = (p: any) => { op = "update"; payload = p; return q }
    q.insert = (p: any) => { op = "insert"; payload = p; return q }
    q.upsert = (p: any, o?: { onConflict?: string }) => { op = "upsert"; payload = p; conflict = o?.onConflict ?? null; return q }
    q.maybeSingle = async () => {
      const snap = table.filter((r) => preds.every((p) => p(r))).map((r) => JSON.parse(JSON.stringify(r)))
      if (opts.onFirstRead && !hookFired) { hookFired = true; await opts.onFirstRead() }
      return { data: snap[0] ?? null, error: null }
    }
    q.then = (res: any, rej: any) => Promise.resolve(run()).then(res, rej)
    const fresh = (p: any): Row => ({
      id: `bs-${++seq}`, settings: {}, review_request_delay_days: null, live_agent_face_provider_order: ["did", "simli"],
      active_listing_sources: [], social_accounts: [], created_at: "2026-09-27T00:00:00.000Z",
      updated_at: new Date(Date.UTC(2026, 8, 27, 0, 0, seq)).toISOString(), ...p,
    })
    const run = () => {
      if (op !== "select" && opts.writeMode === "error") return { data: null, error: { message: "permission denied for table brokerage_settings" } }
      if (op !== "select" && opts.writeMode === "zero") return { data: [], error: null }
      if (op === "insert") {
        if (table.some((r) => r.brokerage_id === payload.brokerage_id)) return { data: null, error: { code: "23505", message: "duplicate key" } }
        const row = fresh(payload); table.push(row); writes.push(`insert:${Object.keys(payload).join(",")}`)
        return { data: [{ id: row.id }], error: null }
      }
      if (op === "upsert") {
        if (conflict !== "brokerage_id") return { data: null, error: { code: "42P10", message: "no unique constraint matching the ON CONFLICT specification" } }
        const hit = table.find((r) => r.brokerage_id === payload.brokerage_id)
        if (hit) { Object.assign(hit, payload); writes.push(`upsert-update:${Object.keys(payload).join(",")}`); return { data: [{ id: hit.id }], error: null } }
        const row = fresh(payload); table.push(row); writes.push(`upsert-insert:${Object.keys(payload).join(",")}`)
        return { data: [{ id: row.id }], error: null }
      }
      const hit = table.filter((r) => preds.every((p) => p(r)))
      for (const r of hit) { Object.assign(r, payload); writes.push(`update:${Object.keys(payload).join(",")}`) }
      return { data: hit.map((r) => ({ id: r.id })), error: null }
    }
    return q
  }
  return { svc: { from } as any, table, writes }
}
const seedRow = (): Row => ({
  id: "bs-0", brokerage_id: B, settings: { ce_provider: { name: "Acme CE" } }, review_request_delay_days: null,
  live_agent_face_provider_order: ["did", "simli"], active_listing_sources: ["batchdata"], social_accounts: [],
  created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-26T00:00:00.000Z",
})

/**
 * MODEL of app/api/cron/review-request-on-close on its daily schedule (cron-dispatch
 * "0 16 * * *"): a closing is considered while it is between MIN_AGE and LOOKBACK days old,
 * and sent once now ≥ close + delay. Returns the number of daily runs that would send.
 */
function sendingRuns(delayDays: number, lookback = REVIEW_REQUEST_LOOKBACK_DAYS): number {
  const DAY = 86_400_000
  const close = Date.UTC(2026, 0, 1, 18, 0) // after the day's run — the worst case
  let n = 0
  for (let k = 0; k <= lookback + 60; k++) {
    const run = Date.UTC(2026, 0, 1, 16, 0) + k * DAY
    const inWindow = close >= run - lookback * DAY && close <= run - REVIEW_REQUEST_MIN_AGE_DAYS * DAY
    if (inWindow && run >= close + delayDays * DAY) n++
  }
  return n
}

async function main() {
  console.log("[1 · VOCABULARY — the writer accepts only what the readers honour]")
  {
    check("the delay bounds are DERIVED from the cron window (MIN = its minimum age, MAX < its lookback)",
      REVIEW_REQUEST_DELAY_MIN_DAYS === REVIEW_REQUEST_MIN_AGE_DAYS && REVIEW_REQUEST_DELAY_MAX_DAYS < REVIEW_REQUEST_LOOKBACK_DAYS
        && REVIEW_REQUEST_DELAY_MIN_DAYS <= REVIEW_REQUEST_DEFAULT_DELAY_DAYS && REVIEW_REQUEST_DEFAULT_DELAY_DAYS <= REVIEW_REQUEST_DELAY_MAX_DAYS,
      `${REVIEW_REQUEST_DELAY_MIN_DAYS}..${REVIEW_REQUEST_DELAY_MAX_DAYS} / lookback ${REVIEW_REQUEST_LOOKBACK_DAYS}`)
    const thin: string[] = []
    for (let d = REVIEW_REQUEST_DELAY_MIN_DAYS; d <= REVIEW_REQUEST_DELAY_MAX_DAYS; d++) {
      if (!validateReviewRequestDelay(d).ok) thin.push(`${d}:refused`)
      else if (sendingRuns(d) < 7) thin.push(`${d}:${sendingRuns(d)} runs`)
    }
    check("EVERY accepted delay is sent by the cron model with ≥ 7 daily runs of margin (a missed run loses nothing)", thin.length === 0, thin.join(" "))
    check("POSITIVE CONTROL — a delay equal to the lookback is sent on ZERO runs (the model sees the defect the bound prevents)",
      sendingRuns(REVIEW_REQUEST_LOOKBACK_DAYS) === 0, String(sendingRuns(REVIEW_REQUEST_LOOKBACK_DAYS)))
    const refused = [0, REVIEW_REQUEST_DELAY_MIN_DAYS - 1, REVIEW_REQUEST_DELAY_MAX_DAYS + 1, 60, 2.5, NaN, "7", undefined]
      .filter((v) => validateReviewRequestDelay(v).ok)
    check("out-of-bounds / fractional / non-number delays are REFUSED by the writer vocabulary (never clamped on write)", refused.length === 0, JSON.stringify(refused))
    check("null is accepted (clears the setting) and reads back as the DEFAULT",
      validateReviewRequestDelay(null).ok && normalizeReviewRequestDelay(null) === REVIEW_REQUEST_DEFAULT_DELAY_DAYS)
    check("the reader clamps a value stored outside this app into what the cron can honour",
      normalizeReviewRequestDelay(90) === REVIEW_REQUEST_DELAY_MAX_DAYS && normalizeReviewRequestDelay(0) === REVIEW_REQUEST_DELAY_MIN_DAYS
        && normalizeReviewRequestDelay(12) === 12)

    const primary = FACE_RENDER_PROVIDERS[0]
    const backups = FACE_RENDER_PROVIDERS.slice(1)
    check("the full default order and the primary alone are accepted", validateFaceProviderOrder([...FACE_RENDER_PROVIDERS]).ok && validateFaceProviderOrder([primary]).ok)
    const badOrders: unknown[] = [[], [...backups, primary], [primary, primary], [primary, "heygen"], "did,simli", null]
    const wrongly = badOrders.filter((o) => validateFaceProviderOrder(o).ok)
    check("a backup-first order, a duplicate, an unknown provider, an empty list and a non-array are REFUSED", wrongly.length === 0, JSON.stringify(wrongly))
    const roundTrip = [[...FACE_RENDER_PROVIDERS], [primary]].every((o) => {
      const v = validateFaceProviderOrder(o)
      return v.ok && normalizeProviderOrder(v.order).join() === v.order.join()
    })
    check("every accepted order reads back UNCHANGED through the reader's own normalizer", roundTrip)

    // The doors consult the list only after the primary failed, by `.includes("<backup>")`.
    // A backup the writer offers must be one BOTH doors really consult — else the toggle is inert.
    const DOORS = ["app/api/did/agents/session/route.ts", "app/api/embed/session/route.ts"]
    const consulted = (src: string, id: string) => new RegExp(`providerOrder\\.includes\\(\\s*["']${id}["']\\s*\\)`).test(src)
    const inert = backups.filter((id) => !DOORS.every((d) => consulted(code(d), id)))
    check("every writable BACKUP is consulted by both session doors (no inert toggle)", inert.length === 0, inert.join(","))
    check("POSITIVE CONTROL — a backup the doors never consult (tavus) is flagged", !DOORS.every((d) => consulted(code(d), "tavus")))
  }

  console.log("\n[2 · WRITER — counted upsert of ONE column; nothing else touched]")
  {
    const w = world()
    const r = await saveReviewRequestDelayDays(w.svc, B, 9)
    check("first-ever save CREATES the brokerage's row (upsert on brokerage_id) and is counted",
      r.ok && w.table.length === 1 && w.table[0].review_request_delay_days === 9 && w.writes[0].startsWith("upsert-insert:"), JSON.stringify(r))

    const s = world({ rows: [seedRow()] })
    const r1 = await saveReviewRequestDelayDays(s.svc, B, 12)
    const r2 = await saveLiveFaceProviderOrder(s.svc, B, [FACE_RENDER_PROVIDERS[0]])
    const row = s.table[0]
    check("a later save touches ONLY its column (+ updated_at): the settings jsonb and the other columns are carried",
      r1.ok && r2.ok && row.review_request_delay_days === 12 && row.live_agent_face_provider_order.join() === FACE_RENDER_PROVIDERS[0]
        && (row.settings as any).ce_provider?.name === "Acme CE" && row.active_listing_sources.join() === "batchdata"
        && s.writes.every((x) => !/\bsettings\b|active_listing_sources/.test(x.split(":")[1] ?? "")), JSON.stringify(s.writes))
    check("the write bumps updated_at (the version the jsonb merge compares)", row.updated_at !== "2026-09-26T00:00:00.000Z")

    const reset = await saveReviewRequestDelayDays(s.svc, B, null)
    check("reset writes NULL (the column is nullable; the cron reads NULL as its default)", reset.ok && s.table[0].review_request_delay_days === null)

    const bad = world({ rows: [seedRow()] })
    const b1 = await saveReviewRequestDelayDays(bad.svc, B, REVIEW_REQUEST_DELAY_MAX_DAYS + 1)
    const b2 = await saveLiveFaceProviderOrder(bad.svc, B, [...FACE_RENDER_PROVIDERS].reverse())
    const b3 = await saveReviewRequestDelayDays(bad.svc, "", 5)
    check("an invalid value or a missing tenant writes NOTHING and says why", !b1.ok && !b2.ok && !b3.ok && bad.writes.length === 0,
      [b1, b2, b3].map((x) => (x as any).error).join(" | "))

    const refused = world({ rows: [seedRow()], writeMode: "error" })
    const e = await saveReviewRequestDelayDays(refused.svc, B, 7)
    check("a refused write is a REFUSAL naming the setting", !e.ok && /Review request delay was not saved/.test((e as any).error))

    const zero = world({ rows: [seedRow()], writeMode: "zero" })
    const z = await saveLiveFaceProviderOrder(zero.svc, B, [...FACE_RENDER_PROVIDERS])
    check("a write that matched ZERO rows (error null) is a REFUSAL, never 'saved' (CLAUDE.md §3)", !z.ok && /matched 0/.test((z as any).error), JSON.stringify(z))
    // The uncounted shape — read the error only — reports success in the SAME fixture.
    const naive = await (async () => {
      const { error } = await zero.svc.from("brokerage_settings").upsert({ brokerage_id: B, live_agent_face_provider_order: ["did"] }, { onConflict: "brokerage_id" })
      return !error
    })()
    check("POSITIVE CONTROL — the error-only (uncounted) writer calls that same zero-row write a success", naive === true)

    // RACE: a jsonb merge reads, the column save lands, the merge's compare-and-set loses and re-merges.
    let columnSave: any = null
    const race = world({ rows: [seedRow()], onFirstRead: async () => { columnSave = await saveReviewRequestDelayDays(race.svc, B, 14) } })
    const m = await mergeBrokerageSettings(race.svc, B, { referral_appreciation: { enabled: true } })
    const rr = race.table[0]
    check("a jsonb merge racing a column save RE-READS (version moved) and both land — neither is lost",
      m.ok && (m as any).attempts === 2 && columnSave?.ok && rr.review_request_delay_days === 14
        && (rr.settings as any).referral_appreciation?.enabled === true && (rr.settings as any).ce_provider?.name === "Acme CE",
      JSON.stringify({ m, columnSave, rr }))
  }

  console.log("\n[3 · GATE — session tenant, tenant-admin, gate before the service client]")
  {
    const ACTIONS = "app/actions/settings/brokerage-column-settings.ts"
    const src = code(ACTIONS)
    check(`${ACTIONS} is a "use server" module`, /^\s*["']use server["']/.test(src))
    const exportsAll = [...src.matchAll(/^export\s+(async\s+function|function|const|let|class|default)\s*(\w*)/gm)]
    const notAsync = exportsAll.filter((m) => m[1] !== "async function").map((m) => m[2] || m[1])
    check("every export is an async function (each is a public endpoint)", exportsAll.length === 4 && notAsync.length === 0,
      `${exportsAll.length} exports; non-async: ${notAsync.join(",")}`)
    const TENANT_PARAM = /export\s+async\s+function\s+\w+\s*\([^)]*\b(brokerage_?id|tenant_?id|userId)\b/i
    check("NO export takes a tenant / user id — the tenant is the session's", !TENANT_PARAM.test(src))
    check("POSITIVE CONTROL — the finder flags a body-supplied brokerageId",
      TENANT_PARAM.test(`export async function saveX(brokerageId: string, days: number) {}`))
    const gateBody = src.slice(src.indexOf("async function gate("), src.indexOf("function readRefusal"))
    check("the gate resolves the WRITE context for saves (read_only act-as refused) and the full tenant-admin rule, failing closed",
      /resolveWriteContext\(\)/.test(gateBody) && /resolveTenantAdmin\(/.test(gateBody) && /if \(!admin\.ok\) return \{ ok: false/.test(gateBody)
        && /if \(!admin\.isTenantAdmin\) return \{ ok: false/.test(gateBody))
    for (const fn of ["saveReviewRequestDelayAction", "saveLiveFaceProviderOrderAction", "getReviewRequestDelaySettingAction", "getLiveFaceProviderSettingAction"]) {
      const start = src.indexOf(`export async function ${fn}(`)
      const body = src.slice(start, src.indexOf("\n}\n", start))
      const g = body.indexOf(fn.startsWith("save") ? `gate("write"` : `gate("read"`)
      const svc = body.indexOf("createServiceClient()")
      check(`${fn} gates (${fn.startsWith("save") ? "write" : "read"}) BEFORE the service client`, start >= 0 && g >= 0 && svc > g, `gate@${g} svc@${svc}`)
    }
  }

  console.log("\n[4 · ONE WRITER PER COLUMN; readers on the shared vocabulary]")
  {
    const files = [...walkTs("app"), ...walkTs("lib")]
    const WRITER = "lib/settings/brokerage-settings-columns.ts"
    const writesCol = (col: string) => new RegExp(`\\.(update|upsert|insert)\\(\\s*\\{[^;]{0,400}?\\b${col}\\s*:`)
    for (const col of ["review_request_delay_days", "live_agent_face_provider_order"]) {
      const writers = files.filter((f) => raw(f).includes(col) && writesCol(col).test(code(f)))
      check(`exactly one module writes ${col} — ${WRITER}`, writers.length === 1 && writers[0] === WRITER, writers.join(", ") || "(none)")
    }
    check("POSITIVE CONTROL — the writer finder flags an update naming the column",
      writesCol("review_request_delay_days").test(`await svc.from("brokerage_settings").update({ review_request_delay_days: 3 }).eq("id", x)`))
    check("CONTROL — a READ of the column is not a writer",
      !writesCol("review_request_delay_days").test(`await svc.from("brokerage_settings").select("brokerage_id, review_request_delay_days")`))

    const CRON = "app/api/cron/review-request-on-close/route.ts"
    const cron = blankStrings(code(CRON))
    const RAW_DEFAULT = /review_request_delay_days\s*\?\?|const\s+DEFAULT_DELAY_DAYS\s*=/
    check("the cron reads the delay through normalizeReviewRequestDelay and derives its window from the same module",
      /normalizeReviewRequestDelay\(\s*s\.review_request_delay_days\s*\)/.test(cron) && /REVIEW_REQUEST_LOOKBACK_DAYS\s*\*/.test(cron)
        && /REVIEW_REQUEST_MIN_AGE_DAYS\s*\*/.test(cron) && !RAW_DEFAULT.test(cron))
    check("POSITIVE CONTROL — the pre-86H local default is flagged",
      RAW_DEFAULT.test(`const DEFAULT_DELAY_DAYS = 5\n x = s.review_request_delay_days ?? DEFAULT_DELAY_DAYS`))
    check("the cron READS the settings error (a refused read fails the run, never 'everyone on the default')",
      /error:\s*settingsError/.test(cron) && /if \(settingsError\) throw/.test(cron))
    const seam = code("lib/live-agent/face-render.ts")
    check("face-render's normalizer filters by the ONE provider list the writer validates against",
      /FACE_RENDER_PROVIDERS: readonly FaceRenderProvider\[\] = DEFAULT_FACE_PROVIDER_ORDER/.test(seam) && /raw\.filter\(isFaceRenderProvider\)/.test(seam)
        && !/v === ["']did["'] \|\| v === ["']simli["']/.test(seam))
  }

  console.log("\n[5 · MOUNTED — each card on the surface beside its feature]")
  {
    const client = code("app/referrals/referrals-os-client.tsx")
    const reviewSection = client.slice(client.indexOf(`id="review-section"`), client.indexOf("<ReviewRequestPanel"))
    check("the review-request timing card renders in /referrals' review-request section, beside ReviewRequestPanel",
      /<ReviewRequestTimingCard\s+initial=\{reviewRequestTiming\}/.test(reviewSection))
    check("/referrals loads it through the gated getter and passes it down",
      /getReviewRequestDelaySettingAction\(\)/.test(code("app/referrals/page.tsx")) && /reviewRequestTiming=\{reviewRequestTiming\}/.test(code("app/referrals/page.tsx")))
    check("the timing card saves through saveReviewRequestDelayAction (min/max from the getter)",
      /saveReviewRequestDelayAction\(/.test(code("app/referrals/review-request-timing-card.tsx")) && /min=\{initial\.minDays\}/.test(code("app/referrals/review-request-timing-card.tsx")))
    const twin = code("app/dashboard/settings/twin-studio/page.tsx")
    check("the live-face card renders on Twin Studio (AI Avatar & Voice) via the gated getter",
      /getLiveFaceProviderSettingAction\(\)/.test(twin) && /<LiveFaceBackupCard\s+initial=\{data\.liveFace\}/.test(twin))
    check("the live-face card saves through saveLiveFaceProviderOrderAction, primary always first",
      /saveLiveFaceProviderOrderAction\(nextOrder\)/.test(code("app/dashboard/settings/twin-studio/live-face-backup-card.tsx"))
        && /const nextOrder = \[primary\.id,/.test(code("app/dashboard/settings/twin-studio/live-face-backup-card.tsx")))
    check("a getter refusal other than 'not a tenant admin' is SHOWN on both pages (never a silently missing card)",
      /loadErrors\.push\(`Review request timing:/.test(code("app/referrals/page.tsx")) && /liveFaceError/.test(twin))
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log(` ❌ BROKERAGE_SETTINGS_COLUMNS_FAIL — ${failures.join("; ")}`)
    process.exit(1)
  }
  console.log(" ✅ BROKERAGE_SETTINGS_COLUMNS_PASS — both read-only columns have one gated, counted writer the readers honour")
}

main().catch((e) => { console.error(e); process.exit(1) })
