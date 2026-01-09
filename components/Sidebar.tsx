"use client"

import type React from "react"
import { UserRole } from "../types"
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
  MessageCircle,
  TrendingUp,
  ImageIcon,
  Navigation,
  Wand2,
  UserPlus,
  DollarSign,
  Sparkles,
  Bot,
} from "lucide-react"

interface SidebarProps {
  role: UserRole
  onChangeView: (view: string) => void
  currentView: string
  onLogout: () => void
}

const Sidebar: React.FC<SidebarProps> = ({ role, onChangeView, currentView, onLogout }) => {
  const getNavItems = () => {
    switch (role) {
      case UserRole.BROKER:
      case UserRole.ADMIN:
        return [
          { id: "broker-dashboard", label: "Command Center", icon: LayoutDashboard },
          { id: "ai-tools", label: "All AI Master Tools", icon: Sparkles },
          { id: "crm", label: "CRM & User Management", icon: Users }, // consolidated from Identity Governance, Contact Intelligence, and Global Lead Stack
          { id: "agents", label: "Agent Roster", icon: Users },
          { id: "recruiting-hub", label: "Expansion Hub", icon: UserPlus },
          { id: "financials", label: "Brokerage Earnings", icon: DollarSign },
          { id: "risk-management", label: "Risk & Legal Control", icon: ShieldAlert },
          { id: "listing-approvals", label: "Compliance Queue", icon: CheckCircle2 },
          { id: "ai-audit", label: "AI Quality Audit", icon: BrainCircuit },
          { id: "vendor-compliance", label: "Vendor Governance", icon: ShieldCheck },
          { id: "system-health", label: "System Vitals", icon: HeartPulse },
          { id: "lead-distribution", label: "Routing Engine", icon: GitMerge },
          { id: "segmentation", label: "Tagging Architect", icon: Tags },
          { id: "data-health", label: "Database Hygiene", icon: Activity },
          { id: "settings", label: "Global OS Config", icon: Settings },
          { id: "transactions", label: "Global Pipeline", icon: Briefcase },
          { id: "map-intelligence", label: "Global Market Map", icon: Globe },
          { id: "knowledge-base", label: "Master Script Vault", icon: BookOpen },
          { id: "events", label: "Company Events", icon: Calendar },
        ]
      case UserRole.AGENT:
        return [
          { id: "agent-dashboard", label: "My Command Desk", icon: LayoutDashboard },
          { id: "ai-tools", label: "Agent AI Suite", icon: Sparkles },
          { id: "crm", label: "My CRM", icon: Users }, // single CRM item for agents with only their assigned contacts
          { id: "transactions", label: "My Active Deals", icon: Briefcase },
          { id: "financials", label: "My Commission Lab", icon: DollarSign },
          { id: "listing-intake", label: "New Listing Protocol", icon: PlusCircle },
          { id: "offer-lab", label: "Smart Offer Lab", icon: Wand2 },
          { id: "calendar", label: "My Availability", icon: Calendar },
          { id: "showings", label: "Tour Coordinator", icon: Clock },
          { id: "buyer-tours", label: "Live Field Routes", icon: Navigation },
          { id: "feedback-log", label: "Showing Feedback", icon: MessageCircle },
          { id: "playbook", label: "Client Journey Mgr", icon: ListTodo },
          { id: "marketing", label: "Marketing Studio", icon: Megaphone },
          { id: "social-scheduler", label: "Social Auto-Pilot", icon: ImageIcon },
          { id: "recruiting-hub", label: "Refer an Agent", icon: UserPlus },
          { id: "knowledge-base", label: "My Script Trainer", icon: BookOpen },
          { id: "sphere", label: "Sphere & Reviews", icon: Heart },
          { id: "documents", label: "My Deal Vault", icon: FileText },
          { id: "marketplace", label: "Preferred Partners", icon: Handshake },
          { id: "inbox", label: "Unified Comms", icon: MessageSquare },
        ]
      case UserRole.BUYER:
        return [
          { id: "buyer-dashboard", label: "My Home Search", icon: LayoutDashboard },
          { id: "matches", label: "Smart Matches", icon: Sparkles },
          { id: "ai-tools", label: "Buyer Decision AI", icon: Bot },
          { id: "playbook", label: "Purchase Roadmap", icon: ListTodo },
          { id: "financials", label: "Mortgage & Costs", icon: DollarSign },
          { id: "closing-dashboard", label: "Moving Guide", icon: Key },
          { id: "marketplace", label: "Trusted Partners", icon: Handshake },
          { id: "documents", label: "My Secure Docs", icon: FileText },
        ]
      case UserRole.SELLER:
        return [
          { id: "listing-journey", label: "My Listing Journey", icon: Activity },
          { id: "home-value", label: "Asset Valuation", icon: TrendingUp },
          { id: "seller-dashboard", label: "Market Performance", icon: BarChart3 },
          { id: "ai-tools", label: "Seller Strategy AI", icon: Bot },
          { id: "playbook", label: "Sale Roadmap", icon: ListTodo },
          { id: "financials", label: "Net Proceeds Lab", icon: DollarSign },
          { id: "shareable-assets", label: "Share Success", icon: Share2 },
          { id: "closing-dashboard", label: "Closing Logistics", icon: Key },
          { id: "showings", label: "Showing Feedback", icon: Users },
          { id: "documents", label: "Transaction Docs", icon: FileText },
        ]
      default:
        return []
    }
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

      <nav className="flex-1 px-4 space-y-2 overflow-y-auto scrollbar-hide">
        <div className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] mb-4 px-4 pt-4 border-t border-slate-800">
          {role.replace("_", " ")} CONSOLE
        </div>
        {getNavItems().map((item) => {
          const Icon = item.icon
          const isActive = currentView === item.id
          return (
            <button
              key={item.id}
              onClick={() => onChangeView(item.id)}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-[11px] font-bold transition-all ${
                isActive
                  ? "bg-blue-700 text-white shadow-xl shadow-blue-950/50 scale-[1.02]"
                  : "text-slate-400 hover:bg-slate-800 hover:text-white"
              }`}
            >
              <Icon size={16} />
              {item.label}
            </button>
          )
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
