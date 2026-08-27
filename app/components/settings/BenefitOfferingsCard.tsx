"use client"

import { useEffect, useState } from "react"
import {
  getBenefitOfferings,
  setBenefitOffering,
  setRevenueShareEnabled,
  type OfferingKey,
} from "@/app/actions/settings/revenue-share-setting"

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
            <div key={row.key} className="flex items-start justify-between gap-4 py-4">
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
          )
        })}
      </div>
      {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
    </div>
  )
}
