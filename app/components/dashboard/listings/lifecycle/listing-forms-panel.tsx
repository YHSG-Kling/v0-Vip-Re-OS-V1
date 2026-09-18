"use client"

// ═══════════════════════════════════════════════════════════════════════════════
// ListingFormsPanel
//
// Surfaces listing-context forms (Listing Agreement, Seller Disclosure, etc.)
// on the lifecycle page. Uses TransactionFormEsignFlow for the prefill → draft
// → send-for-e-sign flow.
//
// Kernel OS: form data is loaded via loadAvailableFormsAction; e-sign delegated
// to TransactionFormEsignFlow → forms-kernel.ts actions.
// ═══════════════════════════════════════════════════════════════════════════════

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  ClipboardList,
  FileText,
  Loader2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  TriangleAlert,
  CircleCheck,
} from "lucide-react"
import { loadAvailableFormsAction } from "@/app/actions/forms-kernel"
import { prefillListingFormAction } from "@/app/actions/listings-kernel"
import {
  TransactionFormEsignFlow,
  type FormTemplate,
} from "@/app/dashboard/transactions/[id]/components/transaction-form-esign-flow"

interface ListingFormsPanelProps {
  listingId: string
  state?: string          // listing.state — used to load state-required forms
  sellerName?: string     // pre-populate signer name
  sellerEmail?: string    // pre-populate signer email
  providerName?: string   // resolved from brokerage platform_credentials
}

export function ListingFormsPanel({
  listingId,
  state,
  sellerName,
  sellerEmail,
  providerName,
}: ListingFormsPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const [forms, setForms] = useState<FormTemplate[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [selectedForm, setSelectedForm] = useState<FormTemplate | null>(null)

  // ── WHO SIGNS, AND WHAT IS ON FILE ─────────────────────────────────────────
  //
  // The e-sign flow prefills form FIELDS via forms-kernel's prefillFormAction,
  // which resolves listing + seller only. prefillListingFormFromRecord resolves
  // the same listing and seller PLUS the block a listing agreement legally needs
  // and nothing else in this product surfaces: the agent's licence number and
  // state, and the brokerage's name, address, phone and licence number.
  //
  // Those are exactly the fields that produce a defective executed agreement when
  // blank — and the agent found out only after the seller had signed it. Reading
  // them here, BEFORE the form goes out, is the whole value: this shows what will
  // land on the paperwork and names anything missing. It writes nothing.
  const [prefill, setPrefill] = useState<Record<string, unknown> | null>(null)
  const [prefillError, setPrefillError] = useState<string | null>(null)

  // Load forms when panel is first expanded
  useEffect(() => {
    if (!expanded || loaded || loading) return
    setLoading(true)
    setPrefillError(null)

    Promise.all([
      loadAvailableFormsAction({ context_type: "listing", state }),
      prefillListingFormAction(listingId),
    ])
      .then(([formsRes, prefillRes]) => {
        if (formsRes.success && (formsRes as any).data?.forms) {
          setForms((formsRes as any).data.forms as FormTemplate[])
        }
        const p = prefillRes as { success: boolean; error?: string; prefillData?: Record<string, unknown> }
        if (!p.success || !p.prefillData) {
          // A readiness read that could not RUN is not "everything is on file".
          setPrefillError(p.error ?? "The signing details could not be read.")
        } else {
          setPrefill(p.prefillData)
        }
        setLoaded(true)
      })
      .catch((e: unknown) => {
        setPrefillError(e instanceof Error ? e.message : "The signing details could not be read.")
        setLoaded(true)
      })
      .finally(() => setLoading(false))
  }, [expanded, loaded, loading, state, listingId])

  // Fields that make an executed listing agreement valid. Missing ones are named.
  const REQUIRED_ON_FORM: Array<{ key: string; label: string }> = [
    { key: "sellerFirstName",    label: "Seller first name" },
    { key: "sellerLastName",     label: "Seller last name" },
    { key: "sellerEmail",        label: "Seller email" },
    { key: "address",            label: "Property address" },
    { key: "listPrice",          label: "List price" },
    { key: "agentLastName",      label: "Listing agent name" },
    { key: "agentLicenseNumber", label: "Agent licence number" },
    { key: "brokerageName",      label: "Brokerage name" },
    { key: "brokerageLicense",   label: "Brokerage licence number" },
  ]
  const missingOnForm = prefill
    ? REQUIRED_ON_FORM.filter(({ key }) => {
        const v = prefill[key]
        return v === null || v === undefined || (typeof v === "string" && !v.trim())
      })
    : []

  const requiredForms = forms.filter(f => f.is_required)
  const optionalForms = forms.filter(f => !f.is_required)

  const providerUrls: Record<string, string> = {
    dotloop:        "https://www.dotloop.com/",
    skyslope:       "https://app.skyslope.com/",
    formsimplicity: "https://www.formsimplicity.com/",
    brokermint:     "https://brokermint.com/",
    authentisign:   "https://authentisign.com/",
    docusign:       "https://www.docusign.com/",
  }

  return (
    <>
      <Card className="border-border">
        <CardHeader
          className="pb-2 cursor-pointer select-none"
          onClick={() => setExpanded(v => !v)}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-sm">Listing Forms</CardTitle>
              {loaded && forms.length > 0 && (
                <Badge variant="secondary" className="text-xs">
                  {forms.length} form{forms.length !== 1 ? "s" : ""}
                  {requiredForms.length > 0 && (
                    <span className="ml-1 text-destructive font-semibold">
                      &middot; {requiredForms.length} req.
                    </span>
                  )}
                </Badge>
              )}
            </div>
            {expanded ? (
              <ChevronUp className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            )}
          </div>
          {!expanded && (
            <CardDescription className="text-xs mt-0.5">
              Access listing agreements, seller disclosures, and other required forms.
            </CardDescription>
          )}
        </CardHeader>

        {expanded && (
          <CardContent className="pt-0 space-y-3">
            {/* What will land on the paperwork — read before anything is sent. */}
            {!loading && prefillError && (
              <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 flex items-start gap-1.5">
                <TriangleAlert className="h-3.5 w-3.5 shrink-0 mt-px" />
                <span>
                  {prefillError} — the signing details on these forms have NOT been verified. Check
                  them on the document before sending it out.
                </span>
              </div>
            )}
            {!loading && !prefillError && prefill && missingOnForm.length > 0 && (
              <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                <p className="font-medium flex items-center gap-1.5">
                  <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
                  These will be blank on any form sent from here
                </p>
                <ul className="list-disc pl-5 mt-1 space-y-0.5">
                  {missingOnForm.map((m) => (
                    <li key={m.key}>{m.label}</li>
                  ))}
                </ul>
                <p className="mt-1.5 text-amber-800">
                  A listing agreement executed without the agent and brokerage licence details is
                  defective. Fill these in before sending it for signature.
                </p>
              </div>
            )}
            {!loading && !prefillError && prefill && missingOnForm.length === 0 && (
              <p className="text-xs text-emerald-700 flex items-center gap-1.5">
                <CircleCheck className="h-3.5 w-3.5 shrink-0" />
                Seller, property, agent licence and brokerage licence details are all on file.
              </p>
            )}

            {loading ? (
              <div className="flex items-center justify-center py-6 gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm">Loading forms...</span>
              </div>
            ) : forms.length === 0 ? (
              <div className="text-center py-6">
                <FileText className="h-8 w-8 mx-auto text-muted-foreground/40 mb-2" />
                <p className="text-sm text-muted-foreground">
                  No listing forms found
                  {state ? ` for ${state}` : ""}.
                </p>
                {providerName && (
                  <a
                    href={providerUrls[providerName] ?? "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline underline-offset-2"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Open {providerName.charAt(0).toUpperCase() + providerName.slice(1)} directly
                  </a>
                )}
              </div>
            ) : (
              <>
                {/* Required forms */}
                {requiredForms.length > 0 && (
                  <div>
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                      Required
                    </p>
                    <div className="divide-y divide-border rounded-lg border overflow-hidden">
                      {requiredForms.map(form => (
                        <FormRow
                          key={form.id}
                          form={form}
                          onUse={() => setSelectedForm(form)}
                          providerName={providerName}
                          providerUrls={providerUrls}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* Optional forms */}
                {optionalForms.length > 0 && (
                  <div>
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                      Optional
                    </p>
                    <div className="divide-y divide-border rounded-lg border overflow-hidden">
                      {optionalForms.map(form => (
                        <FormRow
                          key={form.id}
                          form={form}
                          onUse={() => setSelectedForm(form)}
                          providerName={providerName}
                          providerUrls={providerUrls}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        )}
      </Card>

      {/* E-Sign Flow Sheet */}
      {selectedForm && (
        <TransactionFormEsignFlow
          open={!!selectedForm}
          onOpenChange={open => { if (!open) setSelectedForm(null) }}
          formTemplate={selectedForm}
          contextType="listing"
          contextId={listingId}
          providerName={providerName}
          defaultSigners={[
            ...(sellerName || sellerEmail ? [{ name: sellerName ?? "", email: sellerEmail ?? "", role: "seller" }] : []),
          ].filter(s => s.name || s.email)}
          onSuccess={() => setSelectedForm(null)}
        />
      )}
    </>
  )
}

// ─── FormRow subcomponent ─────────────────────────────────────────────────────

function FormRow({
  form,
  onUse,
  providerName,
  providerUrls,
}: {
  form: FormTemplate
  onUse: () => void
  providerName?: string
  providerUrls: Record<string, string>
}) {
  return (
    <div className="flex items-center justify-between px-3 py-2.5 bg-background hover:bg-muted/30 transition-colors">
      <div className="flex items-start gap-2 min-w-0">
        <FileText className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{form.name}</p>
          {form.description && (
            <p className="text-xs text-muted-foreground line-clamp-1">{form.description}</p>
          )}
          <p className="text-[10px] text-muted-foreground capitalize mt-0.5">
            {form.category.replace(/_/g, " ")}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1.5 ml-2 shrink-0">
        <Button size="sm" className="text-xs h-7 gap-1" onClick={onUse}>
          <FileText className="h-3 w-3" />
          Use
        </Button>
        {providerName && (
          <Button
            size="sm"
            variant="ghost"
            className="text-xs h-7 gap-1 text-muted-foreground"
            onClick={() => window.open(providerUrls[providerName] ?? "#", "_blank")}
          >
            <ExternalLink className="h-3 w-3" />
          </Button>
        )}
      </div>
    </div>
  )
}
