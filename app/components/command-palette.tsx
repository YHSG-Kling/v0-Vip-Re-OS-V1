"use client"

import { useEffect, useState } from "react"
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
import {
  LayoutGrid, Users, Home, FileText, Video, MessageCircle,
  TrendingUp, DollarSign, Settings, Sparkles, BookOpen,
  BarChart3, Share2, GraduationCap, CalendarDays, Shield,
  UserPlus, Activity, Mic
} from "lucide-react"

const NAV_ITEMS = [
  { label: "Dashboard", href: "/dashboard/agent", icon: LayoutGrid, group: "Navigation" },
  { label: "AI Briefing", href: "/dashboard/briefing", icon: Sparkles, group: "Navigation" },
  { label: "My Contacts (CRM)", href: "/crm", icon: Users, group: "Navigation" },
  { label: "My Listings", href: "/dashboard/listings", icon: Home, group: "Navigation" },
  { label: "Transactions", href: "/dashboard/transactions", icon: FileText, group: "Navigation" },
  { label: "Open Houses", href: "/dashboard/open-houses", icon: CalendarDays, group: "Navigation" },
  { label: "Communications Inbox", href: "/dashboard/inbox", icon: MessageCircle, group: "Navigation" },
  { label: "Video Library", href: "/dashboard/videos/library", icon: Video, group: "Navigation" },
  { label: "Social Dashboard", href: "/dashboard/social", icon: Share2, group: "Navigation" },
  { label: "Analytics", href: "/dashboard/analytics", icon: BarChart3, group: "Navigation" },
  { label: "Market Insights", href: "/dashboard/market-insights", icon: TrendingUp, group: "Navigation" },
  { label: "My Financials", href: "/dashboard/financials/agent", icon: DollarSign, group: "Navigation" },
  { label: "Goals Dashboard", href: "/dashboard/goals", icon: Activity, group: "Navigation" },
  { label: "Education Library", href: "/dashboard/education", icon: GraduationCap, group: "Navigation" },
  { label: "Referrals & Reviews", href: "/past-clients?tab=referrals", icon: Users, group: "Navigation" },
  { label: "Content Approvals", href: "/dashboard/content/approvals", icon: Shield, group: "Admin" },
  { label: "Data Health", href: "/dashboard/admin/data-health", icon: Activity, group: "Admin" },
  { label: "AI Usage & Cost", href: "/dashboard/admin/ai-usage", icon: Sparkles, group: "Admin" },
  { label: "Automation Events", href: "/dashboard/admin/events", icon: Activity, group: "Admin" },
  { label: "Agent Onboarding", href: "/dashboard/admin/onboarding", icon: UserPlus, group: "Admin" },
  { label: "Knowledge Base", href: "/dashboard/admin/knowledge", icon: BookOpen, group: "Admin" },
  { label: "Settings", href: "/settings", icon: Settings, group: "Settings" },
  { label: "Brand Voice", href: "/settings/brand-voice", icon: Mic, group: "Settings" },
  { label: "Integrations", href: "/settings/integrations", icon: Settings, group: "Settings" },
]

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const router = useRouter()

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

  const groups = Array.from(new Set(NAV_ITEMS.map(i => i.group)))

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Command Palette" description="Navigate the app">
      <CommandInput placeholder="Search pages and actions..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        {groups.map((group, gi) => (
          <div key={group}>
            {gi > 0 && <CommandSeparator />}
            <CommandGroup heading={group}>
              {NAV_ITEMS.filter(i => i.group === group).map(item => (
                <CommandItem
                  key={item.href}
                  onSelect={() => handleSelect(item.href)}
                  className="gap-2"
                >
                  <item.icon className="h-4 w-4 text-muted-foreground" />
                  {item.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </div>
        ))}
      </CommandList>
    </CommandDialog>
  )
}
