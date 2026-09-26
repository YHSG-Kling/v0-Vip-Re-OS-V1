"use client"

import { useEffect, useState } from "react"
import {
  getBenefitOfferings,
  setBenefitOffering,
  setRevenueShareEnabled,
  getRevenueShareDistributionModel,
  setRevenueShareDistributionModel,
  type OfferingKey,
  type RevenueShareModelInput,
} from "@/app/actions/settings/revenue-share-setting"
import type { RevenueShareModelState } from "@/lib/commission/revenue-share-model"

/**
 * BROKERAGE OFFERINGS — the one settings card where a broker/admin marks what
 * the brokerage offers its agents (owner ruling 2026-08-27): residual income
 * (agent-to-agent revenue share), medical benefits, retirement benefits, and
 * whether tax-assistance tech is enabled for this tenant's agents.
 *
 * TOMBSTONE (§1, 2026-08-27): app/components/settings/RevenueShareToggle.tsx
 * merged HERE — its revenue-share toggle survives as this card's residual-income
 * row (same actions, same column, one settings home per §6). The marked benefits
 * are advertised by the recruiting pitch kit and the public careers page, and
 * surfaced as retention levers; unmarked = not offered, everywhere (fail-closed).
 *
 * DISTRIBUTION MODEL (owner ruling 2026-08-27, m575): the residual-income row
 * carries a detail panel where the broker tells the platform HOW the share is
 * distributed — source (a portion of the agent's income vs the brokerage pays),
 * rate (% vs flat per closing), and duration. Until the model is saved, the
 * enabled mark alone pays NOTHING (the waterfall no-ops and no downline edge is
 * planted) — the panel says so instead of letting the toggle imply a payout.
 */

type RowKey = "revenue_share" | OfferingKey

interface RowSpec {
  key: RowKey
  title: string
  body: string
}

const ROWS: RowSpec[] = [
  {
    key: "revenue_share",
    title: "Residual income — agent revenue share (downline)",
    body:
      "Offer agents a share of the production of the agents they recruit (the eXp/REAL model). When on, " +
      "the commission engine pays configured sponsors on every closing, the revenue-share board appears " +
      "in your command center, and recruiting surfaces advertise the residual-income opportunity. Leave " +
      "off if your brokerage doesn't offer revenue sharing.",
  },
  {
    key: "medical",
    title: "Medical benefits",
    body:
      "Mark this if your brokerage offers agents access to medical benefits. Recruiting surfaces (your " +
      "careers page and pitch one-pager) will say it's offered — eligibility and plan details stay with " +
      "your plan documents.",
  },
  {
    key: "retirement",
    title: "Retirement benefits",
    body:
      "Mark this if your brokerage offers agents a retirement savings option. Advertised the same way as " +
      "medical: offered/not offered, never specific terms.",
  },
  {
    key: "tax_assistance",
    title: "Tax assistance for your agents",
    body:
      "Turns on the 1099 tax tech for this brokerage's agents: the tax set-aside planner with precise " +
      "self-employment tax and the quarterly-estimate concierge that reminds each agent of their exact " +
      "IRS payment before every due date. Off = the tools are hidden and no reminders send.",
  },
]

/** How the share is distributed — a form mirroring the m575 model exactly. */
function RevenueShareModelPanel() {
  const [state, setState] = useState<RevenueShareModelState | null>(null)
  const [loadError, setLoadError] = useState("")
  const [saveError, setSaveError] = useState("")
  const [saving, setSaving] = useState(false)
  const [savedTick, setSavedTick] = useState(false)
  const [form, setForm] = useState<{ sourceOfFunds: "agent" | "brokerage" | ""; rateType: "percent" | "flat" | ""; percent: string; flatDollars: string; durationMonths: string }>({
    sourceOfFunds: "", rateType: "", percent: "", flatDollars: "", durationMonths: "",
  })

  useEffect(() => {
    getRevenueShareDistributionModel().then((r) => {
      if (!r.ok) { setLoadError(r.error); return }
      setState(r.state)
      const m = r.state.model
      if (m) {
        setForm({
          sourceOfFunds: m.sourceOfFunds,
          rateType: m.rateType,
          percent: m.defaultPercent != null ? String(m.defaultPercent) : "",
          flatDollars: m.flatCents != null ? String(m.flatCents / 100) : "",
          durationMonths: String(m.durationMonths),
        })
      }
    })
  }, [])

  async function save() {
    setSaveError("")
    setSavedTick(false)
    if (!form.sourceOfFunds || !form.rateType || form.durationMonths === "") {
      setSaveError("Choose the source, the rate type, and a duration — the platform pays nothing it wasn't told.")
      return
    }
    const input: RevenueShareModelInput = {
      sourceOfFunds: form.sourceOfFunds,
      rateType: form.rateType,
      percent: form.rateType === "percent" ? Number(form.percent) : null,
      flatCents: form.rateType === "flat" ? Math.round(Number(form.flatDollars) * 100) : null,
      durationMonths: Number(form.durationMonths),
    }
    setSaving(true)
    const r = await setRevenueShareDistributionModel(input)
    setSaving(false)
    if (!r.ok) { setSaveError(r.error ?? "Failed to save"); return }
    setSavedTick(true)
    const reread = await getRevenueShareDistributionModel()
    if (reread.ok) setState(reread.state)
  }

  if (loadError) return <p className="text-sm text-red-600 mt-2">{loadError}</p>
  if (!state) return <p className="text-xs text-gray-500 mt-2">Loading distribution model…</p>

  return (
    <div className="mt-3 rounded-md border border-gray-200 bg-gray-50 p-3">
      <h4 className="text-sm font-semibold text-gray-900">How the share is distributed</h4>
      {!state.configured && (
        <p className="text-xs text-amber-700 mt-1">
          Not configured yet — the toggle alone pays nothing. Until you describe the distribution here,
          the commission engine pays no revenue share and no new downline relationships are created.
        </p>
      )}
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <label className="text-xs text-gray-700">
          Who funds the share
          <select
            className="mt-1 block w-full rounded border border-gray-300 p-1.5 text-sm"
            value={form.sourceOfFunds}
            onChange={(e) => setForm((f) => ({ ...f, sourceOfFunds: e.target.value as "agent" | "brokerage" | "" }))}
          >
            <option value="">Choose…</option>
            <option value="agent">A portion of the agent&apos;s income</option>
            <option value="brokerage">The brokerage pays it</option>
          </select>
        </label>
        <label className="text-xs text-gray-700">
          Rate
          <select
            className="mt-1 block w-full rounded border border-gray-300 p-1.5 text-sm"
            value={form.rateType}
            onChange={(e) => setForm((f) => ({ ...f, rateType: e.target.value as "percent" | "flat" | "" }))}
          >
            <option value="">Choose…</option>
            <option value="percent">Percent of the agent&apos;s net</option>
            <option value="flat">Flat fee per closing</option>
          </select>
        </label>
        {form.rateType === "percent" && (
          <label className="text-xs text-gray-700">
            Share percent (new relationships)
            <input
              type="number" min={0.1} max={100} step={0.1}
              className="mt-1 block w-full rounded border border-gray-300 p-1.5 text-sm"
              value={form.percent}
              onChange={(e) => setForm((f) => ({ ...f, percent: e.target.value }))}
              placeholder="e.g. 5"
            />
          </label>
        )}
        {form.rateType === "flat" && (
          <label className="text-xs text-gray-700">
            Flat amount per closing ($)
            <input
              type="number" min={0.01} step={0.01}
              className="mt-1 block w-full rounded border border-gray-300 p-1.5 text-sm"
              value={form.flatDollars}
              onChange={(e) => setForm((f) => ({ ...f, flatDollars: e.target.value }))}
              placeholder="e.g. 250"
            />
          </label>
        )}
        <label className="text-xs text-gray-700">
          Duration for new relationships
          <select
            className="mt-1 block w-full rounded border border-gray-300 p-1.5 text-sm"
            value={form.durationMonths}
            onChange={(e) => setForm((f) => ({ ...f, durationMonths: e.target.value }))}
          >
            <option value="">Choose…</option>
            <option value="12">12 months</option>
            <option value="24">24 months</option>
            <option value="36">36 months</option>
            <option value="60">60 months</option>
            <option value="0">Indefinite — runs until ended</option>
          </select>
        </label>
      </div>
      <p className="text-[11px] text-gray-500 mt-2">
        The duration sets the window stamped on relationships created from now on; relationships that
        already exist keep the terms they were created with.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save distribution model"}
        </button>
        {savedTick && <span className="text-xs text-green-700">Saved</span>}
      </div>
      {saveError && <p className="text-xs text-red-600 mt-2">{saveError}</p>}
    </div>
  )
}

export function BenefitOfferingsCard() {
  const [state, setState] = useState<Record<RowKey, boolean> | null>(null)
  const [saving, setSaving] = useState<RowKey | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    getBenefitOfferings().then((r) => {
      if (r.ok) {
        setState({
          revenue_share: r.offerings.revenueShare,
          medical: r.offerings.medical,
          retirement: r.offerings.retirement,
          tax_assistance: r.offerings.taxAssistance,
        })
      } else {
        setError(r.error ?? "Failed to load")
        setState({ revenue_share: false, medical: false, retirement: false, tax_assistance: false })
      }
    })
  }, [])

  async function toggle(key: RowKey) {
    if (!state || saving) return
    const next = !state[key]
    setSaving(key)
    setError("")
    // ONE writer per column: revenue share keeps its own setter; the m574
    // offerings go through the allow-listed setBenefitOffering.
    const r = key === "revenue_share" ? await setRevenueShareEnabled(next) : await setBenefitOffering(key, next)
    setSaving(null)
    if (r.ok) setState({ ...state, [key]: next })
    else setError(r.error ?? "Failed to save")
  }

  return (
    <div className="rounded-lg border border-gray-200 p-4">
      <h2 className="text-lg font-semibold text-gray-900">What your brokerage offers agents</h2>
      <p className="text-sm text-gray-600 mt-1">
        These marks drive your recruiting surfaces (careers page, pitch one-pager) and your agents&apos;
        tools. Anything left off is treated as not offered — nothing is ever advertised by default.
      </p>
      <div className="mt-4 divide-y divide-gray-100">
        {ROWS.map((row) => {
          const on = state?.[row.key] ?? null
          return (
            <div key={row.key} className="py-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">{row.title}</h3>
                  <p className="text-sm text-gray-600 mt-1">{row.body}</p>
                </div>
                <button
                  type="button"
                  onClick={() => toggle(row.key)}
                  disabled={on === null || saving !== null}
                  aria-pressed={!!on}
                  aria-label={row.title}
                  className={
                    "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 mt-1 " +
                    (on ? "bg-green-600" : "bg-gray-300")
                  }
                >
                  <span
                    className={
                      "inline-block h-5 w-5 transform rounded-full bg-white transition-transform " +
                      (on ? "translate-x-5" : "translate-x-1")
                    }
                  />
                </button>
              </div>
              {/* The distribution model rides the residual-income row: telling
                  the platform HOW is part of offering it, so the panel shows
                  whenever the mark is on. */}
              {row.key === "revenue_share" && on === true && <RevenueShareModelPanel />}
            </div>
          )
        })}
      </div>
      {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
    </div>
  )
}
