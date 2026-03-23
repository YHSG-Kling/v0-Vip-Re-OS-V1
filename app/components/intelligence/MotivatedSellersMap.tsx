"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { MapPin, Clock, Filter, Home, DollarSign, Mail, Phone, RefreshCw, AlertTriangle } from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import { toast } from "sonner"

interface MotivatedSellerLead {
  id: string
  contact_id: string | null
  first_name: string
  last_name: string
  email: string
  phone: string
  property_address: string
  motivation_score: number
  predicted_timeframe: string
  motivation_factors: string[]
  signal_strength: string
  current_value_estimate: number
  assigned_agent_id?: string
}

export default function MotivatedSellersMap() {
  const [sellers, setSellers] = useState<MotivatedSellerLead[]>([])
  const [agents, setAgents] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [assigningLead, setAssigningLead] = useState<string | null>(null)
  const [scoreFilter, setScoreFilter] = useState("all")
  const [timeframeFilter, setTimeframeFilter] = useState("all")

  useEffect(() => {
    loadSellers()
    loadAgents()
  }, [])

  const loadSellers = async () => {
    setLoading(true)
    try {
      const supabase = createClient()

      // This table joins to property_intelligence for property details
      const { data: sellerData, error } = await supabase
        .from("motivated_seller_scores")
        .select(`
          id,
          batchdata_motivation_score,
          readiness_to_sell_score,
          predicted_timeframe,
          motivation_factors,
          life_event_signals,
          property_condition_signals,
          financial_pressure_indicators,
          property_intelligence (
            id,
            property_address,
            owner_name,
            owner_phone,
            owner_email,
            current_value_estimate,
            equity_amount
          )
        `)
        .order("readiness_to_sell_score", { ascending: false })
        .limit(50)

      if (error) {
        console.error("[v0] Error from motivated_seller_scores:", error)
        const { data: signalsData, error: signalsError } = await supabase
          .from("motivated_seller_signals")
          .select(`
            id,
            lead_id,
            signal_type,
            signal_details,
            signal_strength,
            detected_via,
            detected_at,
            contacts (
              id,
              first_name,
              last_name,
              email,
              phone,
              agent_id
            )
          `)
          .order("detected_at", { ascending: false })
          .limit(50)

        if (signalsError) throw signalsError

        // Transform signals data
        const transformedFromSignals: MotivatedSellerLead[] = (signalsData || []).map((item: any) => {
          const details = item.signal_details || {}
          return {
            id: item.id,
            contact_id: item.lead_id,
            first_name: item.contacts?.first_name || "Unknown",
            last_name: item.contacts?.last_name || "Seller",
            email: item.contacts?.email || "",
            phone: item.contacts?.phone || "",
            property_address: details.property_address || "Address Unknown",
            motivation_score:
              details.score ||
              (item.signal_strength === "urgent"
                ? 90
                : item.signal_strength === "strong"
                  ? 75
                  : item.signal_strength === "moderate"
                    ? 50
                    : 30),
            predicted_timeframe: details.timeframe || item.signal_strength === "urgent" ? "immediate" : "3-6_months",
            motivation_factors: [item.signal_type, ...(details.factors || [])],
            signal_strength: item.signal_strength || "moderate",
            current_value_estimate: details.estimated_value || 0,
            assigned_agent_id: item.contacts?.agent_id,
          }
        })

        setSellers(transformedFromSignals)
        return
      }

      // Transform scores data
      const transformedSellers: MotivatedSellerLead[] = (sellerData || []).map((item: any) => {
        const ownerName = item.property_intelligence?.owner_name || "Unknown Owner"
        const nameParts = ownerName.split(" ")
        return {
          id: item.id,
          contact_id: null, // property_intelligence doesn't link to contacts directly
          first_name: nameParts[0] || "Unknown",
          last_name: nameParts.slice(1).join(" ") || "Owner",
          email: item.property_intelligence?.owner_email || "",
          phone: item.property_intelligence?.owner_phone || "",
          property_address: item.property_intelligence?.property_address || "Address Unknown",
          motivation_score: item.readiness_to_sell_score || item.batchdata_motivation_score || 0,
          predicted_timeframe: item.predicted_timeframe || "unknown",
          motivation_factors: [
            ...(item.motivation_factors || []),
            ...(item.life_event_signals || []),
            ...(item.financial_pressure_indicators || []),
          ].filter(Boolean),
          signal_strength:
            item.readiness_to_sell_score >= 80 ? "urgent" : item.readiness_to_sell_score >= 60 ? "strong" : "moderate",
          current_value_estimate: item.property_intelligence?.current_value_estimate || 0,
          assigned_agent_id: undefined,
        }
      })

      setSellers(transformedSellers)
    } catch (error) {
      console.error("[v0] Error loading sellers:", error)
    } finally {
      setLoading(false)
    }
  }

  const loadAgents = async () => {
    try {
      const supabase = createClient()
      const { data } = await supabase
        .from("users")
        .select("id, first_name, last_name")
        .in("role", ["agent", "broker"])
        .order("first_name")
      setAgents(data || [])
    } catch (error) {
      console.error("[v0] Error loading agents:", error)
    }
  }

  const assignLeadToAgent = async (contactId: string | null, agentId: string) => {
    if (!contactId) {
      toast.error("No contact linked — create a contact first")
      return
    }

    setAssigningLead(contactId)
    try {
      const supabase = createClient()
      const { error } = await supabase.from("contacts").update({ agent_id: agentId }).eq("id", contactId)

      if (error) throw error

      toast.success("Seller assigned")
      loadSellers()
    } catch (error) {
      console.error("[v0] Error assigning seller:", error)
      toast.error("Failed to assign seller")
    } finally {
      setAssigningLead(null)
    }
  }

  const filteredSellers = sellers.filter((seller) => {
    if (scoreFilter !== "all" && seller.motivation_score < Number.parseInt(scoreFilter)) return false
    if (timeframeFilter !== "all" && seller.predicted_timeframe !== timeframeFilter) return false
    return true
  })

  const getUrgencyColor = (score: number) => {
    if (score >= 80) return "bg-red-500"
    if (score >= 60) return "bg-orange-500"
    return "bg-yellow-500"
  }

  const getStrengthBadge = (strength: string) => {
    switch (strength) {
      case "urgent":
        return "bg-red-100 text-red-800 border-red-300"
      case "strong":
        return "bg-orange-100 text-orange-800 border-orange-300"
      case "moderate":
        return "bg-yellow-100 text-yellow-800 border-yellow-300"
      default:
        return "bg-slate-100 text-slate-800 border-slate-300"
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="animate-spin text-blue-600" size={32} />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <MapPin className="w-5 h-5 text-blue-600" />
              Motivated Sellers - Full Profiles
            </CardTitle>
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-muted-foreground" />
              <Select value={scoreFilter} onValueChange={setScoreFilter}>
                <SelectTrigger className="w-32">
                  <SelectValue placeholder="Min Score" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Scores</SelectItem>
                  <SelectItem value="80">80+ (Hot)</SelectItem>
                  <SelectItem value="60">60+ (Warm)</SelectItem>
                  <SelectItem value="40">40+ (Cold)</SelectItem>
                </SelectContent>
              </Select>
              <Select value={timeframeFilter} onValueChange={setTimeframeFilter}>
                <SelectTrigger className="w-36">
                  <SelectValue placeholder="Timeframe" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Times</SelectItem>
                  <SelectItem value="immediate">Immediate</SelectItem>
                  <SelectItem value="3months">3 Months</SelectItem>
                  <SelectItem value="6months">6 Months</SelectItem>
                  <SelectItem value="12months">12 Months</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {filteredSellers.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Home className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>No motivated sellers match the current filters.</p>
              <p className="text-sm mt-2">Data will appear as BatchData or OSINT signals are collected.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {filteredSellers.map((seller) => (
                <Card key={seller.id} className="border-l-4 border-l-orange-500 hover:shadow-md transition-shadow">
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-3">
                          <div className={`w-3 h-3 rounded-full ${getUrgencyColor(seller.motivation_score)}`} />
                          <h4 className="font-bold text-slate-900">
                            {seller.first_name} {seller.last_name}
                          </h4>
                          <Badge className="bg-purple-50 text-purple-700">Score: {seller.motivation_score}</Badge>
                          <Badge className={getStrengthBadge(seller.signal_strength)}>{seller.signal_strength}</Badge>
                        </div>

                        <div className="flex flex-wrap gap-4 text-sm text-slate-600 mb-2">
                          {seller.email && (
                            <span className="flex items-center gap-1">
                              <Mail size={14} />
                              {seller.email}
                            </span>
                          )}
                          {seller.phone && (
                            <span className="flex items-center gap-1">
                              <Phone size={14} />
                              {seller.phone}
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-2 text-sm text-slate-700 mb-2">
                          <Home className="w-4 h-4 text-purple-600" />
                          <span>{seller.property_address}</span>
                        </div>

                        <div className="flex flex-wrap gap-4 text-xs text-slate-500 mb-2">
                          <span className="flex items-center gap-1">
                            <Clock size={12} />
                            {seller.predicted_timeframe.replace(/_/g, " ")}
                          </span>
                          {seller.current_value_estimate > 0 && (
                            <span className="flex items-center gap-1">
                              <DollarSign size={12} />${seller.current_value_estimate.toLocaleString()}
                            </span>
                          )}
                        </div>

                        <div className="flex flex-wrap gap-2">
                          {seller.motivation_factors.slice(0, 5).map((factor, idx) => (
                            <Badge key={idx} variant="outline" className="text-xs">
                              {String(factor).replace(/_/g, " ")}
                            </Badge>
                          ))}
                        </div>
                      </div>

                      <div className="flex flex-col gap-2 ml-4">
                        {seller.contact_id ? (
                          <select
                            className="text-sm border border-slate-300 rounded px-2 py-1 min-w-[140px]"
                            value={seller.assigned_agent_id || ""}
                            onChange={(e) => assignLeadToAgent(seller.contact_id, e.target.value)}
                            disabled={assigningLead === seller.contact_id}
                          >
                            <option value="">Assign Agent...</option>
                            {agents.map((agent) => (
                              <option key={agent.id} value={agent.id}>
                                {agent.first_name} {agent.last_name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <Badge variant="outline" className="text-xs text-orange-600 border-orange-300">
                            <AlertTriangle size={12} className="mr-1" />
                            No Contact
                          </Badge>
                        )}

                        <Button size="sm" variant="outline" disabled={!seller.email}>
                          <Mail size={14} className="mr-1" /> Email
                        </Button>
                        <Button size="sm" className="bg-purple-600 hover:bg-purple-700" disabled={!seller.phone}>
                          <Phone size={14} className="mr-1" /> Call
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
