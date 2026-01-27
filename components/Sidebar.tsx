"use client"

import type React from "react"
import { UserRole } from "../types"
import { usePermissions } from "../hooks/usePermissions"
import { ROLE_NAVIGATION } from "../services/permissionsService"
import {
  LayoutDashboard,
  Users,
  Briefcase,
  MessageSquare,
  FileText,
  Settings,
  BarChart3,
  LogOut,
  BrainCircuit,
  PlusCircle,
  Handshake,
  Heart,
  Activity,
  Globe,
  ListTodo,
  BookOpen,
  ShieldAlert,
  ShieldCheck,
  Megaphone,
  Calendar,
  HeartPulse,
  GitMerge,
  Key,
  CheckCircle2,
  Share2,
  Tags,
  Clock,
  ImageIcon,
  Navigation,
  Wand2,
  UserPlus,
  DollarSign,
  Sparkles,
  Home,
  Target,
  TrendingUp,
  Sliders,
  CalendarDays, // Import CalendarDays
  Bell, // Import Bell
  ClipboardList, // Import ClipboardList
  Phone, // Import Phone
  PhoneCall, // Import PhoneCall
  GraduationCap, // Import GraduationCap
} from "lucide-react"

interface SidebarProps {
  role: UserRole
  onChangeView: (view: string) => void
  currentView: string
  onLogout: () => void
}

const ALL_NAV_ITEMS: Record<string, { label: string; icon: any }> = {
  "broker-dashboard": { label: "Command Center", icon: LayoutDashboard },
  "agent-dashboard": { label: "My Command Desk", icon: LayoutDashboard },
  "ai-tools": { label: "AI Tools Suite", icon: Sparkles },
  crm: { label: "CRM & Contacts Management", icon: Users },
  "lead-intelligence": { label: "Lead Intelligence", icon: Target },
  "lead-insights": { label: "Lead Insights", icon: TrendingUp },
  "lead-scraping-config": { label: "Lead Scraping Settings", icon: Sliders },
  "agent-roster": { label: "Agent Roster", icon: Users },
  "recruiting-hub": { label: "Expansion Hub", icon: UserPlus },
  financials: { label: "Financials", icon: DollarSign },
  "risk-management": { label: "Risk & Legal", icon: ShieldAlert },
  "listing-approvals": { label: "Compliance Queue", icon: CheckCircle2 },
  "ai-audit": { label: "AI Audit", icon: BrainCircuit },
  "conversation-analytics": { label: "Conversation Analytics", icon: MessageSquare },
  "vendor-compliance": { label: "Vendor Governance", icon: ShieldCheck },
  "system-health": { label: "System Vitals", icon: HeartPulse },
  "lead-distribution": { label: "Lead Routing", icon: GitMerge },
  segmentation: { label: "Segmentation", icon: Tags },
  "data-health": { label: "Data Health", icon: Activity },
  settings: { label: "Settings", icon: Settings },
  transactions: { label: "Transactions", icon: Briefcase },
  "map-intelligence": { label: "Market Map", icon: Globe },
  "knowledge-base": { label: "Knowledge Base", icon: BookOpen },
  events: { label: "Events", icon: CalendarDays }, // Use CalendarDays
  "listing-intake": { label: "New Listing", icon: PlusCircle },
  "offer-lab": { label: "Offer Lab", icon: Wand2 },
  calendar: { label: "Calendar", icon: Calendar },
  showings: { label: "Showings", icon: Clock },
  "buyer-tours": { label: "Buyer Tours", icon: Navigation },
  "feedback-log": { label: "Feedback", icon: ClipboardList },
  playbook: { label: "Journey Playbook", icon: ListTodo },
  "agent-onboarding": { label: "My Onboarding", icon: GraduationCap },
  "voice-call-bridge": { label: "Voice Call Bridge", icon: Phone },
  "ai-isa": { label: "AI Inside Sales Agent", icon: PhoneCall },
  "content-studio": { label: "Content & Marketing Studio", icon: Megaphone },
  "social-planner": { label: "Social Planner", icon: ImageIcon },
  sphere: { label: "Sphere & SOI", icon: Heart },
  documents: { label: "Documents", icon: FileText },
  marketplace: { label: "Marketplace", icon: Handshake },
  inbox: { label: "Inbox", icon: MessageSquare },
  approvals: { label: "Items for Approval", icon: Target },
  "oh-manager": { label: "Open Houses", icon: Home },
  "closing-dashboard": { label: "Closing", icon: Key },
  cma: { label: "CMA Tool", icon: TrendingUp },
  partners: { label: "Partners", icon: Handshake },
  compliance: { label: "Compliance", icon: ShieldCheck },
  notifications: { label: "Notifications", icon: Bell },
  "shareable-assets": { label: "Share Assets", icon: Share2 },
  "user-management": { label: "User Management", icon: Users },
  "tc-dashboard": { label: "TC Dashboard", icon: Briefcase },
  "listing-distribution": { label: "Listing Distribution", icon: Share2 },
  "buyer-dashboard": { label: "Home Search", icon: Home },
  matches: { label: "Smart Matches", icon: Sparkles },
  "home-value": { label: "Home Value", icon: TrendingUp },
  "seller-dashboard": { label: "Seller Dashboard", icon: BarChart3 },
  "listing-journey": { label: "Listing Journey", icon: Activity },
  "ai-chat": { label: "Smart Engine Chat", icon: MessageSquare },
}

const Sidebar: React.FC<SidebarProps> = ({ role, onChangeView, currentView, onLogout }) => {
  const { allowedNavigation, isAdminOrBroker } = usePermissions()

  // Define navigation sections for admin/broker roles
  const ADMIN_SECTIONS = {
    "Dashboard & Overview": ["broker-dashboard", "system-health", "ai-audit"],
    "Team Management": ["agent-roster", "recruiting-hub", "user-management"],
    "Lead & Contact Management": ["crm", "lead-intelligence", "lead-distribution", "lead-scraping-config", "segmentation"],
    "Listing Operations": ["listing-approvals", "listing-distribution"],
    "Analytics & Reporting": ["financials", "conversation-analytics", "data-health"],
    "Compliance & Risk": ["compliance", "risk-management", "vendor-compliance"],
    "System & Settings": ["settings", "partners"],
  }

  const AGENT_SECTIONS = {
    "Dashboard": ["agent-dashboard"],
    "Core Workflow": ["crm", "transactions", "calendar", "inbox", "approvals"],
    "Listings & Showings": ["listing-intake", "oh-manager", "showings", "buyer-tours", "feedback-log"],
    "Client Tools": ["offer-lab", "cma", "closing-dashboard"],
    "Marketing & Content": ["content-studio", "social-planner", "shareable-assets"],
    "AI & Intelligence": ["ai-tools", "lead-intelligence", "ai-isa", "ai-chat", "voice-call-bridge"],
    "Resources": ["documents", "sphere", "map-intelligence", "knowledge-base", "events"],
    "Personal": ["agent-onboarding", "financials"],
  }

  const getNavItemsWithSections = () => {
    const allowedViews = ROLE_NAVIGATION[role] || []
    const sections = role === UserRole.AGENT ? AGENT_SECTIONS : ADMIN_SECTIONS
    const result: Array<{ type: 'section' | 'item'; title?: string; id?: string; label?: string; icon?: any }> = []

    for (const [sectionTitle, sectionItems] of Object.entries(sections)) {
      const filteredItems = sectionItems.filter(viewId => 
        allowedViews.includes(viewId) && ALL_NAV_ITEMS[viewId]
      )
      
      if (filteredItems.length > 0) {
        result.push({ type: 'section', title: sectionTitle })
        filteredItems.forEach(viewId => {
          result.push({
            type: 'item',
            id: viewId,
            label: ALL_NAV_ITEMS[viewId].label,
            icon: ALL_NAV_ITEMS[viewId].icon,
          })
        })
      }
    }

    return result
  }

  const getRoleLabel = () => {
    switch (role) {
      case UserRole.ADMIN:
        return "ADMIN"
      case UserRole.BROKER:
        return "BROKER"
      case UserRole.AGENT:
        return "AGENT"
      case UserRole.TC:
        return "TC"
      case UserRole.CONTACT:
        return "CLIENT"
      default:
        return role.replace("_", " ").toUpperCase()
    }
  }

  const getNavItems = () => {
    return getNavItemsWithSections().filter(item => item.type === 'item');
  }

  return (
    <div className="h-screen w-64 bg-slate-900 text-white flex flex-col fixed left-0 top-0 border-r border-slate-800 z-40">
      <div className="p-6 flex items-center gap-2">
        <div className="w-8 h-8 bg-blue-50 rounded-lg flex items-center justify-center">
          <BrainCircuit className="w-5 h-5 text-blue-700" />
        </div>
        <div>
          <h1 className="font-bold text-lg tracking-tight uppercase">VIP AGENTS</h1>
          <p className="text-[10px] font-black text-blue-400 uppercase tracking-widest">Smart Engine</p>
        </div>
      </div>

      <nav className="flex-1 px-4 space-y-1 overflow-y-auto scrollbar-hide">
        <div className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] mb-4 px-4 pt-4 border-t border-slate-800">
          {getRoleLabel()} CONSOLE
        </div>
        {getNavItemsWithSections().map((item, index) => {
          if (item.type === 'section') {
            return (
              <div key={`section-${index}`} className="text-[9px] font-black text-slate-600 uppercase tracking-wider px-4 pt-4 pb-2 mt-2">
                {item.title}
              </div>
            )
          } else {
            const Icon = item.icon
            const isActive = currentView === item.id
            return (
              <button
                key={item.id}
                onClick={() => onChangeView(item.id!)}
                className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-[11px] font-bold transition-all ${
                  isActive
                    ? "bg-blue-700 text-white shadow-lg shadow-blue-950/50"
                    : "text-slate-400 hover:bg-slate-800 hover:text-white"
                }`}
              >
                <Icon size={16} />
                {item.label}
              </button>
            )
          }
        })}
      </nav>

      <div className="p-6 border-t border-slate-800">
        <button
          onClick={onLogout}
          className="w-full flex items-center gap-3 px-4 py-2 text-xs font-bold text-slate-500 hover:text-white transition-colors"
        >
          <LogOut size={18} />
          Log Out
        </button>
      </div>
    </div>
  )
}

export default Sidebar
