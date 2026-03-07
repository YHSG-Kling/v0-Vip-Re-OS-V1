'use client'

import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Bell } from 'lucide-react'

export function NotificationBell() {
  const router = useRouter()
  const [unreadCount, setUnreadCount] = useState<number>(0)

  useEffect(() => {
    const fetchUnreadCount = async () => {
      try {
        const res = await fetch('/api/notifications/unread-count')
        if (!res.ok) {
          setUnreadCount(0)
          return
        }
        const data = (await res.json()) as { unread: number }
        setUnreadCount(data.unread)
      } catch {
        setUnreadCount(0)
      }
    }

    void fetchUnreadCount()
  }, [])

  const displayCount = unreadCount > 99 ? '99+' : String(unreadCount)

  return (
    <Button
      variant="ghost"
      size="icon"
      className="relative"
      onClick={() => router.push('/notifications')}
      aria-label={`Notifications${unreadCount > 0 ? `, ${displayCount} unread` : ''}`}
    >
      <Bell className="w-5 h-5 text-gray-700" />
      {unreadCount > 0 && (
        <span className="absolute -top-2 -right-2 h-5 min-w-5 px-0.5 rounded-full bg-red-500 text-white text-xs flex items-center justify-center font-semibold">
          {displayCount}
        </span>
      )}
    </Button>
  )
}
