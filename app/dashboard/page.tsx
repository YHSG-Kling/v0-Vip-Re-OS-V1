'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthStore } from '@/stores/authStore'
import { UserRole } from '@/types'
import Sidebar from '@/app/components/Sidebar'
import LoadingSpinner from '@/app/components/LoadingSpinner'

export default function DashboardPage() {
  const router = useRouter()
  const { user, isLoading, logout, checkAuth } = useAuthStore()
  const [greeting, setGreeting] = useState('')
  const [currentTime, setCurrentTime] = useState(new Date())

  // Check auth on mount
  useEffect(() => {
    checkAuth()
  }, [checkAuth])

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!isLoading && !user) {
      router.push('/login')
    }
  }, [user, isLoading, router])

  // Set greeting based on time of day
  useEffect(() => {
    const hour = new Date().getHours()
    if (hour < 12) {
      setGreeting('Good morning')
    } else if (hour < 18) {
      setGreeting('Good afternoon')
    } else {
      setGreeting('Good evening')
    }
  }, [])

  // Update current time every minute
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 60000)
    return () => clearInterval(timer)
  }, [])

  const handleLogout = async () => {
    // Clear auth token cookie
    await fetch('/api/auth/logout', {
      method: 'POST',
    })
    
    // Clear local state and redirect
    logout()
    router.push('/login')
  }

  // Show loading spinner while checking auth
  if (isLoading) {
    return <LoadingSpinner fullScreen size="lg" text="Loading your dashboard..." />
  }

  // If no user after loading, show nothing (will redirect)
  if (!user) {
    return null
  }

  const userRole = user.role as UserRole
  const firstName = user.name.split(' ')[0]

  return (
    <div className="flex min-h-screen bg-slate-950">
      {/* Sidebar Component */}
      <Sidebar role={userRole} onLogout={handleLogout} />

      {/* Main Content Area */}
      <main className="ml-64 flex-1 p-8">
        {/* Welcome Section */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-white mb-2">
            {greeting}, {firstName}!
          </h1>
          <p className="text-slate-400 text-lg">
            Welcome to your Smart Engine VIP Agents dashboard
          </p>
          <p className="text-slate-500 text-sm mt-1">
            {currentTime.toLocaleDateString("en-US", {
              weekday: "long",
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </p>
        </div>

        {/* Role Badge */}
        <div className="mb-8">
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600/20 border border-blue-600/30 rounded-lg">
            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
            <span className="text-blue-400 font-semibold text-sm uppercase tracking-wider">
              {user.role.replace('_', ' ')}
            </span>
          </div>
        </div>

        {/* Dashboard Content Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {/* Quick Stats Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 hover:border-blue-600/50 transition-colors">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-white font-semibold">Quick Stats</h3>
              <div className="w-8 h-8 bg-blue-600/20 rounded-lg flex items-center justify-center">
                <svg className="w-4 h-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
              </div>
            </div>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-slate-400 text-sm">Active Tasks</span>
                <span className="text-white font-bold">12</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-400 text-sm">Pending Items</span>
                <span className="text-white font-bold">5</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-400 text-sm">This Week</span>
                <span className="text-green-500 font-bold">+24%</span>
              </div>
            </div>
          </div>

          {/* Recent Activity Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 hover:border-blue-600/50 transition-colors">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-white font-semibold">Recent Activity</h3>
              <div className="w-8 h-8 bg-blue-600/20 rounded-lg flex items-center justify-center">
                <svg className="w-4 h-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
            </div>
            <div className="space-y-3">
              <div className="flex items-start gap-3">
                <div className="w-2 h-2 bg-blue-500 rounded-full mt-1.5" />
                <div>
                  <p className="text-white text-sm">New lead assigned</p>
                  <p className="text-slate-500 text-xs">2 hours ago</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-2 h-2 bg-green-500 rounded-full mt-1.5" />
                <div>
                  <p className="text-white text-sm">Task completed</p>
                  <p className="text-slate-500 text-xs">5 hours ago</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-2 h-2 bg-yellow-500 rounded-full mt-1.5" />
                <div>
                  <p className="text-white text-sm">Document pending review</p>
                  <p className="text-slate-500 text-xs">1 day ago</p>
                </div>
              </div>
            </div>
          </div>

          {/* Notifications Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 hover:border-blue-600/50 transition-colors">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-white font-semibold">Notifications</h3>
              <div className="w-8 h-8 bg-blue-600/20 rounded-lg flex items-center justify-center relative">
                <svg className="w-4 h-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
                <div className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full border-2 border-slate-900" />
              </div>
            </div>
            <div className="space-y-3">
              <div className="p-3 bg-slate-800/50 rounded-lg">
                <p className="text-white text-sm mb-1">New message from client</p>
                <p className="text-slate-400 text-xs">Check your inbox</p>
              </div>
              <div className="p-3 bg-slate-800/50 rounded-lg">
                <p className="text-white text-sm mb-1">Upcoming showing</p>
                <p className="text-slate-400 text-xs">Tomorrow at 2:00 PM</p>
              </div>
            </div>
          </div>
        </div>

        {/* Additional Info Section */}
        <div className="mt-8 bg-gradient-to-br from-blue-600/10 to-blue-800/10 border border-blue-600/20 rounded-xl p-8">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 bg-blue-600/20 rounded-xl flex items-center justify-center flex-shrink-0">
              <svg className="w-6 h-6 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <div>
              <h3 className="text-xl font-bold text-white mb-2">Powered by Smart Engine AI</h3>
              <p className="text-slate-300 leading-relaxed">
                Your intelligent assistant is ready to help you manage contacts, generate insights, and streamline your workflow. 
                Explore the navigation menu to access all features tailored to your role.
              </p>
            </div>
          </div>
        </div>

        {/* User Info Debug Section */}
        <div className="mt-8 p-6 bg-slate-900/50 border border-slate-800 rounded-xl">
          <h3 className="text-slate-400 text-sm font-semibold mb-4 uppercase tracking-wider">Account Information</h3>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-slate-500">Name:</span>
              <span className="text-white ml-2">{user.name}</span>
            </div>
            <div>
              <span className="text-slate-500">Email:</span>
              <span className="text-white ml-2">{user.email}</span>
            </div>
            <div>
              <span className="text-slate-500">Role:</span>
              <span className="text-white ml-2">{user.role}</span>
            </div>
            {user.brokerageId && (
              <div>
                <span className="text-slate-500">Brokerage ID:</span>
                <span className="text-white ml-2">{user.brokerageId}</span>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
