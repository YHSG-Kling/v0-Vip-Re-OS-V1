'use client'

import { Button } from '@/components/ui/button'
import { NavigationConfig } from '@/app/types/navigation'
import { UserContext } from '@/app/types/roles'
import { GlobalSearch } from './global-search'
import { UserMenu } from './user-menu'
import { NotificationBell } from './notification-bell'
import { Menu, Inbox, Sparkles } from 'lucide-react'
import { useShell } from './shell-context'

interface HeaderProps {
  navigation: NavigationConfig
  userContext: UserContext
}

export function Header({ navigation, userContext }: HeaderProps) {
  const { toggleInbox, toggleAiAssistant, toggleMobileSidebar } = useShell()

  return (
    <header className="border-b border-gray-200 bg-white h-16 flex items-center justify-between px-6">
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          onClick={toggleMobileSidebar}
          aria-label="Toggle navigation"
        >
          <Menu className="w-5 h-5 text-gray-700" />
        </Button>
      </div>
      <div className="flex-1 max-w-md">
        <GlobalSearch />
      </div>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleAiAssistant}
          title="AI Copilot · ask anything"
          aria-label="Open AI assistant"
        >
          <Sparkles className="w-5 h-5 text-gray-700" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleInbox}
          title="Inbox · press U anywhere"
          aria-label="Open inbox"
        >
          <Inbox className="w-5 h-5 text-gray-700" />
        </Button>
        <NotificationBell />
        <UserMenu userContext={userContext} />
      </div>
    </header>
  )
}
