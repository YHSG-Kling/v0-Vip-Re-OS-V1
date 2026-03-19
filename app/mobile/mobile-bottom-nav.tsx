"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Home, Mic, BarChart3, HelpCircle } from "lucide-react"

const navItems = [
  {
    label: "Home",
    href: "/mobile/assistant",
    icon: Home,
  },
  {
    label: "Voice",
    href: "/mobile/voice",
    icon: Mic,
  },
  {
    label: "Pipeline",
    href: "/leads",
    icon: BarChart3,
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
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-background border-t safe-area-bottom">
      <div className="flex items-center justify-around h-16">
        {navItems.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`)
          const Icon = item.icon

          return (
            <Link
              key={item.href}
              href={item.href}
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
