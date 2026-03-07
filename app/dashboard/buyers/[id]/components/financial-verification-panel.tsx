"use client"

import { useState, useTransition } from "react"
import { Badge }    from "@/components/ui/badge"
import { Button }   from "@/components/ui/button"
import { Input }    from "@/components/ui/input"
import { Label }    from "@/components/ui/label"
import { cn }       from "@/lib/utils"
import {
  upsertFinancialProfile,
  recordDocumentUpload,
  markFinanciallyVerified,
  connectBuyerToLender,
} from "@/app/actions/buyer-financial"
import { useToast } from "@/hooks/use-toast"

interface Partner {
  id:           string
  partner_name: string
  company_name: string | null
  phone:        string | null
}

interface FinancialVerificationPanelProps {
  contactId:    string
  brokerageId:  string
  agentUserId:  string
  agentName:    string
  buyerName:    string
  buyerStage:   string | null
  profile:      any | null
  partners:     Partner[]
  onVerified:   () => void
}

export function FinancialVerificationPanel({
  contactId, brokerageId, agentUserId, agentName, buyerName,
  buyerStage, profile, partners, onVerified,
}: FinancialVerificationPanelProps) {
  const { toast }          = useToast()
  const [, startTransition] = useTransition()

  const isVerified = profile?.verified === true

  // Collapsed verified state
  if (isVerified) {
    const finType   = profile.is_cash_buyer ? "Cash Buyer" : profile.finance_type ?? "Financing"
    const amount    = profile.pre_approval_amount
      ? `$${Number(profile.pre_approval_amount).toLocaleString()}`
      : null
    const expiresAt = profile.pre_approval_expires_at
      ? new Date(profile.pre_approval_expires_at).toLocaleDateString()
      : null

    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge className="bg-green-100 text-green-800 border-green-200">Financially Verified</Badge>
          <span className="text-sm text-muted-foreground">{finType}</span>
          {amount && <span className="text-sm font-medium">{amount}</span>}
          {expiresAt && <span className="text-xs text-muted-foreground">expires {expiresAt}</span>}
        </div>
      </div>
    )
  }

  return <FinancialVerificationForm
    contactId={contactId} brokerageId={brokerageId} agentUserId={agentUserId}
    agentName={agentName} buyerName={buyerName} partners={partners} onVerified={onVerified}
  />
}

// ─── FORM (expanded state) ────────────────────────────────────────────────────

function FinancialVerificationForm({
  contactId, brokerageId, agentUserId, agentName, buyerName, partners, onVerified,
}: Omit<FinancialVerificationPanelProps, "buyerStage" | "profile">) {
  const { toast }               = useToast()
  const [, startTransition]      = useTransition()
  const [buyerType, setBuyerType] = useState<"financing" | "cash">("financing")
  const [docUploaded, setDocUploaded] = useState(false)
  const [docId, setDocId]        = useState<string | null>(null)
  const [lenderWaiting, setLenderWaiting] = useState(false)
  const [showLenderSection, setShowLenderSection] = useState(false)
  const [referredPartnerId, setReferredPartnerId] = useState<string | null>(null)

  // Form field state
  const [amount, setAmount]       = useState("")
  const [lender, setLender]       = useState("")
  const [expiry, setExpiry]       = useState("")
  const [verifyAmount, setVerifyAmount] = useState("")
  const [isPending, setIsPending] = useState(false)

  // Simulate file upload (real upload would use Vercel Blob)
  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setIsPending(true)
    startTransition(async () => {
      const docCategory = buyerType === "financing" ? "pre_approval_letter" : "proof_of_funds"
      const result = await recordDocumentUpload({
        contactId, brokerageId, uploadedBy: agentUserId,
        documentName:  file.name,
        documentUrl:   URL.createObjectURL(file), // placeholder until Blob integration
        docCategory,
        verificationAmount: buyerType === "cash" && verifyAmount ? Number(verifyAmount) : undefined,
        verificationLender: buyerType === "financing" && lender ? lender : undefined,
        expirationDate:     buyerType === "financing" && expiry ? expiry : undefined,
      })
      if (result.success) {
        setDocId(result.docId ?? null)
        setDocUploaded(true)
        toast({ title: "Document uploaded", description: `${file.name} saved successfully` })
      } else {
        toast({ title: "Upload failed", description: result.error, variant: "destructive" })
      }
      setIsPending(false)
    })
  }

  async function handleVerify() {
    if (!docUploaded && !lenderWaiting) return
    setIsPending(true)

    // First upsert profile
    await upsertFinancialProfile({
      contactId, brokerageId, agentUserId,
      financeType:             buyerType === "cash" ? "cash" : "conventional",
      isCashBuyer:             buyerType === "cash",
      preApprovalAmount:       buyerType === "financing" && amount ? Number(amount) : buyerType === "cash" && verifyAmount ? Number(verifyAmount) : undefined,
      preApprovalLender:       buyerType === "financing" ? lender || undefined : undefined,
      preApprovalExpiresAt:    buyerType === "financing" ? expiry || undefined : undefined,
      preApprovalLetterDocId:  buyerType === "financing" ? docId ?? undefined : undefined,
      proofOfFundsDocId:       buyerType === "cash"      ? docId ?? undefined : undefined,
    })

    const result = await markFinanciallyVerified({ contactId, brokerageId, agentUserId })
    setIsPending(false)

    if (result.success) {
      toast({ title: "Buyer financially verified", description: "Stage advanced to Financially Verified" })
      onVerified()
    } else {
      toast({ title: "Verification failed", description: result.error, variant: "destructive" })
    }
  }

  async function handleConnectLender(partner: Partner) {
    setIsPending(true)
    const result = await connectBuyerToLender({
      contactId, brokerageId, agentUserId, agentName, buyerName,
      partnerId:   partner.id,
      partnerName: partner.partner_name,
    })
    setIsPending(false)
    if (result.success) {
      setReferredPartnerId(partner.id)
      toast({ title: `Introduction sent to ${partner.partner_name}`, description: "Waiting for lender pre-approval" })
    } else {
      toast({ title: "Failed to send introduction", description: result.error, variant: "destructive" })
    }
  }

  const canVerify = docUploaded || lenderWaiting

  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-5">
      <div>
        <h3 className="text-sm font-semibold">Financial Verification</h3>
        <p className="text-xs text-muted-foreground mt-0.5">Required before scheduling showings</p>
      </div>

      {/* Buyer type selector */}
      <div className="flex gap-3">
        {(["financing", "cash"] as const).map(type => (
          <button
            key={type}
            onClick={() => setBuyerType(type)}
            className={cn(
              "flex items-center gap-2 px-4 py-2 rounded-md border text-sm transition-colors",
              buyerType === type
                ? "border-primary bg-primary/5 text-primary font-medium"
                : "border-border text-muted-foreground hover:border-foreground/30"
            )}
          >
            <span className={cn(
              "w-3.5 h-3.5 rounded-full border-2 flex-shrink-0",
              buyerType === type ? "border-primary bg-primary" : "border-muted-foreground"
            )} />
            {type === "financing" ? "Financing Buyer" : "Cash Buyer"}
          </button>
        ))}
      </div>

      {/* Financing path */}
      {buyerType === "financing" && (
        <div className="space-y-4">
          {!docUploaded ? (
            <div>
              <Label className="text-xs font-medium mb-2 block">Pre-Approval Letter (PDF, JPG, PNG)</Label>
              <label className={cn(
                "flex flex-col items-center justify-center w-full h-24 rounded-md border-2 border-dashed cursor-pointer",
                "border-border hover:border-primary/50 hover:bg-muted/40 transition-colors text-center px-4"
              )}>
                <span className="text-xs text-muted-foreground">Click to upload or drag &amp; drop</span>
                <input type="file" accept=".pdf,.jpg,.jpeg,.png" className="sr-only" onChange={handleFileChange} disabled={isPending} />
              </label>
            </div>
          ) : (
            <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
              Document uploaded
            </div>
          )}

          {docUploaded && (
            <div className="grid grid-cols-1 gap-3">
              <div className="space-y-1">
                <Label htmlFor="amount" className="text-xs">Pre-approval amount ($)</Label>
                <Input id="amount" type="number" placeholder="450000" value={amount} onChange={e => setAmount(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="lender" className="text-xs">Lender name</Label>
                <Input id="lender" placeholder="First National Bank" value={lender} onChange={e => setLender(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="expiry" className="text-xs">Expiration date</Label>
                <Input id="expiry" type="date" value={expiry} onChange={e => setExpiry(e.target.value)} />
              </div>
            </div>
          )}

          {/* Lender sending directly */}
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={lenderWaiting}
              onChange={e => setLenderWaiting(e.target.checked)}
              className="rounded"
            />
            Lender is sending directly
          </label>
          {lenderWaiting && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Waiting for lender — verify once received
            </div>
          )}

          {/* Need a lender? */}
          {partners.length > 0 && (
            <div>
              <button
                onClick={() => setShowLenderSection(s => !s)}
                className="text-xs text-primary hover:underline"
              >
                {showLenderSection ? "Hide" : "Need a lender?"}
              </button>
              {showLenderSection && (
                <div className="mt-2 space-y-2">
                  {partners.map(p => (
                    <div key={p.id} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                      <div>
                        <p className="text-sm font-medium">{p.partner_name}</p>
                        {p.company_name && <p className="text-xs text-muted-foreground">{p.company_name}</p>}
                        {p.phone && <p className="text-xs text-muted-foreground">{p.phone}</p>}
                      </div>
                      <Button
                        size="sm"
                        variant={referredPartnerId === p.id ? "outline" : "default"}
                        disabled={isPending || referredPartnerId === p.id}
                        onClick={() => handleConnectLender(p)}
                      >
                        {referredPartnerId === p.id ? "Sent" : "Connect"}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Cash path */}
      {buyerType === "cash" && (
        <div className="space-y-4">
          {!docUploaded ? (
            <div>
              <Label className="text-xs font-medium mb-2 block">Proof of Funds (PDF, JPG, PNG)</Label>
              <label className={cn(
                "flex flex-col items-center justify-center w-full h-24 rounded-md border-2 border-dashed cursor-pointer",
                "border-border hover:border-primary/50 hover:bg-muted/40 transition-colors text-center px-4"
              )}>
                <span className="text-xs text-muted-foreground">Click to upload or drag &amp; drop</span>
                <input type="file" accept=".pdf,.jpg,.jpeg,.png" className="sr-only" onChange={handleFileChange} disabled={isPending} />
              </label>
            </div>
          ) : (
            <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
              Document uploaded
            </div>
          )}
          {docUploaded && (
            <div className="space-y-1">
              <Label htmlFor="verifyAmount" className="text-xs">Verified amount ($)</Label>
              <Input id="verifyAmount" type="number" placeholder="800000" value={verifyAmount} onChange={e => setVerifyAmount(e.target.value)} />
            </div>
          )}
        </div>
      )}

      {/* Verify button */}
      <Button
        className="w-full"
        disabled={!canVerify || isPending}
        onClick={handleVerify}
      >
        {isPending ? "Saving..." : "Mark as Financially Verified"}
      </Button>
    </div>
  )
}
