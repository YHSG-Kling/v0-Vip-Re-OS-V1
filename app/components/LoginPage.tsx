"use client"

import React from "react"

import { useState } from "react"
import { UserRole } from "../../types"
import { Button } from "./ui/button"
import { Input } from "./ui/input"
import { Label } from "./ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select"

interface LoginPageProps {
  onLogin: (role: string, email: string, persona?: string) => void
}

const CONTACT_PERSONAS = [
  { value: "first_time_buyer", label: "First Time Buyer" },
  { value: "luxury_buyer", label: "Luxury Buyer" },
  { value: "luxury_seller", label: "Luxury Seller" },
  { value: "investor", label: "Investor" },
  { value: "motivated_seller", label: "Motivated Seller" },
  { value: "relocating", label: "Relocating" },
  { value: "probate", label: "Probate" },
  { value: "divorce", label: "Divorce" },
  { value: "senior", label: "Senior" },
  { value: "empty_nester", label: "Empty Nester" },
  { value: "remote_seller", label: "Remote Seller" },
  { value: "expired", label: "Expired Listing" },
  { value: "fsbo", label: "FSBO" },
  { value: "military_buyer", label: "Military Buyer" },
  { value: "upsizing", label: "Upsizing" },
  { value: "downsizing", label: "Downsizing" },
]

export default function LoginPage({ onLogin }: LoginPageProps) {
  const [email, setEmail] = useState("")
  const [selectedRole, setSelectedRole] = useState<string>("agent")
  const [selectedPersona, setSelectedPersona] = useState<string>("")

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (email) {
      onLogin(selectedRole, email, selectedRole === "contact" ? selectedPersona : undefined)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-100 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl font-bold text-center">Welcome Back</CardTitle>
          <CardDescription className="text-center">Sign in to your Smart Engine account</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="Enter your email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="role">Role</Label>
              <Select value={selectedRole} onValueChange={setSelectedRole}>
                <SelectTrigger id="role">
                  <SelectValue placeholder="Select your role" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="agent">Agent</SelectItem>
                  <SelectItem value="broker">Broker</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="contact">Contact/Client</SelectItem>
                  <SelectItem value="tc">Transaction Coordinator</SelectItem>
                  <SelectItem value="seller">Seller</SelectItem>
                  <SelectItem value="buyer">Buyer</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {selectedRole === "contact" && (
              <div className="space-y-2">
                <Label htmlFor="persona">Contact Type</Label>
                <Select value={selectedPersona} onValueChange={setSelectedPersona}>
                  <SelectTrigger id="persona">
                    <SelectValue placeholder="Select contact type" />
                  </SelectTrigger>
                  <SelectContent>
                    {CONTACT_PERSONAS.map((persona) => (
                      <SelectItem key={persona.value} value={persona.value}>
                        {persona.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <Button type="submit" className="w-full" disabled={!email || (selectedRole === "contact" && !selectedPersona)}>
              Sign In
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
