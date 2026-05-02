"use client"

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Loader2, ShieldCheck, ShieldAlert, FileCheck2, Mail, Copy, Users } from "lucide-react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  loadFinancialProfile,
  upsertFinancialProfile,
  markFinanciallyVerified,
  connectBuyerToLender,
  getBrokerageLenders,
} from "@/app/actions/buyer-financial"

type FinanceType = "conventional" | "fha" | "va" | "cash" | "other"

interface LenderUser {
  id: string
  full_name: string
  email: string | null
  phone: string | null
}

interface Props {
  contactId: string
  brokerageId: string
  agentUserId: string
  agentName?: string
  buyerName?: string
}

export function FinancialVerificationPanel({ contactId, brokerageId, agentUserId, agentName, buyerName }: Props) {
  const [loading, setLoading] = useState(true)
  const [profile, setProfile] = useState<any | null>(null)
  const [documents, setDocuments] = useState<any[]>([])

  const [financeType, setFinanceType] = useState<FinanceType>("conventional")
  const [preApprovalAmount, setPreApprovalAmount] = useState<string>("")
  const [preApprovalExpiresAt, setPreApprovalExpiresAt] = useState<string>("")
  const [downPaymentPercent, setDownPaymentPercent] = useState<string>("")
  const [agentNotes, setAgentNotes] = useState<string>("")
  const [bypassReason, setBypassReason] = useState<string>("")

  // Lender intro — userId-based
  const [lenders, setLenders] = useState<LenderUser[]>([])
  const [selectedLenderId, setSelectedLenderId] = useState<string>("")
  const [lenderIntroOpen, setLenderIntroOpen] = useState(false)
  const [lenderIntroText, setLenderIntroText] = useState("")
  const [sendingIntro, setSendingIntro] = useState(false)

  const [isPending, startTransition] = useTransition()

  async function load() {
    setLoading(true)
    try {
      const [profileResult, lendersResult] = await Promise.all([
        loadFinancialProfile({ contactId }),
        getBrokerageLenders({ brokerageId }),
      ])
      if (profileResult.success && profileResult.profile) {
        setProfile(profileResult.profile)
        setDocuments(profileResult.documents ?? [])
        setFinanceType((profileResult.profile.finance_type as FinanceType) ?? "conventional")
        setPreApprovalAmount(
          profileResult.profile.pre_approval_amount != null ? String(profileResult.profile.pre_approval_amount) : ""
        )
        setPreApprovalExpiresAt(profileResult.profile.pre_approval_expires_at ?? "")
        setDownPaymentPercent(
          profileResult.profile.down_payment_percent != null ? String(profileResult.profile.down_payment_percent) : ""
        )
        setAgentNotes(profileResult.profile.agent_notes ?? "")
        // Restore previously linked lender
        if (profileResult.profile.lender_referred_partner_id) {
          setSelectedLenderId(profileResult.profile.lender_referred_partner_id)
        }
      } else {
        setProfile(null)
        setDocuments([])
      }
      if (lendersResult.success) {
        setLenders(lendersResult.lenders ?? [])
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId])

  const isCash = financeType === "cash"
  const isVerified = profile?.verified === true

  const requiredDocPresent = isCash
    ? !!profile?.proof_of_funds_doc_id
    : !!profile?.pre_approval_letter_doc_id

  const selectedLender = lenders.find((l) => l.id === selectedLenderId) ?? null

  function save() {
    startTransition(async () => {
      const result = await upsertFinancialProfile({
        contactId,
        brokerageId,
        agentUserId,
        financeType,
        isCashBuyer: isCash,
        preApprovalAmount: preApprovalAmount ? Number(preApprovalAmount) : undefined,
        preApprovalLender: selectedLender?.full_name || undefined,
        preApprovalExpiresAt: preApprovalExpiresAt || undefined,
        downPaymentPercent: downPaymentPercent ? Number(downPaymentPercent) : undefined,
      })
      if (result.success) {
        toast.success("Financial profile saved.")
        await load()
      } else {
        toast.error(result.error ?? "Save failed.")
      }
    })
  }

  function verify() {
    startTransition(async () => {
      const result = await markFinanciallyVerified({
        contactId,
        brokerageId,
        agentUserId,
      })
      if (result.success) {
        toast.success("Buyer marked financially verified — Search/Tours/Offers unlocked.")
        await load()
      } else {
        toast.error(result.error ?? "Verification failed.")
      }
    })
  }

  function bypassVerify() {
    if (!bypassReason.trim()) {
      toast.error("Bypass requires a written justification (logged for compliance).")
      return
    }
    startTransition(async () => {
      await upsertFinancialProfile({
        contactId,
        brokerageId,
        agentUserId,
        financeType,
        isCashBuyer: isCash,
      })
      const result = await markFinanciallyVerified({
        contactId,
        brokerageId,
        agentUserId,
      })
      if (result.success) {
        toast.success("Buyer verified via agent bypass — note logged.")
        setBypassReason("")
        await load()
      } else {
        toast.error(result.error ?? "Bypass failed.")
      }
    })
  }

  function openLenderIntro() {
    if (!selectedLender) return
    const amount = preApprovalAmount
      ? `$${Number(preApprovalAmount).toLocaleString()}`
      : "[loan amount]"
    const draft = `Hi ${selectedLender.full_name},

I wanted to introduce you to one of my buyers who is ready to move forward with a home purchase.

Buyer Details:
- Desired loan amount: ${amount}
- Financing type: ${financeType.toUpperCase()}
- Pre-approval status: ${profile?.pre_approval_letter_doc_id ? "Letter received" : "In process"}${preApprovalExpiresAt ? `\n- Pre-approval expires: ${preApprovalExpiresAt}` : ""}

Please reach out to the buyer directly and keep me copied on your correspondence.

Best,
${agentName ?? "[Agent Name]"}`
    setLenderIntroText(draft)
    setLenderIntroOpen(true)
  }

  async function sendLenderIntro() {
    if (!selectedLender) return
    setSendingIntro(true)
    try {
      const result = await connectBuyerToLender({
        contactId,
        brokerageId,
        agentUserId,
        agentName: agentName ?? "Your Agent",
        buyerName: buyerName ?? "Buyer",
        partnerId: selectedLender.id,
        partnerName: selectedLender.full_name,
        lenderUserId: selectedLender.id,
      })
      if (result.success) {
        toast.success(`Introduction sent to ${selectedLender.full_name} — they'll see it in their portal.`)
        setLenderIntroOpen(false)
      } else {
        toast.error(result.error ?? "Failed to send introduction.")
      }
    } finally {
      setSendingIntro(false)
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
          Loading financial profile…
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            {isVerified ? (
              <>
                <ShieldCheck className="h-4 w-4 text-emerald-600" />
                Financially verified
                <Badge variant="outline" className="text-emerald-700 border-emerald-300 ml-auto">
                  Search · Tours · Offers unlocked
                </Badge>
              </>
            ) : (
              <>
                <ShieldAlert className="h-4 w-4 text-amber-600" />
                Financial verification pending
                <Badge variant="outline" className="text-amber-700 border-amber-300 ml-auto">
                  Tours & offers locked
                </Badge>
              </>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label className="text-xs">Financing type</Label>
            <RadioGroup
              value={financeType}
              onValueChange={(v) => setFinanceType(v as FinanceType)}
              className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-2"
            >
              {[
                { value: "conventional", label: "Conventional" },
                { value: "fha", label: "FHA" },
                { value: "va", label: "VA" },
                { value: "cash", label: "Cash buyer" },
                { value: "other", label: "Other" },
              ].map((opt) => (
                <label
                  key={opt.value}
                  className={`flex items-center gap-2 rounded-md border p-2 cursor-pointer text-sm ${
                    financeType === opt.value ? "border-primary bg-primary/5" : "border-border"
                  }`}
                >
                  <RadioGroupItem value={opt.value} />
                  {opt.label}
                </label>
              ))}
            </RadioGroup>
          </div>

          {/* Cash → Proof of Funds; Financed → Pre-approval letter */}
          {isCash ? (
            <div className="rounded-lg border p-3 bg-muted/20">
              <div className="flex items-center gap-2 mb-1">
                <FileCheck2 className="h-4 w-4 text-muted-foreground" />
                <p className="text-sm font-medium">Proof of Funds</p>
                {profile?.proof_of_funds_doc_id ? (
                  <Badge variant="outline" className="text-emerald-700 border-emerald-300">Uploaded</Badge>
                ) : (
                  <Badge variant="outline" className="text-amber-700 border-amber-300">Required</Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Upload via the contact's document center under "Financial Verification" → Proof of Funds.
              </p>
            </div>
          ) : (
            <>
              <div className="rounded-lg border p-3 bg-muted/20">
                <div className="flex items-center gap-2 mb-1">
                  <FileCheck2 className="h-4 w-4 text-muted-foreground" />
                  <p className="text-sm font-medium">Pre-Approval Letter</p>
                  {profile?.pre_approval_letter_doc_id ? (
                    <Badge variant="outline" className="text-emerald-700 border-emerald-300">Uploaded</Badge>
                  ) : (
                    <Badge variant="outline" className="text-amber-700 border-amber-300">Required</Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Upload via the contact's document center under "Financial Verification" → Pre-Approval Letter.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Pre-approval amount</Label>
                  <Input
                    type="number"
                    inputMode="decimal"
                    value={preApprovalAmount}
                    onChange={(e) => setPreApprovalAmount(e.target.value)}
                    placeholder="450000"
                    className="h-8 mt-1"
                  />
                </div>
                <div>
                  <Label className="text-xs">Pre-approval expires</Label>
                  <Input
                    type="date"
                    value={preApprovalExpiresAt}
                    onChange={(e) => setPreApprovalExpiresAt(e.target.value)}
                    className="h-8 mt-1"
                  />
                </div>
                <div>
                  <Label className="text-xs">Down payment %</Label>
                  <Input
                    type="number"
                    inputMode="decimal"
                    value={downPaymentPercent}
                    onChange={(e) => setDownPaymentPercent(e.target.value)}
                    placeholder="20"
                    className="h-8 mt-1"
                  />
                </div>
              </div>

              {/* Lender Selection — userId-based, not free text */}
              <div className="rounded-md bg-blue-50 border border-blue-200 p-3 space-y-3">
                <div className="flex items-center gap-1.5">
                  <Users className="h-4 w-4 text-blue-700" />
                  <p className="text-xs font-medium text-blue-800">Lender Introduction</p>
                </div>
                <div>
                  <Label className="text-xs text-blue-800">Select lender from your brokerage</Label>
                  <Select value={selectedLenderId} onValueChange={setSelectedLenderId}>
                    <SelectTrigger className="h-8 mt-1 bg-white border-blue-300 text-sm">
                      <SelectValue placeholder={lenders.length === 0 ? "No lenders in system" : "Select a lender…"} />
                    </SelectTrigger>
                    <SelectContent>
                      {lenders.map((l) => (
                        <SelectItem key={l.id} value={l.id}>
                          <span className="font-medium">{l.full_name}</span>
                          {l.email && <span className="text-muted-foreground ml-2 text-xs">{l.email}</span>}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {lenders.length === 0 && (
                    <p className="text-xs text-blue-600 mt-1">
                      No lender users exist in this brokerage yet. Ask your admin to invite lenders.
                    </p>
                  )}
                </div>
                {selectedLender && (
                  <div className="text-xs text-blue-700 space-y-0.5">
                    {selectedLender.email && <p>Email: {selectedLender.email}</p>}
                    {selectedLender.phone && <p>Phone: {selectedLender.phone}</p>}
                  </div>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 border-blue-300 text-blue-700 hover:bg-blue-50"
                  disabled={!selectedLender}
                  onClick={openLenderIntro}
                >
                  <Mail className="h-3.5 w-3.5" />
                  Draft Introduction
                </Button>
              </div>
            </>
          )}

          <div className="flex items-center justify-end gap-2 pt-2 border-t">
            <Button onClick={save} variant="outline" disabled={isPending}>
              {isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Save profile
            </Button>
            <Button onClick={verify} disabled={isPending || isVerified || !requiredDocPresent}>
              {isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <ShieldCheck className="h-4 w-4 mr-2" />}
              Mark verified
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Agent bypass — for verbal confirmation, long-standing client, etc. */}
      {!isVerified && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-amber-600" />
              Agent bypass
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Override the verification gate without docs (verbal confirmation, long-standing client, etc.).
              The note below is logged to the contact activity for compliance.
            </p>
            <Textarea
              value={bypassReason}
              onChange={(e) => setBypassReason(e.target.value)}
              placeholder="Why are you bypassing financial verification? (required)"
              rows={2}
            />
            <div className="flex justify-end">
              <Button
                variant="outline"
                onClick={bypassVerify}
                disabled={isPending || !bypassReason.trim()}
                className="text-amber-700 border-amber-300 hover:bg-amber-50"
              >
                Verify by bypass
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {documents.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Verification documents</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {documents.map((doc: any) => (
                <li key={doc.id} className="py-2 text-sm flex items-center justify-between">
                  <span className="truncate">{doc.document_name ?? doc.original_filename ?? "Document"}</span>
                  <Badge variant="outline" className="text-xs">
                    {(doc.doc_category ?? "").toString().replace(/_/g, " ")}
                  </Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Lender Introduction Dialog */}
      <Dialog open={lenderIntroOpen} onOpenChange={setLenderIntroOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              Lender Introduction
              {selectedLender && <span className="text-muted-foreground font-normal"> — {selectedLender.full_name}</span>}
            </DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            Review and edit this message. "Send Introduction" will notify {selectedLender?.full_name} via their lender portal.
            You can also copy the text to send via your own email.
          </p>
          <Textarea
            value={lenderIntroText}
            onChange={(e) => setLenderIntroText(e.target.value)}
            rows={12}
            className="text-sm font-mono resize-none"
          />
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              className="gap-1.5"
              onClick={() => {
                navigator.clipboard.writeText(lenderIntroText)
                toast.success("Copied to clipboard")
              }}
            >
              <Copy className="h-3.5 w-3.5" />
              Copy
            </Button>
            <Button onClick={sendLenderIntro} disabled={sendingIntro || !selectedLender}>
              {sendingIntro ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Mail className="h-4 w-4 mr-2" />}
              Send Introduction
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
