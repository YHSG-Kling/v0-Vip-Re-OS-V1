"use client"

import { Button } from "@/components/ui/button"
import { RefreshCw, Workflow, AlertTriangle, Play, Pause, CheckCircle2 } from "lucide-react"

interface WorkflowCommandStripProps {
  stats: {
    total: number
    running: number
    failed: number
    paused: number
    succeeded_today: number
  } | null
  loading: boolean
  onRefresh: () => void
}

export function WorkflowCommandStrip({ stats, loading, onRefresh }: WorkflowCommandStripProps) {
  const failedCount = stats?.failed || 0

  return (
    <div className="rounded-lg border bg-gradient-to-r from-violet-50 to-purple-50 p-4 mb-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-violet-100">
            <Workflow className="h-5 w-5 text-violet-700" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">Workflow & Automation OS</h1>
            <p className="text-sm text-muted-foreground">
              {stats ? `${stats.total} total automations` : "Loading..."}
            </p>
          </div>
        </div>

        <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh Status
        </Button>
      </div>

      {/* 4-tile radar */}
      <div className="grid grid-cols-4 gap-3 mt-4">
        <div className="flex items-center gap-2 rounded-md bg-blue-50 border border-blue-200 px-3 py-2">
          <Play className="h-4 w-4 text-blue-600" />
          <div>
            <p className="text-xs text-blue-700">Running</p>
            <p className="text-lg font-bold text-blue-900">{stats?.running || 0}</p>
          </div>
        </div>

        <div className="flex items-center gap-2 rounded-md bg-red-50 border border-red-200 px-3 py-2 relative">
          <AlertTriangle className="h-4 w-4 text-red-600" />
          <div>
            <p className="text-xs text-red-700">Failed</p>
            <p className="text-lg font-bold text-red-900">{failedCount}</p>
          </div>
          {failedCount > 0 && (
            <span className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-xs font-medium text-white">
              {failedCount}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2">
          <Pause className="h-4 w-4 text-amber-600" />
          <div>
            <p className="text-xs text-amber-700">Paused</p>
            <p className="text-lg font-bold text-amber-900">{stats?.paused || 0}</p>
          </div>
        </div>

        <div className="flex items-center gap-2 rounded-md bg-green-50 border border-green-200 px-3 py-2">
          <CheckCircle2 className="h-4 w-4 text-green-600" />
          <div>
            <p className="text-xs text-green-700">Succeeded Today</p>
            <p className="text-lg font-bold text-green-900">{stats?.succeeded_today || 0}</p>
          </div>
        </div>
      </div>

      {/* Alert banner for failed */}
      {failedCount > 0 && (
        <div className="mt-4 flex items-center gap-2 rounded-md bg-red-100 border border-red-300 px-4 py-2">
          <AlertTriangle className="h-4 w-4 text-red-600" />
          <p className="text-sm font-medium text-red-800">
            {failedCount} automation{failedCount > 1 ? "s" : ""} need{failedCount === 1 ? "s" : ""} attention
          </p>
        </div>
      )}
    </div>
  )
}
