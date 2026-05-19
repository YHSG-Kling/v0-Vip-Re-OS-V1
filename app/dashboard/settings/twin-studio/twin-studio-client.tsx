"use client"

import { useState } from "react"
import { Plus } from "lucide-react"
import { Button } from "@/app/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/app/components/ui/tabs"
import { Badge } from "@/app/components/ui/badge"
import type { Twin } from "@/app/actions/twin-studio"
import { TwinCard } from "./components/twin-card"
import { TwinWizard } from "./components/twin-wizard"
import { ApprovalQueue } from "./components/approval-queue"

interface Props {
  twins: Twin[]
  pending: Twin[]
  canApprove: boolean
}

export function TwinStudioClient({ twins, pending, canApprove }: Props) {
  const [wizardOpen, setWizardOpen] = useState(false)

  return (
    <Tabs defaultValue="my-twins" className="space-y-6">
      <div className="flex items-center justify-between">
        <TabsList>
          <TabsTrigger value="my-twins">
            My Twins
            {twins.length > 0 && (
              <Badge variant="secondary" className="ml-2 h-5">{twins.length}</Badge>
            )}
          </TabsTrigger>
          {canApprove && (
            <TabsTrigger value="approvals">
              Approval Queue
              {pending.length > 0 && (
                <Badge variant="destructive" className="ml-2 h-5">{pending.length}</Badge>
              )}
            </TabsTrigger>
          )}
        </TabsList>

        <Button onClick={() => setWizardOpen(true)} size="sm">
          <Plus className="h-4 w-4 mr-1.5" />
          New Twin
        </Button>
      </div>

      <TabsContent value="my-twins" className="space-y-4">
        {twins.length === 0 ? (
          <EmptyState onStart={() => setWizardOpen(true)} />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {twins.map((twin) => (
              <TwinCard key={twin.id} twin={twin} canEdit />
            ))}
          </div>
        )}
      </TabsContent>

      {canApprove && (
        <TabsContent value="approvals">
          <ApprovalQueue twins={pending} />
        </TabsContent>
      )}

      <TwinWizard open={wizardOpen} onOpenChange={setWizardOpen} />
    </Tabs>
  )
}

function EmptyState({ onStart }: { onStart: () => void }) {
  return (
    <div className="rounded-lg border border-dashed py-16 px-6 text-center bg-muted/20">
      <p className="text-sm font-medium mb-1">No twins yet</p>
      <p className="text-xs text-muted-foreground max-w-md mx-auto mb-4">
        Create your first twin in three steps: upload a photo or short video, record a 60-second
        voice sample, and pick a personality. It's used everywhere your clients meet you online.
      </p>
      <Button onClick={onStart}>
        <Plus className="h-4 w-4 mr-1.5" />
        Create Your First Twin
      </Button>
    </div>
  )
}
