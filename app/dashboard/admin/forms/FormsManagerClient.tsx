'use client'

/**
 * TOMBSTONE (wave 142, lane 142E — orphan doctrine §1.1): the LEAD-CAPTURE half of this client — a second
 * builder (create / edit modal with a field editor, slug, placeholder, "who fills this form", TCPA text,
 * redirect, thank-you), its table (toggle active, copy /forms/<slug>) and its two doors (POST /api/admin/forms,
 * PATCH /api/admin/forms/[id]) — DUPLICATED the lead-magnet builder on the SAME table (lead_capture_forms).
 * SURVIVOR: app/components/features/lead-magnets/{MagnetBuilder,MagnetDraftReview,MagnetLibrary}.tsx on
 * lib/kernel/lead-magnets.ts (draft → human review → publish; capture with delivery, handoff, consent,
 * attribution, sequences). MERGED onto the survivor before deletion: the declared persona
 * (lib/lead-magnets/form-contact-types.ts → settings.default_contact_type, honoured by
 * captureFormSubmission) and the "Custom Form" questions editor (already there since wave 141).
 * The two admin routes (POST /api/admin/forms — app/api/admin/forms/route.ts; PATCH /api/admin/forms/[id] —
 * app/api/admin/forms/[id]/route.ts) were DELETED at wave-142 integration:
 * no in-tree caller remained once this builder left, and a session-gated door nobody addresses is the orphan the
 * one-sided census names. SURVIVOR for both: lib/kernel/lead-magnets.ts createLeadMagnet / publishLeadMagnet (draft
 * edits ride saveMagnetLandingContentAction) behind app/actions/lead-magnets-actions.ts (the lead-magnet workspace).
 * This client keeps the TRANSACTION-FORMS tab byte-for-byte (a different function) and points lead capture
 * at its survivor.
 */

import { useState, useEffect } from 'react'
import Link from 'next/link'

// ── Types for transaction forms ────────────────────────────────────────────

type TransactionFormTemplate = {
  id: string
  name: string
  form_type: string
  state?: string
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

export default function FormsManagerClient() {
  const [activeTab, setActiveTab] = useState<'lead-capture' | 'transaction-forms'>('lead-capture')
  const [txForms, setTxForms] = useState<TransactionFormsState>({
    status: 'idle',
    provider: null,
    templates: [],
    error: null,
  })

  // Load transaction form templates when tab is first opened. The endpoint
  // REQUIRES a context_type — omitting it returns a 400, which is exactly the
  // "error message" the tab used to show.
  useEffect(() => {
    if (activeTab !== 'transaction-forms' || txForms.status !== 'idle') return
    setTxForms(s => ({ ...s, status: 'loading' }))
    fetch('/api/forms/templates?context_type=transaction')
      .then(r => r.json())
      .then((json: { success?: boolean; provider?: string | null; forms?: TransactionFormTemplate[]; error?: string }) => {
        if (json.success) {
          setTxForms({ status: 'loaded', provider: json.provider ?? null, templates: json.forms ?? [], error: null })
        } else {
          setTxForms(s => ({ ...s, status: 'error', error: json.error ?? 'Failed to load templates' }))
        }
      })
      .catch(() => setTxForms(s => ({ ...s, status: 'error', error: 'Network error loading templates' })))
  }, [activeTab, txForms.status])

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
          Legal Forms
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
                {txForms.status === 'loaded' && (txForms.provider && txForms.provider !== 'not_configured'
                  ? `Connected: ${txForms.provider.charAt(0).toUpperCase() + txForms.provider.slice(1)}`
                  : 'No provider connected — showing the standard template library. Connect one in Settings → Integrations to e-sign.')}
                {txForms.status === 'error' && (txForms.error ?? 'Error loading provider')}
                {txForms.status === 'idle' && 'Loading…'}
              </p>
            </div>
            <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
              txForms.status === 'loaded' && txForms.provider && txForms.provider !== 'not_configured'
                ? 'bg-green-100 text-green-800'
                : txForms.status === 'error'
                ? 'bg-red-100 text-red-800'
                : 'bg-muted text-muted-foreground'
            }`}>
              {txForms.status === 'loaded' && txForms.provider && txForms.provider !== 'not_configured' ? 'Connected' : txForms.status === 'error' ? 'Error' : txForms.status === 'loaded' ? 'Library' : 'Checking'}
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
            <div className="rounded-lg border border-border overflow-x-auto">
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
                        No templates available.
                      </td>
                    </tr>
                  ) : (
                    txForms.templates.map(t => (
                      <tr key={t.id} className="bg-background hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-3 font-medium text-foreground">{t.name}</td>
                        <td className="px-4 py-3 text-muted-foreground capitalize">{t.form_type.replace(/_/g, ' ')}</td>
                        <td className="px-4 py-3 text-muted-foreground">{t.state ?? '—'}</td>
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

      {/* ── Lead Capture panel — ONE builder (the lead-magnet workspace) ──────── */}
      {activeTab === 'lead-capture' && (
        <div className="rounded-lg border border-border bg-muted/20 p-6 space-y-3">
          <p className="text-sm font-medium text-foreground">Lead capture forms live in the Lead Magnets workspace.</p>
          <p className="text-sm text-muted-foreground">
            Every capture form — custom forms, home-value pages, buyer and seller guides, market reports, listing alerts,
            open-house RSVPs and AI-written books — is built, reviewed and published in one place, with the same questions
            editor, the AI draft, the fair-housing review, the QR code, the embed snippet and the attribution every
            submission keeps. A custom form can declare who fills it (buyers, sellers or both) so the right welcome and
            manager pick the person up.
          </p>
          <Link
            href="/dashboard/marketing/lead-magnets"
            className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Open Lead Magnets
          </Link>
        </div>
      )}
    </div>
  )
}
