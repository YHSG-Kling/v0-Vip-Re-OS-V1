"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Settings, User, LogOut, Bell, HelpCircle, ChevronDown } from "lucide-react"
import { signOut } from "@/app/actions/auth"

interface Contact {
  id: string
  first_name?: string
  last_name?: string
  name?: string
  email?: string
  phone?: string
  avatar_url?: string
}

interface PortalUserMenuProps {
  contact: Contact
  contactId: string
}

export default function PortalUserMenu({ contact, contactId }: PortalUserMenuProps) {
  const router = useRouter()
  const [isLoggingOut, setIsLoggingOut] = useState(false)
  const [signOutError, setSignOutError] = useState<string | null>(null)

  const displayName = contact.first_name
    ? `${contact.first_name} ${contact.last_name || ""}`.trim()
    : contact.name || "User"

  const initials = displayName
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2)

  // This used to clear localStorage/sessionStorage and redirect to "/" — it
  // never touched the Supabase session. The portal layout authorises off
  // `supabase.auth.getUser()`, so "Log Out" left the buyer signed in: going
  // back to /portal/<contactId> still worked. On a shared computer that is the
  // whole point of the button, so end the session first and say so if it fails.
  const handleLogout = async () => {
    setIsLoggingOut(true)
    setSignOutError(null)
    const res = await signOut()
    if (!res.success) {
      setSignOutError(res.error)
      setIsLoggingOut(false)
      return
    }
    if (typeof window !== "undefined") {
      localStorage.removeItem("portalContactId")
      sessionStorage.clear()
    }
    router.push("/portal/login")
    router.refresh()
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="flex items-center gap-2 px-2">
          <Avatar className="h-8 w-8">
            <AvatarImage src={contact.avatar_url || "/placeholder.svg"} alt={displayName} />
            <AvatarFallback className="bg-primary text-primary-foreground text-sm">{initials}</AvatarFallback>
          </Avatar>
          <span className="hidden md:inline text-sm font-medium">{displayName}</span>
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          <div className="flex flex-col space-y-1">
            <p className="text-sm font-medium">{displayName}</p>
            {contact.email && <p className="text-xs text-muted-foreground truncate">{contact.email}</p>}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        <DropdownMenuItem asChild>
          <Link href={`/portal/${contactId}/settings`} className="cursor-pointer">
            <User className="mr-2 h-4 w-4" />
            My Profile
          </Link>
        </DropdownMenuItem>

        <DropdownMenuItem asChild>
          <Link href={`/portal/${contactId}/settings`} className="cursor-pointer">
            <Settings className="mr-2 h-4 w-4" />
            Settings
          </Link>
        </DropdownMenuItem>

        <DropdownMenuItem asChild>
          <Link href={`/portal/${contactId}/settings#notifications`} className="cursor-pointer">
            <Bell className="mr-2 h-4 w-4" />
            Notifications
          </Link>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem asChild>
          <Link href={`/portal/${contactId}/help`} className="cursor-pointer">
            <HelpCircle className="mr-2 h-4 w-4" />
            Help & Support
          </Link>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          onClick={handleLogout}
          disabled={isLoggingOut}
          className="text-destructive focus:text-destructive cursor-pointer"
        >
          <LogOut className="mr-2 h-4 w-4" />
          {isLoggingOut ? "Logging out..." : "Log Out"}
        </DropdownMenuItem>
        {signOutError && (
          <p className="px-2 py-1.5 text-xs text-destructive">
            Still signed in — sign out failed: {signOutError}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
