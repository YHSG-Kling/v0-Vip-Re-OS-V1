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
  UserPlus, Activity, Mic,
  // Action-verb icons (additive)
  PenLine, Mail, Phone, Send, FileEdit, Image as ImageIcon,
  Megaphone, Newspaper, Calendar, Plus, Search, Gift,
  ClipboardCheck, AlertTriangle, Inbox as InboxIcon,
  Star, Flame, Target, Headphones, MapPin, Wand2,
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
  { label: "Referrals & Reviews", href: "/lifetime-customers?tab=referrals", icon: Users, group: "Navigation" },
  { label: "Content Approvals", href: "/dashboard/content/approvals", icon: Shield, group: "Admin" },
  { label: "Data Health", href: "/dashboard/admin/data-health", icon: Activity, group: "Admin" },
  { label: "AI Usage & Cost", href: "/dashboard/admin/ai-usage", icon: Sparkles, group: "Admin" },
  { label: "Automation Events", href: "/dashboard/admin/events", icon: Activity, group: "Admin" },
  { label: "Agent Onboarding", href: "/dashboard/admin/onboarding", icon: UserPlus, group: "Admin" },
  { label: "Knowledge Base", href: "/dashboard/settings/knowledge-base", icon: BookOpen, group: "Admin" },
  { label: "Settings", href: "/settings", icon: Settings, group: "Settings" },
  { label: "Brand Voice", href: "/settings/brand-voice", icon: Mic, group: "Settings" },
  { label: "Integrations", href: "/settings/integrations", icon: Settings, group: "Settings" },
]

// ─── Action verbs (additive — separate from NAV_ITEMS) ────────────────────
// Speed-multiplier verbs the agent runs by name. Each navigates to the
// canonical wizard / queue / picker for that action so existing flows handle
// the actual work — no duplicate logic.
const ACTION_ITEMS = [
  // Create
  { label: "Draft offer",                 href: "/crm?action=draft_offer",                                icon: FileEdit,  group: "Create" },
  { label: "Draft listing agreement",     href: "/dashboard/listings/new",                                icon: FileEdit,  group: "Create" },
  { label: "Create new listing",          href: "/dashboard/listings/new",                                icon: Plus,      group: "Create" },
  { label: "Schedule open house",         href: "/dashboard/open-houses?action=new",                      icon: CalendarDays, group: "Create" },
  { label: "Schedule showing",            href: "/crm?action=schedule_showing",                           icon: Calendar,  group: "Create" },
  { label: "Schedule buyer tour",         href: "/crm?action=schedule_tour",                              icon: MapPin,    group: "Create" },
  { label: "Generate CMA",                href: "/dashboard/cma/new",                                     icon: BarChart3, group: "Create" },
  { label: "Compose newsletter",          href: "/dashboard/marketing/newsletter?action=new",             icon: Newspaper, group: "Create" },
  { label: "Compose email campaign",      href: "/dashboard/marketing/email?action=new",                  icon: Mail,      group: "Create" },
  { label: "Compose social post",         href: "/dashboard/social?action=new",                           icon: Share2,    group: "Create" },
  { label: "Generate AI image",           href: "/dashboard/marketing/image?action=new",                  icon: ImageIcon, group: "Create" },
  { label: "Generate AI video",           href: "/dashboard/videos/create",                               icon: Video,     group: "Create" },
  { label: "Record podcast episode",      href: "/dashboard/marketing/podcast?action=new",                icon: Headphones,group: "Create" },
  { label: "Write blog post",             href: "/dashboard/marketing/blog/new",                          icon: PenLine,   group: "Create" },
  { label: "Send direct mail",            href: "/dashboard/campaigns/mail?action=new",                   icon: Send,      group: "Create" },
  { label: "Launch ad campaign",          href: "/dashboard/campaigns/ads?action=new",                    icon: Megaphone, group: "Create" },
  { label: "Send gift",                   href: "/lifetime-customers?action=send_gift",                   icon: Gift,      group: "Create" },
  { label: "Add new contact",             href: "/crm?action=new_contact",                                icon: UserPlus,  group: "Create" },

  // Find — navigates to /crm with a search; the page reads ?q=
  { label: "Find a contact",              href: "/crm?focus=search",                                       icon: Search,    group: "Find" },
  { label: "Find a listing",              href: "/dashboard/listings?focus=search",                        icon: Search,    group: "Find" },
  { label: "Find a transaction",          href: "/dashboard/transactions?focus=search",                    icon: Search,    group: "Find" },

  // Today — segmented dashboards / queues
  { label: "Today's gameplan",            href: "/dashboard/briefing",                                     icon: Sparkles,  group: "Today" },
  { label: "Today's showings",            href: "/dashboard/calendar?filter=showings&day=today",           icon: Calendar,  group: "Today" },
  { label: "Today's appointments",        href: "/dashboard/calendar?day=today",                           icon: CalendarDays, group: "Today" },
  { label: "Today's tours",               href: "/dashboard/calendar?filter=tours&day=today",              icon: MapPin,    group: "Today" },
  { label: "Open inbox",                  href: "/dashboard/inbox",                                        icon: InboxIcon, group: "Today" },

  // Pipeline / segmented queues
  { label: "Hot leads",                   href: "/crm?segment=hot",                                        icon: Flame,     group: "Pipeline" },
  { label: "At-risk contacts",            href: "/crm?segment=at_risk",                                    icon: AlertTriangle, group: "Pipeline" },
  { label: "New contacts (last 7d)",      href: "/crm?segment=new",                                        icon: Plus,      group: "Pipeline" },
  { label: "Likely sellers",              href: "/crm?segment=likely_seller",                              icon: Target,    group: "Pipeline" },
  { label: "Wealth opportunities",        href: "/dashboard/agent?focus=wealth",                           icon: TrendingUp, group: "Pipeline" },
  { label: "Lifetime customers",          href: "/lifetime-customers",                                     icon: Star,      group: "Pipeline" },
  { label: "Pending offers",              href: "/dashboard/transactions?status=pending_offer",            icon: FileText,  group: "Pipeline" },
  { label: "Countered offers",            href: "/dashboard/transactions?status=countered",                icon: FileText,  group: "Pipeline" },
  { label: "Active listings",             href: "/dashboard/listings?status=active",                       icon: Home,      group: "Pipeline" },
  { label: "Coming soon listings",        href: "/dashboard/listings?status=coming_soon",                  icon: Home,      group: "Pipeline" },
  { label: "Closing this week",           href: "/dashboard/transactions?filter=closing_this_week",        icon: ClipboardCheck, group: "Pipeline" },
  { label: "Recently closed",             href: "/dashboard/transactions?status=closed",                   icon: ClipboardCheck, group: "Pipeline" },

  // CDA / Compliance
  { label: "View pending CDAs",           href: "/dashboard/compliance#cda-queue",                         icon: Shield,    group: "CDA" },
  { label: "Compliance violations",       href: "/dashboard/compliance?tab=violations",                    icon: AlertTriangle, group: "CDA" },
  { label: "Approval queue",              href: "/dashboard/content/approvals",                            icon: Shield,    group: "CDA" },

  // Send / Outreach (route navigates to a template-aware composer)
  { label: "Compose with AI (voice)",     href: "/dashboard/agent?action=ai_voice",                        icon: Mic,       group: "Send" },
  { label: "Send touchpoint",             href: "/crm?action=send_touchpoint",                             icon: Wand2,     group: "Send" },
  { label: "Send review request",         href: "/lifetime-customers?action=send_review_request",         icon: Star,      group: "Send" },
  { label: "Send referral request",       href: "/lifetime-customers?action=send_referral_request",       icon: Users,     group: "Send" },
  { label: "Send buyer intake link",      href: "/crm?action=send_buyer_intake",                          icon: Send,      group: "Send" },
  { label: "Make AI call",                href: "/dashboard/isa/calling",                                   icon: Phone,     group: "Send" },

  // Operations
  { label: "Open vendor marketplace",     href: "/dashboard/vendors",                                       icon: Users,     group: "Operations" },
  { label: "Open lender pipeline",        href: "/dashboard/lender",                                        icon: DollarSign,group: "Operations" },
  { label: "Open TC dashboard",           href: "/dashboard/coordinator",                                  icon: ClipboardCheck, group: "Operations" },
  { label: "Open broker dashboard",       href: "/dashboard/admin",                                        icon: BarChart3, group: "Operations" },
  { label: "View commissions",            href: "/dashboard/financials/agent",                              icon: DollarSign,group: "Operations" },
  { label: "View workflow analytics",     href: "/dashboard/admin?widget=workflow_reports",                icon: Activity,  group: "Operations" },
  { label: "View transaction-form library", href: "/dashboard/admin/transaction-forms",                     icon: FileText,  group: "Operations" },
]

// Combined list — preserves NAV_ITEMS order, then ACTION_ITEMS
const ALL_ITEMS = [...NAV_ITEMS, ...ACTION_ITEMS]

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

  // Preserve insertion order — Action groups (Create / Find / Today / Pipeline /
  // CDA / Send / Operations) follow the original Nav / Admin / Settings groups.
  const groups = Array.from(new Set(ALL_ITEMS.map(i => i.group)))

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Command Palette" description="Navigate the app or run an action">
      <CommandInput placeholder="Search pages and actions — try 'draft offer', 'today's showings', 'hot leads'..." />
      <CommandList className="max-h-[60vh]">
        <CommandEmpty>No results found.</CommandEmpty>
        {groups.map((group, gi) => (
          <div key={group}>
            {gi > 0 && <CommandSeparator />}
            <CommandGroup heading={group}>
              {ALL_ITEMS.filter(i => i.group === group).map(item => (
                <CommandItem
                  // Use composite key so identical hrefs across groups don't collide
                  key={`${item.group}::${item.label}::${item.href}`}
                  // Use the label as the searchable value so "draft offer" matches
                  value={`${item.label} ${item.group}`}
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
