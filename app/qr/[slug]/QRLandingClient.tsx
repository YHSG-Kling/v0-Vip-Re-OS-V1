'use client'

import { useState, useTransition } from 'react'
import Image from 'next/image'

interface Props {
  slug: string
  qrCodeId: string
  label: string
  purpose: string | null
  agentName: string | null
  agentPhoto: string | null
  listingAddress: string | null
}

interface FormState {
  first_name: string
  last_name: string
  email: string
  phone: string
  tcpa_checked: boolean
}

export default function QRLandingClient({
  slug,
  qrCodeId,
  label,
  purpose,
  agentName,
  agentPhoto,
  listingAddress,
}: Props) {
  const [form, setForm] = useState<FormState>({
    first_name: '',
    last_name: '',
    email: '',
    phone: '',
    tcpa_checked: false,
  })
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const { name, value, type, checked } = e.target
    setForm((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }))
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (!form.tcpa_checked) {
      setError('You must agree to the consent statement to continue.')
      return
    }
    if (!form.first_name.trim() || !form.last_name.trim()) {
      setError('First and last name are required.')
      return
    }
    if (!form.email.trim() && !form.phone.trim()) {
      setError('Email or phone number is required.')
      return
    }

    startTransition(async () => {
      try {
        const res = await fetch('/api/qr/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            slug,
            qrCodeId,
            first_name: form.first_name.trim(),
            last_name: form.last_name.trim(),
            email: form.email.trim() || undefined,
            phone: form.phone.trim() || undefined,
            tcpa_checked: form.tcpa_checked,
          }),
        })
        const json = (await res.json()) as { success: boolean; error?: string }
        if (!json.success) {
          setError(json.error ?? 'Something went wrong. Please try again.')
          return
        }
        setSubmitted(true)
      } catch {
        setError('Network error. Please try again.')
      }
    })
  }

  if (submitted) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="max-w-md w-full text-center space-y-4 py-16">
          <div className="text-5xl font-bold text-primary">Thank you!</div>
          <p className="text-muted-foreground text-lg">
            We received your information and will be in touch shortly.
          </p>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-background flex flex-col items-center justify-start px-4 py-12">
      <div className="w-full max-w-md space-y-8">

        {/* Agent card */}
        {agentName && (
          <div className="flex items-center gap-4">
            {agentPhoto ? (
              <Image
                src={agentPhoto}
                alt={agentName}
                width={56}
                height={56}
                className="rounded-full object-cover border border-border"
              />
            ) : (
              <div className="w-14 h-14 rounded-full bg-muted flex items-center justify-center text-xl font-semibold text-muted-foreground">
                {agentName.charAt(0).toUpperCase()}
              </div>
            )}
            <div>
              <p className="font-semibold text-foreground">{agentName}</p>
              {purpose && (
                <p className="text-sm text-muted-foreground">{purpose}</p>
              )}
            </div>
          </div>
        )}

        {/* Header */}
        <div className="space-y-1">
          <h1 className="text-2xl font-bold text-foreground text-balance">{label}</h1>
          {listingAddress && (
            <p className="text-muted-foreground text-sm">{listingAddress}</p>
          )}
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label htmlFor="first_name" className="text-sm font-medium text-foreground">
                First Name <span className="text-destructive">*</span>
              </label>
              <input
                id="first_name"
                name="first_name"
                type="text"
                autoComplete="given-name"
                required
                value={form.first_name}
                onChange={handleChange}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder="Jane"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="last_name" className="text-sm font-medium text-foreground">
                Last Name <span className="text-destructive">*</span>
              </label>
              <input
                id="last_name"
                name="last_name"
                type="text"
                autoComplete="family-name"
                required
                value={form.last_name}
                onChange={handleChange}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder="Doe"
              />
            </div>
          </div>

          <div className="space-y-1">
            <label htmlFor="email" className="text-sm font-medium text-foreground">
              Email Address
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              value={form.email}
              onChange={handleChange}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="jane@example.com"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="phone" className="text-sm font-medium text-foreground">
              Phone Number
            </label>
            <input
              id="phone"
              name="phone"
              type="tel"
              autoComplete="tel"
              value={form.phone}
              onChange={handleChange}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="(555) 000-0000"
            />
          </div>

          {/* TCPA */}
          <div className="flex items-start gap-3 rounded-md border border-border bg-muted/30 p-3">
            <input
              id="tcpa_checked"
              name="tcpa_checked"
              type="checkbox"
              checked={form.tcpa_checked}
              onChange={handleChange}
              className="mt-0.5 h-4 w-4 rounded border-border accent-primary cursor-pointer"
              required
            />
            <label htmlFor="tcpa_checked" className="text-xs text-muted-foreground leading-relaxed cursor-pointer">
              By submitting this form, I consent to receive calls, texts, and emails from this agent
              and their brokerage regarding real estate services. I understand I may opt out at any time.
              Message and data rates may apply.
            </label>
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={isPending}
            className="w-full rounded-md bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {isPending ? 'Submitting...' : 'Get in Touch'}
          </button>
        </form>
      </div>
    </main>
  )
}
