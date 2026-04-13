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
} from "lucide-react"
import { loadAvailableFormsAction } from "@/app/actions/forms-kernel"
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

  // Load forms when panel is first expanded
  useEffect(() => {
    if (!expanded || loaded || loading) return
    setLoading(true)
    loadAvailableFormsAction({ context_type: "listing", state })
      .then(res => {
        if (res.success && (res as any).data?.forms) {
          setForms((res as any).data.forms as FormTemplate[])
        }
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
      .finally(() => setLoading(false))
  }, [expanded, loaded, loading, state])

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
