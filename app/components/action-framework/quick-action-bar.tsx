"use client"

import Link from "next/link"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

interface ActionItem {
  id: string
  label: string
  icon?: React.ComponentType<{ className?: string }>
  href?: string
  onClick?: () => void | Promise<void>
  variant?: "default" | "outline" | "ghost" | "destructive"
  loading?: boolean
  disabled?: boolean
  badge?: string
}

interface QuickActionBarProps {
  actions: ActionItem[]
  orientation?: "horizontal" | "vertical"
  size?: "sm" | "md"
}

export function QuickActionBar({
  actions,
  orientation = "horizontal",
  size = "sm",
}: QuickActionBarProps) {
  const buttonSize = size === "sm" ? "sm" : "default"

  return (
    <div
      className={cn(
        "flex",
        orientation === "horizontal" ? "flex-row gap-2" : "flex-col gap-1"
      )}
    >
      {actions.map((action) => {
        const Icon = action.icon
        const isLoading = action.loading
        const isDisabled = action.disabled || isLoading

        const buttonContent = (
          <>
            {isLoading ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : Icon ? (
              <Icon className="h-4 w-4 mr-2" />
            ) : null}
            {action.label}
            {action.badge && (
              <Badge variant="secondary" className="ml-2 text-xs">
                {action.badge}
              </Badge>
            )}
          </>
        )

        if (action.href) {
          return (
            <Link key={action.id} href={action.href}>
              <Button
                variant={action.variant || "default"}
                size={buttonSize}
                disabled={isDisabled}
                className={cn(
                  orientation === "vertical" && "w-full justify-start"
                )}
              >
                {buttonContent}
              </Button>
            </Link>
          )
        }

        return (
          <Button
            key={action.id}
            variant={action.variant || "default"}
            size={buttonSize}
            disabled={isDisabled}
            onClick={action.onClick}
            className={cn(
              orientation === "vertical" && "w-full justify-start"
            )}
          >
            {buttonContent}
          </Button>
        )
      })}
    </div>
  )
}
