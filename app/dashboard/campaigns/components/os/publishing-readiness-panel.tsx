"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import {
  Send,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  Shield,
  Eye,
  FileText,
  Loader2
} from "lucide-react"
import Link from "next/link"
import { useState, useTransition } from "react"

interface PublishingChecklist {
  hasContent: boolean
  hasRecipients: boolean
  complianceApproved: boolean
  scheduledTime?: string
  estimatedReach: number
}

interface CampaignReadiness {
  id: string
  name: string
  type: string
  checklist: PublishingChecklist
  readinessScore: number
}

interface PublishingReadinessPanelProps {
  campaigns: CampaignReadiness[]
  onPublish?: (id: string) => Promise<void>
  onRequestApproval?: (id: string) => Promise<void>
}

export function PublishingReadinessPanel({ 
  campaigns, 
  onPublish,
  onRequestApproval 
}: PublishingReadinessPanelProps) {
  const [isPending, startTransition] = useTransition()
  const [loadingId, setLoadingId] = useState<string | null>(null)

  const handlePublish = async (id: string) => {
    if (!onPublish) return
    setLoadingId(id)
    startTransition(async () => {
      await onPublish(id)
      setLoadingId(null)
    })
  }

  const handleRequestApproval = async (id: string) => {
    if (!onRequestApproval) return
    setLoadingId(id)
    startTransition(async () => {
      await onRequestApproval(id)
      setLoadingId(null)
    })
  }

  const getReadinessColor = (score: number) => {
    if (score >= 100) return "text-green-500"
    if (score >= 75) return "text-amber-500"
    return "text-red-500"
  }

  const getReadinessLabel = (score: number) => {
    if (score >= 100) return "Ready"
    if (score >= 75) return "Almost Ready"
    return "Needs Work"
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Send className="h-5 w-5" />
              Publishing Readiness
            </CardTitle>
            <CardDescription>Pre-flight checks before going live</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {campaigns.length === 0 ? (
          <div className="text-center py-8">
            <Send className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-muted-foreground">No campaigns ready for publishing review</p>
          </div>
        ) : (
          <div className="space-y-4">
            {campaigns.map((campaign) => {
              const isLoading = loadingId === campaign.id
              const { checklist } = campaign
              const allChecksPass = checklist.hasContent && checklist.hasRecipients && checklist.complianceApproved

              return (
                <div key={campaign.id} className="p-4 border rounded-lg space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium">{campaign.name}</p>
                      <p className="text-xs text-muted-foreground capitalize">{campaign.type}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-medium ${getReadinessColor(campaign.readinessScore)}`}>
                        {campaign.readinessScore}%
                      </span>
                      <Badge variant={campaign.readinessScore >= 100 ? "default" : "secondary"}>
                        {getReadinessLabel(campaign.readinessScore)}
                      </Badge>
                    </div>
                  </div>

                  <Progress value={campaign.readinessScore} className="h-2" />

                  {/* Checklist */}
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div className="flex items-center gap-2">
                      {checklist.hasContent ? (
                        <CheckCircle2 className="h-4 w-4 text-green-500" />
                      ) : (
                        <XCircle className="h-4 w-4 text-red-500" />
                      )}
                      <span>Content ready</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {checklist.hasRecipients ? (
                        <CheckCircle2 className="h-4 w-4 text-green-500" />
                      ) : (
                        <XCircle className="h-4 w-4 text-red-500" />
                      )}
                      <span>Recipients set ({checklist.estimatedReach})</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {checklist.complianceApproved ? (
                        <CheckCircle2 className="h-4 w-4 text-green-500" />
                      ) : (
                        <AlertTriangle className="h-4 w-4 text-amber-500" />
                      )}
                      <span>Compliance {checklist.complianceApproved ? "approved" : "pending"}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {checklist.scheduledTime ? (
                        <>
                          <Clock className="h-4 w-4 text-blue-500" />
                          <span>{new Date(checklist.scheduledTime).toLocaleDateString()}</span>
                        </>
                      ) : (
                        <>
                          <Clock className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Not scheduled</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 pt-2 border-t">
                    {allChecksPass ? (
                      <Button 
                        size="sm" 
                        className="gap-2"
                        onClick={() => handlePublish(campaign.id)}
                        disabled={isLoading}
                      >
                        {isLoading ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Send className="h-4 w-4" />
                        )}
                        Publish Now
                      </Button>
                    ) : !checklist.complianceApproved ? (
                      <Button 
                        size="sm" 
                        variant="outline"
                        className="gap-2"
                        onClick={() => handleRequestApproval(campaign.id)}
                        disabled={isLoading}
                      >
                        {isLoading ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Shield className="h-4 w-4" />
                        )}
                        Request Approval
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" className="gap-2">
                        <FileText className="h-4 w-4" />
                        Complete Setup
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" className="gap-2">
                      <Eye className="h-4 w-4" />
                      Preview
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
