'use client'

import { useState, useCallback, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Users, TrendingUp, AlertCircle, Zap, ShieldCheck, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  OnboardingCommandStrip,
  AdoptionRadar,
  SetupBlockersPanel,
  TrainingProgressPanel,
  ProviderReadinessPanel,
  OnboardingActionStack,
  AdoptionHealthPanel,
  OnboardingBatchActionsPanel,
} from './components/os'
import { getBrokerageAgentLicenseStatuses, reviewLicenseManually, type AgentLicenseStatus } from '@/app/actions/admin/license-tracking'
import { CdaSetupPanel } from './components/os/cda-setup-panel'
import type { BrokerageProviderReadiness } from '@/lib/platform/provider-posture'

interface AdoptionMetrics {
  avgCompletion: number
  activeAgents: number
  completedAgents: number
  stalledCount: number
}

interface SetupBlocker {
  provider_type: string
  status: string
}

interface TrainingProgress {
  status: string
  score: number | null
}

interface RecentOnboarding {
  id: string
  status: string
  completion_percentage: number
  created_at: string
}

interface AdminOnboardingOsClientProps {
  userId: string
  brokerageId: string
  userRole: string
  adoptionMetrics: AdoptionMetrics
  setupBlockers: SetupBlocker[]
  trainingProgress: TrainingProgress[]
  providerReadiness: BrokerageProviderReadiness
  recentOnboardings: RecentOnboarding[]
}

export function AdminOnboardingOsClient({
  userId,
  brokerageId,
  userRole,
  adoptionMetrics,
  setupBlockers,
  trainingProgress,
  providerReadiness,
  recentOnboardings,
}: AdminOnboardingOsClientProps) {
  const [activeTab, setActiveTab] = useState('overview')
  const [selectedBatch, setSelectedBatch] = useState<string[]>([])
  const [licenseStatuses, setLicenseStatuses] = useState<AgentLicenseStatus[]>([])
  const [licenseLoading, setLicenseLoading] = useState(false)
  const [reviewingId, setReviewingId] = useState<string | null>(null)
  const [expiryFilter, setExpiryFilter] = useState<'all' | '30' | '60' | '90'>('all')

  const loadLicenses = useCallback(() => {
    setLicenseLoading(true)
    return getBrokerageAgentLicenseStatuses(brokerageId)
      .then(({ agents }) => setLicenseStatuses(agents ?? []))
      .finally(() => setLicenseLoading(false))
  }, [brokerageId])

  useEffect(() => {
    if (activeTab !== 'license') return
    void loadLicenses()
  }, [activeTab, loadLicenses])

  const handleReviewLicense = useCallback((licenseId: string, decision: 'approve' | 'reject') => {
    setReviewingId(licenseId)
    const notes = decision === 'reject'
      ? (typeof window !== 'undefined' ? window.prompt('Reason sent to the agent (optional):') ?? undefined : undefined)
      : undefined
    reviewLicenseManually({ licenseId, decision, notes })
      .then((res) => {
        if (res.success) {
          toast.success(decision === 'approve' ? 'License verified' : 'License sent back to the agent')
          void loadLicenses()
        } else {
          toast.error(res.error ?? 'Review failed')
        }
      })
      .finally(() => setReviewingId(null))
  }, [loadLicenses])

  const needsReviewCount = licenseStatuses.filter((a) => a.needsManualReview).length

  const handleBatchAction = useCallback((_action: string, _agentIds: string[]) => {
    // Batch actions handled by OnboardingBatchActionsPanel
  }, [])

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">Onboarding Operations</h1>
        <p className="text-muted-foreground">
          Manage agent onboarding, training completion, and platform adoption across your brokerage
        </p>
      </div>

      {/* Command Strip */}
      <OnboardingCommandStrip
        brokerageId={brokerageId}
        userId={userId}
      />

      {/* Adoption Radar & Key Metrics */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <AdoptionRadar
            avgCompletion={adoptionMetrics.avgCompletion}
            activeAgents={adoptionMetrics.activeAgents}
            completedAgents={adoptionMetrics.completedAgents}
            stalledCount={adoptionMetrics.stalledCount}
          />
        </div>
        <div className="flex flex-col gap-4">
          {/* Quick metrics cards */}
          <Card className="p-4">
            <div className="flex items-center gap-3">
              <Zap className="h-5 w-5 text-blue-500" />
              <div>
                <p className="text-sm text-muted-foreground">Active Now</p>
                <p className="text-2xl font-bold">{adoptionMetrics.activeAgents}</p>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-3">
              <TrendingUp className="h-5 w-5 text-green-500" />
              <div>
                <p className="text-sm text-muted-foreground">Completed</p>
                <p className="text-2xl font-bold">{adoptionMetrics.completedAgents}</p>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-3">
              <AlertCircle className="h-5 w-5 text-red-500" />
              <div>
                <p className="text-sm text-muted-foreground">Stalled</p>
                <p className="text-2xl font-bold">{adoptionMetrics.stalledCount}</p>
              </div>
            </div>
          </Card>
        </div>
      </div>

      {/* Tabbed Content */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="setup">Setup Status</TabsTrigger>
          <TabsTrigger value="training">Training</TabsTrigger>
          <TabsTrigger value="license">License & CE</TabsTrigger>
          <TabsTrigger value="actions">Actions</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <AdoptionHealthPanel
              recentOnboardings={recentOnboardings}
              avgCompletion={adoptionMetrics.avgCompletion}
            />
            <OnboardingActionStack
              brokerageId={brokerageId}
              userId={userId}
              stallCount={adoptionMetrics.stalledCount}
            />
          </div>
        </TabsContent>

        <TabsContent value="setup" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <SetupBlockersPanel blockers={setupBlockers} />
            <ProviderReadinessPanel readiness={providerReadiness} />
          </div>
          {/* CDA setup — does the brokerage offer Commission Disbursement
              Authorizations? If yes, broker uploads template PDFs here. */}
          <CdaSetupPanel />
        </TabsContent>

        <TabsContent value="training" className="space-y-4">
          <TrainingProgressPanel
            trainingProgress={trainingProgress}
            brokerageId={brokerageId}
          />
        </TabsContent>

        {/* License & CE Tracking */}
        <TabsContent value="license" className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-primary" />
                  License &amp; CE Compliance
                  {needsReviewCount > 0 && (
                    <Badge variant="destructive" className="text-[10px]">{needsReviewCount} need review</Badge>
                  )}
                </CardTitle>
                <Select value={expiryFilter} onValueChange={(v) => setExpiryFilter(v as any)}>
                  <SelectTrigger className="w-40 h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All agents</SelectItem>
                    <SelectItem value="30">Expiring ≤ 30 days</SelectItem>
                    <SelectItem value="60">Expiring ≤ 60 days</SelectItem>
                    <SelectItem value="90">Expiring ≤ 90 days</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent>
              {licenseLoading ? (
                <p className="text-sm text-muted-foreground text-center py-4">Loading…</p>
              ) : licenseStatuses.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">No agent license data found.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs text-muted-foreground">
                        <th className="py-2 pr-4 font-medium">Agent</th>
                        <th className="py-2 pr-4 font-medium">License State</th>
                        <th className="py-2 pr-4 font-medium">License Expiry</th>
                        <th className="py-2 pr-4 font-medium">CE Hours</th>
                        <th className="py-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {licenseStatuses
                        .filter((a) => {
                          if (expiryFilter === 'all') return true
                          const days = a.daysUntilExpiry
                          if (days === null) return true
                          return days <= Number(expiryFilter)
                        })
                        // Licenses needing a human decision float to the top of the queue.
                        .sort((a, b) => Number(b.needsManualReview) - Number(a.needsManualReview))
                        .map((a) => {
                          const days = a.daysUntilExpiry
                          const color =
                            days === null
                              ? 'text-muted-foreground'
                              : days <= 30
                              ? 'text-red-600 font-semibold'
                              : days <= 60
                              ? 'text-amber-600 font-semibold'
                              : 'text-emerald-600'
                          const badge =
                            days === null
                              ? null
                              : days <= 30
                              ? <Badge variant="destructive" className="text-[10px]">Urgent</Badge>
                              : days <= 60
                              ? <Badge variant="outline" className="text-[10px] border-amber-400 text-amber-700">Soon</Badge>
                              : null
                          return (
                            <tr key={a.userId} className="border-b last:border-0 hover:bg-muted/30">
                              <td className="py-2 pr-4">
                                <p className="font-medium">{a.fullName}</p>
                                <p className="text-xs text-muted-foreground">{a.email}</p>
                              </td>
                              <td className="py-2 pr-4 text-muted-foreground">{a.licenseState ?? '—'}</td>
                              <td className={`py-2 pr-4 ${color}`}>
                                {a.expiryDate
                                  ? new Date(a.expiryDate).toLocaleDateString()
                                  : '—'}
                                {days !== null && (
                                  <span className="ml-1 text-xs">({days}d)</span>
                                )}
                              </td>
                              <td className="py-2 pr-4 text-muted-foreground">
                                {a.ceHoursCompleted}/{a.ceHoursRequired}h
                              </td>
                              <td className="py-2">
                                <div className="flex items-center gap-2 flex-wrap">
                                  {a.verificationStatus === 'verified' && (
                                    <Badge className="bg-emerald-100 text-emerald-800 text-[10px]"><CheckCircle2 className="h-3 w-3 mr-1" />Verified</Badge>
                                  )}
                                  {a.needsManualReview && (
                                    <Badge variant="destructive" className="text-[10px]"><AlertCircle className="h-3 w-3 mr-1" />Needs review</Badge>
                                  )}
                                  {badge}
                                  {a.needsManualReview && a.licenseId && (
                                    <span className="flex gap-1">
                                      <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]"
                                        disabled={reviewingId === a.licenseId}
                                        onClick={() => handleReviewLicense(a.licenseId!, 'approve')}>
                                        Verify
                                      </Button>
                                      <Button size="sm" variant="outline" className="h-6 px-2 text-[11px] border-red-300 text-red-700 hover:bg-red-50"
                                        disabled={reviewingId === a.licenseId}
                                        onClick={() => handleReviewLicense(a.licenseId!, 'reject')}>
                                        Reject
                                      </Button>
                                    </span>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="actions" className="space-y-4">
          <OnboardingBatchActionsPanel
            brokerageId={brokerageId}
            userId={userId}
            onBatchAction={handleBatchAction}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
