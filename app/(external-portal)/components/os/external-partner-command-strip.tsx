"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  LayoutDashboard,
  FileText,
  DollarSign,
  Settings,
  RefreshCw,
  Bell,
} from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"

interface ExternalPartnerCommandStripProps {
  partnerType: "vendor" | "lender" | "title"
  partnerId: string
  partnerName?: string
  pendingActions?: number
}

export function ExternalPartnerCommandStrip({
  partnerType,
  partnerId,
  partnerName,
  pendingActions = 0,
}: ExternalPartnerCommandStripProps) {
  const router = useRouter()
  const [refreshing, setRefreshing] = useState(false)

  // partnerId scopes all routes to this specific partner per Kernel OS contract
  const baseRoutes = {
    vendor: {
      dashboard: `/vendor/dashboard`,
      jobs: `/vendor/jobs`,
      earnings: `/vendor/earnings`,
      portfolio: `/vendor/portfolio`,
      settings: `/vendor/settings?partnerId=${partnerId}`,
    },
    lender: {
      dashboard: `/lender/dashboard`,
      pipeline: `/lender/pipeline`,
      documents: `/lender/documents`,
      approvals: `/lender/approvals`,
      settings: `/lender/settings?partnerId=${partnerId}`,
    },
    title: {
      dashboard: `/title/dashboard`,
      orders: `/title/orders`,
      documents: `/title/documents`,
      closing: `/title/closing`,
      settings: `/title/settings?partnerId=${partnerId}`,
    },
  }

  const handleRefresh = async () => {
    setRefreshing(true)
    router.refresh()
    setTimeout(() => setRefreshing(false), 1000)
  }

  return (
    <div className="flex items-center justify-between gap-4 p-3 bg-card border rounded-lg">
      <div className="flex items-center gap-2">
        <LayoutDashboard className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium capitalize">{partnerType} Portal</span>
        {partnerName && (
          <Badge variant="outline" className="text-xs">
            {partnerName}
          </Badge>
        )}
      </div>

      <div className="flex items-center gap-1">
        <Link href={baseRoutes[partnerType].dashboard}>
          <Button variant="ghost" size="sm" className="h-8">
            <LayoutDashboard className="h-4 w-4 mr-1" />
            Dashboard
          </Button>
        </Link>

        {partnerType === "vendor" && (
          <Link href={baseRoutes.vendor.jobs}>
            <Button variant="ghost" size="sm" className="h-8">
              <FileText className="h-4 w-4 mr-1" />
              Jobs
              {pendingActions > 0 && (
                <Badge className="ml-1 h-5 px-1.5 bg-orange-500">{pendingActions}</Badge>
              )}
            </Button>
          </Link>
        )}

        {partnerType === "lender" && (
          <Link href={baseRoutes.lender.pipeline}>
            <Button variant="ghost" size="sm" className="h-8">
              <FileText className="h-4 w-4 mr-1" />
              Pipeline
            </Button>
          </Link>
        )}

        {partnerType === "title" && (
          <Link href={baseRoutes.title.orders}>
            <Button variant="ghost" size="sm" className="h-8">
              <FileText className="h-4 w-4 mr-1" />
              Orders
            </Button>
          </Link>
        )}

        {partnerType === "vendor" && (
          <Link href={baseRoutes.vendor.earnings}>
            <Button variant="ghost" size="sm" className="h-8">
              <DollarSign className="h-4 w-4 mr-1" />
              Earnings
            </Button>
          </Link>
        )}

        {(partnerType === "lender" || partnerType === "title") && (
          <Link href={baseRoutes[partnerType].documents}>
            <Button variant="ghost" size="sm" className="h-8">
              <FileText className="h-4 w-4 mr-1" />
              Documents
            </Button>
          </Link>
        )}

        {/* /notifications is user-scoped (listNotifications keys on the signed-in
            user id), so it is the partner's own notification centre — no partner
            role gate to add, and it already exists. */}
        <Link href="/notifications">
          <Button variant="ghost" size="sm" className="h-8 relative" title="Notifications">
            <Bell className="h-4 w-4" />
            {pendingActions > 0 && (
              <Badge className="absolute -top-1 -right-1 h-4 w-4 p-0 flex items-center justify-center text-[10px] bg-yellow-500">
                {pendingActions}
              </Badge>
            )}
          </Button>
        </Link>

        {/* REMOVED: a "Messages" button with an unread badge. There is no
            messages surface in any of the three partner portals — /vendor,
            /lender and /title have no messages route, and the only partner
            messaging component (ExternalCommunicationPanel) is rendered on one
            dashboard with messages={[]} and no onSendMessage. The control
            advertised an inbox the product does not have. */}

        <Button variant="ghost" size="sm" className="h-8" onClick={handleRefresh} disabled={refreshing}>
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
        </Button>

        <Link href={baseRoutes[partnerType].settings}>
          <Button variant="ghost" size="sm" className="h-8">
            <Settings className="h-4 w-4" />
          </Button>
        </Link>
      </div>
    </div>
  )
}
