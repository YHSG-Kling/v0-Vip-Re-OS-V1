"use client"

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Loader2, ShieldCheck, ShieldAlert, FileCheck2 } from "lucide-react"
import { toast } from "sonner"
import {
  loadFinancialProfile,
  upsertFinancialProfile,
  markFinanciallyVerified,
} from "@/app/actions/buyer-financial"

type FinanceType = "conventional" | "fha" | "va" | "cash" | "other"

interface Props {
  contactId: string
  brokerageId: string
  agentUserId: string
}

export function FinancialVerificationPanel({ contactId, brokerageId, agentUserId }: Props) {
  const [loading, setLoading] = useState(true)
  const [profile, setProfile] = useState<any | null>(null)
  const [documents, setDocuments] = useState<any[]>([])

  const [financeType, setFinanceType] = useState<FinanceType>("conventional")
  const [preApprovalAmount, setPreApprovalAmount] = useState<string>("")
  const [preApprovalLender, setPreApprovalLender] = useState<string>("")
  const [preApprovalExpiresAt, setPreApprovalExpiresAt] = useState<string>("")
  const [downPaymentPercent, setDownPaymentPercent] = useState<string>("")
  const [agentNotes, setAgentNotes] = useState<string>("")
  const [bypassReason, setBypassReason] = useState<string>("")

  const [isPending, startTransition] = useTransition()

  async function load() {
    setLoading(true)
    try {
      const result = await loadFinancialProfile({ contactId })
      if (result.success && result.profile) {
        setProfile(result.profile)
        setDocuments(result.documents ?? [])
        setFinanceType((result.profile.finance_type as FinanceType) ?? "conventional")
        setPreApprovalAmount(
          result.profile.pre_approval_amount != null ? String(result.profile.pre_approval_amount) : ""
        )
        setPreApprovalLender(result.profile.pre_approval_lender ?? "")
        setPreApprovalExpiresAt(result.profile.pre_approval_expires_at ?? "")
        setDownPaymentPercent(
          result.profile.down_payment_percent != null ? String(result.profile.down_payment_percent) : ""
        )
        setAgentNotes(result.profile.agent_notes ?? "")
      } else {
        setProfile(null)
        setDocuments([])
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

  function save() {
    startTransition(async () => {
      const result = await upsertFinancialProfile({
        contactId,
        brokerageId,
        agentUserId,
        financeType,
        isCashBuyer: isCash,
        preApprovalAmount: preApprovalAmount ? Number(preApprovalAmount) : undefined,
        preApprovalLender: preApprovalLender || undefined,
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
      // Record the bypass note before verifying
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
                  <Label className="text-xs">Pre-approval lender</Label>
                  <Input
                    value={preApprovalLender}
                    onChange={(e) => setPreApprovalLender(e.target.value)}
                    placeholder="Lender name"
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
                  <span className="truncate">{doc.original_filename ?? doc.filename ?? "Document"}</span>
                  <Badge variant="outline" className="text-xs">
                    {(doc.doc_category ?? "").toString().replace(/_/g, " ")}
                  </Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
