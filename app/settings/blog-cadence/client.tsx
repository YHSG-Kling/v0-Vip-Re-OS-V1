"use client"

import { useState, useTransition } from "react"
import {
  upsertBlogCadencePolicy,
  type BlogCadencePolicyRow,
  type CadenceValue,
} from "@/app/actions/blog-cadence-policy"

const DOW_LABELS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

const CATEGORY_OPTIONS = [
  { value: "buyer_advice",      label: "Buyer Advice" },
  { value: "seller_advice",     label: "Seller Advice" },
  { value: "finance",           label: "Finance & Mortgage" },
  { value: "market_education",  label: "Market Education" },
  { value: "neighborhood",      label: "Neighborhood" },
  { value: "home_improvement",  label: "Home Improvement" },
]

const PERSONA_OPTIONS = [
  { value: "",                  label: "All audience (no persona bias)" },
  { value: "first_time_buyer",  label: "First-Time Buyer" },
  { value: "investor",          label: "Investor" },
  { value: "lifetime_customer", label: "Lifetime Customer" },
  { value: "luxury",            label: "Luxury" },
  { value: "relocated",         label: "Relocated" },
  { value: "downsize",          label: "Downsizer" },
]

export function BlogCadenceSettingsClient({ initialPolicy }: { initialPolicy: BlogCadencePolicyRow | null }) {
  const [cadence, setCadence] = useState<CadenceValue>((initialPolicy?.cadence as CadenceValue) ?? "off")
  const [fireDay, setFireDay] = useState<number>(initialPolicy?.fire_day ?? 0)
  const [categories, setCategories] = useState<string[]>(initialPolicy?.preferred_categories ?? [])
  const [persona, setPersona] = useState<string>(initialPolicy?.preferred_persona ?? "")
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<Date | null>(null)

  function toggleCategory(value: string) {
    setCategories((prev) => prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value])
  }

  function handleSave() {
    setError(null)
    setSavedAt(null)
    startTransition(async () => {
      const r = await upsertBlogCadencePolicy({
        cadence,
        fireDay:             cadence === "off" ? null : fireDay,
        preferredCategories: categories.length > 0 ? categories : null,
        preferredPersona:    persona || null,
      })
      if (!r.success) {
        setError(r.error ?? "Save failed")
      } else {
        setSavedAt(new Date())
      }
    })
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <header className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Blog Cadence Settings</h1>
        <p className="text-gray-600 mt-2">
          Auto-generate a blog post on a recurring schedule using the platform's content
          intelligence bank. Posts land in your approval queue as drafts — nothing publishes
          to WordPress without your approval.
        </p>
      </header>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-800 rounded">{error}</div>
      )}
      {savedAt && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 text-green-800 rounded">
          Saved at {savedAt.toLocaleTimeString()}
        </div>
      )}

      <div className="space-y-6">
        {/* Cadence */}
        <section className="border rounded-lg p-4">
          <h2 className="font-semibold text-gray-900 mb-3">Cadence</h2>
          <div className="space-y-2">
            {(["off", "weekly", "biweekly", "monthly"] as CadenceValue[]).map((c) => (
              <label key={c} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="cadence"
                  checked={cadence === c}
                  onChange={() => setCadence(c)}
                  disabled={isPending}
                />
                <span className="text-gray-700 capitalize">
                  {c === "off" ? "Off (manual generation only)" : c}
                </span>
              </label>
            ))}
          </div>
        </section>

        {/* Fire day — only when not off */}
        {cadence !== "off" && (
          <section className="border rounded-lg p-4">
            <h2 className="font-semibold text-gray-900 mb-3">
              {cadence === "monthly" ? "Day of Month" : "Day of Week"}
            </h2>
            {cadence === "monthly" ? (
              <select
                value={fireDay}
                onChange={(e) => setFireDay(parseInt(e.target.value, 10))}
                disabled={isPending}
                className="border rounded px-3 py-2 w-32"
              >
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            ) : (
              <select
                value={fireDay}
                onChange={(e) => setFireDay(parseInt(e.target.value, 10))}
                disabled={isPending}
                className="border rounded px-3 py-2 w-40"
              >
                {DOW_LABELS.map((label, idx) => (
                  <option key={idx} value={idx}>{label}</option>
                ))}
              </select>
            )}
            {cadence === "biweekly" && (
              <p className="text-xs text-gray-500 mt-2">
                Biweekly fires on the selected day, even ISO weeks only.
              </p>
            )}
          </section>
        )}

        {/* Preferred categories */}
        {cadence !== "off" && (
          <section className="border rounded-lg p-4">
            <h2 className="font-semibold text-gray-900 mb-1">Preferred Topic Categories</h2>
            <p className="text-sm text-gray-600 mb-3">
              The topic picker biases toward these categories. Leave all unchecked to let
              the picker choose freely from what's trending.
            </p>
            <div className="grid grid-cols-2 gap-2">
              {CATEGORY_OPTIONS.map((cat) => (
                <label key={cat.value} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={categories.includes(cat.value)}
                    onChange={() => toggleCategory(cat.value)}
                    disabled={isPending}
                  />
                  <span className="text-gray-700 text-sm">{cat.label}</span>
                </label>
              ))}
            </div>
          </section>
        )}

        {/* Preferred persona */}
        {cadence !== "off" && (
          <section className="border rounded-lg p-4">
            <h2 className="font-semibold text-gray-900 mb-1">Preferred Audience Persona</h2>
            <p className="text-sm text-gray-600 mb-3">
              The per-(topic, persona) performance loop weights topics that converted with
              this segment. Leave on "All audience" for the brokerage-wide average.
            </p>
            <select
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              disabled={isPending}
              className="border rounded px-3 py-2 w-full max-w-sm"
            >
              {PERSONA_OPTIONS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </section>
        )}

        <div className="flex justify-end">
          <button
            onClick={handleSave}
            disabled={isPending}
            className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {isPending ? "Saving…" : "Save Settings"}
          </button>
        </div>
      </div>
    </div>
  )
}
