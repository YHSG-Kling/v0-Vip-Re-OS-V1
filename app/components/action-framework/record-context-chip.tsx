"use client"

import Link from "next/link"
import { User, FileText, Home, Zap, ArrowRight } from "lucide-react"
import { cn } from "@/lib/utils"

interface RecordContextChipProps {
  type: "contact" | "transaction" | "listing" | "lead"
  id: string
  label: string
  sublabel?: string
  href: string
}

const typeIcons = {
  contact: User,
  transaction: FileText,
  listing: Home,
  lead: Zap,
}

const typeColors = {
  contact: "bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100",
  transaction: "bg-green-50 text-green-700 border-green-200 hover:bg-green-100",
  listing: "bg-purple-50 text-purple-700 border-purple-200 hover:bg-purple-100",
  lead: "bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100",
}

export function RecordContextChip({
  type,
  id,
  label,
  sublabel,
  href,
}: RecordContextChipProps) {
  const Icon = typeIcons[type]
  const colorClass = typeColors[type]

  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-sm transition-colors",
        colorClass
      )}
    >
      <Icon className="h-4 w-4 flex-shrink-0" />
      <span className="font-medium truncate max-w-[150px]">{label}</span>
      {sublabel && (
        <span className="text-xs opacity-75 truncate max-w-[100px]">{sublabel}</span>
      )}
      <ArrowRight className="h-3 w-3 flex-shrink-0 opacity-50" />
    </Link>
  )
}
