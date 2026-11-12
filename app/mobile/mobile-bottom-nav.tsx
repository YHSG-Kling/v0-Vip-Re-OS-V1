"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Home, Mic, Users, ShieldCheck, HelpCircle } from "lucide-react"

const navItems = [
  {
    label: "Home",
    href: "/mobile/assistant",
    icon: Home,
  },
  {
    label: "Approvals",
    href: "/mobile/approvals",
    icon: ShieldCheck,
  },
  {
    label: "Voice",
    href: "/mobile/voice",
    icon: Mic,
  },
  // Wave 150 (lane 150DAC): this bar is the same for every seat, and "Pipeline" opened /leads — a screen that, by
  // the owner's ruling (leads belong to the BROKERAGE; agents see CONTACTS only), shows an agent only a gate notice.
  // The mobile door every seat may use is its own contacts list (app/mobile/contacts/page.tsx); the lead desk keeps
  // /leads on its full menu.
  {
    label: "Contacts",
    href: "/mobile/contacts",
    icon: Users,
  },
  {
    label: "Help",
    href: "/support",
    icon: HelpCircle,
  },
]

export function MobileBottomNav() {
  const pathname = usePathname()

  return (
    <nav aria-label="Mobile" className="fixed bottom-0 left-0 right-0 z-50 bg-background border-t safe-area-bottom">
      <div className="flex items-center justify-around h-16">
        {navItems.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`)
          const Icon = item.icon

          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive ? "page" : undefined}
              className={`
                flex flex-col items-center justify-center gap-1
                min-w-[64px] min-h-[44px] px-3 py-2
                rounded-lg transition-colors
                ${isActive ? "text-primary" : "text-muted-foreground"}
              `}
            >
              <Icon className={`h-5 w-5 ${isActive ? "stroke-[2.5]" : ""}`} />
              <span className="text-xs font-medium">{item.label}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
