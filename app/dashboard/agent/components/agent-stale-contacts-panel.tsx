"use client"

import { useEffect, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Skeleton } from "@/components/ui/skeleton"
import Link from "next/link"
import { Clock, ArrowRight, PhoneCall } from "lucide-react"

interface StaleContact {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  last_contacted_at: string | null
  status: string | null
}

interface Props {
  agentId: string
  brokerageId: string
}

function daysSince(dateStr: string | null): number {
  if (!dateStr) return 999
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24))
}

function getInitials(first: string | null, last: string | null) {
  return `${first?.[0] ?? ""}${last?.[0] ?? ""}`.toUpperCase() || "?"
}

export function AgentStaleContactsPanel({ agentId, brokerageId }: Props) {
  const [contacts, setContacts] = useState<StaleContact[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!agentId || !brokerageId) {
      setLoading(false)
      return
    }
    const twentyOneDaysAgo = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString()
    const supabase = createClient()
    supabase
      .from("contacts")
      .select("id, first_name, last_name, email, phone, last_contacted_at, status")
      .eq("agent_id", agentId)
      .eq("brokerage_id", brokerageId)
      .is("deleted_at", null)
      .or(`last_contacted_at.lt.${twentyOneDaysAgo},last_contacted_at.is.null`)
      .neq("status", "archived")
      .order("last_contacted_at", { ascending: true, nullsFirst: true })
      .limit(10)
      .then(({ data }: { data: any }) => {
        setContacts(data ?? [])
        setLoading(false)
      })
  }, [agentId, brokerageId])

  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Contacts Needing Touch
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </CardContent>
      </Card>
    )
  }

  if (contacts.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Contacts Needing Touch
          </CardTitle>
          <CardDescription>No contact in 21+ days</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground py-2 text-center">
            All contacts are up to date.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="border-amber-200/60">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Clock className="h-4 w-4 text-amber-500" />
            Contacts Needing Touch
            <Badge variant="outline" className="text-xs border-amber-200 text-amber-700 bg-amber-50">
              {contacts.length}
            </Badge>
          </CardTitle>
          <Link href="/dashboard/contacts">
            <Button variant="ghost" size="sm" className="h-6 text-xs gap-1">
              All <ArrowRight className="h-3 w-3" />
            </Button>
          </Link>
        </div>
        <CardDescription>No meaningful activity in 21+ days</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {contacts.map((c) => {
          const days = daysSince(c.last_contacted_at)
          return (
            <Link key={c.id} href={`/dashboard/contacts/${c.id}`}>
              <div className="flex items-center gap-2.5 p-2 rounded-md hover:bg-muted/50 transition-colors cursor-pointer group">
                <Avatar className="h-7 w-7 shrink-0">
                  <AvatarFallback className="text-[10px]">
                    {getInitials(c.first_name, c.last_name)}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate">
                    {c.first_name} {c.last_name}
                  </p>
                  <p className="text-[10px] text-muted-foreground truncate">
                    {c.email ?? c.phone ?? "No contact info"}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Badge
                    variant="outline"
                    className={`text-[10px] px-1.5 ${
                      days >= 60
                        ? "border-red-200 text-red-700 bg-red-50"
                        : days >= 30
                        ? "border-orange-200 text-orange-700 bg-orange-50"
                        : "border-amber-200 text-amber-700 bg-amber-50"
                    }`}
                  >
                    {days === 999 ? "Never" : `${days}d`}
                  </Badge>
                  {c.phone && (
                    <a
                      href={`tel:${c.phone}`}
                      onClick={(e) => e.stopPropagation()}
                      className="opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <PhoneCall className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                    </a>
                  )}
                </div>
              </div>
            </Link>
          )
        })}
      </CardContent>
    </Card>
  )
}
