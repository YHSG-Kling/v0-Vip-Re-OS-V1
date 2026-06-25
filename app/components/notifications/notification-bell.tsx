"use client"

import React, { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import {
  Bell,
  AlertCircle,
  TrendingUp,
  MessageSquare,
  CheckSquare,
  Info,
  BarChart2,
  Sparkles,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  getNotifications,
  markNotificationRead,
  markAllRead,
} from "@/app/actions/notifications"
import type { Notification } from "@/app/actions/notifications"

// ── Type icon map ─────────────────────────────────────────────────────────────

function NotificationIcon({ type }: { type: string }) {
  const cls = "w-4 h-4 shrink-0 mt-0.5"
  switch (type) {
    case "lead_alert":
      return <AlertCircle className={`${cls} text-blue-500`} />
    case "qualified_lead_unassigned":
      return <AlertCircle className={`${cls} text-red-500`} />
    case "ghost_lead_exhausted":
      return <AlertCircle className={`${cls} text-amber-500`} />
    case "deal_update":
      return <TrendingUp className={`${cls} text-green-500`} />
    case "task_due":
      return <CheckSquare className={`${cls} text-orange-500`} />
    case "message_received":
      return <MessageSquare className={`${cls} text-purple-500`} />
    case "system_alert":
      return <Info className={`${cls} text-red-500`} />
    case "market_update":
      return <BarChart2 className={`${cls} text-cyan-500`} />
    case "ai_insight":
      return <Sparkles className={`${cls} text-yellow-500`} />
    default:
      return <Bell className={`${cls} text-gray-400`} />
  }
}

// ── Time ago helper ───────────────────────────────────────────────────────────

function timeAgo(isoString: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(isoString).getTime()) / 1000,
  )
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// ── Entity URL resolver ───────────────────────────────────────────────────────

function resolveNotificationUrl(entityType: string | null, entityId: string | null): string | null {
  if (!entityType || !entityId) return null
  const id = encodeURIComponent(entityId)
  switch (entityType) {
    case "contact": return `/crm?contact=${id}`
    case "lead": return `/leads/${id}`
    case "transaction": return `/dashboard/transactions/${id}`
    case "listing": return `/dashboard/listings/${id}`
    case "open_house": return `/dashboard/open-houses?event=${id}`
    case "deal": return `/dashboard/transactions/${id}`
    default: return null
  }
}

// ── NotificationBell ──────────────────────────────────────────────────────────

export function NotificationBell() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [loading, setLoading] = useState(false)

  const unreadCount = notifications.filter((n) => !n.is_read).length
  const displayCount = unreadCount > 99 ? "99+" : String(unreadCount)

  // Fetch notifications from server action
  const fetchNotifications = useCallback(async () => {
    try {
      const result = await getNotifications(20)
      if (result.success) {
        setNotifications(result.notifications)
      }
    } catch {
      // Silently ignore — empty state is shown
    }
  }, [])

  // Initial fetch + 60-second polling
  useEffect(() => {
    void fetchNotifications()
    const interval = setInterval(() => {
      void fetchNotifications()
    }, 60_000)
    return () => clearInterval(interval)
  }, [fetchNotifications])

  // Refresh when popover opens
  useEffect(() => {
    if (open) {
      void fetchNotifications()
    }
  }, [open, fetchNotifications])

  const handleMarkAllRead = async () => {
    setLoading(true)
    try {
      const result = await markAllRead()
      if (result.success) {
        setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })))
      }
    } finally {
      setLoading(false)
    }
  }

  const handleClickNotification = async (notification: Notification) => {
    if (!notification.is_read) {
      const result = await markNotificationRead(notification.id).catch(() => ({ success: false as const }))
      if (result.success) {
        setNotifications((prev) =>
          prev.map((n) =>
            n.id === notification.id ? { ...n, is_read: true } : n,
          ),
        )
      }
    }
    setOpen(false)
    const url = resolveNotificationUrl(notification.entity_type, notification.entity_id)
    if (url) router.push(url)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={`Notifications${unreadCount > 0 ? `, ${displayCount} unread` : ""}`}
        >
          <Bell className="w-5 h-5 text-gray-700" />
          {unreadCount > 0 && (
            <span className="absolute -top-1 -right-1 h-5 min-w-[1.25rem] px-1 rounded-full bg-red-500 text-white text-xs flex items-center justify-center font-semibold leading-none">
              {displayCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        className="w-[380px] p-0"
        sideOffset={8}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <h3 className="font-semibold text-sm text-gray-900">
            Notifications
            {unreadCount > 0 && (
              <span className="ml-2 text-xs font-normal text-gray-500">
                {unreadCount} unread
              </span>
            )}
          </h3>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="text-xs text-blue-600 hover:text-blue-700 h-auto py-0.5 px-2"
              onClick={handleMarkAllRead}
              disabled={loading}
            >
              Mark all read
            </Button>
          )}
        </div>

        {/* Notification list */}
        <ScrollArea className="h-[360px]">
          {notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-[320px] text-center px-6">
              <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mb-3">
                <Bell className="w-5 h-5 text-gray-400" />
              </div>
              <p className="text-sm font-medium text-gray-900 mb-1">
                All caught up!
              </p>
              <p className="text-xs text-gray-500">
                You have no new notifications. We&apos;ll let you know when
                something needs your attention.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-gray-50">
              {notifications.map((notification) => (
                <li key={notification.id}>
                  <button
                    className={`w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors flex gap-3 ${
                      !notification.is_read ? "bg-blue-50/40" : ""
                    }`}
                    onClick={() => void handleClickNotification(notification)}
                  >
                    {/* Unread indicator */}
                    <div className="flex flex-col items-center pt-0.5 gap-1">
                      <NotificationIcon type={notification.type} />
                      {!notification.is_read && (
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <p
                          className={`text-sm leading-snug truncate ${
                            !notification.is_read
                              ? "font-semibold text-gray-900"
                              : "font-medium text-gray-700"
                          }`}
                        >
                          {notification.title}
                        </p>
                        <span className="text-xs text-gray-400 whitespace-nowrap shrink-0">
                          {timeAgo(notification.created_at)}
                        </span>
                      </div>
                      {notification.body && (
                        <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">
                          {notification.body}
                        </p>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}
