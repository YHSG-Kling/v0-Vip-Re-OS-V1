"use client"

/**
 * FormWizard — CANONICAL creation flow for both listings AND offers.
 *
 * mode="listing" — used by `app/dashboard/listings/listings-new-button.tsx`
 *   (the one-and-only listing creation entry point)
 * mode="offer"   — used by `app/crm/contacts/[contactId]/offers/new` and the
 *   CRM contact action menu. Going forward this is also the canonical
 *   buyer-detail offer creation flow, replacing OfferInitiationFlow +
 *   OfferFormWizard once those are retired.
 *
 * Step pattern (both modes):
 *   1. Context     — property address, parties
 *   2. Forms       — pick the right document set
 *   3. Fill        — populate forms (provider iframe if applicable)
 *   4. Signers     — collect signer roles + emails
 *   5. E-Sign      — review + dispatch
 *   6. Monitor     — track signature progress
 *
 * Strategic AI features (price advisor, escalation, buyer letter,
 * contingency reco) will be added as optional steps inside mode="offer"
 * in a follow-up commit, retiring OfferInitiationFlow.
 *
 * Inbound offer upload (PDF ingestion from cooperating agents) is a
 * SEPARATE flow — not part of FormWizard. Counter-offers use
 * parent_offer_id in offer detail, not a wizard.
 */

import { useState, useCallback, useRef, useEffect } from "react"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Loader2, ChevronLeft, ChevronRight, Check, Building2, Users, User, AlertCircle, ExternalLink, Sparkles, ShieldCheck, Upload } from "lucide-react"
import type { Contact } from "@/lib/domain/types"
import { createClient } from "@/lib/supabase/client"
// The ONE TTL vocabulary for a persisted document URL — the same constant the
// server-side signer uses (lib/storage/signed-doc-url.ts). Imported rather than
// respelled so the wizard and the signer cannot drift.
import { DOC_URL_TTL_SECONDS as FORM_URL_TTL_SECONDS } from "@/lib/storage/signed-doc-url"
import { createOffer } from "@/app/actions/buyer-offers"
import { createListingWithSellerContact, resolveListingIdByMlsAction } from "@/app/actions/listings-kernel"
import { submitForSignature } from "@/app/actions/buyer-offer/submit-for-signature"
import { prefillStorageFormAction } from "@/app/actions/buyer-offer/prefill-storage-form"
import { buildEsignAnchorPlanAction } from "@/app/actions/buyer-offer/esign-anchor-plan"
import Link from "next/link"
import { PROPERTY_TYPE_OPTIONS } from "@/lib/constants"

type TransactionProvider = "dotloop" | "docusign" | "skyslope" | "authentisign"

interface FormRef {
  source: "my_forms" | "transaction_provider"
  formRef: string
  name: string
  scope?: "brokerage" | "team" | "agent"
  /** When source === "transaction_provider", the provider id of the source. */
  providerName?: TransactionProvider
  /** When source === "transaction_provider", optional issuer / category for display. */
  issuer?:    string
  category?:  string
  stateCode?: string
}

interface ProviderFormItem {
  formId:     string
  name:       string
  issuer?:    string
  stateCode?: string
  category?:  string
  version?:   string
  previewUrl?: string
}

interface Signer {
  name: string
  email: string
  phone?: string
  role: "buyer" | "seller" | "agent" | "co_buyer" | "listing_agent"
}

interface WizardState {
  // Step 1 — Context
  propertyAddress: string
  propertyCity: string
  propertyState: string
  propertyZip: string
  /**
   * A REAL listings.id (uuid). In offer mode it is resolved from the MLS number
   * the agent typed; in listing mode it is the draft this wizard just created.
   * It used to be bound directly to the "MLS #" text input, which meant an agent
   * who filled that field in sent "MLS-12345" into the uuid FK `offers.listing_id`.
   */
  listingId?: string
  /** The free-text MLS number the agent typed — NOT a uuid, never an FK. */
  mlsNumber?: string
  listPrice?: number
  sellerName?: string
  propertyType?: string
  // Step 2 — Form Selection
  selectedForms: FormRef[]
  // Step 3 — Fill Forms (provider forms filled via iframe; "my forms" tracked manually)
  filledFormRefs: string[]
  // Step 3 — in-app filled storage PDFs (filled path + preview URL), keyed by formRef
  filledForms?: Record<string, { filledPath?: string; previewUrl?: string }>
  // Step 4 — Signers
  signers: Signer[]
  // Step 5/6
  offerId?: string
  esignProvider?: string | null
  transactionProvider?: TransactionProvider | null
  transactionProviderEmbedUrl?: string | null
}

export interface FormWizardProps {
  mode: "offer" | "listing"
  contact?: Contact
  brokerageId: string
  agentUserId: string
  teamId?: string | null
  agentName?: string
  agentEmail?: string
  open: boolean
  onClose: () => void
  /**
   * Optional — when present, FormWizard preloads a packet that the workflow
   * intake pipeline already staged (status='needs_agent_input') and surfaces
   * a "review prefilled fields" banner. Agent edits flow through the field
   * audit trail; the wizard's "Approve Packet" action flips status to
   * draft_ready so a downstream send_for_esign workflow step can dispatch.
   *
   * When omitted, the wizard works exactly as before (manual creation).
   */
  documentId?: string
}

interface StagedPacket {
  documentId: string
  packetType: "offer" | "listing"
  state: string | null
  filledFieldsCount: number
  agentMustComplete: string[]
  highConfidenceCount: number
  mediumConfidenceCount: number
  lowConfidenceCount: number
  findings: Array<{
    severity: "info" | "warning" | "blocker"
    title: string
    detail: string
    recommendation?: string
  }>
  prefilled: Record<string, unknown>      // contact + property + agent prefills the agent should verify
}

const STEP_LABELS_OFFER = ["Context", "Forms", "Fill", "Signers", "E-Sign", "Monitor"]
const STEP_LABELS_LISTING = ["Context", "Forms", "Fill", "Signers", "E-Sign", "Monitor"]

function stepLabels(mode: "offer" | "listing") {
  return mode === "offer" ? STEP_LABELS_OFFER : STEP_LABELS_LISTING
}

export function FormWizard({ mode, contact, brokerageId, agentUserId, teamId, agentName, agentEmail, open, onClose, documentId }: FormWizardProps) {
  const [step, setStep] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [myForms, setMyForms] = useState<{ name: string; url: string; scope: "brokerage" | "team" | "agent"; path: string }[]>([])
  const [formsLoaded, setFormsLoaded] = useState(false)
  const [providerInfo, setProviderInfo] = useState<{ provider: TransactionProvider; embedUrl: string | null } | null | "loading">("loading")
  // Provider form library — fetched lazily when Step 2 mounts. null = not loaded
  // yet, [] = loaded but empty.
  const [providerForms, setProviderForms] = useState<ProviderFormItem[] | null>(null)
  const [providerFormsLoading, setProviderFormsLoading] = useState(false)
  const [providerFormsError, setProviderFormsError] = useState<string | null>(null)
  const [esignProvider, setEsignProvider] = useState<string | null>(null)
  // ── Packet preload (optional) — only active when documentId prop is set ──
  const [stagedPacket, setStagedPacket] = useState<StagedPacket | null>(null)
  const [packetLoading, setPacketLoading] = useState(false)
  const [editedFields, setEditedFields] = useState<Map<string, { newValue: unknown; reason?: string }>>(new Map())
  const [approving, setApproving] = useState(false)
  // ── Field-level AI-fill audit (document_field_audit) ────────────────────────
  // The banner's confidence COUNTS come from the `filledPacket.audit` blob inside
  // documents.content. The LEDGER — one row per field, with the AI value, its
  // source intake field, its confidence, and whether a licensed agent overrode it
  // — is the E&O record, and until now nothing read it back (recordAIFill and
  // recordAgentOverride both wrote; getDocumentAudit had no caller anywhere).
  // Loaded through the gated reader, which proves the document is in the caller's
  // brokerage before touching the service client.
  const [fieldAudit, setFieldAudit] = useState<
    { fieldName: string; aiValue: unknown; aiSource: string | null; aiConfidence: string | null; agentOverrode: boolean; overrideReason: string | null }[] | null
  >(null)
  const [fieldAuditError, setFieldAuditError] = useState<string | null>(null)

  const [state, setState] = useState<WizardState>(() => ({
    propertyAddress: "",
    propertyCity: "",
    propertyState: "",
    propertyZip: "",
    selectedForms: [],
    filledFormRefs: [],
    signers: buildInitialSigners(mode, contact, agentName, agentEmail),
    transactionProvider: null,
    transactionProviderEmbedUrl: null,
  }))

  const update = useCallback(<K extends keyof WizardState>(key: K, value: WizardState[K]) => {
    setState(prev => ({ ...prev, [key]: value }))
  }, [])

  // ── Packet preload — runs once when wizard opens with a documentId ──────
  // Pulls the staged packet from documents.metadata + filledPacket content,
  // prefills the wizard state with property/contact info, and surfaces the
  // proactive findings + addenda + agent-must-complete list as a banner.
  // PURELY ADDITIVE — when documentId is omitted, this effect is a no-op.
  useEffect(() => {
    if (!open || !documentId || stagedPacket || packetLoading) return
    setPacketLoading(true)
    ;(async () => {
      try {
        const supabase = createClient()
        const { data: doc } = await supabase
          .from("documents")
          .select("id, document_type, status, state_code, content, metadata")
          .eq("id", documentId)
          .maybeSingle()
        if (!doc) {
          setPacketLoading(false)
          return
        }

        // Extract filledPacket from content (JSON-stringified payload from intake)
        let filledPacket: { agentMustComplete?: string[]; audit?: { high_confidence_count?: number; medium_confidence_count?: number; low_confidence_count?: number } } = {}
        let prefilled: Record<string, unknown> = {}
        try {
          const parsed = JSON.parse(doc.content ?? "{}")
          filledPacket = parsed?.filledPacket ?? {}
          prefilled    = parsed?.intake ?? {}
        } catch { /* content may not be JSON for older docs */ }

        const meta = (doc.metadata as { findings?: StagedPacket["findings"]; agent_must_complete?: string[]; prefilled?: Record<string, unknown> }) ?? {}

        setStagedPacket({
          documentId: doc.id,
          packetType: (doc.document_type === "listing_agreement" ? "listing" : "offer"),
          state: doc.state_code ?? null,
          filledFieldsCount:    (filledPacket.audit?.high_confidence_count ?? 0)
                              + (filledPacket.audit?.medium_confidence_count ?? 0)
                              + (filledPacket.audit?.low_confidence_count ?? 0),
          agentMustComplete:    meta.agent_must_complete ?? filledPacket.agentMustComplete ?? [],
          highConfidenceCount:  filledPacket.audit?.high_confidence_count ?? 0,
          mediumConfidenceCount: filledPacket.audit?.medium_confidence_count ?? 0,
          lowConfidenceCount:   filledPacket.audit?.low_confidence_count ?? 0,
          findings:             meta.findings ?? [],
          prefilled:            meta.prefilled ?? prefilled,
        })

        // Prefill wizard state from intake — but only fields that are still empty.
        // Existing user input wins over packet prefill.
        const intakeAddress = (prefilled.propertyAddress as { value?: string })?.value
        const intakeCity    = (prefilled.propertyCity as { value?: string })?.value
        const intakeState   = (prefilled.propertyState as { value?: string })?.value ?? doc.state_code ?? undefined
        const intakeZip     = (prefilled.propertyZip as { value?: string })?.value
        setState(prev => ({
          ...prev,
          propertyAddress: prev.propertyAddress || intakeAddress || "",
          propertyCity:    prev.propertyCity    || intakeCity    || "",
          propertyState:   prev.propertyState   || intakeState   || "",
          propertyZip:     prev.propertyZip     || intakeZip     || "",
        }))
      } finally {
        setPacketLoading(false)
      }
    })()
  }, [open, documentId, stagedPacket, packetLoading])

  // ── Field-level audit load — runs once per staged packet ────────────────────
  const loadFieldAudit = useCallback(async () => {
    if (!documentId) return
    const { getDocumentFieldAuditAction } = await import("@/app/actions/document-field-audit")
    const res = await getDocumentFieldAuditAction(documentId)
    if (!res.ok) {
      // Reported, not swallowed. "The ledger refused this read" and "this packet
      // has no AI-filled fields" mean different things to an E&O reviewer.
      setFieldAuditError(res.error)
      setFieldAudit([])
      return
    }
    setFieldAuditError(null)
    setFieldAudit(res.audit.entries.map(e => ({
      fieldName:      e.fieldName,
      aiValue:        e.aiValue,
      aiSource:       e.aiSource ?? null,
      aiConfidence:   e.aiConfidence ?? null,
      agentOverrode:  !!e.agentOverrode,
      overrideReason: e.overrideReason ?? null,
    })))
  }, [documentId])

  useEffect(() => {
    if (!open || !documentId || fieldAudit !== null) return
    void loadFieldAudit()
  }, [open, documentId, fieldAudit, loadFieldAudit])

  // Track an agent override on a packet field (best-effort persistence)
  const recordOverride = useCallback((fieldName: string, newValue: unknown, reason?: string) => {
    setEditedFields(prev => {
      const next = new Map(prev)
      next.set(fieldName, { newValue, reason })
      return next
    })
  }, [])

  // Approve the packet → flip status to draft_ready (and persist edits)
  const approvePacket = useCallback(async () => {
    if (!documentId) return
    setApproving(true)
    try {
      const overrides = Array.from(editedFields.entries()).map(([fieldName, { newValue, reason }]) => ({
        fieldName, newValue, reason,
      }))
      const res = await fetch("/api/workflow/intake/approve-packet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId, overrides }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        setError((err as { error?: string }).error ?? "Could not approve packet")
        return
      }
      // Surface as a step-5 jump so the agent can send for eSign next
      setStep(5)
    } finally {
      setApproving(false)
    }
  }, [documentId, editedFields])

  // Load forms + provider info when step 2 is reached
  const loadStep2 = useCallback(async () => {
    if (formsLoaded) return
    setFormsLoaded(true)

    const supabase = createClient()

    // Load "My Forms" from Storage at brokerage, team, agent scope
    const paths: { prefix: string; scope: "brokerage" | "team" | "agent" }[] = [
      { prefix: `brokerage/${brokerageId}/`, scope: "brokerage" },
      ...(teamId ? [{ prefix: `teams/${teamId}/`, scope: "team" as const }] : []),
      { prefix: `agents/${agentUserId}/`, scope: "agent" },
    ]

    const collected: typeof myForms = []
    await Promise.all(
      paths.map(async ({ prefix, scope }) => {
        const { data } = await supabase.storage.from("brokerage-forms").list(prefix, { limit: 50 })
        if (data) {
          for (const f of data) {
            if (f.name.endsWith(".pdf") || f.name.endsWith(".docx")) {
              // brokerage-forms is a DOCUMENT-CLASS bucket: it holds broker
              // transaction paperwork AND (under filled/) the FILLED copies that
              // carry a buyer's name, price and terms. getPublicUrl minted a
              // permanent unauthenticated link to each one. Signed, and skipped
              // when it cannot be signed — never downgraded to public.
              const objectPath = `${prefix}${f.name}`
              const { data: signed, error: signErr } = await supabase.storage
                .from("brokerage-forms")
                .createSignedUrl(objectPath, FORM_URL_TTL_SECONDS)
              if (signErr || !signed?.signedUrl) continue
              collected.push({ name: f.name, url: signed.signedUrl, scope, path: objectPath })
            }
          }
        }
      })
    )
    setMyForms(collected)

    // Load provider info via API
    try {
      const res = await fetch(`/api/form-wizard/resolve-provider?agentUserId=${agentUserId}&teamId=${teamId ?? ""}&brokerageId=${brokerageId}`)
      if (res.ok) {
        const data = await res.json()
        setProviderInfo(data.provider ? { provider: data.provider, embedUrl: data.embedUrl } : null)
        setEsignProvider(data.esignProvider ?? null)
        setState(prev => ({ ...prev, transactionProvider: data.provider ?? null, transactionProviderEmbedUrl: data.embedUrl ?? null }))
      } else {
        setProviderInfo(null)
      }
    } catch {
      setProviderInfo(null)
    }
  }, [brokerageId, teamId, agentUserId, formsLoaded])

  const goToStep = useCallback(async (next: number) => {
    setError(null)
    if (next === 2 && step < 2) await loadStep2()
    if (next === 4 && step === 3) {
      setState(prev => ({ ...prev, filledFormRefs: prev.selectedForms.map(f => f.formRef) }))
    }
    setStep(next)
  }, [step, loadStep2])

  const handleSubmitOffer = useCallback(async () => {
    if (!contact) { setError("No contact selected"); return }
    setBusy(true)
    setError(null)
    try {
      // offers.listing_id is a uuid FK. Translate the MLS number the agent typed
      // into one of this brokerage's listing ids; no match is normal (the offer is
      // on someone else's listing) and must not block the offer.
      let resolvedListingId = state.listingId ?? null
      if (!resolvedListingId && state.mlsNumber?.trim()) {
        const lookup = await resolveListingIdByMlsAction(state.mlsNumber)
        resolvedListingId = lookup.listingId
      }

      const result = await createOffer(contact.id, brokerageId, agentUserId, {
        property_address: state.propertyAddress,
        property_city: state.propertyCity,
        property_state: state.propertyState,
        property_zip: state.propertyZip,
        listing_id: resolvedListingId,
        offer_price: 0,
        earnest_money: 0,
        financing_type: "conventional",
        financing_contingency: true,
        financing_contingency_days: 21,
        inspection_contingency: true,
        inspection_period_days: 10,
        appraisal_contingency: true,
        appraisal_contingency_days: 21,
        closing_date: "",
        possession_terms: "at_closing",
        escalation_clause: false,
        form_source: state.selectedForms.map(f => f.source).join(","),
        form_provider_ref: state.selectedForms.map(f => f.formRef).join(","),
        esign_provider: esignProvider ?? undefined,
      })
      if (!result.success || !result.offerId) { setError(result.error ?? "Failed to create offer"); return }
      setState(prev => ({ ...prev, offerId: result.offerId, esignProvider: esignProvider }))

      // THE ROLE TRAVELS. This used to collapse `listing_agent` and `seller`
      // into a flat "agent" here, at the caller, because the action's parameter
      // type admitted only buyer/co_buyer/agent. Step 4 of this very wizard
      // renders a "Listing Agent" row and collects their name and email — and
      // that address was thrown away one line before it left the browser.
      //
      // On an OUTSIDE listing that address is the only key the deal's return
      // mail will ever have: `offers.listing_id` is null, there is no `listings`
      // row, and the inbound address match cannot fire. Flattened to "agent" it
      // is also indistinguishable from OUR OWN buyer's agent, so it cannot be
      // recovered downstream by guessing.
      //
      // The action now takes the real role and narrows it itself for the e-sign
      // provider (which understands parties, not our deal roles) while keeping
      // the counterparty for the reply watch.
      await submitForSignature({
        offerId: result.offerId,
        userId: agentUserId,
        signers: state.signers
          .filter(s => s.email)
          .map(s => ({ name: s.name, email: s.email, role: s.role })),
      })
      setStep(6)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error")
    } finally {
      setBusy(false)
    }
  }, [contact, brokerageId, agentUserId, state, esignProvider])

  /**
   * THE LISTING LANE.
   *
   * Both submit controls used to read `mode === "offer" ? handleSubmitOffer :
   * handleSubmitOffer` — the same handler on both branches — so "New Listing"
   * created an OFFER row against the seller: offer_price 0, buyer contingency
   * defaults, and no listing anywhere.
   *
   * What it creates now is a DRAFT. The owner's rule: a listing is taken on only
   * once the listing agreement is SIGNED and the compliance check has reviewed all
   * required documents, initials and signatures. So this parks the draft the
   * agreement hangs off, and the promotion to a real (coming_soon /
   * LISTING_AGREEMENT_SIGNED) listing happens in exactly one place — the
   * compliance-listing-auto-create chain, once documents.ts has verified the
   * agent's AND the seller's signatures and initials and auditListingDocuments
   * reports no blocking gaps.
   */
  const handleSubmitListing = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      // The seller is whoever this listing is FOR. Contact-scoped entry
      // (/crm/contacts/[id]/listings/new) passes the seller contact directly; the
      // dashboard entry has no contact, so fall back to the seller signer the agent
      // named in step 4. If neither names a seller we stop — a listing with an
      // invented seller is worse than one the agent has to finish naming.
      const sellerSigner = state.signers.find(s => s.role === "seller" && (s.name.trim() || s.email.trim()))
      const sellerName = contact
        ? `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim()
        : (sellerSigner?.name ?? "").trim()
      if (!sellerName) {
        setError("Add the seller in the Signers step before creating the listing.")
        return
      }
      const [firstName, ...restName] = sellerName.split(/\s+/)

      const result = await createListingWithSellerContact({
        sellerFirstName: firstName,
        sellerLastName:  restName.join(" "),
        sellerEmail:     contact?.email ?? sellerSigner?.email ?? undefined,
        sellerPhone:     contact?.phone ?? sellerSigner?.phone ?? undefined,
        address:         state.propertyAddress,
        city:            state.propertyCity,
        state:           state.propertyState,
        zip:             state.propertyZip,
        listPrice:       state.listPrice,
        propertyType:    state.propertyType,
        // The formRefs the agent selected, so the draft carries its packet.
        selectedFormIds: state.selectedForms.map(f => f.formRef),
      })

      if (!result.success || !result.listingId) {
        setError(result.error ?? "Failed to create listing")
        return
      }
      setState(prev => ({ ...prev, listingId: result.listingId }))
      setStep(6)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error")
    } finally {
      setBusy(false)
    }
  }, [contact, state])

  const labels = stepLabels(mode)

  return (
    <Sheet open={open} onOpenChange={v => { if (!v) onClose() }}>
      <SheetContent side="right" className="w-full sm:max-w-3xl flex flex-col gap-0 p-0 overflow-hidden">
        <SheetHeader className="px-6 py-4 border-b">
          <SheetTitle>{mode === "offer" ? "Create Offer" : "New Listing"}</SheetTitle>
          <StepBar step={step} labels={labels} />
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {error && (
            <Alert variant="destructive" className="mb-4">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* AI-staged packet banner — only renders when documentId prop is set */}
          {stagedPacket && (
            <PacketBanner
              packet={stagedPacket}
              fieldAudit={fieldAudit}
              fieldAuditError={fieldAuditError}
            />
          )}

          {step === 1 && <Step1Context mode={mode} state={state} update={update} />}
          {step === 2 && (
            <Step2Forms
              mode={mode}
              state={state}
              update={update}
              myForms={myForms}
              agentUserId={agentUserId}
              onUploaded={(f) => setMyForms(prev => [...prev, f])}
              providerInfo={providerInfo}
              providerForms={providerForms}
              providerFormsLoading={providerFormsLoading}
              providerFormsError={providerFormsError}
              onLoadProviderForms={async () => {
                if (providerForms !== null || providerFormsLoading) return
                if (!providerInfo || providerInfo === "loading") return
                setProviderFormsLoading(true)
                setProviderFormsError(null)
                try {
                  const params = new URLSearchParams()
                  if (state.propertyState) params.set("state", state.propertyState)
                  params.set("category", mode === "offer" ? "offer" : "listing")
                  const res = await fetch(`/api/forms/provider-library?${params.toString()}`)
                  const json = await res.json()
                  if (!res.ok) {
                    setProviderFormsError(json?.error ?? "Could not load provider forms.")
                    setProviderForms([])
                  } else {
                    setProviderForms(json.forms ?? [])
                  }
                } catch (err: any) {
                  setProviderFormsError(err?.message ?? "Network error loading provider forms.")
                  setProviderForms([])
                } finally {
                  setProviderFormsLoading(false)
                }
              }}
            />
          )}
          {step === 3 && <Step3Fill state={state} providerInfo={providerInfo} update={update} />}
          {step === 4 && <Step4Signers state={state} update={update} mode={mode} />}
          {step === 5 && <Step5ESign state={state} mode={mode} esignProvider={esignProvider} busy={busy} onSubmit={mode === "offer" ? handleSubmitOffer : handleSubmitListing} />}
          {step === 6 && mode === "listing" && state.listingId && (
            <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
              <Check className="h-10 w-10 text-emerald-600" />
              <h3 className="text-lg font-semibold">Draft listing created</h3>
              <p className="text-sm text-muted-foreground max-w-sm">
                This listing is a <span className="font-medium">draft</span> — it is not live, not
                searchable and not on the MLS. It becomes a real listing once the listing agreement
                is signed and the compliance check clears every required document, initial and
                signature. Upload the signed agreement to the listing and that happens automatically.
              </p>
              <Button asChild className="mt-2">
                <Link href={`/dashboard/listings/${state.listingId}`}>
                  Open Listing
                  <ExternalLink className="h-4 w-4 ml-1" />
                </Link>
              </Button>
            </div>
          )}
          {step === 6 && mode === "offer" && state.offerId && (
            <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
              <Check className="h-10 w-10 text-emerald-600" />
              <h3 className="text-lg font-semibold">Offer submitted</h3>
              <p className="text-sm text-muted-foreground max-w-sm">
                Your offer is recorded. Open the offer workspace to view details, history, and next steps.
              </p>
              <Button asChild className="mt-2">
                <Link href={`/crm/contacts/${contact?.id ?? ""}/offers/${state.offerId}`}>
                  Open Offer Workspace
                  <ExternalLink className="h-4 w-4 ml-1" />
                </Link>
              </Button>
            </div>
          )}
        </div>

        <div className="border-t px-6 py-4 flex items-center justify-between">
          <Button variant="outline" onClick={() => step > 1 ? setStep(s => s - 1) : onClose()} disabled={busy}>
            <ChevronLeft className="h-4 w-4 mr-1" />
            {step === 1 ? "Cancel" : "Back"}
          </Button>
          {step < 5 && stagedPacket && step >= 1 && (
            <Button
              variant="default"
              onClick={approvePacket}
              disabled={approving || busy}
              className="gap-1.5 mr-2 bg-emerald-600 hover:bg-emerald-700"
              title="Mark this AI-staged packet as agent-approved and ready for eSign"
            >
              {approving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              Approve Packet
            </Button>
          )}
          {step < 5 && (
            <Button onClick={() => goToStep(step + 1)} disabled={busy || !canAdvance(step, state, mode)}>
              Next
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          )}
          {step === 5 && (
            <Button onClick={mode === "offer" ? handleSubmitOffer : handleSubmitListing} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {/* The listing lane does not dispatch an envelope, so it must not say
                  it does. It creates the draft the signed agreement attaches to. */}
              {mode === "offer" ? "Send for E-Sign" : "Create Draft Listing"}
            </Button>
          )}
          {step === 6 && (
            <Button onClick={onClose}>Done</Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

// ─── Step helpers ────────────────────────────────────────────────────────────

function canAdvance(step: number, state: WizardState, mode: "offer" | "listing"): boolean {
  if (step === 1) return state.propertyAddress.trim().length > 0
  if (step === 2) return state.selectedForms.length > 0
  if (step === 3) return true
  if (step === 4) return state.signers.some(s => s.email)
  return true
}

function buildInitialSigners(
  mode: "offer" | "listing",
  contact?: Contact,
  agentName?: string,
  agentEmail?: string
): Signer[] {
  const signers: Signer[] = []
  if (mode === "offer") {
    if (contact) signers.push({ name: `${contact.first_name} ${contact.last_name}`.trim(), email: contact.email, phone: contact.phone, role: "buyer" })
    if (agentName) signers.push({ name: agentName, email: agentEmail ?? "", role: "agent" })
    signers.push({ name: "", email: "", role: "listing_agent" })
  } else {
    if (contact) signers.push({ name: `${contact.first_name} ${contact.last_name}`.trim(), email: contact.email, phone: contact.phone, role: "seller" })
    if (agentName) signers.push({ name: agentName, email: agentEmail ?? "", role: "agent" })
  }
  return signers
}

function StepBar({ step, labels }: { step: number; labels: string[] }) {
  return (
    <div className="flex items-center gap-1 mt-2">
      {labels.map((label, i) => {
        const n = i + 1
        const done = n < step
        const active = n === step
        return (
          <div key={label} className="flex items-center gap-1">
            <div className={`flex items-center justify-center w-6 h-6 rounded-full text-xs font-medium ${done ? "bg-green-500 text-white" : active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
              {done ? <Check className="h-3 w-3" /> : n}
            </div>
            <span className={`text-xs ${active ? "font-medium" : "text-muted-foreground"} hidden sm:inline`}>{label}</span>
            {i < labels.length - 1 && <div className="h-px w-4 bg-muted-foreground/30" />}
          </div>
        )
      })}
    </div>
  )
}

// ─── Step 1 — Context ────────────────────────────────────────────────────────

function Step1Context({ mode, state, update }: { mode: "offer" | "listing"; state: WizardState; update: <K extends keyof WizardState>(k: K, v: WizardState[K]) => void }) {
  return (
    <div className="space-y-4">
      <h3 className="font-semibold">{mode === "offer" ? "Property Details" : "Listing Details"}</h3>

      {mode === "listing" && (
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 space-y-1">
            <Label>List Price</Label>
            <Input type="number" placeholder="500000" value={state.listPrice ?? ""} onChange={e => update("listPrice", Number(e.target.value))} />
          </div>
          <div className="col-span-2 space-y-1">
            <Label>Property Type</Label>
            <select
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              value={state.propertyType ?? ""}
              onChange={e => update("propertyType", e.target.value)}
            >
              <option value="">Select property type…</option>
              {/* Canonical value/label pairs. This list stored its DISPLAY string, so a
                  wizard answer of "Single Family" never equalled a listing's
                  "single_family"; it also offered "Manufactured", which has no canonical
                  equivalent (canonicalPropertyType folds it to "other"). */}
              {PROPERTY_TYPE_OPTIONS.map(pt => (
                <option key={pt.value} value={pt.value}>{pt.label}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      <div className="space-y-1">
        <Label>Street Address *</Label>
        <Input placeholder="123 Main St" value={state.propertyAddress} onChange={e => update("propertyAddress", e.target.value)} />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-1 space-y-1">
          <Label>City</Label>
          <Input placeholder="Austin" value={state.propertyCity} onChange={e => update("propertyCity", e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>State</Label>
          <Input placeholder="TX" maxLength={2} value={state.propertyState} onChange={e => update("propertyState", e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>ZIP</Label>
          <Input placeholder="78701" value={state.propertyZip} onChange={e => update("propertyZip", e.target.value)} />
        </div>
      </div>
      {/* MLS # belongs to the OFFER side only. On the listing side a property has
          no MLS number yet — the number is issued at LAUNCH, and an admin enters it
          there — so asking for it at agreement-initiation could only ever collect a
          number for a property this brokerage has not listed yet. */}
      {mode === "offer" && (
        <div className="space-y-1">
          <Label>MLS # (optional)</Label>
          <Input placeholder="MLS-12345" value={state.mlsNumber ?? ""} onChange={e => update("mlsNumber", e.target.value)} />
          <p className="text-xs text-muted-foreground">
            If this property is one of your brokerage&apos;s listings, the offer is linked to it automatically.
          </p>
        </div>
      )}
    </div>
  )
}

// ─── Step 2 — Form Selection ─────────────────────────────────────────────────

function Step2Forms({ mode, state, update, myForms, agentUserId, onUploaded, providerInfo, providerForms, providerFormsLoading, providerFormsError, onLoadProviderForms }: {
  mode: "offer" | "listing"
  state: WizardState
  update: <K extends keyof WizardState>(k: K, v: WizardState[K]) => void
  myForms: { name: string; url: string; scope: "brokerage" | "team" | "agent"; path: string }[]
  agentUserId: string
  onUploaded: (f: { name: string; url: string; scope: "brokerage" | "team" | "agent"; path: string }) => void
  providerInfo: { provider: TransactionProvider; embedUrl: string | null } | null | "loading"
  providerForms: ProviderFormItem[] | null
  providerFormsLoading: boolean
  providerFormsError: string | null
  onLoadProviderForms: () => void
}) {
  const selected = state.selectedForms
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  function toggleMyForm(f: typeof myForms[0]) {
    const exists = selected.find(s => s.formRef === f.path && s.source === "my_forms")
    if (exists) {
      update("selectedForms", selected.filter(s => !(s.formRef === f.path && s.source === "my_forms")))
    } else {
      update("selectedForms", [...selected, { source: "my_forms", formRef: f.path, name: f.name, scope: f.scope }])
    }
  }

  async function handleUpload(file: File) {
    setUploadError(null)
    if (!/\.(pdf|docx)$/i.test(file.name)) { setUploadError("Only PDF or DOCX files are supported."); return }
    setUploading(true)
    try {
      const supabase = createClient()
      const storagePath = `agents/${agentUserId}/uploads/${Date.now()}-${file.name.replace(/[^\w.\-]/g, "_")}`
      const { error: upErr } = await supabase.storage.from("brokerage-forms").upload(storagePath, file, { upsert: false })
      if (upErr) { setUploadError(upErr.message); return }
      // FAIL CLOSED — a form the agent just uploaded gets a TIME-LIMITED signed
      // URL, or the upload is reported as failed. It must never fall back to a
      // permanent public link (was getPublicUrl on a world-readable bucket).
      const { data: signed, error: signErr } = await supabase.storage
        .from("brokerage-forms")
        .createSignedUrl(storagePath, FORM_URL_TTL_SECONDS)
      if (signErr || !signed?.signedUrl) {
        setUploadError(signErr?.message ?? "The form uploaded but no secure link could be created for it.")
        return
      }
      const url = signed.signedUrl
      // Use that URL as the form ref so it opens for review and dispatches to
      // the e-sign provider exactly like a library form.
      const entry = { name: file.name, url, scope: "agent" as const, path: url }
      onUploaded(entry)
      update("selectedForms", [...state.selectedForms, { source: "my_forms" as const, formRef: url, name: file.name, scope: "agent" as const }])
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Upload failed")
    } finally {
      setUploading(false)
    }
  }

  function toggleProviderForm(f: ProviderFormItem) {
    if (!providerInfo || providerInfo === "loading") return
    const exists = selected.find(s => s.source === "transaction_provider" && s.formRef === f.formId)
    if (exists) {
      update("selectedForms", selected.filter(s => !(s.source === "transaction_provider" && s.formRef === f.formId)))
    } else {
      update("selectedForms", [
        ...selected,
        {
          source:       "transaction_provider",
          formRef:      f.formId,
          name:         f.name,
          providerName: providerInfo.provider,
          issuer:       f.issuer,
          category:     f.category,
          stateCode:    f.stateCode,
        },
      ])
    }
  }

  const scopeIcon = (scope: "brokerage" | "team" | "agent") =>
    scope === "brokerage" ? <Building2 className="h-3 w-3" /> : scope === "team" ? <Users className="h-3 w-3" /> : <User className="h-3 w-3" />

  return (
    <div className="space-y-4">
      <h3 className="font-semibold">Select Forms</h3>
      <p className="text-sm text-muted-foreground">Choose forms from your library and/or your transaction provider. You can select from both.</p>

      <Tabs defaultValue="my-forms">
        <TabsList className="w-full">
          <TabsTrigger value="my-forms" className="flex-1">My Forms</TabsTrigger>
          <TabsTrigger value="provider" className="flex-1">Transaction Provider</TabsTrigger>
          <TabsTrigger value="upload" className="flex-1">Upload</TabsTrigger>
        </TabsList>

        <TabsContent value="my-forms" className="mt-3">
          {myForms.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              No forms found in your brokerage, team, or agent library.
              <br />
              <span className="text-xs">Upload forms via Settings → Forms Library.</span>
            </div>
          ) : (
            <div className="space-y-2">
              {myForms.map(f => {
                const checked = !!selected.find(s => s.formRef === f.path && s.source === "my_forms")
                return (
                  <label key={f.path} className="flex items-center gap-3 p-3 border rounded-lg cursor-pointer hover:bg-muted/50">
                    <Checkbox checked={checked} onCheckedChange={() => toggleMyForm(f)} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{f.name.replace(/\.[^.]+$/, "")}</p>
                    </div>
                    <Badge variant="outline" className="flex items-center gap-1 text-xs shrink-0">
                      {scopeIcon(f.scope)}
                      {f.scope}
                    </Badge>
                  </label>
                )
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="provider" className="mt-3" onFocus={onLoadProviderForms} onClick={onLoadProviderForms}>
          {providerInfo === "loading" && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {providerInfo === null && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                No transaction provider configured.{" "}
                <a href="/settings/integrations" className="underline">Set one up in Integrations.</a>
              </AlertDescription>
            </Alert>
          )}
          {providerInfo && providerInfo !== "loading" && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground capitalize">
                  Forms from {providerInfo.provider}
                  {state.propertyState ? ` for ${state.propertyState}` : ""}
                  {mode === "listing" ? " (listing)" : " (offer)"}.
                </p>
                {providerInfo.embedUrl && (
                  <a href={providerInfo.embedUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                    <ExternalLink className="h-3 w-3" />
                    Open {providerInfo.provider}
                  </a>
                )}
              </div>

              {providerFormsLoading && (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              )}
              {providerFormsError && !providerFormsLoading && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{providerFormsError}</AlertDescription>
                </Alert>
              )}
              {!providerFormsLoading && !providerFormsError && providerForms && providerForms.length === 0 && (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  No forms in {providerInfo.provider}'s library
                  {state.propertyState ? ` for ${state.propertyState}` : ""}.
                  <br />
                  <span className="text-xs">Forms uploaded directly to {providerInfo.provider} will appear here.</span>
                </div>
              )}
              {!providerFormsLoading && !providerFormsError && providerForms && providerForms.length > 0 && (
                <div className="space-y-2">
                  {providerForms.map(f => {
                    const checked = !!selected.find(s => s.source === "transaction_provider" && s.formRef === f.formId)
                    return (
                      <label key={f.formId} className="flex items-center gap-3 p-3 border rounded-lg cursor-pointer hover:bg-muted/50">
                        <Checkbox checked={checked} onCheckedChange={() => toggleProviderForm(f)} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{f.name}</p>
                          <p className="text-xs text-muted-foreground truncate">
                            {[f.issuer, f.stateCode, f.category].filter(Boolean).join(" · ")}
                          </p>
                        </div>
                        {f.previewUrl && (
                          <a href={f.previewUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="text-xs text-muted-foreground hover:text-foreground shrink-0">
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </label>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="upload" className="mt-3">
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Upload a {mode === "offer" ? "contract / addendum" : "listing"} document from your computer (PDF or DOCX).
              It is added to your forms and sent for signature with the rest of the package.
            </p>
            <label className="flex flex-col items-center justify-center gap-2 p-6 border border-dashed rounded-lg cursor-pointer hover:bg-muted/50">
              {uploading ? (
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              ) : (
                <Upload className="h-5 w-5 text-muted-foreground" />
              )}
              <span className="text-sm">{uploading ? "Uploading…" : "Choose a file to upload"}</span>
              <span className="text-xs text-muted-foreground">PDF or DOCX</span>
              <input
                type="file"
                accept=".pdf,.docx"
                className="hidden"
                disabled={uploading}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleUpload(f); e.target.value = "" }}
              />
            </label>
            {uploadError && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{uploadError}</AlertDescription>
              </Alert>
            )}
            <p className="text-xs text-muted-foreground">Uploaded files appear in the “My Forms” tab as agent-scoped forms.</p>
          </div>
        </TabsContent>
      </Tabs>

      {selected.length > 0 && (
        <div className="pt-2 border-t">
          <p className="text-xs text-muted-foreground mb-1">Selected ({selected.length}):</p>
          <div className="flex flex-wrap gap-1">
            {selected.map(s => (
              <Badge key={`${s.source}-${s.formRef}`} variant="secondary" className="text-xs">
                {s.name}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Step 3 — Fill Forms ─────────────────────────────────────────────────────

interface FilledFormState { loading: boolean; filledPath?: string; previewUrl?: string; filledFields?: string[]; unresolvedFields?: string[]; error?: string }

function Step3Fill({ state, providerInfo, update }: { state: WizardState; providerInfo: { provider: TransactionProvider; embedUrl: string | null } | null | "loading"; update: <K extends keyof WizardState>(k: K, v: WizardState[K]) => void }) {
  const myFormsList = state.selectedForms.filter(f => f.source === "my_forms")
  const hasProvider = state.selectedForms.some(f => f.source === "transaction_provider")

  // PROPERTY-ONLY PREFILL — fill the known property identification into each storage PDF in-app, so
  // the agent works in a preview (not another tab). Offer terms stay blank for the agent.
  const [filled, setFilled] = useState<Record<string, FilledFormState>>({})
  useEffect(() => {
    let cancelled = false
    const pdfForms = myFormsList.filter(f => f.formRef.toLowerCase().endsWith(".pdf"))
    for (const f of pdfForms) {
      if (filled[f.formRef]) continue
      setFilled(prev => ({ ...prev, [f.formRef]: { loading: true } }))
      prefillStorageFormAction({
        formPath: f.formRef,
        propertyAddress: state.propertyAddress || null,
        propertyCity: state.propertyCity || null,
        propertyState: state.propertyState || null,
      }).then(res => {
        if (cancelled) return
        setFilled(prev => ({ ...prev, [f.formRef]: res.success
          ? { loading: false, filledPath: res.filledPath, previewUrl: res.previewUrl, filledFields: res.filledFields, unresolvedFields: res.unresolvedFields }
          : { loading: false, error: res.error } }))
      }).catch(() => {
        if (!cancelled) setFilled(prev => ({ ...prev, [f.formRef]: { loading: false, error: "prefill failed" } }))
      })
    }
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.selectedForms])

  // Sync the in-app filled storage forms (filled path + preview) up to wizard state so Step 5 can
  // build the e-sign anchor plan from them.
  useEffect(() => {
    const map: Record<string, { filledPath?: string; previewUrl?: string }> = {}
    for (const [ref, fs] of Object.entries(filled)) if (fs.filledPath || fs.previewUrl) map[ref] = { filledPath: fs.filledPath, previewUrl: fs.previewUrl }
    if (Object.keys(map).length > 0) update("filledForms", map)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filled])

  return (
    <div className="space-y-4">
      <h3 className="font-semibold">Fill Forms</h3>

      {myFormsList.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Forms from your library. Known property details are pre-filled into each form; you complete the offer terms in the preview.</p>
          {myFormsList.map(f => {
            const fs = filled[f.formRef]
            const isPdf = f.formRef.toLowerCase().endsWith(".pdf")
            return (
            <div key={f.formRef} className="border rounded-lg overflow-hidden">
              <div className="px-4 py-2 bg-muted/50 border-b flex items-center gap-2">
                <Badge variant="outline" className="text-xs">{f.scope}</Badge>
                <span className="text-sm font-medium">{f.name}</span>
                {fs?.loading && <span className="text-xs text-muted-foreground ml-auto">Pre-filling…</span>}
                {fs?.filledFields && fs.filledFields.length > 0 && <span className="text-xs text-emerald-600 ml-auto">{fs.filledFields.length} property field(s) pre-filled</span>}
              </div>
              <div className="p-4 space-y-2">
                {isPdf && fs?.previewUrl ? (
                  <>
                    <div className="border rounded-lg overflow-hidden" style={{ height: 480 }}>
                      <iframe src={fs.previewUrl} className="w-full h-full" title={`${f.name} preview`} />
                    </div>
                    {fs.unresolvedFields && fs.unresolvedFields.length > 0 && (
                      <p className="text-xs text-muted-foreground">Complete in the form: {fs.unresolvedFields.join(", ")}, plus the offer terms.</p>
                    )}
                  </>
                ) : (
                  <a href={f.formRef} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs underline text-primary">
                    <ExternalLink className="h-3 w-3" />
                    {fs?.error ? "Open form to review (prefill unavailable)" : "Open form to review"}
                  </a>
                )}
              </div>
            </div>
          )})}
        </div>
      )}

      {hasProvider && providerInfo && providerInfo !== "loading" && providerInfo.embedUrl && (
        <div className="space-y-2">
          <p className="text-sm font-medium capitalize">{providerInfo.provider} — fill forms in provider interface</p>
          <div className="border rounded-lg overflow-hidden" style={{ height: 480 }}>
            <iframe
              src={providerInfo.embedUrl}
              className="w-full h-full"
              title={`${providerInfo.provider} form fill`}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
          </div>
        </div>
      )}

      {myFormsList.length === 0 && !hasProvider && (
        <p className="text-sm text-muted-foreground py-4">No forms selected. Go back and select forms.</p>
      )}
    </div>
  )
}

// ─── Step 4 — Verify Signers ─────────────────────────────────────────────────

function Step4Signers({ state, update, mode }: { state: WizardState; update: <K extends keyof WizardState>(k: K, v: WizardState[K]) => void; mode: "offer" | "listing" }) {
  const signers = state.signers

  function updateSigner(i: number, field: keyof Signer, value: string) {
    const next = signers.map((s, idx) => idx === i ? { ...s, [field]: value } : s)
    update("signers", next)
  }

  function addSigner() {
    update("signers", [...signers, { name: "", email: "", role: "buyer" }])
  }

  function removeSigner(i: number) {
    update("signers", signers.filter((_, idx) => idx !== i))
  }

  const roleLabel = (role: Signer["role"]) => {
    const labels: Record<string, string> = { buyer: "Buyer", seller: "Seller", agent: "Agent", co_buyer: "Co-Buyer", listing_agent: "Listing Agent" }
    return labels[role] ?? role
  }

  return (
    <div className="space-y-4">
      <h3 className="font-semibold">Verify Signers</h3>
      <p className="text-sm text-muted-foreground">Confirm who needs to sign. All signers will receive an email with the document.</p>

      <div className="space-y-3">
        {signers.map((signer, i) => (
          <div key={i} className="border rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <Badge variant="secondary" className="text-xs">{roleLabel(signer.role)}</Badge>
              {i > 0 && <Button variant="ghost" size="sm" className="h-7 text-xs text-destructive" onClick={() => removeSigner(i)}>Remove</Button>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Name</Label>
                <Input className="h-8 text-sm" value={signer.name} onChange={e => updateSigner(i, "name", e.target.value)} placeholder="Full name" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Email</Label>
                <Input className="h-8 text-sm" type="email" value={signer.email} onChange={e => updateSigner(i, "email", e.target.value)} placeholder="email@example.com" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Phone (optional)</Label>
                <Input className="h-8 text-sm" type="tel" value={signer.phone ?? ""} onChange={e => updateSigner(i, "phone", e.target.value)} placeholder="+1 555 000 0000" />
              </div>
            </div>
          </div>
        ))}
      </div>

      <Button variant="outline" size="sm" onClick={addSigner}>+ Add Signer</Button>
    </div>
  )
}

// ─── Step 5 — Send for E-Sign ─────────────────────────────────────────────────

interface AnchorPlanView { loading: boolean; anchorCount?: number; recipientRoles?: string[]; ambiguous?: Array<{ fieldName: string; reason: string }>; safe?: boolean; safetyViolations?: string[]; error?: string }

function Step5ESign({ state, mode, esignProvider, busy, onSubmit }: {
  state: WizardState
  mode: "offer" | "listing"
  esignProvider: string | null
  busy: boolean
  onSubmit: () => void
}) {
  // E-SIGN AREA CHECK — for each in-app filled storage PDF, build the provider-agnostic anchor plan so
  // the agent can confirm each signature/initial area is set for the right party before sending.
  const [plans, setPlans] = useState<Record<string, AnchorPlanView>>({})
  const filledForms = state.filledForms ?? {}
  useEffect(() => {
    let cancelled = false
    for (const [ref, ff] of Object.entries(filledForms)) {
      if (!ff.filledPath || plans[ref]) continue
      setPlans(prev => ({ ...prev, [ref]: { loading: true } }))
      buildEsignAnchorPlanAction({ filledPath: ff.filledPath, provider: esignProvider }).then(res => {
        if (cancelled) return
        setPlans(prev => ({ ...prev, [ref]: res.success
          ? { loading: false, anchorCount: res.anchorCount, recipientRoles: res.recipientRoles, ambiguous: res.ambiguous, safe: res.safe, safetyViolations: res.safetyViolations }
          : { loading: false, error: res.error } }))
      }).catch(() => { if (!cancelled) setPlans(prev => ({ ...prev, [ref]: { loading: false, error: "anchor plan failed" } })) })
    }
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.filledForms, esignProvider])

  const planEntries = Object.entries(plans)

  return (
    <div className="space-y-4">
      <h3 className="font-semibold">
        {mode === "offer" ? "Review & Send for E-Sign" : "Review & Create Draft Listing"}
      </h3>
      {mode === "listing" && (
        <p className="text-xs text-muted-foreground">
          Creates the draft this listing agreement attaches to. The listing goes live only after the
          signed agreement clears the compliance review of required documents, initials and signatures.
        </p>
      )}

      {planEntries.length > 0 && (
        <div className="rounded-lg border p-4 space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">E-sign areas</p>
          {planEntries.map(([ref, p]) => {
            const name = state.selectedForms.find(f => f.formRef === ref)?.name ?? "Form"
            return (
              <div key={ref} className="text-xs flex items-start gap-2">
                {p.loading ? <span className="text-muted-foreground">Checking {name}…</span> : p.error ? (
                  <span className="text-muted-foreground">{name}: areas set manually in the provider.</span>
                ) : (
                  <span>
                    <span className="font-medium">{name}</span>: {p.anchorCount ?? 0} area(s) set for {(p.recipientRoles ?? []).join(", ") || "signers"}.
                    {p.safe === false && <span className="text-destructive"> ⚠ placement issue — review.</span>}
                    {p.ambiguous && p.ambiguous.length > 0 && <span className="text-amber-600"> {p.ambiguous.length} area(s) need manual placement.</span>}
                    {p.safe === true && (!p.ambiguous || p.ambiguous.length === 0) && <span className="text-emerald-600"> ✓ all areas confirmed.</span>}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}

      <div className="rounded-lg border p-4 space-y-3 bg-muted/30">
        <div>
          <p className="text-xs text-muted-foreground">Property</p>
          <p className="text-sm font-medium">{state.propertyAddress}{state.propertyCity ? `, ${state.propertyCity}` : ""}{state.propertyState ? `, ${state.propertyState}` : ""}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Forms selected ({state.selectedForms.length})</p>
          <div className="flex flex-wrap gap-1 mt-1">
            {state.selectedForms.map(f => (
              <Badge key={`${f.source}-${f.formRef}`} variant="secondary" className="text-xs">{f.name}</Badge>
            ))}
          </div>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Signers ({state.signers.filter(s => s.email).length})</p>
          <div className="space-y-0.5 mt-1">
            {state.signers.filter(s => s.email).map((s, i) => (
              <p key={i} className="text-xs">{s.name || "—"} · {s.email}</p>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-lg border p-4 space-y-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Providers</p>
        {state.transactionProvider && (
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs">Forms from:</Badge>
            <span className="text-sm capitalize">{state.transactionProvider}</span>
          </div>
        )}
        {esignProvider ? (
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs">Signatures via:</Badge>
            <span className="text-sm capitalize">{esignProvider}</span>
          </div>
        ) : (
          <Alert className="py-2">
            <AlertCircle className="h-3 w-3" />
            <AlertDescription className="text-xs">
              No e-sign provider configured.{" "}
              <a href="/settings/integrations" className="underline">Set one up in Integrations.</a>
            </AlertDescription>
          </Alert>
        )}
      </div>
    </div>
  )
}

// ─── PacketBanner — renders only when an AI-staged packet was preloaded ──────
// Shows: prefilled count, fields needing agent input, blocker/warning/info
// findings, addendum suggestions. PURELY ADDITIVE — does not affect any other
// step or interaction when documentId prop is omitted.

interface FieldAuditRow {
  fieldName:      string
  aiValue:        unknown
  aiSource:       string | null
  aiConfidence:   string | null
  agentOverrode:  boolean
  overrideReason: string | null
}

function auditValueText(v: unknown): string {
  if (v === null || v === undefined) return "—"
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  try { return JSON.stringify(v) } catch { return "—" }
}

function PacketBanner({
  packet,
  fieldAudit,
  fieldAuditError,
}: {
  packet: StagedPacket
  /** null = still loading; [] = loaded and empty. */
  fieldAudit?: FieldAuditRow[] | null
  fieldAuditError?: string | null
}) {
  const blockerCount = packet.findings.filter(f => f.severity === "blocker").length
  const warningCount = packet.findings.filter(f => f.severity === "warning").length
  const infoCount    = packet.findings.filter(f => f.severity === "info").length

  // The E&O half. The counts above come from the packet blob; these rows come
  // from the document_field_audit LEDGER, which is the record that survives the
  // deal — including which prefilled values the licensed agent overrode and why.
  const auditRows      = fieldAudit ?? []
  const overriddenRows = auditRows.filter(r => r.agentOverrode)
  const lowConfidence  = auditRows.filter(r => r.aiConfidence === "low" || r.aiConfidence === "medium")

  return (
    <div className="mb-4 rounded-lg border border-violet-200 bg-violet-50/50 dark:bg-violet-950/20 p-4 space-y-3">
      <div className="flex items-start gap-2">
        <Sparkles className="h-4 w-4 text-violet-600 mt-0.5 shrink-0" />
        <div className="flex-1">
          <p className="text-sm font-semibold text-violet-900 dark:text-violet-100">
            AI-staged {packet.packetType} packet for {packet.state ?? "this state"}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {packet.filledFieldsCount} fields prefilled
            {packet.highConfidenceCount > 0 && ` · ${packet.highConfidenceCount} high confidence`}
            {packet.mediumConfidenceCount > 0 && ` · ${packet.mediumConfidenceCount} need verification`}
            {packet.lowConfidenceCount > 0 && ` · ${packet.lowConfidenceCount} low confidence`}
          </p>
        </div>
      </div>

      {packet.agentMustComplete.length > 0 && (
        <div className="rounded border border-amber-200 bg-amber-50/50 dark:bg-amber-950/20 px-3 py-2">
          <p className="text-xs font-medium text-amber-900 dark:text-amber-100">
            You must complete:
          </p>
          <p className="text-xs text-amber-800 dark:text-amber-200 mt-0.5">
            {packet.agentMustComplete.slice(0, 6).join(", ")}
            {packet.agentMustComplete.length > 6 && ` +${packet.agentMustComplete.length - 6} more`}
          </p>
        </div>
      )}

      {packet.findings.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium">
            Findings: {blockerCount > 0 && <span className="text-red-600">{blockerCount} blocker{blockerCount !== 1 ? "s" : ""}</span>}
            {blockerCount > 0 && (warningCount > 0 || infoCount > 0) && " · "}
            {warningCount > 0 && <span className="text-amber-600">{warningCount} warning{warningCount !== 1 ? "s" : ""}</span>}
            {warningCount > 0 && infoCount > 0 && " · "}
            {infoCount > 0 && <span className="text-blue-600">{infoCount} info</span>}
          </p>
          <ul className="space-y-1">
            {packet.findings.slice(0, 4).map((f, i) => (
              <li key={i} className="text-xs">
                <span className={
                  f.severity === "blocker" ? "text-red-600 font-medium"
                  : f.severity === "warning" ? "text-amber-700"
                  : "text-blue-700"
                }>
                  {f.severity === "blocker" ? "■" : f.severity === "warning" ? "▲" : "●"} {f.title}:
                </span>{" "}
                <span className="text-muted-foreground">{f.detail}</span>
                {f.recommendation && (
                  <span className="block ml-3 mt-0.5 text-muted-foreground italic">→ {f.recommendation}</span>
                )}
              </li>
            ))}
            {packet.findings.length > 4 && (
              <li className="text-xs text-muted-foreground italic ml-3">
                +{packet.findings.length - 4} more findings — review before approving
              </li>
            )}
          </ul>
        </div>
      )}

      {/* ── AI fill audit (document_field_audit) ───────────────────────────────
          The per-field E&O trail: what the AI put in each field, which intake
          answer it came from, how confident it was, and what the agent changed.
          Medium/low-confidence rows are listed first because those are the ones
          a licensed human is expected to verify before signing. */}
      {fieldAuditError && (
        <p className="text-xs text-red-600">
          AI fill audit unavailable — {fieldAuditError}
        </p>
      )}
      {!fieldAuditError && fieldAudit === null && (
        <p className="text-xs text-muted-foreground">Loading the AI fill audit…</p>
      )}
      {!fieldAuditError && fieldAudit !== null && auditRows.length > 0 && (
        <div className="space-y-1.5 border-t border-violet-200/70 pt-2.5">
          <p className="text-xs font-medium">
            AI fill audit: {auditRows.length} field{auditRows.length !== 1 ? "s" : ""} on record
            {overriddenRows.length > 0 && (
              <span className="text-amber-700"> · {overriddenRows.length} overridden by you</span>
            )}
            {lowConfidence.length > 0 && (
              <span className="text-muted-foreground"> · {lowConfidence.length} to verify</span>
            )}
          </p>
          <ul className="space-y-1">
            {[...lowConfidence, ...auditRows.filter(r => !lowConfidence.includes(r))]
              .slice(0, 8)
              .map((r, i) => (
                <li key={`${r.fieldName}-${i}`} className="text-xs">
                  <span className="font-medium">{r.fieldName}</span>
                  <span className="text-muted-foreground"> = {auditValueText(r.aiValue)}</span>
                  {r.aiConfidence && (
                    <span className={
                      r.aiConfidence === "low" ? " text-red-600"
                      : r.aiConfidence === "medium" ? " text-amber-700"
                      : " text-muted-foreground"
                    }>
                      {" "}({r.aiConfidence}{r.aiSource ? ` from ${r.aiSource}` : ""})
                    </span>
                  )}
                  {r.agentOverrode && (
                    <span className="block ml-3 text-amber-700">
                      → you overrode this{r.overrideReason ? `: ${r.overrideReason}` : ""}
                    </span>
                  )}
                </li>
              ))}
            {auditRows.length > 8 && (
              <li className="text-xs text-muted-foreground italic ml-3">
                +{auditRows.length - 8} more audited fields
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  )
}
