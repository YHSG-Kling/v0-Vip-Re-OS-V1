"use client"

import Link from "next/link"
import { Phone, MessageSquare, BarChart3, Mic } from "lucide-react"

interface QuickAction {
  label: string
  href: string
  icon: React.ReactNode
  color: string
}

const quickActions: QuickAction[] = [
  {
    label: "Call a Lead",
    href: "/mobile/dialpad",
    icon: <Phone className="h-6 w-6" />,
    color: "bg-emerald-500 text-white",
  },
  {
    label: "Send Update",
    href: "/dashboard/messages",
    icon: <MessageSquare className="h-6 w-6" />,
    color: "bg-blue-500 text-white",
  },
  {
    label: "Check Pipeline",
    href: "/dashboard/pipeline",
    icon: <BarChart3 className="h-6 w-6" />,
    color: "bg-amber-500 text-white",
  },
  {
    label: "Start Voice",
    href: "/mobile/voice",
    icon: <Mic className="h-6 w-6" />,
    color: "bg-purple-500 text-white",
  },
]

export function QuickActionGrid() {
  return (
    <div className="grid grid-cols-2 gap-3">
      {quickActions.map((action) => (
        <Link
          key={action.label}
          href={action.href}
          className={`
            flex flex-col items-center justify-center gap-2
            p-4 rounded-xl min-h-[100px]
            ${action.color}
            active:scale-95 transition-transform
            touch-manipulation
          `}
        >
          {action.icon}
          <span className="text-sm font-medium text-center">{action.label}</span>
        </Link>
      ))}
    </div>
  )
}
