'use client'

// C15 (wave 148, lane 148B): the ONE consent component — this form no longer renders its own consent checkbox.
import { ConsentBoxes, useConsentBoxes } from '@/app/components/forms/ConsentBoxes'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

type FormField = {
  key: string
  label: string
  type: 'text' | 'email' | 'tel' | 'textarea' | 'select'
  required?: boolean
  options?: string[]
  placeholder?: string
}

interface FormDef {
  id: string
  slug: string
  fields: FormField[]
  tcpa_disclosure_text: string | null
  thank_you_message: string | null
  redirect_url: string | null
}

interface Props {
  form: FormDef
  /** The name the consent names — THE one brand rule, resolved by the page exactly as the kernel re-renders it. */
  consentBrandName?: string
}

export default function FormRenderer({ form, consentBrandName = 'our brokerage' }: Props) {
  const router = useRouter()
  const [values, setValues] = useState<Record<string, string>>({})
  const consent = useConsentBoxes('web_form', consentBrandName)
  const [submitted, setSubmitted] = useState(false)
  const [thankYou, setThankYou] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const fields: FormField[] = Array.isArray(form.fields) ? form.fields : []

  function handleChange(key: string, value: string) {
    setValues(prev => ({ ...prev, [key]: value }))
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!consent.serviceGiven) {
      setError('Please tick the first consent box (the service follow-up) so we can follow up on your request.')
      return
    }

    setError(null)
    startTransition(async () => {
      try {
        // THE CONSENT TRAVELS WITH THE SUBMISSION (wave 142): this body used to carry no tcpaConsent at all, so
        // the door read every submission as un-consented and dropped the phone the visitor typed — while the
        // checkbox above was required. The checked box and the text the visitor agreed to are sent.
        const res = await fetch('/api/forms/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            slug: form.slug,
            data: values,
            consent: consent.submission,
          }),
        })
        const json = await res.json() as {
          success: boolean
          redirect?: string | null
          thankYouMessage?: string | null
          error?: string
        }

        if (!json.success) {
          setError(json.error ?? 'Submission failed. Please try again.')
          return
        }

        if (json.redirect) {
          router.push(json.redirect)
          return
        }

        setThankYou(json.thankYouMessage ?? 'Thank you! Your information has been received.')
        setSubmitted(true)
      } catch {
        setError('An unexpected error occurred. Please try again.')
      }
    })
  }

  if (submitted) {
    return (
      <div className="rounded-lg border border-border bg-card p-8 text-center">
        <p className="text-lg font-medium text-foreground text-balance">{thankYou}</p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-lg border border-border bg-card p-6 space-y-5">
      {fields.map(field => (
        <div key={field.key} className="flex flex-col gap-1.5">
          <label htmlFor={field.key} className="text-sm font-medium text-foreground">
            {field.label}
            {field.required && <span className="text-destructive ml-1" aria-hidden>*</span>}
          </label>

          {field.type === 'textarea' ? (
            <textarea
              id={field.key}
              required={field.required}
              value={values[field.key] ?? ''}
              onChange={e => handleChange(field.key, e.target.value)}
              rows={4}
              placeholder={field.placeholder || undefined}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          ) : field.type === 'select' && field.options ? (
            <select
              id={field.key}
              required={field.required}
              value={values[field.key] ?? ''}
              onChange={e => handleChange(field.key, e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">Select...</option>
              {field.options.map(opt => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          ) : (
            <input
              id={field.key}
              type={field.type}
              required={field.required}
              value={values[field.key] ?? ''}
              onChange={e => handleChange(field.key, e.target.value)}
              placeholder={field.placeholder || undefined}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          )}
        </div>
      ))}

      {/* C15 — the ONE consent component: explicit, visible, service delivery required, marketing optional per channel. */}
      <ConsentBoxes {...consent.boxProps} idPrefix={`form-consent-${form.slug}`} className="rounded-md border border-border bg-muted/40 p-4" />

      {error && (
        <p role="alert" className="text-sm text-destructive">{error}</p>
      )}

      <button
        type="submit"
        disabled={isPending || !consent.serviceGiven}
        className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {isPending ? 'Submitting...' : 'Submit'}
      </button>
    </form>
  )
}
