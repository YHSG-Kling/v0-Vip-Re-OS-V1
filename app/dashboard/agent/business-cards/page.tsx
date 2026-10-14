"use client"

import { useState, useRef, useCallback, useEffect } from "react"
import { useRouter } from "next/navigation"
import { uploadBusinessCard, getRecentScans, confirmBusinessCardScan } from "@/app/actions/business-card/business-card-actions"
import { createPartner, createReferral } from "@/app/actions/referrals/referral-actions"
import { enrollContactInSequence, listCampaignSequences } from "@/app/actions/campaign-sequences"
import { createClient } from "@/lib/supabase/client"
import { useToast } from "@/hooks/use-toast"
// PURE module (no server-only): the field list and the confidence floor the action applies,
// read here rather than re-typed so the surface and the rule cannot drift (wave 141F).
import { CARD_FIELDS, CARD_FIELD_CONFIDENCE_FLOOR, type CardField, type CardSubjectType } from "@/lib/contacts/card-classifier"

// wave 48 (owner ruling 2026-09-10): the picker on the card review surface —
// "Auto-detect" (undefined) leaves the reader/notes/existing-match classifier
// in charge; any other choice is an EXPLICIT override that wins outright.
const SUBJECT_TYPE_OPTIONS: Array<{ value: CardSubjectType | ""; label: string }> = [
  { value: "", label: "Auto-detect" },
  { value: "sphere", label: "Sphere of influence (someone I know)" },
  { value: "agent", label: "Fellow agent (recruiting prospect)" },
  { value: "potential_contact", label: "Potential client" },
  { value: "contact", label: "Contact (ready client)" },
  { value: "vendor", label: "Vendor / service provider" },
]

// Reader for business_card_scans.classified_by (m617 typed column) — which
// determination tier decided the class (lib/contacts/card-classifier.ts).
const CLASSIFIED_BY_LABEL: Record<"picker" | "reader" | "notes" | "match" | "default", string> = {
  picker: "you picked it",
  reader: "read off the card",
  notes: "from your notes",
  match: "matched an existing record",
  default: "unclassified",
}

const SUBJECT_TYPE_LABEL: Record<CardSubjectType, string> = {
  sphere: "Sphere of influence",
  agent: "Fellow agent — recruiting prospect",
  potential_contact: "Potential client",
  contact: "Contact created",
  vendor: "Vendor bench candidate",
  unknown: "Unclassified — needs a human to pick",
}

type PostScanContact = {
  id: string
  name: string
  email: string
  company: string
  title: string
}

type CampaignSequence = {
  id: string
  name: string
  is_active: boolean
}

type ScanRow = {
  id: string
  created_at: string
  extracted_data: Record<string, string>
  confidence_score: number
  review_status: "approved" | "pending" | "rejected"
  contact_id: string | null
  raw_image_url: string
  /** users.id of the human who confirmed the scan (confirmBusinessCardScan, wave 141F);
   *  null when the automatic viability gate approved it. */
  reviewed_by: string | null
  /** When the viability gate ran, or when a human confirmed. */
  reviewed_at: string | null
  cardSubjectType: CardSubjectType | null
  subjectUserId: string | null
  subjectNotes: string | null
  classifiedBy: "picker" | "reader" | "notes" | "match" | "default" | null
  fieldConfidence: Partial<Record<CardField, number | null>>
  needsConfirmation: boolean
}

type ScanResult = {
  scanId: string
  contactId: string | null
  viable: boolean
  needsConfirmation: boolean
  extracted: Record<string, string>
  fieldConfidence: Partial<Record<CardField, number | null>>
  lowFields: CardField[]
  confidence?: number
  cardSubjectType?: CardSubjectType
  subjectUserId?: string | null
}

/** What the review surface edits: the reader's fields, their confidence, and whether a contact already exists (correction mode). */
type ConfirmTarget = {
  scanId: string
  fields: Partial<Record<CardField, string>>
  fieldConfidence: Partial<Record<CardField, number | null>>
  contactId: string | null
}

function ConfidenceBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100)
  const color =
    pct >= 80 ? "bg-green-100 text-green-800" :
    pct >= 50 ? "bg-yellow-100 text-yellow-800" :
                "bg-red-100 text-red-800"
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${color}`}>
      {pct}%
    </span>
  )
}

const FIELD_LABEL: Record<CardField, string> = {
  first_name: "First Name", last_name: "Last Name", email: "Email",
  phone: "Phone", company: "Company", title: "Title",
  address: "Address", website: "Website",
}

/**
 * CONFIRM / CORRECT THE READING (wave 141F — owner: "human confirmation where
 * needed … never overwrite higher-confidence data with weak extraction"). Every
 * field is editable; the ones the reader was unsure of (below the floor) are
 * marked. Confirming a HELD scan routes it; confirming a scan that already
 * produced a contact applies the correction field by field under the merge rule
 * and reports what was kept and why. Mobile: one column, 16 px inputs, 44 px taps.
 */
function CardConfirmForm({ target, onDone, onCancel }: { target: ConfirmTarget; onDone: (summary: { contactId: string | null; message: string }) => void; onCancel: () => void }) {
  const [values, setValues] = useState<Record<CardField, string>>(() => {
    const v = {} as Record<CardField, string>
    for (const f of CARD_FIELDS) v[f] = target.fields[f] ?? ""
    return v
  })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const floorPct = Math.round(CARD_FIELD_CONFIDENCE_FLOOR * 100)

  const submit = async () => {
    setSubmitting(true)
    setError(null)
    try {
      const res = await confirmBusinessCardScan({ scanId: target.scanId, fields: values })
      if (!res.ok) { setError(res.error); return }
      if (res.mode === "routed") {
        const r = res.result
        onDone({ contactId: r.contactId, message: r.contactId ? "Confirmed — contact created." : `Confirmed — filed as ${r.cardSubjectType.replace(/_/g, " ")}.` })
      } else {
        const applied = res.applied.length ? `updated ${res.applied.map((f) => FIELD_LABEL[f].toLowerCase()).join(", ")}` : "nothing needed updating"
        const kept = res.kept.length ? `; kept ${res.kept.map((k) => `${FIELD_LABEL[k.field].toLowerCase()} (${k.reason.replace(/_/g, " ")})`).join(", ")}` : ""
        onDone({ contactId: res.contactId, message: `Correction applied — ${applied}${kept}.` })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not confirm the scan. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="rounded-xl border border-amber-300 bg-amber-50/40 p-4 space-y-3" aria-label={target.contactId ? "Correct the card reading" : "Confirm the card reading"}>
      <div>
        <p className="text-sm font-semibold text-foreground">
          {target.contactId ? "Correct what the reader got wrong" : "Please confirm this card before it becomes a record"}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5">
          {target.contactId
            ? "Your correction overwrites the card's own reading; a value that came from a verified source or a person's own entry is kept and noted instead."
            : `Fields the reader was less than ${floorPct}% sure of are marked. Nothing is written until you confirm.`}
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {CARD_FIELDS.map((f) => {
          const conf = target.fieldConfidence[f]
          const low = !!target.fields[f] && (conf ?? 0) < CARD_FIELD_CONFIDENCE_FLOOR
          return (
            <div key={f}>
              <label htmlFor={`confirm-${f}`} className="flex items-center justify-between text-xs font-medium text-foreground mb-1">
                <span>{FIELD_LABEL[f]}</span>
                {target.fields[f] ? (
                  <span className={`text-[11px] ${low ? "text-amber-700" : "text-muted-foreground"}`}>
                    {conf == null ? "unsure" : `${Math.round(conf * 100)}% sure`}{low ? " — please check" : ""}
                  </span>
                ) : null}
              </label>
              <input
                id={`confirm-${f}`}
                value={values[f]}
                onChange={(e) => setValues((p) => ({ ...p, [f]: e.target.value }))}
                inputMode={f === "email" ? "email" : f === "phone" ? "tel" : f === "website" ? "url" : "text"}
                className={`w-full min-h-[44px] rounded-md border bg-background px-3 py-2 text-base focus:outline-none focus:ring-1 focus:ring-ring ${low ? "border-amber-400" : "border-border"}`}
              />
            </div>
          )
        })}
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-col sm:flex-row gap-2">
        <button type="button" onClick={onCancel} disabled={submitting} className="min-h-[44px] flex-1 rounded-lg border border-border py-2 text-sm text-muted-foreground hover:bg-muted transition-colors disabled:opacity-60">
          Not now
        </button>
        <button type="button" onClick={submit} disabled={submitting} className="min-h-[44px] flex-1 rounded-lg bg-foreground py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-60 transition-opacity">
          {submitting ? "Saving…" : target.contactId ? "Apply correction" : "Confirm and file"}
        </button>
      </div>
    </section>
  )
}

export default function BusinessCardsPage() {
  const router = useRouter()
  const { toast } = useToast()
  const [scanning, setScanning] = useState(false)
  const [result, setResult] = useState<ScanResult | null>(null)
  const [scans, setScans] = useState<ScanRow[]>([])
  const [loadingScans, setLoadingScans] = useState(true)
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [agentId, setAgentId] = useState<string | null>(null)
  const [brokerageId, setBrokerageId] = useState<string | null>(null)

  // wave 48 — card review surface: free-text notes (priority-2 classification
  // source) + an explicit picker (wins outright over the auto-classifier).
  const [cardNotes, setCardNotes] = useState("")
  const [cardSubjectPick, setCardSubjectPick] = useState<CardSubjectType | "">("")

  // Post-scan sheet state
  const [postScanContact, setPostScanContact] = useState<PostScanContact | null>(null)
  const [showNextSteps, setShowNextSteps] = useState(false)

  // Wave 141F — the confirm / correct surface (a held low-confidence scan, or
  // "Report extraction error" on a scan that already produced a contact).
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null)

  // Option 1 — Referral partner form state
  const [showReferralForm, setShowReferralForm] = useState(false)
  // referral_partners.partner_type CHECK — the UI used to offer agent_to_agent /
  // vendor / lender / title, NONE of which the column accepts, so every scanned
  // card failed on insert and the agent just saw "Please try again" forever.
  const [referralPartnerType, setReferralPartnerType] = useState<
    "real_estate_agent" | "mortgage_broker" | "title_company" | "home_inspector"
    | "contractor" | "insurance_agent" | "attorney" | "property_manager" | "other"
  >("real_estate_agent")
  const [referralNotes, setReferralNotes] = useState("")
  const [referralSubmitting, setReferralSubmitting] = useState(false)
  const [referralDone, setReferralDone] = useState(false)

  // Option 3 — Sequence enrollment state
  const [showSequencePanel, setShowSequencePanel] = useState(false)
  const [sequences, setSequences] = useState<CampaignSequence[]>([])
  const [sequencesLoading, setSequencesLoading] = useState(false)
  const [selectedSequenceId, setSelectedSequenceId] = useState("")
  const [sequenceSubmitting, setSequenceSubmitting] = useState(false)
  const [sequenceDone, setSequenceDone] = useState(false)

  useEffect(() => {
    const supabase = createClient()
    void (async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const { data: agentRecord } = await supabase
        .from("agents")
        .select("id, brokerage_id")
        .eq("user_id", user.id)
        .maybeSingle()

      if (agentRecord) {
        setAgentId(agentRecord.id)
        setBrokerageId(agentRecord.brokerage_id)
        const history = await getRecentScans({ agentId: agentRecord.id, brokerageId: agentRecord.brokerage_id, limit: 20 })
        setScans(history)
      } else {
        // Non-agent user (broker_admin, TC, etc.) — get brokerage_id from users table
        const { data: userRow } = await supabase
          .from("users")
          .select("brokerage_id")
          .eq("id", user.id)
          .maybeSingle()
        if (!userRow?.brokerage_id) return
        setAgentId(user.id)
        setBrokerageId(userRow.brokerage_id)
        const history = await getRecentScans({ agentId: user.id, brokerageId: userRow.brokerage_id, limit: 20 })
        setScans(history)
      }
      setLoadingScans(false)
    })()
  }, [])

  const processFile = useCallback(async (file: File) => {
    // Don't silently swallow the drop ("file won't add" from the walkthrough) — a
    // signed-in but not-yet-provisioned account (agent record / brokerage still
    // being set up by the login-time self-heal) gets clear feedback instead of
    // nothing. Once /dashboard has provisioned the records, the ids resolve and
    // the scan works.
    if (!agentId || !brokerageId) {
      toast({
        title: "Finishing your account setup",
        description: "We're still setting up your agent profile — refresh in a moment, then add your card.",
        variant: "destructive",
      })
      return
    }
    setScanning(true)
    setResult(null)
    try {
      const arrayBuffer = await file.arrayBuffer()
      const base64 = Buffer.from(arrayBuffer).toString("base64")
      const mimeType = (
        file.type === "image/png" ? "image/png" :
        file.type === "image/webp" ? "image/webp" :
        "image/jpeg"
      ) as "image/jpeg" | "image/png" | "image/webp"

      const res = await uploadBusinessCard({
        imageBase64: base64, mimeType, agentId, brokerageId,
        notes: cardNotes.trim() || undefined,
        subjectType: cardSubjectPick || undefined,
      })

      // Reload history
      const history = await getRecentScans({ agentId, brokerageId, limit: 20 })
      setScans(history)

      const newScan = history.find((s) => s.id === res.scanId)
      const extracted = res.extracted
      setResult({
        ...res,
        extracted,
        confidence: newScan?.confidence_score,
      })
      // Reset the review-surface inputs for the next scan.
      setCardNotes("")
      setCardSubjectPick("")

      // A reading the reader was unsure of is HELD — open the confirmation form at once.
      if (res.needsConfirmation) {
        setConfirmTarget({ scanId: res.scanId, fields: res.extracted, fieldConfidence: res.fieldConfidence, contactId: null })
      }

      // Trigger post-scan sheet only on viable scans that produced a contact
      if (res.viable && res.contactId) {
        const name = [extracted.first_name, extracted.last_name].filter(Boolean).join(" ")
        setPostScanContact({
          id: res.contactId,
          name,
          email: extracted.email ?? "",
          company: extracted.company ?? "",
          title: extracted.title ?? "",
        })
        setShowNextSteps(true)
        setShowReferralForm(false)
        setShowSequencePanel(false)
        setReferralDone(false)
        setSequenceDone(false)
        setReferralNotes("")
        setSelectedSequenceId("")
      }
    } finally {
      setScanning(false)
    }
  }, [agentId, brokerageId, cardNotes, cardSubjectPick])

  const dismissSheet = () => {
    setShowNextSteps(false)
    setShowReferralForm(false)
    setShowSequencePanel(false)
  }

  const handleCreatePartner = async () => {
    if (!postScanContact) return
    setReferralSubmitting(true)
    try {
      // Step 1: create the partner record, get back its id
      const partnerResult = await createPartner({
        partnerName: postScanContact.name,
        partnerType: referralPartnerType,
        agreementType: "informal",
        notes: referralNotes.trim() || undefined,
      })

      // Step 2: log the referral, linking the scanned contact as the referred person
      // createPartner returns { id } — that id is the referral_partners row UUID
      const [firstName, ...rest] = postScanContact.name.trim().split(" ")
      await createReferral({
        partnerId: partnerResult.id,
        referralSource: "business_card_scan",
        referredPerson: {
          firstName: firstName ?? undefined,
          lastName: rest.join(" ") || undefined,
          email: postScanContact.email || undefined,
        },
      })

      setReferralDone(true)
      toast({ title: "Referral partner added! Check your referral pipeline." })
      setTimeout(dismissSheet, 1200)
    } catch {
      toast({ title: "Failed to create referral partner. Please try again.", variant: "destructive" })
    } finally {
      setReferralSubmitting(false)
    }
  }

  const handleOpenSequencePanel = async () => {
    if (!brokerageId) return
    setShowSequencePanel(true)
    setSequencesLoading(true)
    try {
      const { sequences: seqs } = await listCampaignSequences(brokerageId)
      setSequences(seqs.filter((s) => s.is_active))
    } finally {
      setSequencesLoading(false)
    }
  }

  const handleEnrollSequence = async () => {
    if (!postScanContact || !selectedSequenceId) return
    setSequenceSubmitting(true)
    try {
      const result = await enrollContactInSequence({ sequenceId: selectedSequenceId, contactId: postScanContact.id })
      if (result.error) throw new Error(result.error)
      const sequenceName = sequences.find((s) => s.id === selectedSequenceId)?.name ?? "sequence"
      setSequenceDone(true)
      toast({ title: `Added to "${sequenceName}" sequence` })
      setTimeout(dismissSheet, 1200)
    } catch {
      toast({ title: "Failed to enroll in sequence. Please try again.", variant: "destructive" })
    } finally {
      setSequenceSubmitting(false)
    }
  }

  const handleFile = (file: File) => {
    if (!file.type.startsWith("image/")) return
    void processFile(file)
  }

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
    e.target.value = ""
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file) handleFile(file)
  }

  const fields = CARD_FIELDS
  const fieldLabel: Record<string, string> = FIELD_LABEL

  /** After a confirm / correction: refresh history, tell the agent, and open next steps when a contact exists. */
  const handleConfirmDone = async (summary: { contactId: string | null; message: string }) => {
    setConfirmTarget(null)
    toast({ title: summary.message })
    if (agentId && brokerageId) {
      const history = await getRecentScans({ agentId, brokerageId, limit: 20 })
      setScans(history)
      if (result) {
        const refreshed = history.find((s) => s.id === result.scanId)
        if (refreshed) {
          setResult({ ...result, needsConfirmation: false, contactId: refreshed.contact_id, extracted: refreshed.extracted_data, confidence: refreshed.confidence_score, cardSubjectType: refreshed.cardSubjectType ?? result.cardSubjectType })
        }
      }
    }
    if (summary.contactId) {
      const f = confirmTarget?.fields ?? {}
      setPostScanContact({
        id: summary.contactId,
        name: [f.first_name, f.last_name].filter(Boolean).join(" "),
        email: f.email ?? "",
        company: f.company ?? "",
        title: f.title ?? "",
      })
      setShowNextSteps(true)
    }
  }

  return (
    <main className="max-w-3xl mx-auto p-6 space-y-8">
      <h1 className="text-2xl font-semibold text-foreground">Business Card Scanner</h1>

      {/* Card review surface (wave 48): a card is never assumed a contact —
          classify it from context before (or after) you scan. Auto-detect
          reads the printed title/company, then these notes, then an existing
          match; picking a class here overrides all of that. */}
      <section className="space-y-3 rounded-xl border border-border p-4">
        <div>
          <label htmlFor="card-notes" className="block text-xs font-medium text-foreground mb-1">
            Notes on this card (optional)
          </label>
          <textarea
            id="card-notes"
            value={cardNotes}
            onChange={(e) => setCardNotes(e.target.value)}
            rows={2}
            placeholder="e.g. &quot;old friend from the block party&quot;, &quot;fellow agent at another shop&quot;, &quot;interested in selling next year&quot;..."
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div>
          <label htmlFor="card-subject-type" className="block text-xs font-medium text-foreground mb-1">
            Who is this?
          </label>
          <select
            id="card-subject-type"
            value={cardSubjectPick}
            onChange={(e) => setCardSubjectPick(e.target.value as CardSubjectType | "")}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          >
            {SUBJECT_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-muted-foreground">
            A scanned card is never assumed a client — it might be someone you know, a fellow agent, or just met.
            Auto-detect reads the card and your notes; picking a class here overrides it.
          </p>
        </div>
      </section>

      {/* Upload zone */}
      <section
        className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors cursor-pointer ${
          dragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/60"
        }`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        role="button"
        tabIndex={0}
        aria-label="Upload business card image"
        onKeyDown={(e) => e.key === "Enter" && fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          onChange={onInputChange}
          aria-hidden="true"
        />
        {scanning ? (
          <div className="space-y-2">
            <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-sm text-muted-foreground">Scanning card...</p>
          </div>
        ) : (
          <div className="space-y-2">
            <svg className="w-10 h-10 mx-auto text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <p className="text-sm font-medium text-foreground">Drop a photo or click to upload</p>
            <p className="text-xs text-muted-foreground">Tap to use camera on mobile — JPG, PNG, WebP</p>
          </div>
        )}
      </section>

      {/* Confirm / correct surface — a held scan, or a correction on a routed one */}
      {confirmTarget && (
        <CardConfirmForm target={confirmTarget} onDone={handleConfirmDone} onCancel={() => setConfirmTarget(null)} />
      )}

      {/* Result */}
      {result && (
        <section className="border border-border rounded-xl p-6 space-y-4">
          {result.viable ? (
            <>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">Extraction confidence</span>
                  {result.confidence !== undefined && <ConfidenceBadge score={result.confidence} />}
                </div>
                <span className={`text-xs px-2 py-1 rounded font-medium ${
                  result.needsConfirmation || result.cardSubjectType === "unknown" ? "bg-yellow-100 text-yellow-800" : "bg-green-100 text-green-700"
                }`}>
                  {result.needsConfirmation ? "Waiting for your confirmation" : result.cardSubjectType ? SUBJECT_TYPE_LABEL[result.cardSubjectType] : "Contact created"}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                {fields.map((k) => {
                  const val = result.extracted?.[k]?.trim()
                  if (!val) return null
                  const conf = result.fieldConfidence?.[k]
                  const low = (conf ?? 0) < CARD_FIELD_CONFIDENCE_FLOOR
                  return (
                    <div key={k}>
                      <p className="text-xs text-muted-foreground">{fieldLabel[k]}{conf != null ? <span className={low ? " text-amber-700" : ""}> · {Math.round(conf * 100)}%</span> : null}</p>
                      <p className="text-sm text-foreground font-medium">{val}</p>
                    </div>
                  )
                })}
              </div>

              {result.contactId && (
                <a
                  href={`/crm?contact=${result.contactId}`}
                  className="inline-flex items-center gap-1 text-sm text-primary underline underline-offset-2"
                >
                  View contact record
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </a>
              )}

              <p className="text-xs text-muted-foreground">
                Note: Physical business cards do not constitute TCPA digital consent. The contact will require explicit opt-in before receiving automated outreach.
              </p>

              {/* WIRED (wave 141F): this used to show a toast and flag nothing. It now opens the
                  correction form — the human's values are applied field by field under the
                  merge rule (a human beats the card's reading; a verified or self-entered value
                  is kept and noted). */}
              <button
                type="button"
                className="min-h-[44px] text-xs text-muted-foreground underline underline-offset-2"
                onClick={() => setConfirmTarget({ scanId: result.scanId, fields: result.extracted, fieldConfidence: result.fieldConfidence ?? {}, contactId: result.contactId })}
              >
                {result.needsConfirmation ? "Confirm the fields" : "Report extraction error"}
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <svg className="w-5 h-5 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <p className="text-sm font-medium text-foreground">Could not extract contact info — try a clearer photo</p>
              </div>
              {result.extracted && Object.values(result.extracted).some((v) => v?.trim()) && (
                <div className="grid grid-cols-2 gap-3 mt-2">
                  {fields.map((k) => {
                    const val = result.extracted?.[k]?.trim()
                    if (!val) return null
                    return (
                      <div key={k}>
                        <p className="text-xs text-muted-foreground">{fieldLabel[k]}</p>
                        <p className="text-sm text-foreground">{val}</p>
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </section>
      )}

      {/* History */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">Recent Scans</h2>
        {loadingScans ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : scans.length === 0 ? (
          <p className="text-sm text-muted-foreground">No scans yet.</p>
        ) : (
          <div className="border border-border rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-4 py-2 text-left font-medium text-muted-foreground">Date</th>
                  <th className="px-4 py-2 text-left font-medium text-muted-foreground">Name Extracted</th>
                  <th className="px-4 py-2 text-left font-medium text-muted-foreground">Confidence</th>
                  <th className="px-4 py-2 text-left font-medium text-muted-foreground">Status</th>
                  <th className="px-4 py-2 text-left font-medium text-muted-foreground">Contact</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {scans.map((s) => {
                  const ext = s.extracted_data
                  const name = [ext.first_name, ext.last_name].filter(Boolean).join(" ") || "—"
                  return (
                    <tr key={s.id} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3 text-muted-foreground">
                        {new Date(s.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 text-foreground">{name}</td>
                      <td className="px-4 py-3">
                        <ConfidenceBadge score={s.confidence_score} />
                      </td>
                      <td className="px-4 py-3">
                        {s.review_status === "approved" ? (
                          <span className={`text-xs px-2 py-0.5 rounded font-medium ${
                            s.cardSubjectType === "unknown" ? "bg-yellow-100 text-yellow-800" : "bg-green-100 text-green-800"
                          }`}>
                            {s.cardSubjectType ? SUBJECT_TYPE_LABEL[s.cardSubjectType] : "Contact created"}
                          </span>
                        ) : s.review_status === "pending" ? (
                          <button
                            type="button"
                            onClick={() => setConfirmTarget({ scanId: s.id, fields: s.extracted_data as Partial<Record<CardField, string>>, fieldConfidence: s.fieldConfidence, contactId: s.contact_id })}
                            className="min-h-[44px] text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded font-medium underline underline-offset-2"
                          >
                            Needs your confirmation — confirm
                          </button>
                        ) : (
                          <span className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded font-medium">Viability failed</span>
                        )}
                        {/* business_card_scans.classified_by (m617 typed column) — which
                            tier decided the class, so a picker override reads differently
                            from an auto-detect. */}
                        {s.review_status === "approved" && s.classifiedBy ? (
                          <p className="mt-1 text-[11px] text-muted-foreground">{CLASSIFIED_BY_LABEL[s.classifiedBy]}</p>
                        ) : null}
                        {/* business_card_scans.subject_notes — the free-text note typed on
                            the review surface at scan time. */}
                        {s.subjectNotes ? (
                          <p className="mt-1 text-[11px] text-muted-foreground italic">&ldquo;{s.subjectNotes}&rdquo;</p>
                        ) : null}
                        {/* The status above is the automatic viability gate's verdict unless a
                            person confirmed the scan (confirmBusinessCardScan stamps reviewed_by,
                            wave 141F) — said truthfully either way. */}
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {s.reviewed_by
                            ? `confirmed by a person${s.reviewed_at ? ` ${new Date(s.reviewed_at).toLocaleDateString()}` : ""}`
                            : s.review_status === "pending"
                              ? "held for your confirmation — nothing written yet"
                              : `auto-gated${s.reviewed_at ? ` ${new Date(s.reviewed_at).toLocaleDateString()}` : ""} — not reviewed by a person`}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        {s.contact_id ? (
                          <a
                            href={`/crm?contact=${s.contact_id}`}
                            className="text-primary underline underline-offset-2"
                          >
                            View
                          </a>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {/* Post-scan next steps sheet */}
      {showNextSteps && postScanContact && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40 bg-black/40"
            onClick={dismissSheet}
            aria-hidden="true"
          />

          {/* Sheet */}
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Contact created — next steps"
            className="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl border-t border-border bg-background p-6 shadow-2xl"
          >
            {/* Header */}
            <div className="flex items-start justify-between mb-4">
              <div>
                <div className="flex items-center gap-2 mb-0.5">
                  <svg className="w-4 h-4 text-green-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                  </svg>
                  <span className="text-base font-semibold text-foreground">Contact Created</span>
                </div>
                {postScanContact.name && (
                  <p className="text-sm text-muted-foreground leading-snug">
                    {postScanContact.name}
                    {postScanContact.title && postScanContact.company
                      ? ` · ${postScanContact.title} at ${postScanContact.company}`
                      : postScanContact.company
                      ? ` · ${postScanContact.company}`
                      : postScanContact.title
                      ? ` · ${postScanContact.title}`
                      : ""}
                  </p>
                )}
              </div>
              <button
                onClick={dismissSheet}
                className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                aria-label="Close"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">What would you like to do?</p>

            <div className="space-y-3">

              {/* Option 1 — Add as Referral Partner */}
              {!showReferralForm && !showSequencePanel && (
                <button
                  onClick={() => setShowReferralForm(true)}
                  className="w-full flex items-center justify-between rounded-xl border border-foreground/10 bg-muted/40 px-4 py-3 text-left hover:bg-muted/70 transition-colors"
                >
                  <div>
                    <p className="text-sm font-semibold text-foreground">Add as Referral Partner</p>
                    <p className="text-xs text-muted-foreground mt-0.5">Create a partner relationship in your referral pipeline</p>
                  </div>
                  <svg className="w-4 h-4 text-muted-foreground shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              )}

              {/* Referral partner inline form */}
              {showReferralForm && (
                <div className="rounded-xl border border-foreground/10 bg-muted/40 px-4 py-4 space-y-3">
                  <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                    {postScanContact.name && <p><span className="font-medium text-foreground">Name:</span> {postScanContact.name}</p>}
                    {postScanContact.email && <p><span className="font-medium text-foreground">Email:</span> {postScanContact.email}</p>}
                    {postScanContact.company && <p><span className="font-medium text-foreground">Company:</span> {postScanContact.company}</p>}
                    {postScanContact.title && <p><span className="font-medium text-foreground">Title:</span> {postScanContact.title}</p>}
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-foreground mb-1">Partnership Type</label>
                    <select
                      value={referralPartnerType}
                      onChange={(e) => setReferralPartnerType(e.target.value as typeof referralPartnerType)}
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                    >
                      <option value="real_estate_agent">Real estate agent</option>
                      <option value="mortgage_broker">Lender / mortgage broker</option>
                      <option value="title_company">Title company</option>
                      <option value="home_inspector">Home inspector</option>
                      <option value="contractor">Contractor</option>
                      <option value="insurance_agent">Insurance agent</option>
                      <option value="attorney">Attorney</option>
                      <option value="property_manager">Property manager</option>
                      <option value="other">Other</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-foreground mb-1">Notes (optional)</label>
                    <textarea
                      value={referralNotes}
                      onChange={(e) => setReferralNotes(e.target.value)}
                      rows={2}
                      placeholder="Met at open house, strong referral network..."
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setShowReferralForm(false)}
                      className="flex-1 rounded-lg border border-border py-2 text-sm text-muted-foreground hover:bg-muted transition-colors"
                    >
                      Back
                    </button>
                    <button
                      onClick={handleCreatePartner}
                      disabled={referralSubmitting || referralDone}
                      className="flex-1 rounded-lg bg-foreground py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-60 transition-opacity"
                    >
                      {referralDone ? "Partner added!" : referralSubmitting ? "Adding..." : "Create Referral Partner"}
                    </button>
                  </div>
                </div>
              )}

              {/* Options 2, 3, 4 — only when no sub-form open */}
              {!showReferralForm && !showSequencePanel && (
                <>
                  {/* Option 2 — Open Contact Record */}
                  <button
                    onClick={() => {
                      dismissSheet()
                      router.push(`/crm?contact=${postScanContact.id}`)
                    }}
                    className="w-full flex items-center justify-between rounded-xl border border-foreground/10 bg-muted/40 px-4 py-3 text-left hover:bg-muted/70 transition-colors"
                  >
                    <div>
                      <p className="text-sm font-medium text-foreground">Open Contact Record</p>
                      <p className="text-xs text-muted-foreground mt-0.5">View and edit the full contact in CRM</p>
                    </div>
                    <svg className="w-4 h-4 text-muted-foreground shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </button>

                  {/* Option 3 — Add to Nurture Sequence */}
                  <button
                    onClick={handleOpenSequencePanel}
                    className="w-full flex items-center justify-between rounded-xl border border-foreground/10 bg-muted/40 px-4 py-3 text-left hover:bg-muted/70 transition-colors"
                  >
                    <div>
                      <p className="text-sm font-medium text-foreground">Add to Nurture Sequence</p>
                      <p className="text-xs text-muted-foreground mt-0.5">Enroll in an automated follow-up sequence</p>
                    </div>
                    <svg className="w-4 h-4 text-muted-foreground shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </button>

                  {/* Option 4 — Just Keep Scanning */}
                  <button
                    onClick={dismissSheet}
                    className="w-full rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground hover:bg-muted transition-colors"
                  >
                    Just Keep Scanning
                  </button>
                </>
              )}

              {/* Sequence panel */}
              {showSequencePanel && (
                <div className="rounded-xl border border-foreground/10 bg-muted/40 px-4 py-4 space-y-3">
                  <p className="text-sm font-medium text-foreground">Choose a Sequence</p>
                  {sequencesLoading ? (
                    <p className="text-xs text-muted-foreground">Loading sequences...</p>
                  ) : sequences.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No active sequences found. Create one in Campaigns first.</p>
                  ) : (
                    <select
                      value={selectedSequenceId}
                      onChange={(e) => setSelectedSequenceId(e.target.value)}
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                    >
                      <option value="">Select a sequence...</option>
                      {sequences.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={() => setShowSequencePanel(false)}
                      className="flex-1 rounded-lg border border-border py-2 text-sm text-muted-foreground hover:bg-muted transition-colors"
                    >
                      Back
                    </button>
                    <button
                      onClick={handleEnrollSequence}
                      disabled={!selectedSequenceId || sequenceSubmitting || sequenceDone}
                      className="flex-1 rounded-lg bg-foreground py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-60 transition-opacity"
                    >
                      {sequenceDone ? "Enrolled!" : sequenceSubmitting ? "Enrolling..." : "Add to Sequence"}
                    </button>
                  </div>
                </div>
              )}

            </div>
          </div>
        </>
      )}
    </main>
  )
}
