"use client"

// app/dashboard/forms/FormsLibraryClient.tsx
// ═══════════════════════════════════════════════════════════════════════════
// FORMS LIBRARY CLIENT — Role-scoped forms management dashboard.
// Tabs: Provider Forms / Brokerage Forms / Submissions / E-Sign History
// Strictly kernel OS: no direct DB calls here. All data passed from RSC page.
// ═══════════════════════════════════════════════════════════════════════════

import { useState, useEffect } from "react"
import { providerPortalMode } from "@/lib/integrations/providers/catalog"
import {
  Card, CardContent, } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Tabs, TabsContent, TabsList, TabsTrigger,
} from "@/components/ui/tabs"
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog"
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command"
import {
  FileText, ExternalLink, Search, Building2, AlertCircle, ClipboardList, Send, Download, Shield, Loader2, Users, Settings, Eye, UserCircle2,
} from "lucide-react"
import { formatDistanceToNow, format } from "date-fns"
import Link from "next/link"
import {
  loadAvailableFormsAction,
  resolveFormsProviderAction,
} from "@/app/actions/forms-kernel"
import { getContacts } from "@/app/actions/contacts"
import {
  TransactionFormEsignFlow,
  type FormTemplate,
  type DefaultSigner,
} from "@/app/dashboard/transactions/[id]/components/transaction-form-esign-flow"

// ─── Types ───────────────────────────────────────────────────────────────────

interface StateRequirement {
  id: string
  state: string
  requirement_name: string
  document_type: string
  requirement_category: string
  transaction_type: string
  is_mandatory: boolean
  timeline_days: number | null
  description: string | null
}

interface PlatformCred {
  id: string
  platform: string
  account_name: string | null
  account_id: string | null
  is_active: boolean
  last_synced_at: string | null
  test_status: string | null
}

interface FormSubmission {
  id: string
  form_id: string | null
  submitted_at: string | null
  source: string | null
  brokerage_id: string
  contact_id: string | null
}

interface EsignRecord {
  id: string
  contract_type: string | null
  provider_name: string | null
  provider_envelope_id: string | null
  esign_status: string | null
  sent_at: string | null
  agent_signed_at: string | null
  fully_signed_at: string | null
  document_url: string | null
  agent_id: string | null
  brokerage_id: string
}

interface ListingAgreement {
  id: string
  listing_id: string | null
  agreement_type: string | null
  esign_status: string | null
  seller_signed_at: string | null
  agent_signed_at: string | null
  fully_executed_at: string | null
  provider_name: string | null
  brokerage_id: string
  agent_user_id: string | null
}

interface FormsLibraryClientProps {
  brokerageId: string
  agentId: string | null
  teamId: string | null
  userRole: string
  isAdminOrBroker: boolean
  stateRequirements: StateRequirement[]
  platformCreds: PlatformCred[]
  submissions: FormSubmission[]
  esignHistory: EsignRecord[]
  listingAgreements: ListingAgreement[]
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PROVIDER_URLS: Record<string, string> = {
  dotloop:        "https://www.dotloop.com/",
  skyslope:       "https://app.skyslope.com/",
  formsimplicity: "https://www.formsimplicity.com/",
  brokermint:     "https://brokermint.com/",
  authentisign:   "https://authentisign.com/",
  docusign:       "https://www.docusign.com/",
}

function capitalize(s: string) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

function EsignStatusBadge({ status }: { status: string | null }) {
  const s = (status ?? "unknown").toLowerCase()
  if (s === "completed" || s === "fully_signed" || s === "signed")
    return <Badge variant="default" className="text-[10px] bg-green-600">Signed</Badge>
  if (s === "sent" || s === "out_for_signature" || s === "pending")
    return <Badge variant="secondary" className="text-[10px] bg-amber-100 text-amber-700 border-amber-200">Pending Signature</Badge>
  if (s === "voided" || s === "declined")
    return <Badge variant="destructive" className="text-[10px]">{capitalize(s)}</Badge>
  return <Badge variant="outline" className="text-[10px] capitalize">{s.replace(/_/g, " ")}</Badge>
}

// ─── Component ───────────────────────────────────────────────────────────────

export function FormsLibraryClient({
  brokerageId,
  agentId,
  teamId,
  userRole,
  isAdminOrBroker,
  stateRequirements,
  platformCreds,
  submissions,
  esignHistory,
  listingAgreements,
}: FormsLibraryClientProps) {

  const [searchState, setSearchState]           = useState("")
  const [searchForms, setSearchForms]           = useState("")
  const [selectedForm, setSelectedForm]         = useState<FormTemplate | null>(null)

  // "View Form" Sheet
  const [viewingForm, setViewingForm]           = useState<FormTemplate | null>(null)

  // Contact picker — shown before launching e-sign flow
  const [pendingEsignForm, setPendingEsignForm] = useState<FormTemplate | null>(null)
  const [contactPickerOpen, setContactPickerOpen] = useState(false)
  const [contactSearch, setContactSearch]       = useState("")
  const [contacts, setContacts]                 = useState<Array<{ id: string; first_name: string; last_name: string; email: string }>>([])
  const [contactsLoading, setContactsLoading]   = useState(false)
  // Signers pre-populated from the contact picker; passed to TransactionFormEsignFlow
  const [esignDefaultSigners, setEsignDefaultSigners] = useState<DefaultSigner[]>([])

  // Kernel-loaded transaction forms (lazy loaded on first render)
  const [kernelForms, setKernelForms]           = useState<FormTemplate[]>([])
  const [kernelFormsLoading, setKernelFormsLoading] = useState(false)
  const [kernelFormsLoaded, setKernelFormsLoaded]   = useState(false)

  // Resolved provider from kernel
  const [resolvedProvider, setResolvedProvider] = useState<{ provider_name: string; is_configured: boolean } | null>(null)

  useEffect(() => {
    if (kernelFormsLoaded || kernelFormsLoading) return
    setKernelFormsLoading(true)
    Promise.all([
      loadAvailableFormsAction({ context_type: "transaction" }),
      resolveFormsProviderAction(),
    ]).then(([formsRes, providerRes]) => {
      if (formsRes.success && (formsRes as any).data?.forms) {
        setKernelForms((formsRes as any).data.forms as FormTemplate[])
      }
      if (providerRes.success && (providerRes as any).data) {
        setResolvedProvider((providerRes as any).data)
      }
      setKernelFormsLoaded(true)
    }).catch(() => setKernelFormsLoaded(true))
      .finally(() => setKernelFormsLoading(false))
  }, [kernelFormsLoaded, kernelFormsLoading])

  // Load agent's contacts lazily when the contact picker is opened
  useEffect(() => {
    if (!contactPickerOpen || contacts.length > 0 || contactsLoading) return
    setContactsLoading(true)
    getContacts({ limit: 100 })
      .then(res => setContacts((res.contacts ?? []) as any))
      .catch(() => {})
      .finally(() => setContactsLoading(false))
  }, [contactPickerOpen, contacts.length, contactsLoading])

  // Open contact picker before launching e-sign flow
  function handleUseForm(form: FormTemplate) {
    setPendingEsignForm(form)
    setContactPickerOpen(true)
    setViewingForm(null)
  }

  // Launch e-sign flow — optionally with a pre-selected contact as first signer
  function launchEsign(contact: { first_name: string; last_name: string; email: string } | null) {
    if (!pendingEsignForm) return
    if (contact) {
      setEsignDefaultSigners([{
        name:  `${contact.first_name} ${contact.last_name}`.trim(),
        email: contact.email,
        role:  "client",
      }])
    } else {
      setEsignDefaultSigners([])
    }
    setSelectedForm(pendingEsignForm)
    setContactPickerOpen(false)
    setPendingEsignForm(null)
  }

  const activeCred = platformCreds.find(c => c.is_active)

  // Filtered state requirements
  const filteredStateReqs = stateRequirements.filter(r =>
    !searchState ||
    r.state.toLowerCase().includes(searchState.toLowerCase()) ||
    r.requirement_name.toLowerCase().includes(searchState.toLowerCase()) ||
    r.document_type.toLowerCase().includes(searchState.toLowerCase())
  )

  // Filtered kernel forms
  const filteredKernelForms = kernelForms.filter(f =>
    !searchForms ||
    f.name.toLowerCase().includes(searchForms.toLowerCase()) ||
    f.category.toLowerCase().includes(searchForms.toLowerCase())
  )

  // Combined esign + listing agreements for e-sign history tab
  const allEsign = [
    ...esignHistory.map(e => ({
      id:            e.id,
      type:          e.contract_type ?? "Document",
      provider:      e.provider_name,
      status:        e.esign_status,
      sentAt:        e.sent_at,
      completedAt:   e.fully_signed_at,
      documentUrl:   e.document_url,
      source:        "contract_signatures" as const,
    })),
    ...listingAgreements
      .filter(a => a.esign_status)
      .map(a => ({
        id:          a.id,
        type:        a.agreement_type ?? "Listing Agreement",
        provider:    a.provider_name,
        status:      a.esign_status,
        sentAt:      a.agent_signed_at,
        completedAt: a.fully_executed_at,
        documentUrl: null,
        source:      "listing_agreements" as const,
      })),
  ].sort((a, b) => {
    const ta = a.sentAt ? new Date(a.sentAt).getTime() : 0
    const tb = b.sentAt ? new Date(b.sentAt).getTime() : 0
    return tb - ta
  })

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">

        {/* Page Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground text-balance">Forms Library</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {isAdminOrBroker
                ? "Brokerage-wide forms, provider connections, and e-sign history"
                : "Transaction and listing forms for your deals"}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {isAdminOrBroker && (
              <Link href="/dashboard/settings/integrations">
                <Button variant="outline" size="sm" className="gap-1.5 text-xs">
                  <Settings className="h-3.5 w-3.5" />
                  Provider Settings
                </Button>
              </Link>
            )}
            <div className="text-right">
              <p className="text-[10px] text-muted-foreground">Brokerage ID</p>
              <p className="font-mono text-xs text-muted-foreground select-all">{brokerageId}</p>
            </div>
          </div>
        </div>

        {/* Provider Connection Banner */}
        {activeCred ? (
          <Card className="border-green-200 bg-green-50/40">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-green-200 bg-green-100">
                    <Building2 className="h-4 w-4 text-green-700" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-green-900 capitalize">
                      {activeCred.platform} — Connected
                    </p>
                    <p className="text-xs text-green-700">
                      {activeCred.account_name ?? activeCred.account_id}
                      {activeCred.last_synced_at && (
                        <> &middot; Synced {formatDistanceToNow(new Date(activeCred.last_synced_at), { addSuffix: true })}</>
                      )}
                    </p>
                  </div>
                </div>
                <a href={PROVIDER_URLS[activeCred.platform] ?? "#"} target="_blank" rel="noopener noreferrer">
                  <Button size="sm" className="gap-1.5 text-xs">
                    <ExternalLink className="h-3 w-3" />
                    Open {capitalize(activeCred.platform)} Portal
                  </Button>
                </a>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card className="border-amber-200 bg-amber-50/40">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-amber-200 bg-amber-100">
                    <AlertCircle className="h-4 w-4 text-amber-700" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-amber-900">No transaction provider connected</p>
                    <p className="text-xs text-amber-700">
                      Connect a transaction management provider in Settings to access forms directly.
                    </p>
                  </div>
                </div>
                {isAdminOrBroker && (
                  <Link href="/dashboard/settings/integrations">
                    <Button size="sm" variant="outline" className="gap-1.5 text-xs border-amber-300 text-amber-800">
                      <Settings className="h-3 w-3" />
                      Connect Provider
                    </Button>
                  </Link>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Role Scope Badge */}
        <div className="flex items-center gap-2">
          <Shield className="h-3.5 w-3.5 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">
            Viewing as: <span className="font-medium capitalize">{userRole.replace(/_/g, " ")}</span>
            {isAdminOrBroker ? " — full brokerage scope" : teamId ? " — team scope" : " — own records"}
          </p>
        </div>

        {/* Main Tabs */}
        <Tabs defaultValue="transaction-forms">
          <TabsList className="flex-wrap h-auto gap-1">
            <TabsTrigger value="transaction-forms" className="text-xs">
              <ClipboardList className="h-3 w-3 mr-1.5" />
              Transaction Forms
            </TabsTrigger>
            <TabsTrigger value="state-forms" className="text-xs">
              <Shield className="h-3 w-3 mr-1.5" />
              State Requirements
              <Badge variant="secondary" className="ml-1.5 text-[9px] px-1 py-0 h-4">
                {stateRequirements.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="submissions" className="text-xs">
              <FileText className="h-3 w-3 mr-1.5" />
              Submissions
              <Badge variant="secondary" className="ml-1.5 text-[9px] px-1 py-0 h-4">
                {submissions.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="esign-history" className="text-xs">
              <Send className="h-3 w-3 mr-1.5" />
              E-Sign History
              <Badge variant="secondary" className="ml-1.5 text-[9px] px-1 py-0 h-4">
                {allEsign.length}
              </Badge>
            </TabsTrigger>
          </TabsList>

          {/* ── Tab 1: Transaction Forms (kernel-loaded) ── */}
          <TabsContent value="transaction-forms" className="mt-4 space-y-4">
            {/* THE PROVIDER'S OWN WINDOW (owner ask): browse the connected
                provider's live forms portal without leaving the app — iframe
                when the vendor permits framing (catalog embed:true), honest
                new-tab button when their X-Frame/CSP blocks it. Selection
                happens in their window; FILLING stays native below (where the
                AI prefill lives); sending stays launchEsignEnvelope. */}
            {(() => {
              const portal = providerPortalMode(resolvedProvider?.provider_name)
              if (!portal || !resolvedProvider?.is_configured) return null
              return portal.mode === "iframe" ? (
                <Card>
                  <CardContent className="p-2">
                    <div className="flex items-center justify-between px-2 pb-2">
                      <p className="text-xs font-medium">{portal.label} — your live forms workspace (signed in with your {portal.label} session)</p>
                      <a href={portal.url} target="_blank" rel="noopener noreferrer" className="text-xs underline text-muted-foreground">Open full screen</a>
                    </div>
                    <iframe src={portal.url} title={`${portal.label} forms portal`} className="w-full rounded border" style={{ height: 560 }} />
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <CardContent className="flex items-center justify-between py-3 px-4">
                    <p className="text-xs text-muted-foreground">{portal.label} doesn't allow embedding its window (their security policy) — it opens in a new tab; your work syncs back here via the provider connection.</p>
                    <Button size="sm" variant="outline" asChild>
                      <a href={portal.url} target="_blank" rel="noopener noreferrer">Open {portal.label}</a>
                    </Button>
                  </CardContent>
                </Card>
              )
            })()}
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <p className="text-sm font-medium">Available Transaction Forms</p>
                <p className="text-xs text-muted-foreground">
                  Forms loaded from your brokerage&apos;s connected provider and state requirements.
                </p>
              </div>
              <div className="relative w-64">
                <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search forms..."
                  value={searchForms}
                  onChange={e => setSearchForms(e.target.value)}
                  className="pl-8 h-8 text-xs"
                />
              </div>
            </div>

            {kernelFormsLoading ? (
              <Card>
                <CardContent className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </CardContent>
              </Card>
            ) : filteredKernelForms.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <ClipboardList className="h-8 w-8 mx-auto text-muted-foreground/40 mb-3" />
                  <p className="text-sm font-medium text-muted-foreground">No transaction forms found</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {activeCred
                      ? "Forms will appear here once synced from your provider."
                      : "Connect a transaction provider in Settings to load forms."}
                  </p>
                  {isAdminOrBroker && (
                    <Link href="/dashboard/settings/integrations">
                      <Button size="sm" variant="outline" className="mt-4 gap-1.5 text-xs">
                        <Settings className="h-3.5 w-3.5" />
                        Connect Provider
                      </Button>
                    </Link>
                  )}
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="p-0">
                  <div className="divide-y divide-border">
                    {filteredKernelForms.map(form => (
                      <div key={form.id} className="flex items-center justify-between px-4 py-3 hover:bg-muted/20 transition-colors">
                        <div className="flex items-start gap-3 min-w-0">
                          <FileText className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="text-sm font-medium">{form.name}</p>
                              {form.is_required && (
                                <Badge variant="destructive" className="text-[10px] px-1.5 py-0 h-4">Required</Badge>
                              )}
                            </div>
                            {form.description && (
                              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{form.description}</p>
                            )}
                            <p className="text-[10px] text-muted-foreground capitalize mt-0.5">
                              {form.category.replace(/_/g, " ")} &middot; {form.form_type}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 ml-3 shrink-0">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-xs h-7 gap-1 text-muted-foreground"
                            onClick={() => setViewingForm(form)}
                          >
                            <Eye className="h-3 w-3" />
                            View
                          </Button>
                          <Button
                            size="sm"
                            className="text-xs h-7 gap-1"
                            onClick={() => handleUseForm(form)}
                          >
                            Use This Form
                          </Button>
                          {activeCred && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-xs h-7 gap-1 text-muted-foreground"
                              onClick={() => window.open(PROVIDER_URLS[activeCred.platform] ?? "#", "_blank")}
                            >
                              <ExternalLink className="h-3 w-3" />
                              Portal
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* ── Tab 2: State Requirements ── */}
          <TabsContent value="state-forms" className="mt-4 space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <p className="text-sm font-medium">State-Required Transaction Documents</p>
                <p className="text-xs text-muted-foreground">
                  Mandatory and recommended forms by state. Read-only — managed at the platform level.
                </p>
              </div>
              <div className="relative w-64">
                <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Filter by state or form..."
                  value={searchState}
                  onChange={e => setSearchState(e.target.value)}
                  className="pl-8 h-8 text-xs"
                />
              </div>
            </div>

            {filteredStateReqs.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <Shield className="h-8 w-8 mx-auto text-muted-foreground/40 mb-3" />
                  <p className="text-sm text-muted-foreground">No state requirements match your filter.</p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-1">
                {/* Group by state */}
                {Array.from(new Set(filteredStateReqs.map(r => r.state))).sort().map(state => {
                  const stateItems = filteredStateReqs.filter(r => r.state === state)
                  return (
                    <Card key={state} className="overflow-hidden">
                      <div className="px-4 py-2 bg-muted/40 border-b flex items-center justify-between">
                        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                          {state} — {stateItems.length} requirement{stateItems.length !== 1 ? "s" : ""}
                        </p>
                      </div>
                      <div className="divide-y divide-border">
                        {stateItems.map(req => (
                          <div key={req.id} className="flex items-start justify-between px-4 py-3 hover:bg-muted/10 transition-colors gap-3">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className="text-sm font-medium">{req.requirement_name}</p>
                                {req.is_mandatory && (
                                  <Badge variant="destructive" className="text-[10px] px-1.5 py-0 h-4">Mandatory</Badge>
                                )}
                                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 capitalize">
                                  {req.transaction_type.replace(/_/g, " ")}
                                </Badge>
                              </div>
                              <p className="text-xs text-muted-foreground mt-0.5 capitalize">
                                {req.requirement_category.replace(/_/g, " ")} &middot; {req.document_type.replace(/_/g, " ")}
                                {req.timeline_days != null && <> &middot; Due within {req.timeline_days} days</>}
                              </p>
                              {req.description && (
                                <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{req.description}</p>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </Card>
                  )
                })}
              </div>
            )}
          </TabsContent>

          {/* ── Tab 3: Submissions ── */}
          <TabsContent value="submissions" className="mt-4 space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <p className="text-sm font-medium">Form Submissions</p>
                <p className="text-xs text-muted-foreground">
                  {isAdminOrBroker ? "All brokerage form submissions" : "Your form submissions"}
                </p>
              </div>
              {isAdminOrBroker && (
                <Badge variant="outline" className="text-xs gap-1">
                  <Users className="h-3 w-3" />
                  Full brokerage view
                </Badge>
              )}
            </div>

            {submissions.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <FileText className="h-8 w-8 mx-auto text-muted-foreground/40 mb-3" />
                  <p className="text-sm text-muted-foreground">No form submissions yet.</p>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="p-0">
                  <div className="divide-y divide-border">
                    {submissions.map(sub => (
                      <div key={sub.id} className="flex items-center justify-between px-4 py-3 hover:bg-muted/20">
                        <div>
                          <p className="text-sm font-medium font-mono text-xs text-muted-foreground">{sub.id.slice(0, 8)}…</p>
                          <p className="text-xs text-muted-foreground capitalize">
                            {sub.source ?? "web"} submission
                            {sub.submitted_at && (
                              <> &middot; {formatDistanceToNow(new Date(sub.submitted_at), { addSuffix: true })}</>
                            )}
                          </p>
                        </div>
                        <Badge variant="secondary" className="text-[10px]">Submitted</Badge>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* ── Tab 4: E-Sign History ── */}
          <TabsContent value="esign-history" className="mt-4 space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <p className="text-sm font-medium">E-Sign History</p>
                <p className="text-xs text-muted-foreground">
                  {isAdminOrBroker
                    ? "All brokerage e-sign envelopes and listing agreements"
                    : "Your e-sign envelopes and listing agreements"}
                </p>
              </div>
              {isAdminOrBroker && (
                <Badge variant="outline" className="text-xs gap-1">
                  <Users className="h-3 w-3" />
                  Brokerage scope
                </Badge>
              )}
            </div>

            {allEsign.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <Send className="h-8 w-8 mx-auto text-muted-foreground/40 mb-3" />
                  <p className="text-sm text-muted-foreground">No e-sign history yet.</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    E-sign envelopes appear here after sending forms for signature.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="p-0">
                  <div className="divide-y divide-border">
                    {allEsign.map(record => (
                      <div key={record.id} className="flex items-center justify-between px-4 py-3 hover:bg-muted/20 transition-colors gap-3">
                        <div className="flex items-start gap-3 min-w-0">
                          <Send className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                          <div className="min-w-0">
                            <p className="text-sm font-medium capitalize">
                              {(record.type ?? "Document").replace(/_/g, " ")}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {record.provider ? capitalize(record.provider) : "In-app"}
                              {record.sentAt && (
                                <> &middot; Sent {formatDistanceToNow(new Date(record.sentAt), { addSuffix: true })}</>
                              )}
                              {record.completedAt && (
                                <> &middot; Completed {format(new Date(record.completedAt), "MMM d, yyyy")}</>
                              )}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <EsignStatusBadge status={record.status} />
                          {record.documentUrl && (
                            <a href={record.documentUrl} target="_blank" rel="noopener noreferrer">
                              <Button size="sm" variant="outline" className="text-xs h-7 gap-1">
                                <Download className="h-3 w-3" />
                                View
                              </Button>
                            </a>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* E-Sign Flow Sheet — launched after contact picker step */}
      {selectedForm && (
        <TransactionFormEsignFlow
          open={!!selectedForm}
          onOpenChange={open => {
            if (!open) {
              setSelectedForm(null)
              setEsignDefaultSigners([])
            }
          }}
          formTemplate={selectedForm}
          contextType="transaction"
          contextId="new"
          defaultSigners={esignDefaultSigners}
          providerName={resolvedProvider?.provider_name ?? activeCred?.platform}
          onSuccess={() => {
            setSelectedForm(null)
            setEsignDefaultSigners([])
          }}
        />
      )}

      {/* View Form Sheet */}
      <Sheet open={!!viewingForm} onOpenChange={open => { if (!open) setViewingForm(null) }}>
        <SheetContent className="w-full sm:max-w-md overflow-y-auto">
          {viewingForm && (
            <>
              <SheetHeader className="pb-4">
                <SheetTitle className="flex items-start gap-2">
                  <FileText className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
                  <span>{viewingForm.name}</span>
                </SheetTitle>
                <SheetDescription asChild>
                  <div className="space-y-1">
                    <p className="text-xs capitalize text-muted-foreground">
                      {viewingForm.category.replace(/_/g, " ")} &middot; {viewingForm.form_type}
                    </p>
                    {viewingForm.is_required && (
                      <div className="pt-1">
                        <Badge variant="destructive" className="text-[10px]">Required</Badge>
                      </div>
                    )}
                  </div>
                </SheetDescription>
              </SheetHeader>

              <div className="space-y-4 text-sm">
                {viewingForm.description && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Description</p>
                    <p className="text-sm text-muted-foreground">{viewingForm.description}</p>
                  </div>
                )}

                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Details</p>
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Category</span>
                      <span className="capitalize font-medium">{viewingForm.category.replace(/_/g, " ")}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Form Type</span>
                      <span className="capitalize font-medium">{viewingForm.form_type}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Mandatory</span>
                      <span className="font-medium">{viewingForm.is_required ? "Yes" : "No"}</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="pt-6">
                <Button className="w-full" onClick={() => handleUseForm(viewingForm)}>
                  Use This Form
                </Button>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Contact Picker Dialog — shown before e-sign flow */}
      <Dialog open={contactPickerOpen} onOpenChange={open => {
        if (!open) {
          setContactPickerOpen(false)
          setPendingEsignForm(null)
          setContactSearch("")
        }
      }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserCircle2 className="h-4 w-4" />
              Select a Contact
            </DialogTitle>
            <DialogDescription>
              Optionally pick a contact from your CRM to pre-fill as the first signer.
            </DialogDescription>
          </DialogHeader>

          <Command className="border rounded-md">
            <CommandInput
              placeholder="Search contacts..."
              value={contactSearch}
              onValueChange={setContactSearch}
            />
            <CommandList className="max-h-56">
              {contactsLoading ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <>
                  <CommandEmpty>No contacts found.</CommandEmpty>
                  <CommandGroup>
                    {contacts
                      .filter(c => {
                        const q = contactSearch.toLowerCase()
                        return !q ||
                          `${c.first_name} ${c.last_name}`.toLowerCase().includes(q) ||
                          c.email.toLowerCase().includes(q)
                      })
                      .slice(0, 50)
                      .map(c => (
                        <CommandItem
                          key={c.id}
                          onSelect={() => launchEsign(c)}
                          className="flex items-center gap-2 cursor-pointer"
                        >
                          <UserCircle2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          <div className="min-w-0">
                            <p className="text-sm font-medium">{c.first_name} {c.last_name}</p>
                            <p className="text-xs text-muted-foreground truncate">{c.email}</p>
                          </div>
                        </CommandItem>
                      ))}
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </Command>

          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => launchEsign(null)} className="w-full text-xs">
              Skip — proceed without contact
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
