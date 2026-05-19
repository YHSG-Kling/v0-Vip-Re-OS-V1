"use client"

import { useState, useEffect } from "react"
import { Bell } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Badge } from "@/components/ui/badge"
import { createClient } from "@/lib/supabase/client"

interface Notification {
  id: string
  title: string | null
  body: string | null
  type: string | null
  is_read: boolean
  created_at: string
}

interface Props {
  contactId: string
  initialUnread: number
}

export function PortalNotificationBell({ contactId, initialUnread }: Props) {
  const [unread, setUnread] = useState(initialUnread)
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)

  async function loadNotifications() {
    if (loaded) return
    const supabase = createClient()
    const { data } = await supabase
      .from("notifications")
      .select("id, title, body, type, is_read, created_at")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(20)
    if (data) {
      setNotifications(data)
      setUnread(data.filter((n: Notification) => !n.is_read).length)
      setLoaded(true)
    }
  }

  // Subscribe to realtime INSERTs on the notifications table for this contact
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel(`portal-notifications-${contactId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `contact_id=eq.${contactId}`,
        },
        (payload: { new: Notification }) => {
          const n = payload.new
          setNotifications((prev) => [n, ...prev].slice(0, 20))
          if (!n.is_read) setUnread((prev) => prev + 1)
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [contactId])

  async function markAllRead() {
    const supabase = createClient()
    await supabase
      .from("notifications")
      .update({ is_read: true })
      .eq("contact_id", contactId)
      .eq("is_read", false)
    setNotifications((prev) => prev.map((n: Notification) => ({ ...n, is_read: true })))
    setUnread(0)
  }

  function handleOpen(v: boolean) {
    setOpen(v)
    if (v) {
      loadNotifications()
    }
  }

  if (initialUnread === 0 && !loaded) {
    return null
  }

  return (
    <Popover open={open} onOpenChange={handleOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative h-9 w-9">
          <Bell className="h-5 w-5" />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[9px] font-bold text-white">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <p className="font-semibold text-sm">Notifications</p>
          {unread > 0 && (
            <button
              onClick={markAllRead}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Mark all read
            </button>
          )}
        </div>
        <ul className="max-h-80 overflow-y-auto divide-y">
          {notifications.length === 0 ? (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">
              No notifications
            </li>
          ) : (
            notifications.map((n) => (
              <li
                key={n.id}
                className={`px-4 py-3 ${!n.is_read ? "bg-blue-50/50" : ""}`}
              >
                <div className="flex items-start gap-2">
                  {!n.is_read && (
                    <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-blue-500 shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{n.title ?? "Update"}</p>
                    {n.body && (
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{n.body}</p>
                    )}
                    <p className="text-[10px] text-muted-foreground mt-1">
                      {new Date(n.created_at).toLocaleDateString()}
                    </p>
                  </div>
                </div>
              </li>
            ))
          )}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
