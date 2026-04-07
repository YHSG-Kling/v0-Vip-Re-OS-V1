"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from "@/components/ui/sheet"

interface ActionConfirmSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  actionLabel: string
  onConfirm: () => Promise<void>
  destructive?: boolean
  confirmingLabel?: string
  children?: React.ReactNode
}

export function ActionConfirmSheet({
  open,
  onOpenChange,
  title,
  description,
  actionLabel,
  onConfirm,
  destructive = false,
  confirmingLabel = "Processing...",
  children,
}: ActionConfirmSheetProps) {
  const [confirming, setConfirming] = useState(false)

  const handleConfirm = async () => {
    setConfirming(true)
    try {
      await onConfirm()
      onOpenChange(false)
    } catch (error) {
      console.error("[ActionConfirmSheet] Confirm failed:", error)
    } finally {
      setConfirming(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>

        {children && <div className="py-4">{children}</div>}

        <SheetFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={confirming}
          >
            Cancel
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            onClick={handleConfirm}
            disabled={confirming}
          >
            {confirming ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {confirmingLabel}
              </>
            ) : (
              actionLabel
            )}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
