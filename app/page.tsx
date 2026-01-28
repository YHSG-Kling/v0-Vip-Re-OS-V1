'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthStore } from '@/stores/authStore'

export default function Page() {
  const router = useRouter()
  const { isAuthenticated, isLoading, user, checkAuth } = useAuthStore()

  // Check auth on mount
  useEffect(() => {
    checkAuth()
  }, [checkAuth])

  useEffect(() => {
    // Wait for auth state to load from localStorage
    if (isLoading) return

    if (isAuthenticated && user) {
      // Redirect to dashboard if authenticated
      router.push('/dashboard')
    } else {
      // Redirect to login if not authenticated
      router.push('/login')
    }
  }, [isAuthenticated, isLoading, user, router])

  // Show loading state while checking auth
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    </div>
  )
}
