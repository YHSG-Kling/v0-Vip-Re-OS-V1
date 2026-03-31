'use client'

import { useState, useTransition, useEffect } from 'react'

type FormField = {
  key: string
  label: string
  type: 'text' | 'email' | 'tel' | 'textarea' | 'select'
  required?: boolean
  options?: string[]
}

type FormRow = {
  id: string
  name: string
  slug: string
  is_active: boolean
  submission_count: number | null
  created_at: string
  fields: FormField[] | null
  tcpa_disclosure_text: string | null
  redirect_url: string | null
  thank_you_message: string | null
}

interface Props {
  forms: FormRow[]
  brokerageId: string
  baseUrl: string
}

const DEFAULT_TCPA =
  'By submitting this form you agree to receive communications from us regarding real estate services. Message and data rates may apply. You may opt out at any time.'

const emptyForm = () => ({
  name: '',
  slug: '',
  tcpa_disclosure_text: DEFAULT_TCPA,
  redirect_url: '',
  thank_you_message: 'Thank you! We will be in touch shortly.',
  fields: [
    { key: 'first_name', label: 'First Name', type: 'text' as const, required: true },
    { key: 'last_name', label: 'Last Name', type: 'text' as const, required: true },
    { key: 'email', label: 'Email', type: 'email' as const, required: true },
    { key: 'phone', label: 'Phone', type: 'tel' as const, required: false },
  ],
})

// ── Types for transaction forms ────────────────────────────────────────────

type TransactionFormTemplate = {
  id: string
  name: string
  form_type: string
  state_code?: string
  is_required: boolean
  category?: string
}

type TransactionFormsState = {
  status: 'idle' | 'loading' | 'loaded' | 'error'
  provider: string | null
  templates: TransactionFormTemplate[]
  error: string | null
}

// ── Component ──────────────────────────────────────────────────────────────

export default function FormsManagerClient({ forms: initialForms, brokerageId, baseUrl }: Props) {
  const [forms, setForms] = useState<FormRow[]>(initialForms)
  const [showModal, setShowModal] = useState(false)
  const [draft, setDraft] = useState(emptyForm())
  const [copied, setCopied] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [activeTab, setActiveTab] = useState<'lead-capture' | 'transaction-forms'>('lead-capture')
  const [txForms, setTxForms] = useState<TransactionFormsState>({
    status: 'idle',
    provider: null,
    templates: [],
    error: null,
  })

  // Load transaction form templates when tab is first opened
  useEffect(() => {
    if (activeTab !== 'transaction-forms' || txForms.status !== 'idle') return
    setTxForms(s => ({ ...s, status: 'loading' }))
    fetch('/api/forms/templates')
      .then(r => r.json())
      .then((json: { success: boolean; provider?: string; templates?: TransactionFormTemplate[]; error?: string }) => {
        if (json.success) {
          setTxForms({ status: 'loaded', provider: json.provider ?? null, templates: json.templates ?? [], error: null })
        } else {
          setTxForms(s => ({ ...s, status: 'error', error: json.error ?? 'Failed to load templates' }))
        }
      })
      .catch(() => setTxForms(s => ({ ...s, status: 'error', error: 'Network error loading templates' })))
  }, [activeTab, txForms.status])

  function handleCopy(slug: string) {
    const url = `${baseUrl}/forms/${slug}`
    void navigator.clipboard.writeText(url)
    setCopied(slug)
    setTimeout(() => setCopied(null), 2000)
  }

  function updateField(index: number, patch: Partial<FormField>) {
    setDraft(prev => {
      const fields = [...prev.fields]
      fields[index] = { ...fields[index], ...patch }
      return { ...prev, fields }
    })
  }

  function addField() {
    setDraft(prev => ({
      ...prev,
      fields: [
        ...prev.fields,
        { key: `field_${Date.now()}`, label: 'New Field', type: 'text', required: false },
      ],
    }))
  }

  function removeField(index: number) {
    setDraft(prev => ({
      ...prev,
      fields: prev.fields.filter((_, i) => i !== index),
    }))
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/forms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...draft, brokerage_id: brokerageId }),
        })
        const json = await res.json() as { success: boolean; form?: FormRow; error?: string }
        if (!json.success || !json.form) {
          setError(json.error ?? 'Failed to create form')
          return
        }
        setForms(prev => [json.form!, ...prev])
        setShowModal(false)
        setDraft(emptyForm())
      } catch {
        setError('An unexpected error occurred')
      }
    })
  }

  async function toggleActive(id: string, current: boolean) {
    const res = await fetch(`/api/admin/forms/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !current }),
    })
    if (res.ok) {
      setForms(prev =>
        prev.map(f => (f.id === id ? { ...f, is_active: !current } : f))
      )
    }
  }

  return (
    <div className="p-6 space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Forms</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Lead capture forms and transaction document templates.
          </p>
        </div>
        {activeTab === 'lead-capture' && (
          <button
            onClick={() => setShowModal(true)}
            className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            + Create Form
          </button>
        )}
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 rounded-lg border border-border bg-muted/40 p-1 w-fit">
        <button
          onClick={() => setActiveTab('lead-capture')}
          className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
            activeTab === 'lead-capture'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Lead Capture
        </button>
        <button
          onClick={() => setActiveTab('transaction-forms')}
          className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
            activeTab === 'transaction-forms'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Transaction Forms
        </button>
      </div>

      {/* ── Transaction Forms panel ───────────────────────────────────────── */}
      {activeTab === 'transaction-forms' && (
        <div className="space-y-4">
          {/* Provider status */}
          <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 flex items-center justify-between">
            <div className="space-y-0.5">
              <p className="text-sm font-medium text-foreground">Forms Provider</p>
              <p className="text-xs text-muted-foreground">
                {txForms.status === 'loading' && 'Detecting provider…'}
                {txForms.status === 'loaded' && (txForms.provider
                  ? `Connected: ${txForms.provider.charAt(0).toUpperCase() + txForms.provider.slice(1)}`
                  : 'No provider connected — templates are unavailable')}
                {txForms.status === 'error' && (txForms.error ?? 'Error loading provider')}
                {txForms.status === 'idle' && 'Loading…'}
              </p>
            </div>
            <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
              txForms.status === 'loaded' && txForms.provider
                ? 'bg-green-100 text-green-800'
                : txForms.status === 'error'
                ? 'bg-red-100 text-red-800'
                : 'bg-muted text-muted-foreground'
            }`}>
              {txForms.status === 'loaded' && txForms.provider ? 'Connected' : txForms.status === 'error' ? 'Error' : 'Checking'}
            </span>
          </div>

          {/* Templates table */}
          {txForms.status === 'loading' && (
            <div className="rounded-lg border border-border py-12 text-center text-sm text-muted-foreground">
              Loading templates…
            </div>
          )}
          {txForms.status === 'error' && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 py-8 text-center space-y-2">
              <p className="text-sm font-medium text-destructive">{txForms.error}</p>
              <button
                onClick={() => setTxForms(s => ({ ...s, status: 'idle', error: null }))}
                className="text-xs text-primary hover:underline"
              >
                Retry
              </button>
            </div>
          )}
          {txForms.status === 'loaded' && (
            <div className="rounded-lg border border-border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">Form Name</th>
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">Type</th>
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">State</th>
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">Required</th>
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">Category</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {txForms.templates.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                        {txForms.provider
                          ? 'No templates available from this provider.'
                          : 'Connect a forms provider in Settings to see available templates.'}
                      </td>
                    </tr>
                  ) : (
                    txForms.templates.map(t => (
                      <tr key={t.id} className="bg-background hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-3 font-medium text-foreground">{t.name}</td>
                        <td className="px-4 py-3 text-muted-foreground capitalize">{t.form_type.replace(/_/g, ' ')}</td>
                        <td className="px-4 py-3 text-muted-foreground">{t.state_code ?? '—'}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                            t.is_required ? 'bg-amber-100 text-amber-800' : 'bg-muted text-muted-foreground'
                          }`}>
                            {t.is_required ? 'Required' : 'Optional'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground capitalize">{t.category ?? '—'}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Lead Capture panel ───────────────────────────────────────────── */}
      {activeTab === 'lead-capture' && (
        <>
      {/* Forms list */}
      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Name</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Slug</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Submissions</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Share Link</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {forms.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                  No forms yet. Create your first form.
                </td>
              </tr>
            )}
            {forms.map(form => (
              <tr key={form.id} className="bg-background hover:bg-muted/30 transition-colors">
                <td className="px-4 py-3 font-medium text-foreground">{form.name}</td>
                <td className="px-4 py-3 text-muted-foreground font-mono text-xs">{form.slug}</td>
                <td className="px-4 py-3 text-foreground">{form.submission_count ?? 0}</td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => void toggleActive(form.id, form.is_active)}
                    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                      form.is_active
                        ? 'bg-green-100 text-green-800 hover:bg-green-200'
                        : 'bg-muted text-muted-foreground hover:bg-muted/70'
                    }`}
                  >
                    {form.is_active ? 'Active' : 'Inactive'}
                  </button>
                </td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => handleCopy(form.slug)}
                    className="text-xs text-primary hover:underline"
                  >
                    {copied === form.slug ? 'Copied!' : 'Copy Link'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Create Form Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl bg-background border border-border shadow-xl">
            <div className="flex items-center justify-between p-6 border-b border-border">
              <h2 className="text-lg font-semibold text-foreground">Create Form</h2>
              <button
                onClick={() => { setShowModal(false); setError(null) }}
                className="text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreate} className="p-6 space-y-5">
              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-foreground">Form Name</label>
                  <input
                    required
                    value={draft.name}
                    onChange={e => setDraft(p => ({ ...p, name: e.target.value }))}
                    className="rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-foreground">URL Slug</label>
                  <input
                    required
                    value={draft.slug}
                    onChange={e => setDraft(p => ({ ...p, slug: e.target.value.toLowerCase().replace(/\s+/g, '-') }))}
                    placeholder="my-form-slug"
                    className="rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              </div>

              {/* Fields builder */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-foreground">Fields</span>
                  <button
                    type="button"
                    onClick={addField}
                    className="text-xs text-primary hover:underline"
                  >
                    + Add Field
                  </button>
                </div>
                <div className="space-y-2">
                  {draft.fields.map((field, i) => (
                    <div key={field.key} className="flex items-center gap-2 rounded-md border border-border p-2">
                      <input
                        value={field.label}
                        onChange={e => updateField(i, { label: e.target.value })}
                        placeholder="Label"
                        className="flex-1 rounded border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                      <select
                        value={field.type}
                        onChange={e => updateField(i, { type: e.target.value as FormField['type'] })}
                        className="rounded border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                      >
                        <option value="text">Text</option>
                        <option value="email">Email</option>
                        <option value="tel">Phone</option>
                        <option value="textarea">Textarea</option>
                        <option value="select">Select</option>
                      </select>
                      <label className="flex items-center gap-1 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={field.required ?? false}
                          onChange={e => updateField(i, { required: e.target.checked })}
                          className="accent-primary"
                        />
                        Req
                      </label>
                      <button
                        type="button"
                        onClick={() => removeField(i)}
                        className="text-destructive text-xs hover:underline"
                        aria-label="Remove field"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* TCPA text */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-foreground">TCPA Disclosure Text</label>
                <textarea
                  required
                  rows={3}
                  value={draft.tcpa_disclosure_text}
                  onChange={e => setDraft(p => ({ ...p, tcpa_disclosure_text: e.target.value }))}
                  className="rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-foreground">Redirect URL</label>
                  <input
                    type="url"
                    value={draft.redirect_url}
                    onChange={e => setDraft(p => ({ ...p, redirect_url: e.target.value }))}
                    placeholder="https://..."
                    className="rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-foreground">Thank You Message</label>
                  <input
                    value={draft.thank_you_message}
                    onChange={e => setDraft(p => ({ ...p, thank_you_message: e.target.value }))}
                    className="rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              </div>

              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => { setShowModal(false); setError(null) }}
                  className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors"
                >
                  Cancel
                </button>
              <button
                type="submit"
                disabled={isPending}
                className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {isPending ? 'Creating...' : 'Create Form'}
              </button>
            </div>
          </form>
        </div>
      )}
        </>
      )}
    </div>
  )
}
