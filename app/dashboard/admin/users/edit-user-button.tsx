"use client"

import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"

export function EditUserButton({ userId }: { userId: string }) {
  const router = useRouter()
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => router.push(`/dashboard/admin/users/${userId}`)}
    >
      Edit
    </Button>
  )
}
