"use client"

import type React from "react"
import { AuthProvider } from "@/lib/auth/client"
import { Toaster } from "@/components/ui/toaster"
import { Toaster as SonnerToaster } from "@/app/components/ui/sonner"

interface ProvidersProps {
  children: React.ReactNode
}

export function Providers({ children }: ProvidersProps) {
  return (
    <AuthProvider>
      {children}
      {/* shadcn/ui toast */}
      <Toaster />
      {/* Sonner toast — used by inbox, AI-ISA console, and other modules */}
      <SonnerToaster richColors position="bottom-right" />
    </AuthProvider>
  )
}
