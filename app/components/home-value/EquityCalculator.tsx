"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Calculator, DollarSign, TrendingUp } from "lucide-react"

interface EquityCalculatorProps {
  estimatedValue: number
}

export function EquityCalculator({ estimatedValue }: EquityCalculatorProps) {
  const [mortgageBalance, setMortgageBalance] = useState("")

  const balance = parseFloat(mortgageBalance.replace(/[^0-9.]/g, "")) || 0
  const equity = estimatedValue - balance
  const equityPercent = estimatedValue > 0 ? (equity / estimatedValue) * 100 : 0

  const formatCurrency = (value: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(value)

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Remove non-numeric characters except decimal
    const value = e.target.value.replace(/[^0-9]/g, "")
    if (value) {
      // Format with commas
      const formatted = parseInt(value, 10).toLocaleString()
      setMortgageBalance(formatted)
    } else {
      setMortgageBalance("")
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Calculator className="h-5 w-5" />
          Equity Calculator
        </CardTitle>
        <CardDescription>
          Estimate your home equity based on your mortgage balance
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="mortgage">What do you owe on your mortgage?</Label>
          <div className="relative">
            <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              id="mortgage"
              type="text"
              placeholder="Enter mortgage balance"
              value={mortgageBalance}
              onChange={handleInputChange}
              className="pl-9"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Optional: Enter your current mortgage balance to calculate equity
          </p>
        </div>

        {balance > 0 && (
          <div className="grid grid-cols-2 gap-4 pt-4 border-t">
            <div className="p-4 bg-muted/50 rounded-lg text-center">
              <p className="text-sm text-muted-foreground mb-1">Estimated Equity</p>
              <p
                className={`text-2xl font-bold ${
                  equity >= 0 ? "text-green-600" : "text-red-600"
                }`}
              >
                {formatCurrency(equity)}
              </p>
            </div>
            <div className="p-4 bg-muted/50 rounded-lg text-center">
              <p className="text-sm text-muted-foreground mb-1">Equity Percentage</p>
              <p
                className={`text-2xl font-bold flex items-center justify-center gap-1 ${
                  equityPercent >= 0 ? "text-green-600" : "text-red-600"
                }`}
              >
                <TrendingUp className="h-5 w-5" />
                {equityPercent.toFixed(1)}%
              </p>
            </div>
          </div>
        )}

        {balance > 0 && (
          <div className="text-center p-4 bg-primary/5 rounded-lg">
            <p className="text-lg font-medium text-foreground">
              Your estimated equity is{" "}
              <span className={equity >= 0 ? "text-green-600" : "text-red-600"}>
                {formatCurrency(Math.abs(equity))}
              </span>
              {equity < 0 && " underwater"}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              Based on estimated value of {formatCurrency(estimatedValue)}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
