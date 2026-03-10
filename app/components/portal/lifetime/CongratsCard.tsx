"use client"

import { useState, useEffect } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { X, PartyPopper } from "lucide-react"

interface CongratsCardProps {
  contactId: string
  firstName: string
  propertyAddress: string
  closeDate: string
  salePrice: number
}

export function CongratsCard({
  contactId,
  firstName,
  propertyAddress,
  closeDate,
  salePrice,
}: CongratsCardProps) {
  const [isDismissed, setIsDismissed] = useState(true)
  const [showConfetti, setShowConfetti] = useState(false)

  useEffect(() => {
    const key = `lifetime_congrats_dismissed_${contactId}`
    const dismissed = localStorage.getItem(key)
    if (!dismissed) {
      setIsDismissed(false)
      setShowConfetti(true)
      // Stop confetti after 3 seconds
      const timer = setTimeout(() => setShowConfetti(false), 3000)
      return () => clearTimeout(timer)
    }
  }, [contactId])

  const handleDismiss = () => {
    const key = `lifetime_congrats_dismissed_${contactId}`
    localStorage.setItem(key, "true")
    setIsDismissed(true)
  }

  if (isDismissed) return null

  const formattedDate = new Date(closeDate).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  })

  const formattedPrice = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(salePrice)

  return (
    <Card className="relative overflow-hidden border-2 border-green-200 bg-gradient-to-br from-green-50 to-emerald-50">
      {/* CSS-only confetti animation */}
      {showConfetti && (
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          {[...Array(20)].map((_, i) => (
            <div
              key={i}
              className="absolute w-2 h-2 rounded-full animate-confetti"
              style={{
                left: `${Math.random() * 100}%`,
                backgroundColor: ["#10b981", "#f59e0b", "#3b82f6", "#ef4444", "#8b5cf6"][i % 5],
                animationDelay: `${Math.random() * 0.5}s`,
                animationDuration: `${1.5 + Math.random()}s`,
              }}
            />
          ))}
        </div>
      )}

      <Button
        variant="ghost"
        size="icon"
        className="absolute top-2 right-2 h-8 w-8 text-muted-foreground hover:text-foreground"
        onClick={handleDismiss}
      >
        <X className="h-4 w-4" />
        <span className="sr-only">Dismiss</span>
      </Button>

      <CardContent className="pt-6 pb-6">
        <div className="flex items-start gap-4">
          <div className="flex-shrink-0 w-12 h-12 rounded-full bg-green-100 flex items-center justify-center">
            <PartyPopper className="h-6 w-6 text-green-600" />
          </div>
          <div className="space-y-2">
            <h3 className="text-xl font-semibold text-green-800">
              Welcome home, {firstName}!
            </h3>
            <p className="text-green-700">
              You closed on <span className="font-medium">{propertyAddress}</span> on {formattedDate}
            </p>
            <p className="text-lg font-semibold text-green-800">
              {formattedPrice} — Congratulations!
            </p>
          </div>
        </div>
      </CardContent>

      <style jsx>{`
        @keyframes confetti {
          0% {
            transform: translateY(-10px) rotate(0deg);
            opacity: 1;
          }
          100% {
            transform: translateY(400px) rotate(720deg);
            opacity: 0;
          }
        }
        .animate-confetti {
          animation: confetti 2s ease-out forwards;
        }
      `}</style>
    </Card>
  )
}
