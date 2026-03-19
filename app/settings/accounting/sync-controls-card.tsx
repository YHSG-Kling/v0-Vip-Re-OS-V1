"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useToast } from "@/hooks/use-toast"
import { RefreshCw, DollarSign, Receipt, Loader2 } from "lucide-react"

interface SyncControlsCardProps {
  brokerageId: string
}

export function SyncControlsCard({ brokerageId }: SyncControlsCardProps) {
  const [syncingType, setSyncingType] = useState<string | null>(null)
  const { toast } = useToast()

  const handleSync = async (syncType: "commission" | "expense" | "full") => {
    setSyncingType(syncType)

    try {
      const response = await fetch("/api/accounting/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sync_type: syncType }),
      })

      const result = await response.json()

      if (result.success) {
        toast({
          title: "Sync Complete",
          description: `Synced ${result.recordsSynced} records${result.recordsFailed > 0 ? `, ${result.recordsFailed} failed` : ""}`,
        })
      } else {
        toast({
          title: "Sync Failed",
          description: result.error || "An error occurred during sync",
          variant: "destructive",
        })
      }
    } catch (error) {
      toast({
        title: "Sync Error",
        description: "Failed to initiate sync",
        variant: "destructive",
      })
    } finally {
      setSyncingType(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sync Controls</CardTitle>
        <CardDescription>
          Manually trigger sync operations with your accounting provider
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 sm:grid-cols-3">
          <Button
            variant="outline"
            className="h-auto py-4 flex-col gap-2"
            onClick={() => handleSync("commission")}
            disabled={syncingType !== null}
          >
            {syncingType === "commission" ? (
              <Loader2 className="h-6 w-6 animate-spin" />
            ) : (
              <DollarSign className="h-6 w-6" />
            )}
            <span className="font-medium">Sync Commissions</span>
            <span className="text-xs text-muted-foreground">
              Paid commissions only
            </span>
          </Button>

          <Button
            variant="outline"
            className="h-auto py-4 flex-col gap-2"
            onClick={() => handleSync("expense")}
            disabled={syncingType !== null}
          >
            {syncingType === "expense" ? (
              <Loader2 className="h-6 w-6 animate-spin" />
            ) : (
              <Receipt className="h-6 w-6" />
            )}
            <span className="font-medium">Sync Expenses</span>
            <span className="text-xs text-muted-foreground">
              Business expenses
            </span>
          </Button>

          <Button
            className="h-auto py-4 flex-col gap-2"
            onClick={() => handleSync("full")}
            disabled={syncingType !== null}
          >
            {syncingType === "full" ? (
              <Loader2 className="h-6 w-6 animate-spin" />
            ) : (
              <RefreshCw className="h-6 w-6" />
            )}
            <span className="font-medium">Full Sync</span>
            <span className="text-xs text-muted-foreground">
              All financial data
            </span>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
