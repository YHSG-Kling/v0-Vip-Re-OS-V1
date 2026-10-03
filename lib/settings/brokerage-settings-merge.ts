/**
 * lib/settings/brokerage-settings-merge.ts — THE ONE WRITER of brokerage_settings.settings keys
 * (lane 86C; the race 84D published).
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RACE. `brokerage_settings.settings` is one jsonb that ~10 features share (business
 * registration, phone port-ins, AI agent capabilities, CE provider, referral appreciation,
 * vendor verification, topic-video cadence, manager learning, the body-visual rule ledger…).
 * Every writer did READ → spread → WRITE THE WHOLE OBJECT. Two saves landing together each
 * spread the SAME old object and the second write silently deleted the first one's key — a
 * registration save and a port submission at the same instant lost one of them, and the
 * database reported success for both. Nothing refused; the key was just gone.
 *
 * THE FIX (read live 2026-09-27, project hrvaqgvukzxfskkcrwbt): MERGE BY KEY with an optimistic
 * version check, no migration. The table has UNIQUE (brokerage_id) and no trigger on
 * updated_at, so this module owns the version: it reads (id, settings, updated_at), computes the
 * caller's keys FROM THAT FRESH VALUE, and writes with `.eq("updated_at", <the value it read>)`,
 * bumping updated_at strictly forward. A concurrent writer that got there first moved
 * updated_at, so this UPDATE matches ZERO rows — COUNTED (`.select("id")`, CLAUDE.md §3) — and
 * the merge re-runs on the newer object. A first-ever row is an INSERT; a concurrent first
 * insert loses on the unique key (23505) and re-runs as an update. Every other key is carried
 * exactly as the database holds it at write time, never as some earlier read had it.
 *
 * Why not an RPC (`settings || jsonb_build_object(k, v)`): a single-statement merge would need
 * migration m667 and would still not serve writers whose NEW value depends on the OLD one
 * (append a port-in record, toggle one capability in a list) — those need the fresh value in
 * TypeScript anyway. The compare-and-set serves both shapes.
 *
 * The caller passes a service client it has ALREADY gated (CLAUDE.md §4: gate first); the
 * tenant is the brokerageId the caller resolved from its session / verified row.
 */

type SettingsObject = Record<string, unknown>

/** The keys to write, computed from the CURRENT settings. A key set to `undefined` is removed. */
type SettingsPatch = SettingsObject | ((current: SettingsObject) => SettingsObject)

type MergeSettingsResult =
  | { ok: true; rowId: string; settings: SettingsObject; attempts: number }
  | { ok: false; error: string; conflict?: boolean }

const DEFAULT_ATTEMPTS = 5

/** The next updated_at: now, but strictly after the version read (clocks and same-ms writes). */
function nextVersion(previous: string | null | undefined, now: Date): string {
  const prev = previous ? Date.parse(previous) : NaN
  const t = Number.isFinite(prev) && prev >= now.getTime() ? prev + 1 : now.getTime()
  return new Date(t).toISOString()
}

/**
 * Merge `patch` into brokerage_settings.settings for `brokerageId`, by key, without losing a
 * concurrent writer's keys. Retries a lost compare-and-set up to `maxAttempts` times on the
 * newer value; after that it REFUSES ("concurrent edits"), it never writes over a newer row.
 */
export async function mergeBrokerageSettings(
  svc: any,
  brokerageId: string,
  patch: SettingsPatch,
  opts: { maxAttempts?: number; now?: () => Date } = {},
): Promise<MergeSettingsResult> {
  if (!brokerageId) return { ok: false, error: "No brokerage to save settings for — nothing was written." }
  const attempts = Math.max(1, opts.maxAttempts ?? DEFAULT_ATTEMPTS)
  const now = opts.now ?? (() => new Date())

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { data: row, error: readErr } = await svc
      .from("brokerage_settings")
      .select("id, settings, updated_at")
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    // FAIL CLOSED: a refused read must never be taken for "no settings yet" — writing `{…patch}`
    // over it would replace every other key the brokerage has.
    if (readErr) return { ok: false, error: `Brokerage settings could not be read (${readErr.message}) — nothing was written.` }

    const current = ((row as { settings?: unknown } | null)?.settings ?? {}) as SettingsObject
    const keys = typeof patch === "function" ? patch({ ...current }) : patch
    const next: SettingsObject = { ...current }
    for (const [k, v] of Object.entries(keys)) {
      if (v === undefined) delete next[k]
      else next[k] = v
    }

    if (!row) {
      const { data: ins, error: insErr } = await svc
        .from("brokerage_settings")
        .insert({ brokerage_id: brokerageId, settings: next })
        .select("id")
      if (insErr) {
        // A concurrent first save created the row: merge onto it instead.
        if ((insErr as { code?: string }).code === "23505") continue
        return { ok: false, error: `Brokerage settings were not saved (${insErr.message}).` }
      }
      const id = Array.isArray(ins) ? (ins[0] as { id?: string } | undefined)?.id : (ins as { id?: string } | null)?.id
      if (!id) return { ok: false, error: "Brokerage settings insert returned no row, so nothing was saved." }
      return { ok: true, rowId: id, settings: next, attempts: attempt }
    }

    const r = row as { id: string; updated_at: string | null }
    let q = svc
      .from("brokerage_settings")
      .update({ settings: next, updated_at: nextVersion(r.updated_at, now()) })
      .eq("id", r.id)
      .eq("brokerage_id", brokerageId)
    // THE VERSION CHECK: only the object this merge was computed from may be replaced.
    q = r.updated_at == null ? q.is("updated_at", null) : q.eq("updated_at", r.updated_at)
    const { data: upd, error: updErr } = await q.select("id")
    if (updErr) return { ok: false, error: `Brokerage settings were not saved (${updErr.message}).` }
    if (Array.isArray(upd) && upd.length === 1) return { ok: true, rowId: r.id, settings: next, attempts: attempt }
    // Zero rows: a concurrent writer moved the version — re-read and merge onto ITS object.
  }
  return { ok: false, conflict: true, error: `Brokerage settings are being changed concurrently — ${attempts} merge attempts lost the race; nothing was overwritten. Try again.` }
}
