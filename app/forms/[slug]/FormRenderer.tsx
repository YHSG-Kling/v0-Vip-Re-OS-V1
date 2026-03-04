'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

type FormField = {
  key: string
  label: string
  type: 'text' | 'email' | 'tel' | 'textarea' | 'select'
  required?: boolean
  options?: string[]
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
}

export default function FormRenderer({ form }: Props) {
  const router = useRouter()
  const [values, setValues] = useState<Record<string, string>>({})
  const [tcpaChecked, setTcpaChecked] = useState(false)
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
    if (!tcpaChecked) {
      setError('You must consent to the terms before submitting.')
      return
    }

    setError(null)
    startTransition(async () => {
      try {
        const res = await fetch('/api/forms/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug: form.slug, data: values }),
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
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          )}
        </div>
      ))}

      {/* TCPA — must be explicit and visible */}
      <div className="rounded-md border border-border bg-muted/40 p-4 space-y-3">
        <p className="text-xs text-muted-foreground leading-relaxed">
          {form.tcpa_disclosure_text ??
            'By submitting this form you consent to receive communications from us. Message and data rates may apply.'}
        </p>
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={tcpaChecked}
            onChange={e => setTcpaChecked(e.target.checked)}
            required
            className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
            aria-label="I agree to the terms above"
          />
          <span className="text-xs text-foreground font-medium">
            I agree to the terms above and consent to be contacted.
          </span>
        </label>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">{error}</p>
      )}

      <button
        type="submit"
        disabled={isPending || !tcpaChecked}
        className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {isPending ? 'Submitting...' : 'Submit'}
      </button>
    </form>
  )
}
