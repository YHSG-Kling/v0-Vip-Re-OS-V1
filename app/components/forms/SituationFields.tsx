"use client"

/**
 * app/components/forms/SituationFields.tsx — the person's SITUATION on every intake form (wave 148, lane 148B — owner
 * ruling 12: "all forms … should be created with other fields for identity and attributes about that person's situation").
 *
 * Optional, plain-language questions whose answers land on the contact as what the person SAID (never inferred):
 *   · what they want to do  → contacts.contact_type   (buyer · seller · both — the live CHECK vocabulary)
 *   · when                  → contacts.timeline       (the CHECK buckets — CLAUDE.md §5: 1-3 / 3-6 / 6-12, never 30/60/90)
 *   · already working with an agent? → the NAR Article 16 representation disclosure the doors already honour
 * No protected characteristic is ever asked here (fair housing): needs and timing only.
 */

export type SituationIntent = "buyer" | "seller" | "both"
export interface SituationValue {
  intent: SituationIntent | ""
  timeline: string
  workingWithAgent: "" | "yes" | "no"
}

export const EMPTY_SITUATION: SituationValue = { intent: "", timeline: "", workingWithAgent: "" }

/** The contacts.timeline CHECK values, in the order a person thinks about them. */
export const SITUATION_TIMELINES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "immediate", label: "Right away" },
  { value: "1-3_months", label: "In 1–3 months" },
  { value: "3-6_months", label: "In 3–6 months" },
  { value: "6-12_months", label: "In 6–12 months" },
  { value: "12+_months", label: "More than a year out" },
  { value: "researching", label: "Just researching" },
]

/** The JSON a form posts — only what was answered. */
export function situationPayload(v: SituationValue): { intent?: SituationIntent; timeline?: string; working_with_agent?: boolean } {
  return {
    ...(v.intent ? { intent: v.intent } : {}),
    ...(v.timeline ? { timeline: v.timeline } : {}),
    ...(v.workingWithAgent ? { working_with_agent: v.workingWithAgent === "yes" } : {}),
  }
}

export function SituationFields({ value, onChange, idPrefix = "situation", askAgent = false, compact }: {
  value: SituationValue
  onChange: (next: SituationValue) => void
  idPrefix?: string
  /** Ask the representation question (listing / showing / open-house doors). */
  askAgent?: boolean
  compact?: boolean
}) {
  const text = compact ? "text-[11px]" : "text-xs"
  const select = "mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
  return (
    <div className={`grid gap-2 ${compact ? "" : "sm:grid-cols-2"} ${text}`}>
      <label htmlFor={`${idPrefix}-intent`} className="text-muted-foreground">
        I&apos;m looking to (optional)
        <select id={`${idPrefix}-intent`} className={select} value={value.intent} onChange={(e) => onChange({ ...value, intent: e.target.value as SituationIntent | "" })}>
          <option value="">Choose…</option>
          <option value="buyer">Buy</option>
          <option value="seller">Sell</option>
          <option value="both">Buy and sell</option>
        </select>
      </label>
      <label htmlFor={`${idPrefix}-timeline`} className="text-muted-foreground">
        When (optional)
        <select id={`${idPrefix}-timeline`} className={select} value={value.timeline} onChange={(e) => onChange({ ...value, timeline: e.target.value })}>
          <option value="">Choose…</option>
          {SITUATION_TIMELINES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </label>
      {askAgent && (
        <label htmlFor={`${idPrefix}-agent`} className="text-muted-foreground">
          Already working with an agent? (optional)
          <select id={`${idPrefix}-agent`} className={select} value={value.workingWithAgent} onChange={(e) => onChange({ ...value, workingWithAgent: e.target.value as SituationValue["workingWithAgent"] })}>
            <option value="">Choose…</option>
            <option value="no">No</option>
            <option value="yes">Yes</option>
          </select>
        </label>
      )}
    </div>
  )
}
