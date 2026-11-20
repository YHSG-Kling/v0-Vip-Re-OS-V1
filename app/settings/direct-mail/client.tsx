"use client"

import { useState, useTransition } from "react"
import {
  saveFarmMailConfig,
  addCompetitorToWatchlist,
  removeCompetitorFromWatchlist,
  saveSenderAddress,
  approveSenderAddress,
  setDefaultSenderAddress,
  retireSenderAddress,
  type FarmMailConfig,
  type CompetitorWatchlistEntry,
  type SenderAddressSettings,
} from "@/app/actions/direct-mail-settings"
import type { SenderAddressRow } from "@/lib/direct-mail/piece-type"

export function DirectMailSettingsClient({
  initialConfig,
  initialWatchlist,
  initialSender,
}: {
  initialConfig:    FarmMailConfig
  initialWatchlist: CompetitorWatchlistEntry[]
  initialSender:    SenderAddressSettings
}) {
  return (
    <div className="p-6 max-w-4xl mx-auto space-y-8">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">Direct Mail Settings</h1>
        <p className="text-gray-600 mt-2">
          Brokerage-level configuration for the return address every piece carries, the farm-mail weekly cron and the
          competitive intel ingest. Per-persona size preferences and lifecycle
          event toggles live on their respective sub-pages.
        </p>
      </header>

      <SenderAddressSection initial={initialSender} />
      <FarmMailSection initialConfig={initialConfig} />
      <CompetitorWatchlistSection initialWatchlist={initialWatchlist} />
    </div>
  )
}

/** Wave 151 (lane 151H): THE RETURN ADDRESS ON EVERY PIECE. The platform's address is never printed on a tenant mailing; a
 *  send with no approved, CASS-verified sender address is refused by name — this section is where the admin fixes that. */
function SenderAddressSection({ initial }: { initial: SenderAddressSettings }) {
  const [rows, setRows] = useState<SenderAddressRow[]>(initial.rows)
  const [effective, setEffective] = useState(initial.effective)
  const [refusal, setRefusal] = useState(initial.refusal)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [form, setForm] = useState({ label: "", name: "", line1: "", line2: "", city: "", state: "", zip: "" })

  function refreshEffective(next: SenderAddressRow[]) {
    const def = next.find((r) => r.scope_type === "brokerage" && r.is_default && r.approved_at && r.cass_verified_at) ?? next.find((r) => r.scope_type === "brokerage" && r.approved_at && r.cass_verified_at)
    if (def) { setEffective({ source: "tenant_return_address", line: `${def.name} · ${def.line1}, ${def.city}, ${def.state} ${def.zip}`, verified: true }); setRefusal(null) }
    else { setEffective(null); setRefusal("no approved, verified return address — a send resolves to the brokerage's business address only if it can be verified at send time, else it is refused") }
  }

  function handleSave() {
    setError(null); setNotice(null)
    startTransition(async () => {
      const r = await saveSenderAddress({ scope_type: "brokerage", label: form.label || null, name: form.name, line1: form.line1, line2: form.line2 || null, city: form.city, state: form.state, zip: form.zip })
      if (!r.success) { setError(r.error); return }
      const next = [r.row, ...rows.filter((x) => x.id !== r.row.id)]
      setRows(next); refreshEffective(next)
      setNotice(r.verified ? `Saved and CASS-verified (${r.deliverability ?? "deliverable"}). Approve it to use it as the sender.` : "Saved. It could not be verified now (no Lob key, or Lob unavailable) — an unverified address is refused as a sender until it is.")
      setForm({ label: "", name: "", line1: "", line2: "", city: "", state: "", zip: "" })
    })
  }
  function act(fn: (id: string) => Promise<{ success: boolean; error?: string }>, id: string, patch: (r: SenderAddressRow) => SenderAddressRow | null) {
    setError(null); setNotice(null)
    startTransition(async () => {
      const r = await fn(id)
      if (!r.success) { setError(r.error ?? "Failed"); return }
      const next = rows.map((x) => (x.id === id ? patch(x) : x)).filter((x): x is SenderAddressRow => x !== null)
      setRows(next); refreshEffective(next)
    })
  }

  return (
    <section className="border border-gray-200 rounded-lg p-5 bg-white">
      <h2 className="text-lg font-semibold text-gray-900 mb-1">Return address (the sender on every piece)</h2>
      <p className="text-sm text-gray-600 mb-3">
        Every letter, note and postcard prints <strong>your</strong> return address — the platform&apos;s address is never used. An
        address is CASS-verified once when saved, then approved here before any piece carries it. A send with no approved,
        verified address is refused and says so; nothing is substituted.
      </p>
      <div className={`text-sm rounded p-3 mb-4 ${effective ? "bg-green-50 text-green-800" : "bg-amber-50 text-amber-800"}`}>
        {effective
          ? <>Sends from this brokerage use: <span className="font-medium">{effective.line}</span> <span className="text-xs">({effective.source}{effective.verified ? ", CASS-verified" : ""})</span></>
          : <>No usable sender address yet{refusal ? ` — ${refusal}` : ""}.</>}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3 p-3 bg-gray-50 rounded">
        <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Label (e.g. Main office)" className="border border-gray-300 rounded px-3 py-2 text-sm" />
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Return name — your legal / business name (required)" className="border border-gray-300 rounded px-3 py-2 text-sm" />
        <input value={form.line1} onChange={(e) => setForm({ ...form, line1: e.target.value })} placeholder="Street address (required)" className="border border-gray-300 rounded px-3 py-2 text-sm" />
        <input value={form.line2} onChange={(e) => setForm({ ...form, line2: e.target.value })} placeholder="Suite / unit (optional)" className="border border-gray-300 rounded px-3 py-2 text-sm" />
        <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} placeholder="City (required)" className="border border-gray-300 rounded px-3 py-2 text-sm" />
        <div className="grid grid-cols-2 gap-3">
          <input value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} placeholder="ST" maxLength={2} className="border border-gray-300 rounded px-3 py-2 text-sm" />
          <input value={form.zip} onChange={(e) => setForm({ ...form, zip: e.target.value })} placeholder="ZIP" className="border border-gray-300 rounded px-3 py-2 text-sm" />
        </div>
        <button onClick={handleSave} disabled={pending} className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700 disabled:opacity-50">
          {pending ? "Saving…" : initial.canVerify ? "Save and verify (CASS)" : "Save (verification unavailable — no Lob key)"}
        </button>
      </div>
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      {notice && <p className="mb-3 text-sm text-green-700">{notice}</p>}

      {rows.length === 0 ? (
        <p className="text-sm text-gray-500 italic">No return addresses saved yet.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id} className="flex items-start justify-between border border-gray-100 rounded p-3">
              <div className="flex-1 min-w-0 text-sm">
                <div className="font-medium">{r.label ? `${r.label} — ` : ""}{r.name}</div>
                <div className="text-gray-700">{r.line1}{r.line2 ? `, ${r.line2}` : ""}, {r.city}, {r.state} {r.zip}</div>
                <div className="text-xs text-gray-500 mt-1">
                  scope {r.scope_type} · {r.cass_verified_at ? `${r.cass_source === "lob_cass" ? "Lob CASS" : r.cass_source ?? "CASS"} ${r.cass_deliverability ?? "verified"}` : "not verified"} · {r.approved_at ? "approved" : "awaiting approval"}{r.is_default ? " · default" : ""}{r.created_by_user_id ? ` · added by user ${r.created_by_user_id.slice(0, 8)}` : ""}
                </div>
              </div>
              <div className="ml-3 flex flex-col gap-1 text-xs">
                {!r.approved_at && <button disabled={pending} onClick={() => act(approveSenderAddress, r.id, (x) => ({ ...x, approved_at: new Date().toISOString() }))} className="text-blue-600 hover:underline disabled:opacity-50">Approve</button>}
                {r.approved_at && !r.is_default && <button disabled={pending} onClick={() => act(setDefaultSenderAddress, r.id, (x) => ({ ...x, is_default: true }))} className="text-blue-600 hover:underline disabled:opacity-50">Make default</button>}
                <button disabled={pending} onClick={() => act(retireSenderAddress, r.id, () => null)} className="text-red-600 hover:underline disabled:opacity-50">Retire</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function FarmMailSection({ initialConfig }: { initialConfig: FarmMailConfig }) {
  const [enabled, setEnabled]   = useState(initialConfig.farm_mail_enabled)
  const [maxWeek, setMaxWeek]   = useState<string>(initialConfig.farm_mail_max_per_week?.toString() ?? "")
  const [templateId, setTemplateId] = useState(initialConfig.lob_fallback_template_id ?? "")
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  function handleSave() {
    setError(null)
    setSaved(false)
    startTransition(async () => {
      const r = await saveFarmMailConfig({
        farm_mail_enabled:        enabled,
        farm_mail_max_per_week:   maxWeek.trim() ? Number(maxWeek) : null,
        lob_fallback_template_id: templateId.trim() || null,
      })
      if (!r.success) setError(r.error ?? "Save failed")
      else setSaved(true)
    })
  }

  return (
    <section className="border border-gray-200 rounded-lg p-5 bg-white">
      <h2 className="text-lg font-semibold text-gray-900 mb-1">Farm Mail (Weekly Cron)</h2>
      <p className="text-sm text-gray-600 mb-4">
        Walks each agent&apos;s farm_territories on Thursday 08:00 UTC, picks a fresh
        persona-targeted topic from the content bank, and dispatches a branded
        postcard per contact through Lob. Fall-through to the template below
        ships when the AI copy gate fails.
      </p>

      <label className="flex items-center gap-3 mb-4">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-5 w-5"
        />
        <span className="font-medium">Enable weekly farm mail</span>
      </label>

      <div className="space-y-4">
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Max contacts per agent per cycle</span>
          <input
            type="number"
            min={1}
            max={200}
            value={maxWeek}
            onChange={(e) => setMaxWeek(e.target.value)}
            placeholder="50 (default)"
            className="mt-1 block w-40 border border-gray-300 rounded px-3 py-2 text-sm"
          />
          <span className="block text-xs text-gray-500 mt-1">
            At Lob&apos;s ~$0.78/postcard (4×6) the default 50 ≈ $39/agent/week.
          </span>
        </label>

        <label className="block">
          <span className="text-sm font-medium text-gray-700">Lob fallback template id</span>
          <input
            type="text"
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
            placeholder="tmpl_..."
            className="mt-1 block w-full border border-gray-300 rounded px-3 py-2 text-sm font-mono"
          />
          <span className="block text-xs text-gray-500 mt-1">
            Required when farm mail is enabled. Used by the orchestrator when
            AI copy + Remotion render fail.
          </span>
        </label>
      </div>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {saved && <p className="mt-3 text-sm text-green-700">Saved.</p>}

      <button
        onClick={handleSave}
        disabled={pending}
        className="mt-4 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700 disabled:opacity-50"
      >
        {pending ? "Saving…" : "Save farm mail config"}
      </button>
    </section>
  )
}

function CompetitorWatchlistSection({ initialWatchlist }: { initialWatchlist: CompetitorWatchlistEntry[] }) {
  const [entries, setEntries] = useState(initialWatchlist)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // Add form state
  const [name, setName]                 = useState("")
  const [fbId, setFbId]                 = useState("")
  const [googleId, setGoogleId]         = useState("")
  const [zips, setZips]                 = useState("")
  const [threshold, setThreshold]       = useState("")

  function handleAdd() {
    setError(null)
    if (!name.trim()) return setError("Competitor name required")
    startTransition(async () => {
      const r = await addCompetitorToWatchlist({
        competitor_name:      name,
        facebook_page_id:     fbId.trim() || null,
        google_advertiser_id: googleId.trim() || null,
        watch_zip_codes:      zips.split(",").map((z) => z.trim()).filter(Boolean),
        min_engagement_score: threshold.trim() ? Number(threshold) : null,
      })
      if (!r.success) {
        setError(r.error ?? "Add failed")
        return
      }
      // Optimistic refresh; the page revalidates and the parent will rehydrate
      // on next navigation. For inline UX add a placeholder row.
      setEntries((prev) => [
        {
          id: r.entryId ?? `pending-${Date.now()}`,
          competitor_name: name,
          facebook_page_id: fbId.trim() || null,
          google_advertiser_id: googleId.trim() || null,
          watch_zip_codes: zips.split(",").map((z) => z.trim()).filter(Boolean),
          min_engagement_score: threshold.trim() ? Number(threshold) : null,
          is_active: true,
        },
        ...prev,
      ])
      setName(""); setFbId(""); setGoogleId(""); setZips(""); setThreshold("")
    })
  }

  function handleRemove(id: string) {
    setError(null)
    startTransition(async () => {
      const r = await removeCompetitorFromWatchlist(id)
      if (!r.success) setError(r.error ?? "Remove failed")
      else setEntries((prev) => prev.filter((e) => e.id !== id))
    })
  }

  return (
    <section className="border border-gray-200 rounded-lg p-5 bg-white">
      <h2 className="text-lg font-semibold text-gray-900 mb-1">Competitor Watchlist</h2>
      <p className="text-sm text-gray-600 mb-4">
        The daily Exa cron pulls Meta + Google ads for each competitor below,
        scores them by relevance × recency, and promotes the top-performing
        creative into the topic bank tagged{" "}
        <code className="text-xs bg-gray-100 px-1 rounded">competitor_intel</code>{" "}
        so the marketing agent + farm-mail picks see competitor-aware
        candidates next cycle.
      </p>

      {/* Add form */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4 p-3 bg-gray-50 rounded">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Competitor name (required)"
          className="border border-gray-300 rounded px-3 py-2 text-sm"
        />
        <input
          type="text"
          value={fbId}
          onChange={(e) => setFbId(e.target.value)}
          placeholder="Facebook Page id (optional)"
          className="border border-gray-300 rounded px-3 py-2 text-sm font-mono"
        />
        <input
          type="text"
          value={googleId}
          onChange={(e) => setGoogleId(e.target.value)}
          placeholder="Google Advertiser id (optional)"
          className="border border-gray-300 rounded px-3 py-2 text-sm font-mono"
        />
        <input
          type="text"
          value={zips}
          onChange={(e) => setZips(e.target.value)}
          placeholder="Watch zip codes, comma-separated (optional)"
          className="border border-gray-300 rounded px-3 py-2 text-sm"
        />
        <input
          type="number"
          min={0}
          max={100}
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
          placeholder="Min engagement (0-100, blank = default 30)"
          className="border border-gray-300 rounded px-3 py-2 text-sm"
        />
        <button
          onClick={handleAdd}
          disabled={pending}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {pending ? "Adding…" : "Add to watchlist"}
        </button>
      </div>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      {/* List */}
      {entries.filter((e) => e.is_active).length === 0 ? (
        <p className="text-sm text-gray-500 italic">No competitors on watchlist yet.</p>
      ) : (
        <ul className="space-y-2">
          {entries.filter((e) => e.is_active).map((e) => (
            <li key={e.id} className="flex items-start justify-between border border-gray-100 rounded p-3 bg-white">
              <div className="flex-1 min-w-0">
                <div className="font-medium">{e.competitor_name}</div>
                <div className="text-xs text-gray-500 mt-1">
                  {e.facebook_page_id && <span className="mr-3">FB: {e.facebook_page_id}</span>}
                  {e.google_advertiser_id && <span className="mr-3">Google: {e.google_advertiser_id}</span>}
                  {e.watch_zip_codes && e.watch_zip_codes.length > 0 && (
                    <span className="mr-3">Zips: {e.watch_zip_codes.join(", ")}</span>
                  )}
                  {e.min_engagement_score !== null && (
                    <span>Min score: {e.min_engagement_score}</span>
                  )}
                </div>
              </div>
              <button
                onClick={() => handleRemove(e.id)}
                disabled={pending}
                className="ml-3 text-sm text-red-600 hover:text-red-700 disabled:opacity-50"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
