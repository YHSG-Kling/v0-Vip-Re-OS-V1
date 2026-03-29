"use client"

import { useState, useEffect, useTransition } from "react"
import { createClient } from "@/lib/supabase/client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { RefreshCw, CheckCircle2, AlertCircle, Link2, ExternalLink } from "lucide-react"
import { syncCalendar } from "@/app/actions/ai-calendar-management"
import Link from "next/link"

interface CalendarSyncStatusCardProps {
  agentId: string
}

type ProviderAccount = {
  id: string
  provider_type: "google" | "outlook"
  last_sync_at: string | null
  is_active: boolean
  sync_direction: string
}

export function CalendarSyncStatusCard({ agentId }: CalendarSyncStatusCardProps) {
  const supabase = createClient()
  const [providerAccounts, setProviderAccounts] = useState<ProviderAccount[]>([])
  const [isPending, startTransition] = useTransition()
  const [syncErrors, setSyncErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    async function loadProviders() {
      // calendar_provider_accounts has user_id, provider_type, is_active, last_sync_at
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const { data } = await supabase
        .from("calendar_provider_accounts")
        .select("id, provider_type, last_sync_at, is_active, sync_direction")
        .eq("user_id", user.id)
      setProviderAccounts((data || []) as ProviderAccount[])
    }
    loadProviders()
  }, [supabase])

  const handleSync = (provider: "google" | "outlook") => {
    startTransition(async () => {
      const res = await syncCalendar({ agentId, provider })
      if (!res.success) {
        const errMsg = (res as any).error === "calendar_not_connected"
          ? "Not connected — configure in Settings"
          : (res as any).error || "Sync failed"
        setSyncErrors((prev) => ({ ...prev, [provider]: errMsg }))
      } else {
        setSyncErrors((prev) => { const n = { ...prev }; delete n[provider]; return n })
        // Refresh provider accounts to update last_sync_at
        const { data: { user } } = await supabase.auth.getUser()
        if (user) {
          const { data } = await supabase
            .from("calendar_provider_accounts")
            .select("id, provider_type, last_sync_at, is_active, sync_direction")
            .eq("user_id", user.id)
          setProviderAccounts((data || []) as ProviderAccount[])
        }
      }
    })
  }

  const googleAccount = providerAccounts.find((a) => a.provider_type === "google")
  const outlookAccount = providerAccounts.find((a) => a.provider_type === "outlook")
  const neitherConnected = !googleAccount && !outlookAccount

  const formatLastSync = (acct: ProviderAccount | undefined) => {
    if (!acct?.last_sync_at) return "Never synced"
    const date = new Date(acct.last_sync_at)
    const diff = Date.now() - date.getTime()
    const minutes = Math.floor(diff / 60000)
    if (minutes < 1) return "Just now"
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    return date.toLocaleDateString()
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Link2 className="h-4 w-4" />
          Calendar Sync
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Not-connected CTA (non-blocking) */}
        {neitherConnected && (
          <Alert className="border-blue-200 bg-blue-50 py-2">
            <AlertDescription className="text-xs text-blue-900 flex items-center justify-between gap-2">
              <span>Connect Google Calendar to sync events automatically.</span>
              <Link href="/dashboard/settings/calendar">
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1 shrink-0 border-blue-300 text-blue-800 hover:bg-blue-100">
                  <ExternalLink className="h-3 w-3" />
                  Connect
                </Button>
              </Link>
            </AlertDescription>
          </Alert>
        )}

        {/* Google Calendar */}
        <div className="flex items-center justify-between p-2 bg-muted/50 rounded-lg">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded bg-white flex items-center justify-center">
              <svg viewBox="0 0 24 24" className="w-4 h-4">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
            </div>
            <div>
              <p className="text-xs font-medium text-foreground">Google Calendar</p>
              <p className="text-xs text-muted-foreground">
                {googleAccount ? formatLastSync(googleAccount) : "Not connected"}
              </p>
              {syncErrors.google && (
                <p className="text-xs text-destructive">{syncErrors.google}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {googleAccount?.is_active ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
            ) : googleAccount ? (
              <AlertCircle className="h-3.5 w-3.5 text-amber-500" />
            ) : null}
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              onClick={() => handleSync("google")}
              disabled={isPending}
              title={googleAccount ? "Sync now" : "Connect in Settings to sync"}
            >
              <RefreshCw className={`h-3 w-3 ${isPending ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>

        {/* Outlook */}
        <div className="flex items-center justify-between p-2 bg-muted/50 rounded-lg">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded bg-[#0078D4] flex items-center justify-center">
              <svg viewBox="0 0 24 24" className="w-4 h-4" fill="white">
                <path d="M7.88 12.04q0 .45-.11.87-.1.41-.33.74-.22.33-.58.52-.37.2-.87.2t-.85-.2q-.35-.21-.57-.55-.22-.33-.33-.75-.1-.42-.1-.86t.1-.87q.1-.43.34-.76.22-.34.59-.54.36-.2.87-.2t.86.2q.35.21.57.55.22.34.31.77.1.43.1.88zM24 12v9.38q0 .46-.33.8-.33.32-.8.32H7.13q-.46 0-.8-.33-.32-.33-.32-.8V18H1q-.41 0-.7-.3-.3-.29-.3-.7V7q0-.41.3-.7Q.58 6 1 6h6.13V2.55q0-.44.3-.75.3-.3.7-.3h15.12q.44 0 .75.3.3.3.3.75V12zm-8.25-7.13V12h4.87V3.62h-4.87zm-7.88 7.87l2.09 1.46-.7 1.02-2.38-1.69q.26-.38.99-.79zM9.64 6v1.93L7.45 9.67l-.57-.58L7 9l1.57-1.28q.21-.17.33-.3t.2-.3L9.29 7l.35-.27V6h.01zm2.75 4.41l2.09-1.46.99.79-2.38 1.68-.7-1.01zm2.75-2.41V6h1.5v5.63q0 .3-.08.53-.06.21-.25.43t-.57.52l-2.08 1.46-.71-1.01 2.09-1.46q.26-.18.36-.33V8zm3.75 6.37V6h1.5v8.37h-1.5zM7 10h6v1H7v-1zm0 2h6v1H7v-1zm0 2h4v1H7v-1z"/>
              </svg>
            </div>
            <div>
              <p className="text-xs font-medium text-foreground">Outlook</p>
              <p className="text-xs text-muted-foreground">
                {outlookAccount ? formatLastSync(outlookAccount) : "Not connected"}
              </p>
              {syncErrors.outlook && (
                <p className="text-xs text-destructive">{syncErrors.outlook}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {outlookAccount?.is_active ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
            ) : outlookAccount ? (
              <AlertCircle className="h-3.5 w-3.5 text-amber-500" />
            ) : null}
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              onClick={() => handleSync("outlook")}
              disabled={isPending}
              title={outlookAccount ? "Sync now" : "Connect in Settings to sync"}
            >
              <RefreshCw className={`h-3 w-3 ${isPending ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>

        {!neitherConnected && (
          <p className="text-xs text-muted-foreground text-center">
            Syncs every 15 minutes automatically
          </p>
        )}
        <Link href="/dashboard/settings/calendar" className="block">
          <Button variant="ghost" size="sm" className="w-full text-xs h-7 gap-1 text-muted-foreground hover:text-foreground">
            <ExternalLink className="h-3 w-3" />
            Manage Calendar Integrations
          </Button>
        </Link>
      </CardContent>
    </Card>
  )
}
