"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  AlertCircle, AlertTriangle, ShieldAlert, Clock, Search,
  CheckSquare, Flag, Calendar, GraduationCap, Gift, Banknote, ArrowRight,
} from "lucide-react"
import type { OverdueCategory, OverdueItem, OverdueSeverity, OverdueSummary } from "@/app/actions/overdue"

interface Props {
  summary: OverdueSummary
}

const CATEGORY_META: Record<OverdueCategory, { label: string; icon: React.ReactElement }> = {
  task:         { label: "Tasks",         icon: <CheckSquare className="h-3.5 w-3.5" /> },
  milestone:    { label: "Milestones",    icon: <Flag className="h-3.5 w-3.5" /> },
  deadline:     { label: "Deadlines",     icon: <Calendar className="h-3.5 w-3.5" /> },
  license:      { label: "Licenses",      icon: <GraduationCap className="h-3.5 w-3.5" /> },
  gift:         { label: "Gifts",         icon: <Gift className="h-3.5 w-3.5" /> },
  pre_approval: { label: "Pre-approvals", icon: <Banknote className="h-3.5 w-3.5" /> },
}

const SEVERITY_META: Record<OverdueSeverity, { label: string; color: string; icon: React.ReactElement }> = {
  critical: { label: "Critical", color: "bg-red-100 text-red-800 border-red-200", icon: <AlertCircle className="h-3 w-3" /> },
  high:     { label: "High",     color: "bg-orange-100 text-orange-800 border-orange-200", icon: <AlertTriangle className="h-3 w-3" /> },
  medium:   { label: "Medium",   color: "bg-amber-100 text-amber-800 border-amber-200", icon: <ShieldAlert className="h-3 w-3" /> },
  low:      { label: "Low",      color: "bg-slate-100 text-slate-700 border-slate-200", icon: <Clock className="h-3 w-3" /> },
}

export function OverdueClient({ summary }: Props) {
  const [search, setSearch] = useState("")
  const [activeCategory, setActiveCategory] = useState<OverdueCategory | "all">("all")
  const [severityFilter, setSeverityFilter] = useState<OverdueSeverity | "all">("all")

  const filtered = useMemo(() => {
    return summary.items.filter((it) => {
      if (activeCategory !== "all" && it.category !== activeCategory) return false
      if (severityFilter !== "all" && it.severity !== severityFilter) return false
      if (search.trim()) {
        const q = search.trim().toLowerCase()
        return it.title.toLowerCase().includes(q) || it.description.toLowerCase().includes(q)
      }
      return true
    })
  }, [summary.items, activeCategory, severityFilter, search])

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <AlertCircle className="h-6 w-6 text-red-600" />
          Overdue
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Everything that's late, in one place. Tasks, deadlines, licenses, gifts, pre-approvals.
        </p>
      </div>

      {/* Top stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Total Overdue" value={summary.totalCount} />
        <StatCard label="Critical" value={summary.criticalCount} variant="danger" />
        <StatCard label="Categories" value={Object.values(summary.byCategory).filter((v) => v > 0).length} />
        <StatCard
          label="Showing"
          value={filtered.length}
        />
      </div>

      {/* Search + severity */}
      <Card>
        <CardContent className="p-3 flex items-center gap-2 flex-wrap">
          <div className="flex-1 min-w-[200px] relative">
            <Search className="h-4 w-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search titles or descriptions…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-9 text-sm"
            />
          </div>
          <div className="flex gap-1">
            {(["all", "critical", "high", "medium", "low"] as const).map((s) => (
              <Button
                key={s}
                size="sm"
                variant={severityFilter === s ? "default" : "outline"}
                className="h-8 text-xs capitalize"
                onClick={() => setSeverityFilter(s as any)}
              >
                {s}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Two-column: category sidebar + items */}
      <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-6">
        <div className="space-y-1">
          <CategoryButton
            label="All"
            count={summary.totalCount}
            active={activeCategory === "all"}
            onClick={() => setActiveCategory("all")}
          />
          {Object.entries(CATEGORY_META).map(([cat, meta]) => {
            const count = summary.byCategory[cat as OverdueCategory] ?? 0
            return (
              <CategoryButton
                key={cat}
                icon={meta.icon}
                label={meta.label}
                count={count}
                active={activeCategory === cat}
                disabled={count === 0}
                onClick={() => setActiveCategory(cat as OverdueCategory)}
              />
            )
          })}
        </div>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              {activeCategory === "all" ? "All Items" : CATEGORY_META[activeCategory].label}
              <span className="text-muted-foreground font-normal ml-2">({filtered.length})</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {filtered.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-12">
                {summary.totalCount === 0
                  ? "Nothing is overdue. Nice work."
                  : "No items match your filters."}
              </p>
            ) : (
              <div className="divide-y">
                {filtered.map((item) => (
                  <ItemRow key={item.id} item={item} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function StatCard({
  label, value, variant,
}: { label: string; value: number; variant?: "danger" }) {
  return (
    <Card>
      <CardContent className="p-3 text-center">
        <p className={`text-2xl font-bold ${variant === "danger" ? "text-red-600" : "text-gray-900"}`}>
          {value}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
      </CardContent>
    </Card>
  )
}

function CategoryButton({
  icon, label, count, active, onClick, disabled,
}: {
  icon?: React.ReactElement
  label: string
  count: number
  active: boolean
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full flex items-center justify-between px-3 py-2 rounded text-sm transition-colors ${
        active
          ? "bg-red-50 text-red-900 font-medium"
          : disabled
          ? "text-muted-foreground/50 cursor-not-allowed"
          : "hover:bg-gray-50"
      }`}
    >
      <span className="flex items-center gap-2">
        {icon}
        {label}
      </span>
      <span className={`text-xs ${count > 0 && !active ? "text-muted-foreground" : ""}`}>{count}</span>
    </button>
  )
}

function ItemRow({ item }: { item: OverdueItem }) {
  const sev = SEVERITY_META[item.severity]
  return (
    <Link
      href={item.href}
      className="px-4 py-3 flex items-start justify-between gap-3 hover:bg-gray-50 transition-colors block"
    >
      <div className="flex items-start gap-3 min-w-0 flex-1">
        {CATEGORY_META[item.category].icon}
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm">{item.title}</p>
          {item.description && (
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{item.description}</p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Badge variant="outline" className={`text-xs flex items-center gap-1 ${sev.color}`}>
          {sev.icon}
          {item.daysOverdue > 0 ? `${item.daysOverdue}d late` : sev.label}
        </Badge>
        <ArrowRight className="h-4 w-4 text-muted-foreground" />
      </div>
    </Link>
  )
}
