'use client'

import React from 'react'
import { Button } from '@/components/ui/button'
import { Bell } from 'lucide-react'

export function NotificationBell() {
  const notificationCount = 3

  return (
    <Button variant="ghost" size="icon" className="relative">
      <Bell className="w-5 h-5 text-gray-700" />
      {notificationCount > 0 && (
        <span className="absolute -top-2 -right-2 h-5 w-5 rounded-full bg-red-500 text-white text-xs flex items-center justify-center font-semibold">
          {notificationCount}
        </span>
      )}
    </Button>
  )
}
