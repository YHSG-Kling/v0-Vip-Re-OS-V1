"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  LayoutDashboard,
  FileText,
  DollarSign,
  MessageSquare,
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
  unreadMessages?: number
}

export function ExternalPartnerCommandStrip({
  partnerType,
  partnerId,
  partnerName,
  pendingActions = 0,
  unreadMessages = 0,
}: ExternalPartnerCommandStripProps) {
  const router = useRouter()
  const [refreshing, setRefreshing] = useState(false)

  const baseRoutes = {
    vendor: {
      dashboard: "/vendor/dashboard",
      jobs: "/vendor/jobs",
      earnings: "/vendor/earnings",
      portfolio: "/vendor/portfolio",
      settings: "/vendor/settings",
    },
    lender: {
      dashboard: "/lender/dashboard",
      pipeline: "/lender/pipeline",
      documents: "/lender/documents",
      approvals: "/lender/approvals",
      settings: "/lender/settings",
    },
    title: {
      dashboard: "/title/dashboard",
      orders: "/title/orders",
      documents: "/title/documents",
      closing: "/title/closing",
      settings: "/title/settings",
    },
  }

  const routes = baseRoutes[partnerType]

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
        <Link href={routes.dashboard}>
          <Button variant="ghost" size="sm" className="h-8">
            <LayoutDashboard className="h-4 w-4 mr-1" />
            Dashboard
          </Button>
        </Link>

        {partnerType === "vendor" && (
          <Link href={routes.jobs}>
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
          <Link href={routes.pipeline}>
            <Button variant="ghost" size="sm" className="h-8">
              <FileText className="h-4 w-4 mr-1" />
              Pipeline
            </Button>
          </Link>
        )}

        {partnerType === "title" && (
          <Link href={routes.orders}>
            <Button variant="ghost" size="sm" className="h-8">
              <FileText className="h-4 w-4 mr-1" />
              Orders
            </Button>
          </Link>
        )}

        <Link href={partnerType === "vendor" ? routes.earnings : routes.documents}>
          <Button variant="ghost" size="sm" className="h-8">
            {partnerType === "vendor" ? (
              <>
                <DollarSign className="h-4 w-4 mr-1" />
                Earnings
              </>
            ) : (
              <>
                <FileText className="h-4 w-4 mr-1" />
                Documents
              </>
            )}
          </Button>
        </Link>

        <Button variant="ghost" size="sm" className="h-8 relative">
          <MessageSquare className="h-4 w-4" />
          {unreadMessages > 0 && (
            <Badge className="absolute -top-1 -right-1 h-4 w-4 p-0 flex items-center justify-center text-[10px] bg-red-500">
              {unreadMessages}
            </Badge>
          )}
        </Button>

        <Button variant="ghost" size="sm" className="h-8" onClick={handleRefresh} disabled={refreshing}>
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
        </Button>

        <Link href={routes.settings}>
          <Button variant="ghost" size="sm" className="h-8">
            <Settings className="h-4 w-4" />
          </Button>
        </Link>
      </div>
    </div>
  )
}
