'use client'

import { useState, useCallback } from 'react'
import { Card } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Users, TrendingUp, AlertCircle, Zap } from 'lucide-react'
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

interface AdoptionMetrics {
  avgCompletion: number
  activeAgents: number
  completedAgents: number
  stalledCount: number
}

interface SetupBlocker {
  integration_type: string
  is_configured: boolean
}

interface TrainingProgress {
  status: string
  completion_percentage: number
}

interface Provider {
  integration_type: string
  is_configured: boolean
  configured_at?: string
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
  providers: Provider[]
  recentOnboardings: RecentOnboarding[]
}

export function AdminOnboardingOsClient({
  userId,
  brokerageId,
  userRole,
  adoptionMetrics,
  setupBlockers,
  trainingProgress,
  providers,
  recentOnboardings,
}: AdminOnboardingOsClientProps) {
  const [activeTab, setActiveTab] = useState('overview')
  const [selectedBatch, setSelectedBatch] = useState<string[]>([])

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
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="setup">Setup Status</TabsTrigger>
          <TabsTrigger value="training">Training</TabsTrigger>
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
            <ProviderReadinessPanel
              providers={providers}
              brokerageId={brokerageId}
            />
          </div>
        </TabsContent>

        <TabsContent value="training" className="space-y-4">
          <TrainingProgressPanel
            trainingProgress={trainingProgress}
            brokerageId={brokerageId}
          />
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
