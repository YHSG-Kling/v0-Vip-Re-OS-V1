"use client"

/**
 * app/components/forms/ConsentBoxes.tsx — CONTRACT C15, THE ONE CONSENT COMPONENT (wave 148, lane 148B).
 *
 * Every public form that creates a contact renders THIS — no form renders its own consent checkbox
 * (scripts/one-door-consent-guard.ts holds the census). The words come from the pure contract
 * lib/kernel/compliance/consent-component.ts, the same function the server re-renders when it records what was ticked, so
 * what a person reads and what the ledger stores cannot drift.
 *
 *   · one REQUIRED box — contact me about the thing I asked for (service delivery);
 *   · OPTIONAL marketing, one explicit box per channel the form offers (email · text · phone call · direct mail);
 *   · nothing pre-checked; the way out (unsubscribe link, reply STOP) stated under the boxes.
 *
 * Accessible: native checkboxes with real <label>s, a fieldset/legend for the optional group, keyboard-operable, and the
 * required box marked aria-required. Palette tokens only (foreground / muted-foreground / border / primary).
 */

import { useMemo, useState } from "react"
import {
  CONSENT_COMPONENT_CHANNELS,
  DEFAULT_OFFERED_CHANNELS,
  EMPTY_CONSENT_VALUE,
  consentComponentWording,
  consentSubmissionFor,
  type ConsentComponentChannel,
  type ConsentComponentSubmission,
  type ConsentComponentValue,
  type ConsentDoorKey,
} from "@/lib/kernel/compliance/consent-component"

const CHANNEL_LABEL: Record<ConsentComponentChannel, string> = {
  email: "Email",
  sms: "Text messages",
  voice: "Phone calls",
  direct_mail: "Mail",
}

export interface ConsentBoxesProps {
  door: ConsentDoorKey
  /** The brokerage / agent the person is giving consent to — the server reads the same name off the form owner. */
  brandName: string
  value: ConsentComponentValue
  onChange: (next: ConsentComponentValue) => void
  /** The marketing channels this form offers (default email · text · phone). Offer direct_mail where an address is collected. */
  offered?: readonly ConsentComponentChannel[]
  /** Unique per page when a page renders more than one form. */
  idPrefix?: string
  className?: string
  /** Smaller type for compact widgets (chat, embed, kiosk side panel). */
  compact?: boolean
}

export function ConsentBoxes({ door, brandName, value, onChange, offered = DEFAULT_OFFERED_CHANNELS, idPrefix = "consent", className, compact }: ConsentBoxesProps) {
  const wording = useMemo(() => consentComponentWording({ door, brandName }), [door, brandName])
  const text = compact ? "text-[11px]" : "text-xs"
  const channels = CONSENT_COMPONENT_CHANNELS.filter((c) => offered.includes(c))
  return (
    <div className={`space-y-2 ${text} text-muted-foreground ${className ?? ""}`} data-consent-component={wording.version}>
      <label htmlFor={`${idPrefix}-service`} className="flex items-start gap-2 text-foreground">
        <input
          id={`${idPrefix}-service`}
          type="checkbox"
          className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
          checked={value.serviceDelivery}
          aria-required="true"
          onChange={(e) => onChange({ ...value, serviceDelivery: e.target.checked })}
        />
        <span>{wording.serviceDelivery} <span aria-hidden="true">*</span></span>
      </label>
      {channels.length > 0 && (
        <fieldset className="space-y-1.5 rounded-md border border-border p-2">
          <legend className="px-1">{wording.marketingLead}</legend>
          {channels.map((c) => (
            <label key={c} htmlFor={`${idPrefix}-${c}`} className="flex items-start gap-2">
              <input
                id={`${idPrefix}-${c}`}
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                checked={value.marketing[c]}
                onChange={(e) => onChange({ ...value, marketing: { ...value.marketing, [c]: e.target.checked } })}
              />
              <span><span className="font-medium text-foreground">{CHANNEL_LABEL[c]}.</span> {wording.marketing[c]}</span>
            </label>
          ))}
        </fieldset>
      )}
      <p>{wording.footer}</p>
    </div>
  )
}

/**
 * The state + submission a form needs, in one hook: `serviceGiven` gates the submit button, `submission` is what the form
 * posts (the server re-renders the words from it — it never posts text or a hash).
 */
export function useConsentBoxes(door: ConsentDoorKey, brandName: string, offered: readonly ConsentComponentChannel[] = DEFAULT_OFFERED_CHANNELS): {
  value: ConsentComponentValue
  setValue: (v: ConsentComponentValue) => void
  serviceGiven: boolean
  submission: ConsentComponentSubmission
  boxProps: Pick<ConsentBoxesProps, "door" | "brandName" | "value" | "onChange" | "offered">
} {
  const [value, setValue] = useState<ConsentComponentValue>(EMPTY_CONSENT_VALUE)
  const submission = useMemo(() => consentSubmissionFor(value, { door, brandName, offered }), [value, door, brandName, offered])
  return { value, setValue, serviceGiven: value.serviceDelivery, submission, boxProps: { door, brandName, value, onChange: setValue, offered } }
}
