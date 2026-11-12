"use client"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { User, Phone, Home, FileText, Users, LayoutGrid } from "lucide-react"

export type CalendarRole = "all" | "agent" | "isa" | "listing" | "transaction" | "buyer"

interface CalendarRoleFilterBarProps {
  activeRole: CalendarRole
  onRoleChange: (role: CalendarRole) => void
}

const ROLES: { value: CalendarRole; label: string; icon: typeof User; description: string }[] = [
  { value: "all", label: "All Events", icon: LayoutGrid, description: "View everything" },
  { value: "agent", label: "Agent", icon: User, description: "Full agent calendar" },
  // Lane 88B (owner, wave 88: "Isa is a system ai ai isa."): this lens shows what the AI ISA booked
  // (isa_appointment / listing_appointment) plus follow-ups — a view OF the AI's work for the humans
  // who own the calendar, not a human ISA seat's personal calendar.
  { value: "isa", label: "AI ISA", icon: Phone, description: "Booked by the AI ISA & follow-ups" },
  { value: "listing", label: "Listings", icon: Home, description: "Showings & open houses" },
  { value: "transaction", label: "Transactions", icon: FileText, description: "Inspections, appraisals, closings" },
  { value: "buyer", label: "Buyers", icon: Users, description: "Tours & buyer meetings" },
]

export function CalendarRoleFilterBar({ activeRole, onRoleChange }: CalendarRoleFilterBarProps) {
  return (
    <div className="flex flex-wrap gap-2 p-1 bg-muted/50 rounded-lg">
      {ROLES.map((role) => {
        const Icon = role.icon
        const isActive = activeRole === role.value
        return (
          <Button
            key={role.value}
            variant={isActive ? "default" : "ghost"}
            size="sm"
            onClick={() => onRoleChange(role.value)}
            className={cn(
              "flex items-center gap-1.5 text-xs",
              isActive && "shadow-sm"
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            <span>{role.label}</span>
          </Button>
        )
      })}
    </div>
  )
}
