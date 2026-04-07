"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import {
  Building2,
  DollarSign,
  Brain,
  Settings,
  Link2,
  AlertTriangle,
  FileSearch,
  Activity,
  Shield,
  RefreshCw
} from "lucide-react"

interface PlatformOwnerCommandStripProps {
  onRefresh?: () => void
}

export function PlatformOwnerCommandStrip({ onRefresh }: PlatformOwnerCommandStripProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 p-4 bg-card border rounded-lg">
      <Link href="/admin/brokerages">
        <Button variant="outline" size="sm" className="gap-2">
          <Building2 className="h-4 w-4" />
          Brokerages
        </Button>
      </Link>
      <Link href="/admin/billing">
        <Button variant="outline" size="sm" className="gap-2">
          <DollarSign className="h-4 w-4" />
          Billing
        </Button>
      </Link>
      <Link href="/admin/ai-audit">
        <Button variant="outline" size="sm" className="gap-2">
          <Brain className="h-4 w-4" />
          AI Audit
        </Button>
      </Link>
      <Link href="/admin/integrations">
        <Button variant="outline" size="sm" className="gap-2">
          <Link2 className="h-4 w-4" />
          Integrations
        </Button>
      </Link>
      <Link href="/admin/system-health">
        <Button variant="outline" size="sm" className="gap-2">
          <Activity className="h-4 w-4" />
          System Health
        </Button>
      </Link>
      <Link href="/admin/error-handler">
        <Button variant="outline" size="sm" className="gap-2">
          <AlertTriangle className="h-4 w-4" />
          Errors
        </Button>
      </Link>
      <Link href="/admin/audit-trail">
        <Button variant="outline" size="sm" className="gap-2">
          <FileSearch className="h-4 w-4" />
          Audit Trail
        </Button>
      </Link>
      <Link href="/dashboard/superadmin/observability">
        <Button variant="outline" size="sm" className="gap-2">
          <Shield className="h-4 w-4" />
          Observability
        </Button>
      </Link>
      {onRefresh && (
        <Button variant="ghost" size="sm" className="gap-2 ml-auto" onClick={onRefresh}>
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      )}
    </div>
  )
}
