'use client'

import React from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { UserContext } from '@/app/types/roles'
import { useRouter } from 'next/navigation'
import { User } from 'lucide-react'

interface UserMenuProps {
  userContext: UserContext
}

export function UserMenu({ userContext }: UserMenuProps) {
  const router = useRouter()

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/login')
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon">
          <User className="w-5 h-5 text-gray-700" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="border-gray-200 bg-white">
        <div className="px-2 py-1.5">
          <p className="text-sm font-medium text-gray-900">{userContext.first_name} {userContext.last_name}</p>
          <p className="text-xs text-gray-600">{userContext.email}</p>
        </div>
        <DropdownMenuSeparator className="bg-gray-200" />
        <DropdownMenuItem onClick={() => router.push('/profile')} className="text-gray-700">
          My Profile
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => router.push('/settings')} className="text-gray-700">
          Settings
        </DropdownMenuItem>
        <DropdownMenuSeparator className="bg-gray-200" />
        <DropdownMenuItem onClick={handleLogout} className="text-gray-700">
          Logout
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
