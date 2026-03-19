"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import {
  Settings,
  Palette,
  Users,
  Bell,
  CreditCard,
  Link2,
  DollarSign,
  Building,
  FileText,
  Shield,
} from "lucide-react"

interface SettingsCommandStripProps {
  currentSection?: string
}

const settingsSections = [
  { key: "general", label: "General", href: "/settings/general", icon: Settings },
  { key: "branding", label: "Branding", href: "/settings/branding", icon: Palette },
  { key: "users", label: "Users", href: "/settings/users", icon: Users },
  { key: "notifications", label: "Notifications", href: "/settings/notifications", icon: Bell },
  { key: "billing", label: "Billing", href: "/settings/billing", icon: CreditCard },
  { key: "integrations", label: "Integrations", href: "/dashboard/settings/integrations", icon: Link2 },
  { key: "providers", label: "Providers", href: "/settings/providers", icon: Building },
  { key: "commission", label: "Commission", href: "/settings/commission", icon: DollarSign },
  { key: "accounting", label: "Accounting", href: "/settings/accounting", icon: FileText },
  { key: "compliance", label: "Compliance", href: "/compliance/settings", icon: Shield },
]

export function SettingsCommandStrip({ currentSection }: SettingsCommandStripProps) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-2">
      {settingsSections.map((section) => {
        const Icon = section.icon
        const isActive = currentSection === section.key
        return (
          <Link key={section.key} href={section.href}>
            <Button
              variant={isActive ? "default" : "outline"}
              size="sm"
              className="gap-2 whitespace-nowrap"
            >
              <Icon className="h-4 w-4" />
              {section.label}
            </Button>
          </Link>
        )
      })}
    </div>
  )
}
