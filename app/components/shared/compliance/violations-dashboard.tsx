"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertTriangle, CheckCircle, TrendingUp, Eye, User, Calendar, Shield } from "lucide-react"
import { formatDistanceToNow } from "date-fns"

interface ViolationsDashboardProps {
  initialViolations: any[]
  report: {
    totalCommunications: number
    compliantCommunications: number
    totalViolations: number
    criticalViolations: number
    violationsByType: Record<string, number>
    communicationsByChannel: Record<string, number>
    /** null = the communication log could not be read, so nothing is established. */
    coldLeadChannelCompliance: boolean | null
    unreadableSources?: string[]
  }
}

export default function ViolationsDashboard({ initialViolations, report }: ViolationsDashboardProps) {
  const [violations] = useState(initialViolations)
  const [selectedViolation, setSelectedViolation] = useState<any>(null)

  const complianceRate =
    report.totalCommunications > 0
      ? Math.round((report.compliantCommunications / report.totalCommunications) * 100)
      : 100

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Compliance Rate</CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${complianceRate >= 90 ? "text-green-600" : "text-red-600"}`}>
              {complianceRate}%
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {report.compliantCommunications}/{report.totalCommunications} communications
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Violations</CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${report.totalViolations > 0 ? "text-red-600" : "text-green-600"}`}>
              {report.totalViolations}
            </div>
            <p className="text-xs text-muted-foreground mt-1">{report.criticalViolations} critical</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Cold Lead Compliance</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              {report.coldLeadChannelCompliance === null ? (
                // Three states, not two. "The log could not be read" is not a
                // pass and is not a violation — showing it as either would be a
                // finding we did not make.
                <>
                  <AlertTriangle className="w-5 h-5 text-amber-600" />
                  <span className="text-2xl font-bold text-amber-600">Not established</span>
                </>
              ) : report.coldLeadChannelCompliance ? (
                <>
                  <CheckCircle className="w-5 h-5 text-green-600" />
                  <span className="text-2xl font-bold text-green-600">Compliant</span>
                </>
              ) : (
                <>
                  <AlertTriangle className="w-5 h-5 text-red-600" />
                  <span className="text-2xl font-bold text-red-600">Issues</span>
                </>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Email/print only</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Communications</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{report.totalCommunications}</div>
            <p className="text-xs text-muted-foreground mt-1">Last 30 days</p>
          </CardContent>
        </Card>
      </div>

      {/* Violations by Type */}
      {report.violationsByType && Object.keys(report.violationsByType).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5" />
              Violations by Type
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {Object.entries(report.violationsByType).map(([type, count]) => (
                <div key={type} className="p-3 bg-muted rounded-lg">
                  <p className="text-sm font-medium">{type.replace(/_/g, " ")}</p>
                  <p className="text-2xl font-bold text-red-600">{count}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Communications by Channel */}
      {report.communicationsByChannel && Object.keys(report.communicationsByChannel).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              Communications by Channel
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {Object.entries(report.communicationsByChannel).map(([channel, count]) => (
                <div key={channel} className="p-3 bg-muted rounded-lg">
                  <p className="text-sm font-medium capitalize">{channel}</p>
                  <p className="text-2xl font-bold">{count}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Violations List */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5" />
            Recent Violations
          </CardTitle>
          <CardDescription>Review and resolve compliance violations</CardDescription>
        </CardHeader>
        <CardContent>
          {violations.length === 0 ? (
            <div className="text-center py-8">
              <CheckCircle className="w-12 h-12 mx-auto text-green-600 mb-4" />
              <h3 className="text-lg font-semibold mb-2">No Violations</h3>
              <p className="text-muted-foreground">Great job! No compliance violations detected.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {violations.map((violation: any) => (
                <div key={violation.id} className="border rounded-lg p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <Badge
                          variant={
                            violation.severity === "critical"
                              ? "destructive"
                              : violation.severity === "high"
                                ? "destructive"
                                : "default"
                          }
                        >
                          {violation.severity}
                        </Badge>
                        <span className="font-medium">{violation.violation_type?.replace(/_/g, " ")}</span>
                      </div>
                      <div className="flex items-center gap-4 text-sm text-muted-foreground">
                        {violation.agents && (
                          <span className="flex items-center gap-1">
                            <User className="w-3 h-3" />
                            {violation.agents.first_name} {violation.agents.last_name}
                          </span>
                        )}
                        <span className="flex items-center gap-1">
                          <Calendar className="w-3 h-3" />
                          {violation.detected_at
                            ? formatDistanceToNow(new Date(violation.detected_at), { addSuffix: true })
                            : "Unknown"}
                        </span>
                      </div>
                      <p className="text-sm mt-2">
                        {typeof violation.violation_details === "object"
                          ? JSON.stringify(violation.violation_details)
                          : violation.violation_details}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={
                          violation.resolution_status === "resolved"
                            ? "default"
                            : violation.resolution_status === "pending"
                              ? "secondary"
                              : "outline"
                        }
                      >
                        {violation.resolution_status || "open"}
                      </Badge>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setSelectedViolation(violation)}
                        className="bg-transparent"
                      >
                        <Eye className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Violation Detail Dialog */}
      <Dialog open={!!selectedViolation} onOpenChange={(open) => !open && setSelectedViolation(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Violation Details</DialogTitle>
          </DialogHeader>

          {selectedViolation && (
            <div className="space-y-4 py-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <span className="text-sm text-muted-foreground">Type:</span>
                  <p className="font-medium">{selectedViolation.violation_type?.replace(/_/g, " ")}</p>
                </div>
                <div>
                  <span className="text-sm text-muted-foreground">Severity:</span>
                  <Badge
                    variant={
                      selectedViolation.severity === "critical" || selectedViolation.severity === "high"
                        ? "destructive"
                        : "default"
                    }
                  >
                    {selectedViolation.severity}
                  </Badge>
                </div>
                <div>
                  <span className="text-sm text-muted-foreground">Detected By:</span>
                  <p className="font-medium">{selectedViolation.detected_by || "Auto-scan"}</p>
                </div>
                <div>
                  <span className="text-sm text-muted-foreground">Status:</span>
                  <Badge>{selectedViolation.resolution_status || "open"}</Badge>
                </div>
              </div>

              <div>
                <span className="text-sm text-muted-foreground">Details:</span>
                <pre className="mt-1 p-3 bg-muted rounded-lg text-sm overflow-x-auto">
                  {JSON.stringify(selectedViolation.violation_details, null, 2)}
                </pre>
              </div>

              {selectedViolation.remediation_notes && (
                <Alert>
                  <AlertDescription>
                    <strong>Remediation Notes:</strong> {selectedViolation.remediation_notes}
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
