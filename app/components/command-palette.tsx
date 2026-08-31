"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/app/components/ui/command"
import { useAuth } from "@/lib/auth/client"
import { visiblePaletteItems } from "@/app/components/command-palette-items"
import type { LucideIcon } from "lucide-react"
import {
  LayoutGrid, Users, Home, FileText, Video, MessageCircle,
  TrendingUp, DollarSign, Settings, Sparkles, BookOpen,
  BarChart3, Share2, GraduationCap, CalendarDays, Shield,
  UserPlus, Activity, Mic,
  PenLine, Mail, Phone, Send, FileEdit, Image as ImageIcon,
  Megaphone, Newspaper, Calendar, Plus, Search, Gift,
  ClipboardCheck, AlertTriangle, Inbox as InboxIcon,
  Star, Flame, Target, Headphones, MapPin, Wand2,
} from "lucide-react"

// The entry roster and the role-admission logic live in
// app/components/command-palette-items.ts (pure, guard-driven). Entries are
// filtered per user by the SAME navigation config that builds the sidebar —
// getNavigationForRole — so the palette can never show a role a surface its
// nav withholds. FAIL CLOSED: until the user's roles have loaded, the palette
// lists nothing.

/** lucide name → component, matching the icon-name vocabulary of the roster. */
const ICONS: Record<string, LucideIcon> = {
  LayoutGrid, Users, Home, FileText, Video, MessageCircle,
  TrendingUp, DollarSign, Settings, Sparkles, BookOpen,
  BarChart3, Share2, GraduationCap, CalendarDays, Shield,
  UserPlus, Activity, Mic,
  PenLine, Mail, Phone, Send, FileEdit, ImageIcon,
  Megaphone, Newspaper, Calendar, Plus, Search, Gift,
  ClipboardCheck, AlertTriangle, Inbox: InboxIcon,
  Star, Flame, Target, Headphones, MapPin, Wand2,
}

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const { userContext } = useAuth()

  // NO fallback role here (unlike app-shell's crash guard): a user whose roles
  // have not resolved sees an empty palette, not the agent's (§4 fail closed).
  const roles = userContext?.roles
  const items = useMemo(() => visiblePaletteItems(roles), [roles])

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault()
        setOpen(prev => !prev)
      }
    }
    document.addEventListener("keydown", down)
    return () => document.removeEventListener("keydown", down)
  }, [])

  const handleSelect = (href: string) => {
    setOpen(false)
    router.push(href)
  }

  // Preserve insertion order — the role's own Quick Actions lead, then the
  // Nav / Admin / Settings groups, then the action groups (Create / Find /
  // Today / Pipeline / CDA / Content / Send / Operations).
  const groups = Array.from(new Set(items.map(i => i.group)))

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Command Palette" description="Navigate the app or run an action">
      <CommandInput placeholder="Search pages and actions — try 'draft offer', 'hot leads', 'compose newsletter'..." />
      <CommandList className="max-h-[60vh]">
        <CommandEmpty>No results found.</CommandEmpty>
        {groups.map((group, gi) => (
          <div key={group}>
            {gi > 0 && <CommandSeparator />}
            <CommandGroup heading={group}>
              {items.filter(i => i.group === group).map(item => {
                const Icon = ICONS[item.icon] ?? Sparkles
                return (
                  <CommandItem
                    // Composite key so identical hrefs across groups don't collide
                    key={`${item.group}::${item.label}::${item.href}`}
                    // The label is the searchable value so "draft offer" matches
                    value={`${item.label} ${item.group}`}
                    onSelect={() => handleSelect(item.href)}
                    className="gap-2"
                  >
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    {item.label}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </div>
        ))}
      </CommandList>
    </CommandDialog>
  )
}
