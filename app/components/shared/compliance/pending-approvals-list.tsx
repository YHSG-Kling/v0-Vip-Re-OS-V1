"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Clock, CheckCircle, XCircle, Eye, User, AlertCircle, Loader2 } from "lucide-react"
import { reviewContentApproval } from "@/app/actions/compliance-monitoring"
import { useToast } from "@/hooks/use-toast"
import { formatDistanceToNow } from "date-fns"

interface PendingApprovalsListProps {
  initialApprovals: any[]
  reviewerId: string
  onRefresh?: () => void
}

export default function PendingApprovalsList({ initialApprovals, reviewerId, onRefresh }: PendingApprovalsListProps) {
  const [approvals, setApprovals] = useState(initialApprovals)
  const [selectedApproval, setSelectedApproval] = useState<any>(null)
  const [reviewNotes, setReviewNotes] = useState("")
  const [expiresInDays, setExpiresInDays] = useState(90)
  const [isReviewing, setIsReviewing] = useState(false)
  const { toast } = useToast()

  const handleReview = async (status: "approved" | "rejected" | "needs_revision") => {
    if (!selectedApproval) return

    setIsReviewing(true)
    try {
      await reviewContentApproval({
        approvalId: selectedApproval.id,
        reviewerId,
        status,
        reviewNotes,
        expiresInDays: status === "approved" ? expiresInDays : undefined,
      })

      toast({
        title: `Content ${status}`,
        description: `The content has been ${status.replace("_", " ")}`,
      })

      setApprovals(approvals.filter((a: any) => a.id !== selectedApproval.id))
      setSelectedApproval(null)
      setReviewNotes("")
      onRefresh?.()
    } catch (error) {
      toast({ title: "Review failed", variant: "destructive" })
    }
    setIsReviewing(false)
  }

  return (
    <div className="space-y-4">
      {approvals.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <CheckCircle className="w-12 h-12 mx-auto text-green-600 mb-4" />
            <h3 className="text-lg font-semibold mb-2">All Caught Up!</h3>
            <p className="text-muted-foreground">No content waiting for compliance review</p>
          </CardContent>
        </Card>
      ) : (
        approvals.map((approval: any) => (
          <Card key={approval.id}>
            <CardHeader>
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <CardTitle className="text-lg">{approval.content_title}</CardTitle>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <User className="w-4 h-4" />
                    {approval.agents?.first_name} {approval.agents?.last_name}
                  </div>
                </div>
                <Badge variant={approval.compliance_status === "pending" ? "default" : "destructive"}>
                  {approval.compliance_status.replace("_", " ")}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-3 gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground">Type:</span>
                  <p className="font-medium">{approval.content_type?.replace(/_/g, " ")}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Audience:</span>
                  <p className="font-medium">{approval.target_audience?.replace(/_/g, " ")}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Submitted:</span>
                  <p className="font-medium">
                    {approval.submitted_at
                      ? formatDistanceToNow(new Date(approval.submitted_at), { addSuffix: true })
                      : "Unknown"}
                  </p>
                </div>
              </div>

              <div>
                <span className="text-sm text-muted-foreground">Channels:</span>
                <div className="flex gap-2 mt-1">
                  {approval.distribution_channels?.map((channel: string) => (
                    <Badge key={channel} variant="outline">
                      {channel}
                    </Badge>
                  ))}
                </div>
              </div>

              {/* Auto-scan Results */}
              {approval.auto_scan_results && (
                <div className="p-3 bg-muted rounded-lg">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium">Auto-Scan Results</span>
                    <Badge variant={approval.auto_scan_results.passed ? "default" : "destructive"}>
                      Score: {approval.auto_scan_results.score}/100
                    </Badge>
                  </div>
                  {approval.auto_scan_results.issues?.length > 0 && (
                    <div className="text-sm text-red-600">
                      <AlertCircle className="inline w-3 h-3 mr-1" />
                      {approval.auto_scan_results.issues.length} issue(s) detected
                    </div>
                  )}
                  {approval.auto_scan_results.warnings?.length > 0 && (
                    <div className="text-sm text-yellow-600">
                      {approval.auto_scan_results.warnings.length} warning(s)
                    </div>
                  )}
                </div>
              )}

              {/* Content Preview */}
              <div>
                <span className="text-sm text-muted-foreground">Preview:</span>
                <p className="mt-1 text-sm line-clamp-3 bg-muted/50 p-2 rounded">{approval.content_body}</p>
              </div>

              {/* Actions */}
              <div className="flex gap-2 justify-end">
                <Button variant="outline" size="sm" onClick={() => setSelectedApproval(approval)} className="bg-transparent">
                  <Eye className="w-4 h-4 mr-2" />
                  Review
                </Button>
              </div>
            </CardContent>
          </Card>
        ))
      )}

      {/* Review Dialog */}
      <Dialog open={!!selectedApproval} onOpenChange={(open) => !open && setSelectedApproval(null)}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Review Content: {selectedApproval?.content_title}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {/* Full Content */}
            <div>
              <Label>Full Content</Label>
              <div className="mt-1 p-4 bg-muted rounded-lg font-mono text-sm whitespace-pre-wrap max-h-64 overflow-y-auto">
                {selectedApproval?.content_body}
              </div>
            </div>

            {/* Scan Results Detail */}
            {selectedApproval?.auto_scan_results && (
              <div className="space-y-2">
                <Label>Compliance Scan Details</Label>
                {selectedApproval.auto_scan_results.issues?.map((issue: any, idx: number) => (
                  <Alert key={idx} variant="destructive">
                    <AlertDescription>
                      <strong>{issue.type}:</strong> {issue.message || issue.found}
                      {issue.suggestedAlternative && (
                        <p className="mt-1 text-sm">Suggestion: {issue.suggestedAlternative}</p>
                      )}
                    </AlertDescription>
                  </Alert>
                ))}
                {selectedApproval.auto_scan_results.warnings?.map((warning: any, idx: number) => (
                  <Alert key={idx}>
                    <AlertDescription>
                      <strong>{warning.type}:</strong> {warning.message}
                    </AlertDescription>
                  </Alert>
                ))}
              </div>
            )}

            {/* Review Notes */}
            <div className="space-y-2">
              <Label>Review Notes</Label>
              <Textarea
                value={reviewNotes}
                onChange={(e) => setReviewNotes(e.target.value)}
                placeholder="Add notes about your review decision..."
                rows={3}
              />
            </div>

            {/* Expiration (for approved content) */}
            <div className="space-y-2">
              <Label>Approval Expiration (days)</Label>
              <Input
                type="number"
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(Number(e.target.value))}
                min={1}
                max={365}
              />
              <p className="text-xs text-muted-foreground">How long this content approval is valid</p>
            </div>
          </div>

          <DialogFooter className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => handleReview("needs_revision")}
              disabled={isReviewing}
              className="bg-transparent"
            >
              <Clock className="w-4 h-4 mr-2" />
              Request Revision
            </Button>
            <Button variant="destructive" onClick={() => handleReview("rejected")} disabled={isReviewing}>
              {isReviewing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <XCircle className="w-4 h-4 mr-2" />}
              Reject
            </Button>
            <Button onClick={() => handleReview("approved")} disabled={isReviewing}>
              {isReviewing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CheckCircle className="w-4 h-4 mr-2" />}
              Approve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
