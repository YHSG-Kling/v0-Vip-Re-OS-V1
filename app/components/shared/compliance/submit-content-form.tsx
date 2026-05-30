"use client"

import React from "react"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Loader2, AlertCircle, CheckCircle, Info } from "lucide-react"
import { submitContentForApproval, scanContentCompliance } from "@/app/actions/compliance-monitoring"
import { useToast } from "@/hooks/use-toast"

interface SubmitContentFormProps {
  userId: string
  agentId?: string
  onSuccess?: () => void
}

export default function SubmitContentForm({ userId, agentId, onSuccess }: SubmitContentFormProps) {
  const { toast } = useToast()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [scanResults, setScanResults] = useState<any>(null)
  const [isScanning, setIsScanning] = useState(false)

  const [formData, setFormData] = useState({
    contentType: "",
    contentTitle: "",
    contentBody: "",
    targetAudience: "",
    distributionChannels: [] as string[],
    agentState: "FL",
  })

  const handleScanContent = async () => {
    if (!formData.contentBody) {
      toast({ title: "Error", description: "Please enter content to scan", variant: "destructive" })
      return
    }

    setIsScanning(true)
    try {
      const results = await scanContentCompliance({
        contentBody: formData.contentBody,
        contentType: formData.contentType,
        targetAudience: formData.targetAudience,
        distributionChannels: formData.distributionChannels,
        agentState: formData.agentState,
      })
      setScanResults(results)
    } catch (error) {
      toast({ title: "Scan failed", description: "Could not scan content", variant: "destructive" })
    }
    setIsScanning(false)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    try {
      await submitContentForApproval({
        userId,
        agentId,
        contentType: formData.contentType,
        contentTitle: formData.contentTitle,
        contentBody: formData.contentBody,
        targetAudience: formData.targetAudience,
        distributionChannels: formData.distributionChannels,
        agentState: formData.agentState,
      })

      toast({
        title: "Content submitted",
        description: "Your content has been submitted for compliance review",
      })

      // Reset form
      setFormData({
        contentType: "",
        contentTitle: "",
        contentBody: "",
        targetAudience: "",
        distributionChannels: [],
        agentState: "FL",
      })
      setScanResults(null)
      onSuccess?.()
    } catch (error) {
      toast({ title: "Submission failed", variant: "destructive" })
    }
    setIsSubmitting(false)
  }

  const handleChannelChange = (channel: string, checked: boolean) => {
    setFormData((prev) => ({
      ...prev,
      distributionChannels: checked
        ? [...prev.distributionChannels, channel]
        : prev.distributionChannels.filter((c) => c !== channel),
    }))
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Content Type */}
      <div className="space-y-2">
        <Label htmlFor="contentType">Content Type *</Label>
        <Select value={formData.contentType} onValueChange={(v) => setFormData({ ...formData, contentType: v })}>
          <SelectTrigger>
            <SelectValue placeholder="Select content type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="email_template">Email Template</SelectItem>
            <SelectItem value="print_mailer">Print Mailer</SelectItem>
            <SelectItem value="social_post">Social Media Post</SelectItem>
            <SelectItem value="video_script">Video Script</SelectItem>
            <SelectItem value="listing_description">Listing Description</SelectItem>
            <SelectItem value="them_first_nurture">Them-First Nurture</SelectItem>
            <SelectItem value="market_update">Market Update</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Content Title */}
      <div className="space-y-2">
        <Label htmlFor="contentTitle">Content Title *</Label>
        <Input
          id="contentTitle"
          value={formData.contentTitle}
          onChange={(e) => setFormData({ ...formData, contentTitle: e.target.value })}
          placeholder="e.g., Winter Market Update - Them First"
          required
        />
      </div>

      {/* Target Audience */}
      <div className="space-y-2">
        <Label htmlFor="targetAudience">Target Audience *</Label>
        <Select value={formData.targetAudience} onValueChange={(v) => setFormData({ ...formData, targetAudience: v })}>
          <SelectTrigger>
            <SelectValue placeholder="Select audience" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="cold_lead">Cold Lead (Email/Print Only)</SelectItem>
            <SelectItem value="warm_lead">Warm Lead</SelectItem>
            <SelectItem value="active_client">Active Client</SelectItem>
            <SelectItem value="lifetime_customer">Lifetime Customer</SelectItem>
          </SelectContent>
        </Select>

        {formData.targetAudience === "cold_lead" && (
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Cold leads can ONLY be contacted via email or print mail per compliance regulations
            </AlertDescription>
          </Alert>
        )}
      </div>

      {/* Distribution Channels */}
      <div className="space-y-2">
        <Label>Distribution Channels *</Label>
        <div className="space-y-2">
          {["email", "print", "sms", "social"].map((channel) => {
            const isDisabled = formData.targetAudience === "cold_lead" && !["email", "print"].includes(channel)
            return (
              <div key={channel} className="flex items-center space-x-2">
                <Checkbox
                  id={channel}
                  disabled={isDisabled}
                  checked={formData.distributionChannels.includes(channel)}
                  onCheckedChange={(checked) => handleChannelChange(channel, !!checked)}
                />
                <Label htmlFor={channel} className={isDisabled ? "text-muted-foreground" : ""}>
                  {channel.charAt(0).toUpperCase() + channel.slice(1)}
                  {isDisabled && " (Not allowed for cold leads)"}
                </Label>
              </div>
            )
          })}
        </div>
      </div>

      {/* State */}
      <div className="space-y-2">
        <Label>Agent State</Label>
        <Select value={formData.agentState} onValueChange={(v) => setFormData({ ...formData, agentState: v })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="FL">Florida</SelectItem>
            <SelectItem value="TX">Texas</SelectItem>
            <SelectItem value="CA">California</SelectItem>
            <SelectItem value="NY">New York</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Content Body */}
      <div className="space-y-2">
        <Label htmlFor="contentBody">Content Body *</Label>
        <Textarea
          id="contentBody"
          value={formData.contentBody}
          onChange={(e) => setFormData({ ...formData, contentBody: e.target.value })}
          rows={12}
          placeholder="Enter your content here. Remember to use them-first language focusing on client needs..."
          className="font-mono text-sm"
          required
        />
        <p className="text-xs text-muted-foreground">
          Use them-first philosophy: Focus on &quot;you&quot; and client needs, not &quot;I&quot; and agent services
        </p>
      </div>

      {/* Scan Button */}
      <Button
        type="button"
        variant="outline"
        onClick={handleScanContent}
        disabled={isScanning || !formData.contentBody}
        className="w-full bg-transparent"
      >
        {isScanning ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Scanning for compliance issues...
          </>
        ) : (
          <>
            <AlertCircle className="mr-2 h-4 w-4" />
            Scan Content for Compliance
          </>
        )}
      </Button>

      {/* Scan Results */}
      {scanResults && (
        <Card className="p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">Compliance Scan Results</h3>
            <Badge variant={scanResults.passed ? "default" : "destructive"}>Score: {scanResults.score}/100</Badge>
          </div>

          {/* Blocking Issues */}
          {scanResults.issues.filter((i: any) => i.severity === "blocking").length > 0 && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-red-600 flex items-center gap-2">
                <AlertCircle className="w-4 h-4" />
                Blocking Issues (Must Fix)
              </h4>
              {scanResults.issues
                .filter((i: any) => i.severity === "blocking")
                .map((issue: any, idx: number) => (
                  <Alert key={idx} variant="destructive">
                    <AlertDescription>
                      <strong>{issue.type}:</strong> {issue.message || issue.found}
                      {issue.suggestedAlternative && (
                        <p className="mt-1 text-sm">Try instead: &quot;{issue.suggestedAlternative}&quot;</p>
                      )}
                    </AlertDescription>
                  </Alert>
                ))}
            </div>
          )}

          {/* Warnings */}
          {scanResults.warnings.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-yellow-600 flex items-center gap-2">
                <Info className="w-4 h-4" />
                Warnings (Recommended to Address)
              </h4>
              {scanResults.warnings.map((warning: any, idx: number) => (
                <Alert key={idx}>
                  <AlertDescription>
                    <strong>{warning.type}:</strong> {warning.message}
                    {warning.requiredText && (
                      <p className="mt-1 text-xs font-mono bg-muted p-2 rounded">{warning.requiredText}</p>
                    )}
                  </AlertDescription>
                </Alert>
              ))}
            </div>
          )}

          {/* Success */}
          {scanResults.passed && scanResults.issues.length === 0 && scanResults.warnings.length === 0 && (
            <Alert>
              <CheckCircle className="h-4 w-4 text-green-600" />
              <AlertDescription className="text-green-600">
                No compliance issues detected! Content is ready for submission.
              </AlertDescription>
            </Alert>
          )}
        </Card>
      )}

      {/* Submit Button */}
      <Button
        type="submit"
        disabled={
          isSubmitting ||
          (scanResults && !scanResults.passed) ||
          !formData.contentType ||
          !formData.contentTitle ||
          !formData.contentBody
        }
        className="w-full"
        size="lg"
      >
        {isSubmitting ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Submitting for Review...
          </>
        ) : (
          "Submit for Compliance Approval"
        )}
      </Button>
    </form>
  )
}
