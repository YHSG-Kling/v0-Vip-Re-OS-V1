"use client"

// ============================================================
// SYSTEM: L11-S01 — Agent License Intake Client Component
// VIP Real Estate AI OS — Layer 11
// ============================================================
// 4-step horizontal stepper with persistent progress.

import { useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import useSWR, { mutate } from "swr"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { toast } from "sonner"
import { Check, Upload, FileText, Shield, AlertCircle, Loader2 } from "lucide-react"
import {
  submitLicenseDetails,
  submitEOInsurance,
  sendContractForSignature,
  markContractSignedManually,
  markComplianceComplete,
  type AgentLicenseStatus,
  type LicenseFormData,
  type EOFormData,
} from "@/app/actions/onboarding/license"
import { createClient } from "@/lib/supabase/client"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { US_STATES } from "@/lib/constants/us-states"

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface LicenseIntakeClientProps {
  userId: string
  brokerageId: string
  initialStatus: AgentLicenseStatus | null
  complianceSteps: Array<{
    id: string
    step_key: string
    step_name: string
    instructions: string | null
  }>
}

const STEP_LABELS = [
  { label: "License Details", icon: FileText },
  { label: "E&O Insurance", icon: Shield },
  { label: "Sign Contract", icon: FileText },
  { label: "Compliance", icon: Check },
]

// ─── FETCHER ──────────────────────────────────────────────────────────────────

const fetcher = async (url: string) => {
  const res = await fetch(url)
  if (!res.ok) throw new Error("Failed to fetch")
  return res.json()
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

export function LicenseIntakeClient({
  userId,
  brokerageId,
  initialStatus,
  complianceSteps,
}: LicenseIntakeClientProps) {
  const router = useRouter()
  const [activeStep, setActiveStep] = useState(initialStatus?.currentStep || 1)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // SWR for status updates
  const { data: status } = useSWR<AgentLicenseStatus>(
    `/api/onboarding/license?agent_id=${userId}`,
    fetcher,
    {
      fallbackData: initialStatus || undefined,
      refreshInterval: 30000, // Poll every 30s for contract status
    }
  )

  // Update active step when status changes
  useEffect(() => {
    if (status?.currentStep && status.currentStep > activeStep) {
      setActiveStep(status.currentStep)
    }
  }, [status?.currentStep, activeStep])

  const handleStepClick = (step: number) => {
    // Only allow navigating to completed steps or current step
    if (step <= (status?.currentStep || 1)) {
      setActiveStep(step)
    }
  }

  const refreshStatus = useCallback(() => {
    mutate(`/api/onboarding/license?agent_id=${userId}`)
  }, [userId])

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-4xl px-4 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight">License Intake</h1>
          <p className="mt-2 text-muted-foreground">
            Complete your license verification and compliance requirements to begin working with your brokerage.
          </p>
        </div>

        {/* Stepper */}
        <div className="mb-8">
          <div className="flex items-center justify-between">
            {STEP_LABELS.map((step, index) => {
              const stepNumber = index + 1
              const isCompleted = (status?.currentStep || 1) > stepNumber
              const isActive = activeStep === stepNumber
              const Icon = step.icon

              return (
                <div
                  key={step.label}
                  className="flex flex-1 items-center"
                >
                  <button
                    onClick={() => handleStepClick(stepNumber)}
                    disabled={stepNumber > (status?.currentStep || 1)}
                    className={`flex flex-col items-center gap-2 ${
                      stepNumber <= (status?.currentStep || 1)
                        ? "cursor-pointer"
                        : "cursor-not-allowed opacity-50"
                    }`}
                  >
                    <div
                      className={`flex h-10 w-10 items-center justify-center rounded-full border-2 transition-colors ${
                        isCompleted
                          ? "border-primary bg-primary text-primary-foreground"
                          : isActive
                            ? "border-primary bg-background text-primary"
                            : "border-muted-foreground/30 bg-background text-muted-foreground"
                      }`}
                    >
                      {isCompleted ? (
                        <Check className="h-5 w-5" />
                      ) : (
                        <Icon className="h-5 w-5" />
                      )}
                    </div>
                    <span
                      className={`text-sm font-medium ${
                        isActive ? "text-foreground" : "text-muted-foreground"
                      }`}
                    >
                      {step.label}
                    </span>
                  </button>

                  {index < STEP_LABELS.length - 1 && (
                    <div
                      className={`mx-4 h-0.5 flex-1 ${
                        (status?.currentStep || 1) > stepNumber
                          ? "bg-primary"
                          : "bg-muted"
                      }`}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* Step Content */}
        <Card>
          {activeStep === 1 && (
            <LicenseDetailsStep
              userId={userId}
              brokerageId={brokerageId}
              status={status}
              isSubmitting={isSubmitting}
              setIsSubmitting={setIsSubmitting}
              onComplete={() => {
                refreshStatus()
                setActiveStep(2)
              }}
            />
          )}
          {activeStep === 2 && (
            <EOInsuranceStep
              userId={userId}
              brokerageId={brokerageId}
              status={status}
              isSubmitting={isSubmitting}
              setIsSubmitting={setIsSubmitting}
              onComplete={() => {
                refreshStatus()
                setActiveStep(3)
              }}
            />
          )}
          {activeStep === 3 && (
            <ContractStep
              userId={userId}
              brokerageId={brokerageId}
              status={status}
              isSubmitting={isSubmitting}
              setIsSubmitting={setIsSubmitting}
              onComplete={() => {
                refreshStatus()
                setActiveStep(4)
              }}
            />
          )}
          {activeStep === 4 && (
            <ComplianceStep
              userId={userId}
              brokerageId={brokerageId}
              status={status}
              complianceSteps={complianceSteps}
              isSubmitting={isSubmitting}
              setIsSubmitting={setIsSubmitting}
              onComplete={() => {
                toast.success("License intake complete!")
                router.push("/dashboard/onboarding/brand")
              }}
            />
          )}
        </Card>
      </div>
    </div>
  )
}

// ─── STEP 1: LICENSE DETAILS ──────────────────────────────────────────────────

function LicenseDetailsStep({
  userId,
  brokerageId,
  status,
  isSubmitting,
  setIsSubmitting,
  onComplete,
}: {
  userId: string
  brokerageId: string
  status: AgentLicenseStatus | null | undefined
  isSubmitting: boolean
  setIsSubmitting: (v: boolean) => void
  onComplete: () => void
}) {
  const [formData, setFormData] = useState<LicenseFormData>({
    licenseState: status?.licenseRecord?.license_state || "",
    licenseNumber: status?.licenseRecord?.license_number || "",
    licenseType: (status?.licenseRecord?.license_type as LicenseFormData["licenseType"]) || "salesperson",
    expiryDate: status?.licenseRecord?.expiry_date || "",
    documentUrl: status?.licenseRecord?.document_url || undefined,
  })
  const [uploading, setUploading] = useState(false)

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (file.size > 10 * 1024 * 1024) {
      toast.error("File size must be less than 10MB")
      return
    }

    const allowedTypes = ["image/jpeg", "image/png", "application/pdf"]
    if (!allowedTypes.includes(file.type)) {
      toast.error("File must be JPEG, PNG, or PDF")
      return
    }

    setUploading(true)
    try {
      const supabase = createClient()
      const fileName = `${userId}/license/${Date.now()}-${file.name}`

      const { error } = await supabase.storage
        .from("agent-documents")
        .upload(fileName, file)

      if (error) throw error

      const { data: urlData } = supabase.storage
        .from("agent-documents")
        .getPublicUrl(fileName)

      setFormData(prev => ({ ...prev, documentUrl: urlData.publicUrl }))
      toast.success("Document uploaded successfully")
    } catch (error) {
      console.error("Upload error:", error)
      toast.error("Failed to upload document")
    } finally {
      setUploading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!formData.licenseState || !formData.licenseNumber || !formData.expiryDate) {
      toast.error("Please fill in all required fields")
      return
    }

    setIsSubmitting(true)
    try {
      const result = await submitLicenseDetails(formData)
      if (result.success) {
        toast.success("License details saved")
        onComplete()
      } else {
        toast.error(result.error || "Failed to save license details")
      }
    } catch (error) {
      console.error("Submit error:", error)
      toast.error("An unexpected error occurred")
    } finally {
      setIsSubmitting(false)
    }
  }

  const isComplete = status?.completedSteps?.includes("license_upload")

  return (
    <>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>License Details</CardTitle>
            <CardDescription>
              Enter your real estate license information for verification
            </CardDescription>
          </div>
          {status?.licenseRecord?.verification_status === "verified" && (
            <Badge variant="default" className="bg-green-600">
              <Check className="mr-1 h-3 w-3" /> Verified
            </Badge>
          )}
          {status?.licenseRecord?.verification_status === "pending_review" && (
            <Badge variant="secondary">
              <AlertCircle className="mr-1 h-3 w-3" /> Needs Manual Review
            </Badge>
          )}
          {status?.licenseRecord?.verification_status === "pending" && (
            <Badge variant="outline">
              <Loader2 className="mr-1 h-3 w-3 animate-spin" /> Verifying...
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="licenseState">State *</Label>
              <Select
                value={formData.licenseState}
                onValueChange={(v) => setFormData(prev => ({ ...prev, licenseState: v }))}
                disabled={isComplete}
              >
                <SelectTrigger id="licenseState">
                  <SelectValue placeholder="Select state" />
                </SelectTrigger>
                <SelectContent>
                  {US_STATES.map(state => (
                    <SelectItem key={state.code} value={state.code}>
                      {state.code} — {state.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="licenseNumber">License Number *</Label>
              <Input
                id="licenseNumber"
                value={formData.licenseNumber}
                onChange={(e) => setFormData(prev => ({ ...prev, licenseNumber: e.target.value }))}
                placeholder="Enter license number"
                disabled={isComplete}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="licenseType">License Type *</Label>
              <Select
                value={formData.licenseType}
                onValueChange={(v) => setFormData(prev => ({ ...prev, licenseType: v as LicenseFormData["licenseType"] }))}
                disabled={isComplete}
              >
                <SelectTrigger id="licenseType">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="salesperson">Salesperson</SelectItem>
                  <SelectItem value="broker">Broker</SelectItem>
                  <SelectItem value="broker_associate">Broker-Associate</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="expiryDate">Expiry Date *</Label>
              <Input
                id="expiryDate"
                type="date"
                value={formData.expiryDate}
                onChange={(e) => setFormData(prev => ({ ...prev, expiryDate: e.target.value }))}
                disabled={isComplete}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>License Document (Front)</Label>
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <label
                  htmlFor="licenseDoc"
                  className={`flex cursor-pointer items-center justify-center gap-2 rounded-md border-2 border-dashed p-6 transition-colors hover:border-primary ${
                    uploading || isComplete ? "pointer-events-none opacity-50" : ""
                  }`}
                >
                  {uploading ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <Upload className="h-5 w-5" />
                  )}
                  <span className="text-sm text-muted-foreground">
                    {formData.documentUrl
                      ? "Document uploaded - Click to replace"
                      : "Click to upload (JPEG, PNG, PDF - Max 10MB)"}
                  </span>
                  <input
                    id="licenseDoc"
                    type="file"
                    accept="image/jpeg,image/png,application/pdf"
                    onChange={handleFileUpload}
                    className="hidden"
                    disabled={uploading || isComplete}
                  />
                </label>
              </div>
              {formData.documentUrl && (
                <Badge variant="outline" className="gap-1">
                  <Check className="h-3 w-3" /> Uploaded
                </Badge>
              )}
            </div>
          </div>

          {!isComplete && (
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save & Continue"
              )}
            </Button>
          )}

          {isComplete && (
            <Button type="button" variant="outline" className="w-full" onClick={onComplete}>
              Continue to E&O Insurance
            </Button>
          )}
        </form>
      </CardContent>
    </>
  )
}

// ─── STEP 2: E&O INSURANCE ────────────────────────────────────────────────────

function EOInsuranceStep({
  userId,
  brokerageId,
  status,
  isSubmitting,
  setIsSubmitting,
  onComplete,
}: {
  userId: string
  brokerageId: string
  status: AgentLicenseStatus | null | undefined
  isSubmitting: boolean
  setIsSubmitting: (v: boolean) => void
  onComplete: () => void
}) {
  const [formData, setFormData] = useState<EOFormData>({
    insurerName: "",
    policyNumber: "",
    coverageAmount: 0,
    expiryDate: "",
    certificateUrl: undefined,
  })
  const [uploading, setUploading] = useState(false)

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (file.size > 10 * 1024 * 1024) {
      toast.error("File size must be less than 10MB")
      return
    }

    setUploading(true)
    try {
      const supabase = createClient()
      const fileName = `${userId}/eo-insurance/${Date.now()}-${file.name}`

      const { error } = await supabase.storage
        .from("agent-documents")
        .upload(fileName, file)

      if (error) throw error

      const { data: urlData } = supabase.storage
        .from("agent-documents")
        .getPublicUrl(fileName)

      setFormData(prev => ({ ...prev, certificateUrl: urlData.publicUrl }))
      toast.success("Certificate uploaded successfully")
    } catch (error) {
      console.error("Upload error:", error)
      toast.error("Failed to upload certificate")
    } finally {
      setUploading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!formData.insurerName || !formData.policyNumber || !formData.expiryDate) {
      toast.error("Please fill in all required fields")
      return
    }

    const expiryDate = new Date(formData.expiryDate)
    if (expiryDate <= new Date()) {
      toast.error("E&O insurance expiry date must be in the future")
      return
    }

    setIsSubmitting(true)
    try {
      const result = await submitEOInsurance(formData)
      if (result.success) {
        toast.success("E&O insurance saved")
        onComplete()
      } else {
        toast.error(result.error || "Failed to save E&O insurance")
      }
    } catch (error) {
      console.error("Submit error:", error)
      toast.error("An unexpected error occurred")
    } finally {
      setIsSubmitting(false)
    }
  }

  const isComplete = status?.completedSteps?.includes("eo_insurance")

  return (
    <>
      <CardHeader>
        <CardTitle>E&O Insurance</CardTitle>
        <CardDescription>
          Enter your Errors & Omissions insurance information
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="insurerName">Insurance Company *</Label>
              <Input
                id="insurerName"
                value={formData.insurerName}
                onChange={(e) => setFormData(prev => ({ ...prev, insurerName: e.target.value }))}
                placeholder="E.g., CRES Insurance"
                disabled={isComplete}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="policyNumber">Policy Number *</Label>
              <Input
                id="policyNumber"
                value={formData.policyNumber}
                onChange={(e) => setFormData(prev => ({ ...prev, policyNumber: e.target.value }))}
                placeholder="Enter policy number"
                disabled={isComplete}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="coverageAmount">Coverage Amount</Label>
              <Input
                id="coverageAmount"
                type="number"
                value={formData.coverageAmount || ""}
                onChange={(e) => setFormData(prev => ({ ...prev, coverageAmount: Number(e.target.value) }))}
                placeholder="1000000"
                disabled={isComplete}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="eoExpiryDate">Expiry Date *</Label>
              <Input
                id="eoExpiryDate"
                type="date"
                value={formData.expiryDate}
                onChange={(e) => setFormData(prev => ({ ...prev, expiryDate: e.target.value }))}
                disabled={isComplete}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Certificate of Insurance</Label>
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <label
                  htmlFor="eoCert"
                  className={`flex cursor-pointer items-center justify-center gap-2 rounded-md border-2 border-dashed p-6 transition-colors hover:border-primary ${
                    uploading || isComplete ? "pointer-events-none opacity-50" : ""
                  }`}
                >
                  {uploading ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <Upload className="h-5 w-5" />
                  )}
                  <span className="text-sm text-muted-foreground">
                    {formData.certificateUrl
                      ? "Certificate uploaded - Click to replace"
                      : "Click to upload certificate (PDF or image)"}
                  </span>
                  <input
                    id="eoCert"
                    type="file"
                    accept="image/jpeg,image/png,application/pdf"
                    onChange={handleFileUpload}
                    className="hidden"
                    disabled={uploading || isComplete}
                  />
                </label>
              </div>
              {formData.certificateUrl && (
                <Badge variant="outline" className="gap-1">
                  <Check className="h-3 w-3" /> Uploaded
                </Badge>
              )}
            </div>
          </div>

          {!isComplete && (
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save & Continue"
              )}
            </Button>
          )}

          {isComplete && (
            <Button type="button" variant="outline" className="w-full" onClick={onComplete}>
              Continue to Contract
            </Button>
          )}
        </form>
      </CardContent>
    </>
  )
}

// ─── STEP 3: CONTRACT ─────────────────────────────────────────────────────────

function ContractStep({
  userId,
  brokerageId,
  status,
  isSubmitting,
  setIsSubmitting,
  onComplete,
}: {
  userId: string
  brokerageId: string
  status: AgentLicenseStatus | null | undefined
  isSubmitting: boolean
  setIsSubmitting: (v: boolean) => void
  onComplete: () => void
}) {
  const [contractId, setContractId] = useState(status?.contractRecord?.id)

  // Poll for contract status when sent
  const { data: contractStatus } = useSWR(
    contractId && status?.contractRecord?.status !== "signed"
      ? `/api/onboarding/license?action=contract_status&contract_id=${contractId}`
      : null,
    fetcher,
    { refreshInterval: 30000 }
  )

  useEffect(() => {
    if (contractStatus?.status === "signed") {
      toast.success("Contract signed successfully!")
      onComplete()
    }
  }, [contractStatus?.status, onComplete])

  const handleSendContract = async () => {
    setIsSubmitting(true)
    try {
      const result = await sendContractForSignature(userId, brokerageId)
      if (result.success && result.documentId) {
        setContractId(result.documentId)
        toast.success("Contract sent for signature")
      } else {
        toast.error(result.error || "Failed to send contract")
      }
    } catch (error) {
      console.error("Send contract error:", error)
      toast.error("An unexpected error occurred")
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleMarkSigned = async () => {
    if (!contractId) return

    setIsSubmitting(true)
    try {
      const result = await markContractSignedManually(contractId)
      if (result.success) {
        toast.success("Contract marked as signed")
        onComplete()
      } else {
        toast.error(result.error || "Failed to mark contract as signed")
      }
    } catch (error) {
      console.error("Mark signed error:", error)
      toast.error("An unexpected error occurred")
    } finally {
      setIsSubmitting(false)
    }
  }

  const isSent = status?.contractRecord?.status === "sent" || contractStatus?.status === "sent"
  const isSigned = status?.contractRecord?.status === "signed" || contractStatus?.status === "signed"

  return (
    <>
      <CardHeader>
        <CardTitle>Independent Contractor Agreement</CardTitle>
        <CardDescription>
          Review and sign your Independent Contractor Agreement
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Contract Preview */}
        <div className="rounded-lg border bg-muted/50 p-8 text-center">
          <FileText className="mx-auto h-16 w-16 text-muted-foreground/50" />
          <h3 className="mt-4 text-lg font-medium">Independent Contractor Agreement</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            This agreement outlines the terms and conditions of your relationship with the brokerage.
          </p>
        </div>

        {/* Status */}
        <div className="flex items-center justify-between rounded-lg border p-4">
          <div>
            <p className="font-medium">Contract Status</p>
            <p className="text-sm text-muted-foreground">
              {isSigned
                ? `Signed on ${new Date(status?.contractRecord?.signed_at || contractStatus?.signed_at).toLocaleDateString()}`
                : isSent
                  ? "Awaiting signature..."
                  : "Ready to send"}
            </p>
          </div>
          <Badge
            variant={isSigned ? "default" : isSent ? "secondary" : "outline"}
            className={isSigned ? "bg-green-600" : ""}
          >
            {isSigned ? (
              <>
                <Check className="mr-1 h-3 w-3" /> Signed
              </>
            ) : isSent ? (
              <>
                <Loader2 className="mr-1 h-3 w-3 animate-spin" /> Pending
              </>
            ) : (
              "Not Sent"
            )}
          </Badge>
        </div>

        {/* Actions */}
        {!isSent && !isSigned && (
          <Button onClick={handleSendContract} className="w-full" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Sending...
              </>
            ) : (
              "Send for Signature"
            )}
          </Button>
        )}

        {isSent && !isSigned && (
          <div className="space-y-4">
            {/* Packet-gated (owner rule): the Sign button appears only when an
                ACTIVE contract packet exists, routing straight to the invite. */}
            {status?.contractRecord?.signing_url ? (
              <Button className="w-full" asChild>
                <a href={status.contractRecord.signing_url} target="_blank" rel="noopener noreferrer">
                  Sign Contract Now
                </a>
              </Button>
            ) : (
              <p className="text-center text-sm text-muted-foreground">
                Check your email for the signature request. This page will update automatically when signed.
              </p>
            )}

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" className="w-full">
                  Mark as Signed Manually (Admin Only)
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Confirm Manual Signature</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will mark the contract as signed without an electronic signature.
                    Only use this if the contract was signed on paper or through another system.
                    This action is logged for compliance purposes.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleMarkSigned} disabled={isSubmitting}>
                    Confirm
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}

        {isSigned && (
          <Button variant="outline" className="w-full" onClick={onComplete}>
            Continue to Compliance Checklist
          </Button>
        )}

        {/* Empty State */}
        {!status?.contractRecord && !contractId && (
          <div className="rounded-lg border border-dashed p-6 text-center">
            <AlertCircle className="mx-auto h-8 w-8 text-muted-foreground" />
            <p className="mt-2 text-sm text-muted-foreground">
              No e-sign provider configured — contact your broker admin
            </p>
          </div>
        )}
      </CardContent>
    </>
  )
}

// ─── STEP 4: COMPLIANCE CHECKLIST ─────────────────────────────────────────────

function ComplianceStep({
  userId,
  brokerageId,
  status,
  complianceSteps,
  isSubmitting,
  setIsSubmitting,
  onComplete,
}: {
  userId: string
  brokerageId: string
  status: AgentLicenseStatus | null | undefined
  complianceSteps: Array<{
    id: string
    step_key: string
    step_name: string
    instructions: string | null
  }>
  isSubmitting: boolean
  setIsSubmitting: (v: boolean) => void
  onComplete: () => void
}) {
  const defaultItems = [
    { step_key: "fair_housing_ack", step_name: "Fair Housing Acknowledgment", instructions: "I acknowledge that I have read and understand the Fair Housing Act and agree to comply with all fair housing laws." },
    { step_key: "tcpa_ack", step_name: "TCPA Compliance", instructions: "I acknowledge that I have read and understand the Telephone Consumer Protection Act and agree to obtain proper consent before sending marketing messages." },
    { step_key: "mls_rules_ack", step_name: "MLS Rules & Regulations", instructions: "I acknowledge that I have read and understand the MLS rules and regulations and agree to comply with all MLS policies." },
    { step_key: "brand_standards_ack", step_name: "Brand Standards", instructions: "I acknowledge that I have read and understand the brokerage brand standards and agree to represent the brand professionally." },
  ]

  const items = complianceSteps.length > 0 ? complianceSteps : defaultItems
  const [checkedItems, setCheckedItems] = useState<Set<string>>(
    new Set(status?.completedSteps?.filter(s =>
      ["fair_housing_ack", "tcpa_ack", "mls_rules_ack", "brand_standards_ack"].includes(s)
    ) || [])
  )

  const handleCheck = (stepKey: string, checked: boolean) => {
    const newChecked = new Set(checkedItems)
    if (checked) {
      newChecked.add(stepKey)
    } else {
      newChecked.delete(stepKey)
    }
    setCheckedItems(newChecked)
  }

  const allChecked = items.every(item => checkedItems.has(item.step_key))

  const handleComplete = async () => {
    if (!allChecked) {
      toast.error("Please acknowledge all items before continuing")
      return
    }

    setIsSubmitting(true)
    try {
      const result = await markComplianceComplete(userId, Array.from(checkedItems))
      if (result.success) {
        onComplete()
      } else {
        toast.error(result.error || "Failed to save compliance acknowledgments")
      }
    } catch (error) {
      console.error("Complete error:", error)
      toast.error("An unexpected error occurred")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <>
      <CardHeader>
        <CardTitle>Compliance Checklist</CardTitle>
        <CardDescription>
          Review and acknowledge the following compliance requirements
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-4">
          {items.map((item) => (
            <div
              key={item.step_key}
              className="flex items-start gap-4 rounded-lg border p-4"
            >
              <Checkbox
                id={item.step_key}
                checked={checkedItems.has(item.step_key)}
                onCheckedChange={(checked) => handleCheck(item.step_key, checked as boolean)}
              />
              <div className="flex-1">
                <label
                  htmlFor={item.step_key}
                  className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                >
                  {item.step_name}
                </label>
                <p className="mt-1 text-sm text-muted-foreground">
                  {item.instructions}
                </p>
                <Button variant="link" size="sm" className="h-auto p-0 text-primary">
                  Read Full Policy
                </Button>
              </div>
            </div>
          ))}
        </div>

        <Button
          onClick={handleComplete}
          className="w-full"
          disabled={!allChecked || isSubmitting}
        >
          {isSubmitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Completing...
            </>
          ) : (
            "Complete License Intake"
          )}
        </Button>
      </CardContent>
    </>
  )
}
