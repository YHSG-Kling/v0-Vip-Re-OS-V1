"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { 
  DollarSign,
  FileText,
  Link2,
  ExternalLink,
  CheckCircle2,
  AlertTriangle 
} from "lucide-react"

interface AccountingStatus {
  quickbooksConnected: boolean
  xeroConnected: boolean
  lastSyncAt?: string | null
  syncErrors: number
}

interface CommissionSettings {
  defaultSplitPct: number
  capAmount?: number | null
  hasStructures: boolean
  structureCount: number
}

interface AccountingCommissionPanelProps {
  accounting: AccountingStatus
  commission: CommissionSettings
}

export function AccountingCommissionPanel({ 
  accounting, 
  commission 
}: AccountingCommissionPanelProps) {
  const hasAccountingProvider = accounting.quickbooksConnected || accounting.xeroConnected
  const providerName = accounting.quickbooksConnected ? "QuickBooks" : accounting.xeroConnected ? "Xero" : null
  
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <DollarSign className="h-4 w-4" />
          Accounting & Commission
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Accounting Status */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Link2 className={`h-4 w-4 ${hasAccountingProvider ? "text-green-500" : "text-muted-foreground"}`} />
              <span className="text-sm">Accounting Sync</span>
            </div>
            {hasAccountingProvider ? (
              <Badge variant="default" className="text-xs">{providerName}</Badge>
            ) : (
              <Link href="/settings/accounting">
                <Button variant="outline" size="sm" className="h-6 px-2 text-xs">
                  Connect
                </Button>
              </Link>
            )}
          </div>
          
          {hasAccountingProvider && accounting.syncErrors > 0 && (
            <div className="flex items-center gap-2 text-xs text-amber-600 pl-6">
              <AlertTriangle className="h-3 w-3" />
              {accounting.syncErrors} sync errors need attention
            </div>
          )}
          
          {hasAccountingProvider && accounting.lastSyncAt && (
            <p className="text-xs text-muted-foreground pl-6">
              Last synced: {new Date(accounting.lastSyncAt).toLocaleDateString()}
            </p>
          )}
        </div>

        {/* Commission Settings */}
        <div className="space-y-2 pt-2 border-t">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm">Commission Structures</span>
            </div>
            <Badge variant="outline" className="text-xs">
              {commission.structureCount} active
            </Badge>
          </div>
          
          <div className="grid grid-cols-2 gap-2 text-xs pl-6">
            <div>
              <p className="text-muted-foreground">Default Split</p>
              <p className="font-medium">{commission.defaultSplitPct}%</p>
            </div>
            {commission.capAmount && (
              <div>
                <p className="text-muted-foreground">Cap Amount</p>
                <p className="font-medium">${commission.capAmount.toLocaleString()}</p>
              </div>
            )}
          </div>
        </div>

        {/* Quick Links */}
        <div className="flex gap-2 pt-2 border-t">
          <Link href="/settings/accounting" className="flex-1">
            <Button variant="outline" size="sm" className="w-full text-xs">
              Accounting <ExternalLink className="h-3 w-3 ml-1" />
            </Button>
          </Link>
          <Link href="/settings/commission" className="flex-1">
            <Button variant="outline" size="sm" className="w-full text-xs">
              Commission <ExternalLink className="h-3 w-3 ml-1" />
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  )
}
