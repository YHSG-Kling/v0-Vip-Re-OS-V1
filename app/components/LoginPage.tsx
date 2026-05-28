"use client"

import React from "react"

import { useState } from "react"
import { UserRole } from "@/types"
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

          <div className="mt-6 pt-6 border-t border-slate-200">
            <div className="text-xs text-slate-500 text-center mb-3 font-semibold uppercase tracking-wide">
              Demo Quick Links
            </div>
            
            <div className="space-y-2">
              {/* Agent Demo */}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full justify-start text-xs bg-transparent"
                onClick={() => {
                  setEmail("agent@demo.com")
                  setSelectedRole("agent")
                  onLogin("agent", "agent@demo.com")
                }}
              >
                <span className="mr-2">👨‍💼</span>
                <span className="flex-1 text-left">Agent Demo</span>
                <span className="text-slate-400">agent@demo.com</span>
              </Button>

              {/* Broker Demo */}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full justify-start text-xs bg-transparent"
                onClick={() => {
                  setEmail("broker@demo.com")
                  setSelectedRole("broker")
                  onLogin("broker", "broker@demo.com")
                }}
              >
                <span className="mr-2">🏢</span>
                <span className="flex-1 text-left">Broker Demo</span>
                <span className="text-slate-400">broker@demo.com</span>
              </Button>

              {/* Contact/Client Persona Demos */}
              <details className="group">
                <summary className="cursor-pointer list-none">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full justify-start text-xs bg-transparent"
                    asChild
                  >
                    <div>
                      <span className="mr-2">🏠</span>
                      <span className="flex-1 text-left">Client Portal Demos</span>
                      <span className="text-slate-400 group-open:rotate-180 transition-transform">▼</span>
                    </div>
                  </Button>
                </summary>
                
                <div className="mt-2 ml-4 space-y-1.5 pl-2 border-l-2 border-slate-200">
                  {/* First Time Buyer */}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start text-xs h-8"
                    onClick={() => {
                      const email = "sarah.mitchell@demo.example.com"
                      setEmail(email)
                      setSelectedRole("contact")
                      setSelectedPersona("first_time_buyer")
                      onLogin("contact", email, "first_time_buyer")
                    }}
                  >
                    <span className="flex-1 text-left">First Time Buyer</span>
                    <span className="text-slate-400 text-[10px]">Sarah M.</span>
                  </Button>

                  {/* Luxury Buyer */}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start text-xs h-8"
                    onClick={() => {
                      const email = "victoria.sterling@demo.example.com"
                      setEmail(email)
                      setSelectedRole("contact")
                      setSelectedPersona("luxury_buyer")
                      onLogin("contact", email, "luxury_buyer")
                    }}
                  >
                    <span className="flex-1 text-left">Luxury Buyer</span>
                    <span className="text-slate-400 text-[10px]">Victoria S.</span>
                  </Button>

                  {/* Motivated Seller */}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start text-xs h-8"
                    onClick={() => {
                      const email = "robert.wilson@demo.example.com"
                      setEmail(email)
                      setSelectedRole("contact")
                      setSelectedPersona("motivated_seller")
                      onLogin("contact", email, "motivated_seller")
                    }}
                  >
                    <span className="flex-1 text-left">Motivated Seller</span>
                    <span className="text-slate-400 text-[10px]">Robert W.</span>
                  </Button>

                  {/* Investor */}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start text-xs h-8"
                    onClick={() => {
                      const email = "david.chen@demo.example.com"
                      setEmail(email)
                      setSelectedRole("contact")
                      setSelectedPersona("investor")
                      onLogin("contact", email, "investor")
                    }}
                  >
                    <span className="flex-1 text-left">Investor</span>
                    <span className="text-slate-400 text-[10px]">David C.</span>
                  </Button>

                  {/* Relocating */}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start text-xs h-8"
                    onClick={() => {
                      const email = "jennifer.martinez@demo.example.com"
                      setEmail(email)
                      setSelectedRole("contact")
                      setSelectedPersona("relocating")
                      onLogin("contact", email, "relocating")
                    }}
                  >
                    <span className="flex-1 text-left">Relocating Buyer</span>
                    <span className="text-slate-400 text-[10px]">Jennifer M.</span>
                  </Button>

                  {/* Senior */}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start text-xs h-8"
                    onClick={() => {
                      const email = "dorothy.williams@demo.example.com"
                      setEmail(email)
                      setSelectedRole("contact")
                      setSelectedPersona("senior")
                      onLogin("contact", email, "senior")
                    }}
                  >
                    <span className="flex-1 text-left">Senior Downsizing</span>
                    <span className="text-slate-400 text-[10px]">Dorothy W.</span>
                  </Button>
                </div>
              </details>

              {/* Magic Link Note */}
              <div className="pt-2 mt-2 border-t border-slate-200">
                <p className="text-[10px] text-slate-400 text-center leading-relaxed">
                  Magic link authentication for client portals. Each persona demonstrates different journey stages and features.
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
