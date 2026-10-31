"use client"

// Wave 143 (lane 143E) — THE FOLLOW-UP POLICY, in the tenant's hands.
// Owner: "the follow-up timetable must not depend on code". brokerage_settings.settings.followup_policy is the ONE place every
// follow-up number lives (lib/ai-isa/followup-policy.ts); the AI decides WHETHER, WHEN and HOW to follow up (email, text, a task
// for the agent, property or market info, a video, education, or wait) INSIDE these limits, and the legal limits (consent, DNC,
// the 8am-9pm send window) are never loosened by anything saved here. Every save is an immutable, revertible tenant_policy_versions
// row. Tenant admins only: /referrals renders this card only when getFollowupPolicyAction passed its gate, and the save re-runs
// that gate server-side. A number the policy reader would have to correct is REFUSED by the save, with the reason — shown, never hidden.
import { useState, useTransition } from "react"
import { Check, Loader2, RotateCcw, Sparkles } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { saveFollowupPolicyAction } from "@/app/actions/settings/brokerage-column-settings"
import type { FollowupPolicy } from "@/lib/ai-isa/followup-policy"

export interface FollowupPolicyInitial {
  canEdit: boolean
  /** The policy as the managers read it (platform defaults where the tenant never set one). */
  effective: FollowupPolicy
  /** The platform defaults (what "reset" returns to). */
  defaults: FollowupPolicy
  /** True when the tenant has stored a policy of its own. */
  isCustom: boolean
  /** What the reader had to correct in the stored value — shown, never hidden. */
  adjustments: string[]
}

type Group = "guardrails" | "reengagement" | "sphere" | "nurture" | "arbiter"
interface NumField { group: Group; key: string; label: string; step?: number }

// Every numeric field of the policy. The guard (scripts/intent-driven-followup-guard.ts) derives the policy's numeric keys from
// DEFAULT_FOLLOWUP_POLICY and fails if one is missing here, so a number added to the policy cannot be left without a form field.
const LIMITS: NumField[] = [
  { group: "guardrails", key: "minHoursBetweenTouches", label: "Hours between any two automated touches (minimum)" },
  { group: "guardrails", key: "agentActiveDays", label: "Days a human agent's own touch keeps the AI hands-off" },
  { group: "guardrails", key: "callCooldownDays", label: "AI ISA calls: days before the same person is proposed for another call" },
  { group: "guardrails", key: "coldCallCooldownDays", label: "…and after a call that went cold" },
  { group: "arbiter", key: "maxDeferDays", label: "Longest the AI may postpone a follow-up (days)" },
]
const ENVELOPE: NumField[] = [
  { group: "reengagement", key: "staleDays", label: "A lead counts as stale after (days)" },
  { group: "reengagement", key: "lifetimeStaleDays", label: "A past client counts as quiet after (days)" },
  { group: "reengagement", key: "ghostedDays", label: "A lead counts as ghosted after (days)" },
  { group: "reengagement", key: "phase1WindowDays", label: "First re-engagement window (days)" },
  { group: "reengagement", key: "phase2SpacingDays", label: "Spacing in the second phase (days)" },
  { group: "reengagement", key: "phase3SpacingDays", label: "Spacing in the long-term phase (days)" },
  { group: "reengagement", key: "maxGhostAttempts", label: "Most re-engagement attempts for a ghosted lead" },
  { group: "reengagement", key: "maxHorizonAttempts", label: "Most re-engagement attempts over the long term" },
  { group: "sphere", key: "lifeEventWindowDays", label: "A life event stays relevant for (days)" },
  { group: "sphere", key: "valueCheckWindowDays", label: "A home-value change stays relevant for (days)" },
  { group: "sphere", key: "anniversaryLookaheadDays", label: "Look ahead for anniversaries (days)" },
  { group: "sphere", key: "goneQuietDays", label: "A relationship counts as gone quiet after (days)" },
  { group: "nurture", key: "signalWindowDays", label: "A re-activation signal counts for (days)" },
  { group: "nurture", key: "enrollmentSpacingDays", label: "Re-enroll a long-term lead no sooner than (days)" },
  { group: "nurture", key: "reactivationScoreThreshold", label: "Wake the AI only at or above this lead score" },
  { group: "arbiter", key: "maxDecisionsPerRun", label: "Most AI decisions per daily sweep" },
  { group: "arbiter", key: "minConfidence", label: "Lowest AI confidence that may change the default (0 to 1)", step: 0.05 },
]

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MOMENT_LABELS: Record<string, string> = {
  post_close_3_day: "First days in the home",
  post_close_30_day: "Settled-in check",
  post_close_6_month: "Half-year check-in",
  home_anniversary: "Home anniversary",
  referral_request: "Referral invitation",
  thank_you: "Thank-you",
  market_update: "Market update",
  holiday: "Holiday",
  custom: "Custom",
}
type Channel = "video" | "sms" | "email"
interface MomentDraft { key: string; include: boolean; days: string; channel: Channel; intent: string }

const numKey = (f: { group: string; key: string }) => `${f.group}.${f.key}`
const read = (p: FollowupPolicy, f: NumField): number => ((p as unknown as Record<string, Record<string, number>>)[f.group] ?? {})[f.key]

function momentsFrom(effective: FollowupPolicy, defaults: FollowupPolicy): MomentDraft[] {
  // Every default moment is offered (unticked when the tenant removed it) so a removed moment can come back; tenant-only keys follow.
  const keys = [...new Set([...defaults.postClose.map((m) => m.key), ...effective.postClose.map((m) => m.key)])]
  return keys.map((key) => {
    const mine = effective.postClose.find((m) => m.key === key)
    const base = mine ?? defaults.postClose.find((m) => m.key === key)!
    return { key, include: !!mine, days: String(base.afterClosingDays), channel: base.defaultChannel, intent: base.intent }
  })
}

function draftFrom(p: FollowupPolicy, defaults: FollowupPolicy) {
  return {
    guidance: p.guidance,
    nums: Object.fromEntries([...LIMITS, ...ENVELOPE].map((f) => [numKey(f), String(read(p, f))])) as Record<string, string>,
    startHour: String(p.guardrails.quietHours.startHour),
    endHour: String(p.guardrails.quietHours.endHour),
    weekdays: [...p.reengagement.phase1SendWeekdays],
    arbiterEnabled: p.arbiter.enabled,
    moments: momentsFrom(p, defaults),
  }
}

export function FollowupPolicyCard({ initial }: { initial: FollowupPolicyInitial }) {
  const [draft, setDraft] = useState(() => draftFrom(initial.effective, initial.defaults))
  const [custom, setCustom] = useState(initial.isCustom)
  const [pending, startTransition] = useTransition()
  const locked = !initial.canEdit || pending

  const setNum = (f: NumField, v: string) => setDraft((d) => ({ ...d, nums: { ...d.nums, [numKey(f)]: v } }))
  const setMoment = (key: string, patch: Partial<MomentDraft>) =>
    setDraft((d) => ({ ...d, moments: d.moments.map((m) => (m.key === key ? { ...m, ...patch } : m)) }))

  const field = (f: NumField) => (
    <div key={numKey(f)} className="space-y-1">
      <Label htmlFor={`fp-${numKey(f)}`} className="text-xs">{f.label}</Label>
      <Input
        id={`fp-${numKey(f)}`}
        className="h-8 text-xs"
        type="number"
        inputMode="decimal"
        step={f.step ?? 1}
        value={draft.nums[numKey(f)] ?? ""}
        disabled={locked}
        onChange={(e) => setNum(f, e.target.value)}
      />
    </div>
  )

  const save = () =>
    startTransition(async () => {
      const n = (f: NumField) => (draft.nums[numKey(f)]?.trim() === "" ? NaN : Number(draft.nums[numKey(f)]))
      const group = (g: Group) => Object.fromEntries([...LIMITS, ...ENVELOPE].filter((f) => f.group === g).map((f) => [f.key, n(f)]))
      const moments = draft.moments.filter((m) => m.include).map((m) => ({ key: m.key, afterClosingDays: Number(m.days), defaultChannel: m.channel, intent: m.intent }))
      const policy = {
        guidance: draft.guidance,
        guardrails: { ...group("guardrails"), quietHours: { startHour: Number(draft.startHour), endHour: Number(draft.endHour) } },
        reengagement: { ...group("reengagement"), phase1SendWeekdays: draft.weekdays },
        sphere: group("sphere"),
        nurture: group("nurture"),
        postClose: moments,
        arbiter: { ...group("arbiter"), enabled: draft.arbiterEnabled },
      }
      const anyBlank = [...LIMITS, ...ENVELOPE].some((f) => Number.isNaN(n(f))) || [draft.startHour, draft.endHour, ...draft.moments.filter((m) => m.include).map((m) => m.days)].some((s) => s.trim() === "")
      if (anyBlank) {
        toast.error("Every number needs a value — nothing was saved.")
        return
      }
      const r = await saveFollowupPolicyAction(policy)
      if (!r.ok) {
        toast.error(r.error)
        return
      }
      setCustom(true)
      toast.success("Follow-up policy saved — the AI uses it from the next sweep")
    })

  const reset = () =>
    startTransition(async () => {
      const r = await saveFollowupPolicyAction(null)
      if (!r.ok) {
        toast.error(r.error)
        return
      }
      setDraft(draftFrom(initial.defaults, initial.defaults))
      setCustom(false)
      toast.success("Follow-up policy reset to the platform defaults")
    })

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          How the AI follows up with your clients
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          The AI reads each person&apos;s intent and history and chooses whether, when and how to follow up — an email, a text, a task for
          the agent, property or market information, a video, education, or waiting. These are the limits it works inside.
          {custom ? " Your brokerage has its own settings." : " Showing the platform defaults."} Consent, do-not-contact and the 8am–9pm
          send window always apply and cannot be loosened here.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <Label htmlFor="fp-guidance" className="text-xs">In your own words: how should your clients be followed up with?</Label>
          <Textarea
            id="fp-guidance"
            className="text-xs min-h-[72px]"
            maxLength={2000}
            placeholder="e.g. Keep it warm and short. Never text before 10am. Past clients love a yearly home-value note."
            value={draft.guidance}
            disabled={locked}
            onChange={(e) => setDraft((d) => ({ ...d, guidance: e.target.value }))}
          />
        </div>

        <div className="flex items-center gap-2">
          <input
            id="fp-arbiter-enabled"
            type="checkbox"
            checked={draft.arbiterEnabled}
            disabled={locked}
            onChange={(e) => setDraft((d) => ({ ...d, arbiterEnabled: e.target.checked }))}
          />
          <Label htmlFor="fp-arbiter-enabled" className="text-xs">Let the AI choose the best channel and timing (off = the built-in rules decide, no AI cost)</Label>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {LIMITS.map(field)}
          <div className="space-y-1">
            <Label htmlFor="fp-start" className="text-xs">Earliest hour a message may go out (8–21)</Label>
            <Input id="fp-start" className="h-8 text-xs" type="number" value={draft.startHour} disabled={locked} onChange={(e) => setDraft((d) => ({ ...d, startHour: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="fp-end" className="text-xs">Latest hour a message may go out (8–21)</Label>
            <Input id="fp-end" className="h-8 text-xs" type="number" value={draft.endHour} disabled={locked} onChange={(e) => setDraft((d) => ({ ...d, endHour: e.target.value }))} />
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium">After a closing</p>
          <p className="text-xs text-muted-foreground">When each check-in opens. The AI decides whether, how and exactly when within it. Untick one to skip it.</p>
          {draft.moments.map((m) => (
            <div key={m.key} className="grid grid-cols-[auto_1fr_5rem_6rem] items-center gap-2">
              <input id={`fp-m-${m.key}`} type="checkbox" checked={m.include} disabled={locked} onChange={(e) => setMoment(m.key, { include: e.target.checked })} />
              <Label htmlFor={`fp-m-${m.key}`} className="text-xs">{MOMENT_LABELS[m.key] ?? m.key}</Label>
              <Input aria-label={`${MOMENT_LABELS[m.key] ?? m.key}: days after closing`} className="h-8 text-xs" type="number" value={m.days} disabled={locked || !m.include} onChange={(e) => setMoment(m.key, { days: e.target.value })} />
              <select
                aria-label={`${MOMENT_LABELS[m.key] ?? m.key}: usual channel`}
                className="h-8 rounded-md border bg-background px-2 text-xs"
                value={m.channel}
                disabled={locked || !m.include}
                onChange={(e) => setMoment(m.key, { channel: e.target.value === "sms" ? "sms" : e.target.value === "email" ? "email" : "video" })}
              >
                <option value="video">video</option>
                <option value="sms">text</option>
                <option value="email">email</option>
              </select>
            </div>
          ))}
          <p className="text-[11px] text-muted-foreground">Columns: days after closing · the channel used unless the AI finds a better one for that person.</p>
        </div>

        <details className="rounded-md border p-3">
          <summary className="cursor-pointer text-xs font-medium">Re-engagement, relationship and nurture windows</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {ENVELOPE.map(field)}
          </div>
          <div className="mt-3 space-y-1">
            <p className="text-xs">Days of the week the first re-engagement phase may send</p>
            <div className="flex flex-wrap gap-3">
              {WEEKDAYS.map((w, i) => (
                <label key={w} className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={draft.weekdays.includes(i)}
                    disabled={locked}
                    onChange={(e) => setDraft((d) => ({ ...d, weekdays: e.target.checked ? [...new Set([...d.weekdays, i])].sort() : d.weekdays.filter((x) => x !== i) }))}
                  />
                  {w}
                </label>
              ))}
            </div>
          </div>
        </details>

        {initial.adjustments.length > 0 && (
          <p className="text-xs text-destructive">Corrected when read: {initial.adjustments.join("; ")}.</p>
        )}
        <div className="flex gap-2">
          <Button size="sm" disabled={locked} onClick={save}>
            {pending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Check className="h-3.5 w-3.5 mr-1" />}
            Save follow-up policy
          </Button>
          <Button size="sm" variant="outline" disabled={locked || !custom} onClick={reset}>
            <RotateCcw className="h-3.5 w-3.5 mr-1" />
            Reset to defaults
          </Button>
        </div>
        {!initial.canEdit && (
          <p className="text-xs text-muted-foreground">Read-only access — switch to full access to change this.</p>
        )}
      </CardContent>
    </Card>
  )
}
