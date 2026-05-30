"use client"

/**
 * BuyerFinancialUploadCard — buyer-portal surface for self-serve
 * pre-approval / proof-of-funds uploads + lender marketplace connect.
 *
 * Two parallel paths (per Sprint Z3 spec):
 *   • Direct upload     — buyer uploads pre-approval letter or POF (PDF/image)
 *   • Lender from market — buyer picks a brokerage-vetted lender; the
 *                          agent gets a notification to introduce, and the
 *                          lender then uploads on the buyer's behalf when
 *                          the buyer is approved.
 *
 * 100% wraps EXISTING service-role actions (recordDocumentUpload,
 * connectBuyerToLender, loadFinancialProfile, getBrokerageLenders) via
 * the auth-gated portal wrappers in app/actions/portal-buyer-financial.ts.
 *
 * Slot into /portal/[contactId]/page.tsx (buyer mode) alongside the
 * existing FinancialMeaningCard.
 */

import { useEffect, useState } from "react"
import { upload } from "@vercel/blob/client"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Upload, FileText, CheckCircle2, Loader2, ShieldCheck, Mail } from "lucide-react"
import { toast } from "sonner"
import {
  submitBuyerFinancialFromPortalAction,
  connectBuyerToLenderFromPortalAction,
  loadFinancialProfileFromPortalAction,
  getBrokerageLendersFromPortalAction,
} from "@/app/actions/portal-buyer-financial"

interface Props {
  contactId: string
}

interface ProfileDocument {
  id: string
  document_name: string
  document_url: string
  doc_category: string | null
  verified: boolean
  uploaded_at: string
}

interface Lender {
  id: string
  full_name: string
  email: string | null
  phone: string | null
}

export function BuyerFinancialUploadCard({ contactId }: Props) {
  const [profile, setProfile] = useState<any>(null)
  const [documents, setDocuments] = useState<ProfileDocument[]>([])
  const [lenders, setLenders] = useState<Lender[]>([])
  const [busy, setBusy] = useState(false)
  const [docCategory, setDocCategory] = useState<"pre_approval_letter" | "proof_of_funds">("pre_approval_letter")
  const [verificationAmount, setVerificationAmount] = useState<string>("")
  const [verificationLender, setVerificationLender] = useState<string>("")
  const [pickedLenderId, setPickedLenderId] = useState<string>("")

  useEffect(() => {
    void reload()
    void loadLenders()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId])

  async function reload() {
    const res = await loadFinancialProfileFromPortalAction({ contactId })
    if (res.success) {
      setProfile(res.profile ?? null)
      setDocuments((res.documents ?? []) as ProfileDocument[])
    }
  }

  async function loadLenders() {
    const res = await getBrokerageLendersFromPortalAction({ contactId })
    if (res.success) setLenders((res.lenders ?? []) as Lender[])
  }

  async function handleUpload(file: File) {
    setBusy(true)
    try {
      // Use the existing auth-gated /api/blob/upload route
      const blob = await upload(`buyer-financial/${contactId}/${file.name}`, file, {
        access: "public",
        handleUploadUrl: "/api/blob/upload",
      })
      const res = await submitBuyerFinancialFromPortalAction({
        contactId,
        blobUrl:     blob.url,
        fileName:    file.name,
        docCategory,
        verificationAmount: verificationAmount ? Number(verificationAmount) : undefined,
        verificationLender: verificationLender.trim() || undefined,
      })
      if ("success" in res && res.success) {
        toast.success("Document submitted to your agent")
        setVerificationAmount("")
        setVerificationLender("")
        void reload()
      } else {
        toast.error(("error" in res ? res.error : "") || "Upload failed")
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed")
    } finally {
      setBusy(false)
    }
  }

  async function handleConnectLender() {
    if (!pickedLenderId) return
    const lender = lenders.find(l => l.id === pickedLenderId)
    if (!lender) return
    setBusy(true)
    try {
      const res = await connectBuyerToLenderFromPortalAction({
        contactId,
        partnerId:   lender.id,
        partnerName: lender.full_name,
      })
      if ("success" in res && res.success) {
        toast.success(`We'll connect you with ${lender.full_name}`)
        setPickedLenderId("")
      } else {
        toast.error(("error" in res ? res.error : "") || "Connection failed")
      }
    } finally {
      setBusy(false)
    }
  }

  const isVerified = profile?.verified === true
  const preApprovalDoc = documents.find(d => d.doc_category === "pre_approval_letter")
  const pofDoc = documents.find(d => d.doc_category === "proof_of_funds")

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-muted-foreground" />
          Financial verification
        </CardTitle>
        <CardDescription>
          Upload your pre-approval letter or proof of funds, or connect with one of our trusted lenders to get started.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Status row */}
        <div className="flex flex-wrap gap-2">
          {isVerified && <Badge className="bg-green-600 text-white"><CheckCircle2 className="h-3 w-3 mr-1" /> Verified</Badge>}
          {preApprovalDoc && (
            <Badge variant="outline">
              <FileText className="h-3 w-3 mr-1" /> Pre-approval on file
            </Badge>
          )}
          {pofDoc && (
            <Badge variant="outline">
              <FileText className="h-3 w-3 mr-1" /> POF on file
            </Badge>
          )}
        </div>

        <Tabs defaultValue="upload">
          <TabsList>
            <TabsTrigger value="upload">Upload yourself</TabsTrigger>
            <TabsTrigger value="lender">Connect with a lender</TabsTrigger>
          </TabsList>

          <TabsContent value="upload" className="space-y-3 pt-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Document type</Label>
                <Select value={docCategory} onValueChange={(v) => setDocCategory(v as typeof docCategory)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pre_approval_letter">Pre-approval letter</SelectItem>
                    <SelectItem value="proof_of_funds">Proof of funds</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Approved amount (optional)</Label>
                <Input
                  type="number"
                  inputMode="decimal"
                  placeholder="e.g. 750000"
                  value={verificationAmount}
                  onChange={e => setVerificationAmount(e.target.value)}
                />
              </div>
              <div className="sm:col-span-2">
                <Label className="text-xs">
                  {docCategory === "pre_approval_letter" ? "Lender name (optional)" : "Bank / institution (optional)"}
                </Label>
                <Input
                  placeholder={docCategory === "pre_approval_letter" ? "e.g. Wells Fargo" : "e.g. Chase"}
                  value={verificationLender}
                  onChange={e => setVerificationLender(e.target.value)}
                />
              </div>
            </div>
            <div>
              <input
                id="buyer-financial-file"
                type="file"
                accept="application/pdf,image/png,image/jpeg"
                className="hidden"
                onChange={e => {
                  const f = e.target.files?.[0]
                  if (f) void handleUpload(f)
                  e.currentTarget.value = ""
                }}
              />
              <Button
                onClick={() => document.getElementById("buyer-financial-file")?.click()}
                disabled={busy}
                className="w-full sm:w-auto"
              >
                {busy
                  ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Uploading…</>
                  : <><Upload className="h-4 w-4 mr-2" /> Upload {docCategory === "pre_approval_letter" ? "pre-approval" : "POF"}</>}
              </Button>
              <p className="text-xs text-muted-foreground mt-1">
                PDF, PNG, or JPG up to 50MB. Your agent will be notified.
              </p>
            </div>
          </TabsContent>

          <TabsContent value="lender" className="space-y-3 pt-3">
            {lenders.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Your brokerage hasn't added marketplace lenders yet. Reach out to your agent for an introduction.
              </p>
            ) : (
              <>
                <Label className="text-xs">Pick a lender</Label>
                <Select value={pickedLenderId} onValueChange={setPickedLenderId}>
                  <SelectTrigger><SelectValue placeholder="Select a lender" /></SelectTrigger>
                  <SelectContent>
                    {lenders.map(l => (
                      <SelectItem key={l.id} value={l.id}>{l.full_name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button onClick={handleConnectLender} disabled={busy || !pickedLenderId}>
                  {busy
                    ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Sending…</>
                    : <><Mail className="h-4 w-4 mr-2" /> Request introduction</>}
                </Button>
                <p className="text-xs text-muted-foreground">
                  Your agent will introduce you. The lender will reach out and upload your pre-approval directly when ready.
                </p>
              </>
            )}
          </TabsContent>
        </Tabs>

        {documents.length > 0 && (
          <div className="pt-2 border-t">
            <p className="text-xs font-semibold text-muted-foreground mb-1">On file</p>
            {documents.map(d => (
              <a
                key={d.id}
                href={d.document_url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 text-sm hover:underline"
              >
                <FileText className="h-4 w-4 text-muted-foreground" />
                {d.document_name}
                <span className="text-xs text-muted-foreground">— {new Date(d.uploaded_at).toLocaleDateString()}</span>
              </a>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
