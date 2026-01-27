"use client"

import { useEffect, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AlertTriangle, CheckCircle2, Shield, FileText, Calendar, Send, Clock, Library, Eye, XCircle } from "lucide-react"
import { trackCertificationExpiration, getPendingApprovals, getApprovedContentLibrary, scanContentCompliance, submitContentForApproval, reviewContentApproval } from "@/app/actions/compliance-monitoring"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"

export function ComplianceContent() {
  const [alerts, setAlerts] = useState<any[]>([])
  const [certifications, setCertifications] = useState<any>(null)
  const [fairHousingLogs, setFairHousingLogs] = useState<any[]>([])
  const [pendingApprovals, setPendingApprovals] = useState<any[]>([])
  const [approvedContent, setApprovedContent] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [userId, setUserId] = useState<string | null>(null)
  
  // Content submission state
  const [submitDialogOpen, setSubmitDialogOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [scanResult, setScanResult] = useState<any>(null)
  const [newContent, setNewContent] = useState({
    contentTitle: "",
    contentBody: "",
    contentType: "email_template",
    targetAudience: "warm_lead",
    distributionChannels: ["email"],
    agentState: "FL"
  })

  useEffect(() => {
    loadComplianceData()
  }, [])

  async function loadComplianceData() {
    const supabase = createClient()

    // Load unresolved alerts
    const { data: alertsData } = await supabase
      .from("compliance_alerts")
      .select("*")
      .eq("resolved", false)
      .order("created_at", { ascending: false })
      .limit(10)

    setAlerts(alertsData || [])

    // Load recent fair housing logs with risk
    const { data: fhLogs } = await supabase
      .from("fair_housing_logs")
      .select("*, contacts(first_name, last_name)")
      .eq("steering_risk_detected", true)
      .order("timestamp", { ascending: false })
      .limit(10)

    setFairHousingLogs(fhLogs || [])

    // Get current user certifications
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (user) {
      setUserId(user.id)
      const certStatus = await trackCertificationExpiration(user.id)
      setCertifications(certStatus)
    }
    
    // Load pending approvals and approved content
    const pending = await getPendingApprovals()
    setPendingApprovals(pending)
    
    const approved = await getApprovedContentLibrary()
    setApprovedContent(approved)

    setLoading(false)
  }
  
  async function handleScanContent() {
    const result = await scanContentCompliance({
      contentBody: newContent.contentBody,
      contentType: newContent.contentType,
      targetAudience: newContent.targetAudience,
      distributionChannels: newContent.distributionChannels,
      agentState: newContent.agentState
    })
    setScanResult(result)
  }
  
  async function handleSubmitContent() {
    if (!userId) return
    setSubmitting(true)
    try {
      await submitContentForApproval({
        userId,
        ...newContent
      })
      setSubmitDialogOpen(false)
      setNewContent({
        contentTitle: "",
        contentBody: "",
        contentType: "email_template",
        targetAudience: "warm_lead",
        distributionChannels: ["email"],
        agentState: "FL"
      })
      setScanResult(null)
      loadComplianceData()
    } catch (error) {
      console.error("[v0] Error submitting content:", error)
    } finally {
      setSubmitting(false)
    }
  }
  
  async function handleReviewApproval(approvalId: string, status: "approved" | "rejected") {
    if (!userId) return
    try {
      await reviewContentApproval({
        approvalId,
        reviewerId: userId,
        status,
        expiresInDays: status === "approved" ? 365 : undefined
      })
      loadComplianceData()
    } catch (error) {
      console.error("[v0] Error reviewing approval:", error)
    }
  }

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case "critical":
        return "destructive"
      case "high":
        return "destructive"
      case "medium":
        return "default"
      default:
        return "secondary"
    }
  }

  if (loading) {
    return <div>Loading compliance dashboard...</div>
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Compliance & TRID Monitoring</h1>
        <p className="text-muted-foreground">Track regulatory compliance, TRID timelines, and fair housing adherence</p>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Alerts</CardTitle>
            <AlertTriangle className="h-4 w-4 text-destructive" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{alerts.length}</div>
            <p className="text-xs text-muted-foreground">Requiring attention</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Fair Housing Flags</CardTitle>
            <Shield className="h-4 w-4 text-yellow-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{fairHousingLogs.length}</div>
            <p className="text-xs text-muted-foreground">Recent risk detections</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Certifications</CardTitle>
            <FileText className="h-4 w-4 text-blue-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {certifications?.active || 0}/
              {(certifications?.active || 0) + (certifications?.expiring || 0) + (certifications?.expired || 0)}
            </div>
            <p className="text-xs text-muted-foreground">{certifications?.expiring || 0} expiring soon</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Status</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {alerts.filter((a) => a.severity === "critical").length === 0 ? "Good" : "At Risk"}
            </div>
            <p className="text-xs text-muted-foreground">Overall compliance</p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="alerts" className="space-y-4">
        <TabsList>
          <TabsTrigger value="alerts">Active Alerts</TabsTrigger>
          <TabsTrigger value="content">
            Content Approval
            {pendingApprovals.length > 0 && (
              <Badge variant="secondary" className="ml-2">{pendingApprovals.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="fair-housing">Fair Housing</TabsTrigger>
          <TabsTrigger value="trid">TRID Timeline</TabsTrigger>
          <TabsTrigger value="certifications">Certifications</TabsTrigger>
        </TabsList>

        <TabsContent value="alerts" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Compliance Alerts</CardTitle>
              <CardDescription>Active compliance issues requiring attention</CardDescription>
            </CardHeader>
            <CardContent>
              {alerts.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <CheckCircle2 className="h-12 w-12 mx-auto mb-2 text-green-600" />
                  <p>No active compliance alerts</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {alerts.map((alert) => (
                    <Alert key={alert.id}>
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle className="flex items-center gap-2">
                        {alert.message}
                        <Badge variant={getSeverityColor(alert.severity)}>{alert.severity}</Badge>
                      </AlertTitle>
                      <AlertDescription>
                        <span className="text-xs text-muted-foreground">
                          {new Date(alert.created_at).toLocaleString()}
                        </span>
                        {alert.details && (
                          <pre className="mt-2 text-xs bg-muted p-2 rounded">
                            {JSON.stringify(alert.details, null, 2)}
                          </pre>
                        )}
                      </AlertDescription>
                    </Alert>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Content Approval Tab */}
        <TabsContent value="content" className="space-y-4">
          <div className="flex justify-between items-center">
            <div>
              <h2 className="text-xl font-semibold">Content Approval Workflow</h2>
              <p className="text-sm text-muted-foreground">Submit marketing content for compliance review before distribution</p>
            </div>
            <Dialog open={submitDialogOpen} onOpenChange={setSubmitDialogOpen}>
              <DialogTrigger asChild>
                <Button>
                  <Send className="h-4 w-4 mr-2" />
                  Submit New Content
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>Submit Content for Approval</DialogTitle>
                  <DialogDescription>
                    Content will be auto-scanned for compliance issues before submission
                  </DialogDescription>
                </DialogHeader>
                
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label>Content Title</Label>
                    <Input 
                      placeholder="e.g., Monthly Market Update Email"
                      value={newContent.contentTitle}
                      onChange={(e) => setNewContent({...newContent, contentTitle: e.target.value})}
                    />
                  </div>
                  
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Content Type</Label>
                      <Select 
                        value={newContent.contentType} 
                        onValueChange={(v) => setNewContent({...newContent, contentType: v})}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="email_template">Email Template</SelectItem>
                          <SelectItem value="print_mailer">Print Mailer</SelectItem>
                          <SelectItem value="social_post">Social Post</SelectItem>
                          <SelectItem value="video_script">Video Script</SelectItem>
                          <SelectItem value="listing_description">Listing Description</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    
                    <div className="space-y-2">
                      <Label>Target Audience</Label>
                      <Select 
                        value={newContent.targetAudience} 
                        onValueChange={(v) => setNewContent({...newContent, targetAudience: v})}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="cold_lead">Cold Lead (Email/Print Only)</SelectItem>
                          <SelectItem value="warm_lead">Warm Lead</SelectItem>
                          <SelectItem value="active_client">Active Client</SelectItem>
                          <SelectItem value="past_client">Past Client</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  
                  <div className="space-y-2">
                    <Label>Content Body</Label>
                    <Textarea 
                      placeholder="Enter your marketing content here..."
                      rows={8}
                      value={newContent.contentBody}
                      onChange={(e) => setNewContent({...newContent, contentBody: e.target.value})}
                    />
                  </div>
                  
                  <Button variant="outline" onClick={handleScanContent} disabled={!newContent.contentBody} className="bg-transparent">
                    <Eye className="h-4 w-4 mr-2" />
                    Scan for Compliance Issues
                  </Button>
                  
                  {scanResult && (
                    <Card className={scanResult.passed ? "border-green-500" : "border-red-500"}>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-base flex items-center gap-2">
                          {scanResult.passed ? (
                            <CheckCircle2 className="h-5 w-5 text-green-600" />
                          ) : (
                            <XCircle className="h-5 w-5 text-red-600" />
                          )}
                          Compliance Score: {scanResult.score}/100
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        {scanResult.issues.length > 0 && (
                          <div>
                            <p className="text-sm font-medium text-red-600">Issues ({scanResult.issues.length}):</p>
                            {scanResult.issues.map((issue: any, i: number) => (
                              <div key={i} className="text-sm p-2 bg-red-50 rounded mt-1">
                                <span className="font-medium">{issue.type}:</span> {issue.message || issue.found}
                                {issue.suggestedAlternative && (
                                  <p className="text-xs text-muted-foreground">Suggestion: {issue.suggestedAlternative}</p>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                        {scanResult.warnings.length > 0 && (
                          <div>
                            <p className="text-sm font-medium text-yellow-600">Warnings ({scanResult.warnings.length}):</p>
                            {scanResult.warnings.map((warning: any, i: number) => (
                              <div key={i} className="text-sm p-2 bg-yellow-50 rounded mt-1">
                                {warning.message || warning.type}
                              </div>
                            ))}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  )}
                </div>
                
                <DialogFooter>
                  <Button variant="outline" onClick={() => setSubmitDialogOpen(false)} className="bg-transparent">Cancel</Button>
                  <Button onClick={handleSubmitContent} disabled={submitting || !newContent.contentTitle || !newContent.contentBody}>
                    {submitting ? "Submitting..." : "Submit for Review"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
          
          {/* Pending Approvals */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Clock className="h-5 w-5" />
                Pending Approvals
              </CardTitle>
              <CardDescription>Content awaiting compliance review</CardDescription>
            </CardHeader>
            <CardContent>
              {pendingApprovals.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <CheckCircle2 className="h-12 w-12 mx-auto mb-2 text-green-600" />
                  <p>No pending content approvals</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {pendingApprovals.map((approval) => (
                    <div key={approval.id} className="border rounded-lg p-4">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <h4 className="font-medium">{approval.content_title}</h4>
                            <Badge variant="outline">{approval.content_type?.replace(/_/g, " ")}</Badge>
                          </div>
                          <p className="text-sm text-muted-foreground mb-2">
                            Target: {approval.target_audience?.replace(/_/g, " ")} | 
                            Channels: {approval.distribution_channels?.join(", ")}
                          </p>
                          <p className="text-sm line-clamp-2">{approval.content_body}</p>
                          {approval.auto_scan_results && (
                            <div className="mt-2 flex items-center gap-2">
                              <Badge variant={approval.auto_scan_results.passed ? "default" : "destructive"}>
                                Score: {approval.auto_scan_results.score}/100
                              </Badge>
                              {approval.auto_scan_results.issues?.length > 0 && (
                                <span className="text-xs text-red-600">
                                  {approval.auto_scan_results.issues.length} issues
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="flex gap-2 ml-4">
                          <Button 
                            size="sm" 
                            variant="outline" 
                            onClick={() => handleReviewApproval(approval.id, "rejected")}
                            className="bg-transparent"
                          >
                            <XCircle className="h-4 w-4 mr-1" />
                            Reject
                          </Button>
                          <Button 
                            size="sm"
                            onClick={() => handleReviewApproval(approval.id, "approved")}
                          >
                            <CheckCircle2 className="h-4 w-4 mr-1" />
                            Approve
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          
          {/* Approved Content Library */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Library className="h-5 w-5" />
                Approved Content Library
              </CardTitle>
              <CardDescription>Pre-approved templates ready for use</CardDescription>
            </CardHeader>
            <CardContent>
              {approvedContent.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <FileText className="h-12 w-12 mx-auto mb-2" />
                  <p>No approved content templates yet</p>
                </div>
              ) : (
                <div className="grid gap-4 md:grid-cols-2">
                  {approvedContent.map((content) => (
                    <div key={content.id} className="border rounded-lg p-4">
                      <div className="flex items-center gap-2 mb-2">
                        <Badge variant="secondary">{content.content_category?.replace(/_/g, " ")}</Badge>
                        <Badge variant="outline" className="text-green-600 border-green-600">Approved</Badge>
                      </div>
                      <p className="text-sm line-clamp-3">{content.content_template}</p>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {content.allowed_channels?.map((ch: string) => (
                          <Badge key={ch} variant="outline" className="text-xs">{ch}</Badge>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="fair-housing" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Fair Housing Risk Logs</CardTitle>
              <CardDescription>AI-detected potential fair housing violations</CardDescription>
            </CardHeader>
            <CardContent>
              {fairHousingLogs.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Shield className="h-12 w-12 mx-auto mb-2 text-green-600" />
                  <p>No fair housing risks detected</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {fairHousingLogs.map((log) => (
                    <div key={log.id} className="border rounded-lg p-4">
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <p className="font-medium">
                            {log.contacts?.first_name} {log.contacts?.last_name}
                          </p>
                          <p className="text-sm text-muted-foreground">{log.interaction_type}</p>
                        </div>
                        <Badge variant="destructive">Risk: {(log.risk_score * 100).toFixed(0)}%</Badge>
                      </div>
                      {log.flagged_phrases && log.flagged_phrases.length > 0 && (
                        <div className="mt-2">
                          <p className="text-sm font-medium mb-1">Flagged phrases:</p>
                          <div className="flex flex-wrap gap-1">
                            {log.flagged_phrases.map((phrase: string, i: number) => (
                              <Badge key={i} variant="outline">
                                {phrase}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground mt-2">{new Date(log.timestamp).toLocaleString()}</p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="trid" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>TRID Timeline Monitoring</CardTitle>
              <CardDescription>Track RESPA/TRID compliance for active transactions</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-center py-8 text-muted-foreground">
                <Calendar className="h-12 w-12 mx-auto mb-2" />
                <p>TRID timelines are monitored on transaction detail pages</p>
                <p className="text-sm mt-2">Navigate to a transaction to view TRID compliance</p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="certifications" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>License & Certification Tracking</CardTitle>
              <CardDescription>Monitor expiration dates and renewal requirements</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="border rounded-lg p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <CheckCircle2 className="h-5 w-5 text-green-600" />
                      <span className="font-medium">Active</span>
                    </div>
                    <p className="text-3xl font-bold">{certifications?.active || 0}</p>
                    <p className="text-xs text-muted-foreground">Valid certifications</p>
                  </div>
                  <div className="border rounded-lg p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <AlertTriangle className="h-5 w-5 text-yellow-600" />
                      <span className="font-medium">Expiring Soon</span>
                    </div>
                    <p className="text-3xl font-bold">{certifications?.expiring || 0}</p>
                    <p className="text-xs text-muted-foreground">Within 30 days</p>
                  </div>
                  <div className="border rounded-lg p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <AlertTriangle className="h-5 w-5 text-destructive" />
                      <span className="font-medium">Expired</span>
                    </div>
                    <p className="text-3xl font-bold">{certifications?.expired || 0}</p>
                    <p className="text-xs text-muted-foreground">Needs renewal</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
