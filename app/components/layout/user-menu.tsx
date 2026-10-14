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
import { signOut } from '@/app/actions/auth'

interface UserMenuProps {
  userContext: UserContext
}

export function UserMenu({ userContext }: UserMenuProps) {
  const router = useRouter()
  const [signOutError, setSignOutError] = React.useState<string | null>(null)

  // This used to POST /api/auth/logout, which cleared two cookies named
  // `auth-token` and `supabase-auth-token`. Supabase SSR keeps the session in
  // `sb-<ref>-auth-token`, so NEITHER cookie was the session: the user was
  // bounced to /login while still fully signed in, and could walk straight back
  // into the dashboard. Sign out for real, and only claim it when it worked.
  const handleLogout = async () => {
    setSignOutError(null)
    const res = await signOut()
    if (!res.success) {
      setSignOutError(res.error)
      return
    }
    router.push('/login')
    router.refresh()
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
          <p className="text-sm font-medium text-gray-900">{userContext.firstName} {userContext.lastName}</p>
          <p className="text-xs text-gray-600">{userContext.email}</p>
        </div>
        <DropdownMenuSeparator className="bg-gray-200" />
        <DropdownMenuItem onClick={() => router.push('/dashboard/profile')} className="text-gray-700">
          My Profile
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => router.push('/settings')} className="text-gray-700">
          Settings
        </DropdownMenuItem>
        <DropdownMenuSeparator className="bg-gray-200" />
        <DropdownMenuItem onClick={handleLogout} className="text-gray-700">
          Logout
        </DropdownMenuItem>
        {signOutError && (
          <p className="px-2 py-1.5 text-xs text-red-600">
            Still signed in — sign out failed: {signOutError}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
