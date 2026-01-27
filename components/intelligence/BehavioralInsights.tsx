"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Globe,
  Search,
  Home,
  Mail,
  Phone,
  RefreshCw,
  ExternalLink,
  MapPin,
  DollarSign,
  Calendar,
  Database,
  Facebook,
  MessageCircle,
} from "lucide-react"
import { createClient } from "@/lib/supabase/client"

interface ExternalBehaviorLead {
  id: string
  source: string // zillow, realtor, redfin, trulia, nextdoor
  activity_type: string
  property_addresses_viewed: string[]
  search_criteria_json: any
  confidence_score: number
  scraped_at: string
  detected_via_zenrows: boolean
  // Contact info if linked
  contact_id?: string
  first_name?: string
  last_name?: string
  email?: string
  phone?: string
  assigned_agent_id?: string
}

interface PropertySearchLead {
  id: string
  lead_id: string
  search_source: string // zillow, realtor_com, redfin, nextdoor, google, idx_broker
  search_query: string
  search_location: string
  properties_viewed: any[]
  search_criteria: any
  detected_via: string // zenrows_scrape, osint, behavioral_tracking
  scraped_at: string
  // Contact info
  first_name?: string
  last_name?: string
  email?: string
  phone?: string
  assigned_agent_id?: string
}

interface SocialIntelLead {
  id: string
  source: string // facebook, reddit, nextdoor, craigslist, google
  post_content: string
  post_url: string
  author_name: string
  posted_date: string
  detected_location: string
  intent_keywords_matched: string[]
  ai_intent_score: number
  intent_summary: string
  urgency_level: string
  scraped_at: string
  // Contact info if linked
  contact_id?: string
  first_name?: string
  last_name?: string
  email?: string
  phone?: string
  assigned_agent_id?: string
}

export default function BehavioralInsights() {
  const [externalBehavior, setExternalBehavior] = useState<ExternalBehaviorLead[]>([])
  const [propertySearches, setPropertySearches] = useState<PropertySearchLead[]>([])
  const [socialIntel, setSocialIntel] = useState<SocialIntelLead[]>([])
  const [agents, setAgents] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [assigningLead, setAssigningLead] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState("zillow")

  const [stats, setStats] = useState({
    zillowScrapes: 0,
    realtorScrapes: 0,
    socialPosts: 0,
    totalPropertySearches: 0,
    highIntentLeads: 0,
  })

  useEffect(() => {
    loadAllScrapedData()
    loadAgents()
  }, [])

  const loadExternalBehavior = async () => {
    try {
      const supabase = createClient()

      const { data, error } = await supabase
        .from("external_behavior")
        .select(`
          id,
          source,
          activity_type,
          property_addresses_viewed,
          search_criteria_json,
          confidence_score,
          scraped_at,
          detected_via_zenrows,
          behavioral_signal_id,
          behavioral_signals (
            contact_id,
            contacts (
              id,
              first_name,
              last_name,
              email,
              phone,
              agent_id
            )
          )
        `)
        .order("scraped_at", { ascending: false })
        .limit(100)

      if (error) {
        console.log("[v0] external_behavior table may not exist yet:", error.message)
        return []
      }

      return (data || []).map((item: any) => ({
        id: item.id,
        source: item.source,
        activity_type: item.activity_type,
        property_addresses_viewed: item.property_addresses_viewed || [],
        search_criteria_json: item.search_criteria_json,
        confidence_score: item.confidence_score || 0,
        scraped_at: item.scraped_at,
        detected_via_zenrows: item.detected_via_zenrows,
        contact_id: item.behavioral_signals?.contacts?.id,
        first_name: item.behavioral_signals?.contacts?.first_name,
        last_name: item.behavioral_signals?.contacts?.last_name,
        email: item.behavioral_signals?.contacts?.email,
        phone: item.behavioral_signals?.contacts?.phone,
        assigned_agent_id: item.behavioral_signals?.contacts?.agent_id,
      }))
    } catch (error) {
      console.error("[v0] Error loading external behavior:", error)
      return []
    }
  }

  const loadPropertySearches = async () => {
    try {
      const supabase = createClient()

      const { data, error } = await supabase
        .from("lead_property_searches")
        .select(`
          id,
          lead_id,
          search_source,
          search_query,
          search_location,
          properties_viewed,
          search_criteria,
          detected_via,
          scraped_at,
          contacts:lead_id (
            id,
            first_name,
            last_name,
            email,
            phone,
            agent_id
          )
        `)
        .order("scraped_at", { ascending: false })
        .limit(100)

      if (error) {
        console.log("[v0] lead_property_searches table may not exist yet:", error.message)
        return []
      }

      return (data || []).map((item: any) => ({
        id: item.id,
        lead_id: item.lead_id,
        search_source: item.search_source,
        search_query: item.search_query || "",
        search_location: item.search_location || "",
        properties_viewed: item.properties_viewed || [],
        search_criteria: item.search_criteria || {},
        detected_via: item.detected_via,
        scraped_at: item.scraped_at,
        first_name: item.contacts?.first_name,
        last_name: item.contacts?.last_name,
        email: item.contacts?.email,
        phone: item.contacts?.phone,
        assigned_agent_id: item.contacts?.agent_id,
      }))
    } catch (error) {
      console.error("[v0] Error loading property searches:", error)
      return []
    }
  }

  const loadSocialIntelligence = async () => {
    try {
      const supabase = createClient()

      const { data, error } = await supabase
        .from("social_intelligence")
        .select(`
          id,
          source,
          post_content,
          post_url,
          author_name,
          posted_date,
          detected_location,
          intent_keywords_matched,
          ai_intent_score,
          intent_summary,
          urgency_level,
          scraped_at,
          contact_id,
          contacts:contact_id (
            id,
            first_name,
            last_name,
            email,
            phone,
            agent_id
          )
        `)
        .order("ai_intent_score", { ascending: false })
        .limit(100)

      if (error) {
        console.log("[v0] social_intelligence table may not exist yet:", error.message)
        return []
      }

      return (data || []).map((item: any) => ({
        id: item.id,
        source: item.source,
        post_content: item.post_content || "",
        post_url: item.post_url,
        author_name: item.author_name || "Unknown",
        posted_date: item.posted_date,
        detected_location: item.detected_location,
        intent_keywords_matched: item.intent_keywords_matched || [],
        ai_intent_score: item.ai_intent_score || 0,
        intent_summary: item.intent_summary,
        urgency_level: item.urgency_level || "medium",
        scraped_at: item.scraped_at,
        contact_id: item.contact_id,
        first_name: item.contacts?.first_name,
        last_name: item.contacts?.last_name,
        email: item.contacts?.email,
        phone: item.contacts?.phone,
        assigned_agent_id: item.contacts?.agent_id,
      }))
    } catch (error) {
      console.error("[v0] Error loading social intelligence:", error)
      return []
    }
  }

  const loadAllScrapedData = async () => {
    setLoading(true)
    try {
      const [external, searches, social] = await Promise.all([
        loadExternalBehavior(),
        loadPropertySearches(),
        loadSocialIntelligence(),
      ])

      setExternalBehavior(external)
      setPropertySearches(searches)
      setSocialIntel(social)

      // Calculate stats
      const zillowCount = external.filter((e) => e.source === "zillow").length
      const realtorCount = external.filter((e) => e.source === "realtor").length
      const highIntent = social.filter((s) => s.ai_intent_score >= 70).length

      setStats({
        zillowScrapes: zillowCount,
        realtorScrapes: realtorCount,
        socialPosts: social.length,
        totalPropertySearches: searches.length,
        highIntentLeads: highIntent,
      })
    } catch (error) {
      console.error("[v0] Error loading scraped data:", error)
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

  const assignLeadToAgent = async (contactId: string | null | undefined, agentId: string) => {
    if (!contactId) {
      alert("Cannot assign - no contact linked. Create a contact first.")
      return
    }

    setAssigningLead(contactId)
    try {
      const supabase = createClient()
      const { error } = await supabase.from("contacts").update({ agent_id: agentId }).eq("id", contactId)

      if (error) throw error

      alert("Lead assigned successfully!")
      loadAllScrapedData()
    } catch (error) {
      console.error("[v0] Error assigning lead:", error)
      alert("Failed to assign lead")
    } finally {
      setAssigningLead(null)
    }
  }

  const getSourceIcon = (source: string) => {
    switch (source?.toLowerCase()) {
      case "zillow":
        return <Home className="w-4 h-4 text-blue-600" />
      case "realtor":
        return <Home className="w-4 h-4 text-red-600" />
      case "redfin":
        return <Home className="w-4 h-4 text-orange-600" />
      case "trulia":
        return <Home className="w-4 h-4 text-green-600" />
      case "facebook":
        return <Facebook className="w-4 h-4 text-blue-600" />
      case "reddit":
        return <MessageCircle className="w-4 h-4 text-orange-500" />
      case "nextdoor":
        return <MapPin className="w-4 h-4 text-green-600" />
      case "craigslist":
        return <Globe className="w-4 h-4 text-purple-600" />
      case "google":
        return <Search className="w-4 h-4 text-blue-500" />
      default:
        return <Globe className="w-4 h-4 text-slate-500" />
    }
  }

  const getSourceBadgeColor = (source: string) => {
    switch (source?.toLowerCase()) {
      case "zillow":
        return "bg-blue-100 text-blue-800 border-blue-300"
      case "realtor":
        return "bg-red-100 text-red-800 border-red-300"
      case "redfin":
        return "bg-orange-100 text-orange-800 border-orange-300"
      case "trulia":
        return "bg-green-100 text-green-800 border-green-300"
      case "facebook":
        return "bg-blue-100 text-blue-800 border-blue-300"
      case "reddit":
        return "bg-orange-100 text-orange-800 border-orange-300"
      case "nextdoor":
        return "bg-green-100 text-green-800 border-green-300"
      case "craigslist":
        return "bg-purple-100 text-purple-800 border-purple-300"
      default:
        return "bg-slate-100 text-slate-800 border-slate-300"
    }
  }

  const getUrgencyColor = (urgency: string) => {
    switch (urgency) {
      case "urgent":
        return "bg-red-500 text-white"
      case "high":
        return "bg-orange-500 text-white"
      case "medium":
        return "bg-yellow-500 text-white"
      default:
        return "bg-slate-400 text-white"
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="animate-spin text-blue-600" size={32} />
        <span className="ml-2 text-muted-foreground">Loading scraped intelligence data...</span>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <Card className="bg-gradient-to-br from-blue-50 to-indigo-50 border-blue-200">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Home className="w-4 h-4 text-blue-600" />
              Zillow Scrapes
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-blue-600">{stats.zillowScrapes}</div>
            <span className="text-xs text-muted-foreground">Via ZenRows</span>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-red-50 to-rose-50 border-red-200">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Home className="w-4 h-4 text-red-600" />
              Realtor.com Scrapes
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-red-600">{stats.realtorScrapes}</div>
            <span className="text-xs text-muted-foreground">Via ZenRows</span>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-green-50 to-emerald-50 border-green-200">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <MessageCircle className="w-4 h-4 text-green-600" />
              Social Posts
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-green-600">{stats.socialPosts}</div>
            <span className="text-xs text-muted-foreground">FB, Reddit, Nextdoor, CL</span>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-purple-50 to-violet-50 border-purple-200">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Search className="w-4 h-4 text-purple-600" />
              Property Searches
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-purple-600">{stats.totalPropertySearches}</div>
            <span className="text-xs text-muted-foreground">OSINT detected</span>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-orange-50 to-amber-50 border-orange-200">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Database className="w-4 h-4 text-orange-600" />
              High Intent
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-orange-600">{stats.highIntentLeads}</div>
            <span className="text-xs text-muted-foreground">Score 70+</span>
          </CardContent>
        </Card>
      </div>

      {/* Tabbed Data Views */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="w-5 h-5 text-blue-600" />
            Scraped Intelligence Data (ZenRows, Apify, OSINT)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="grid grid-cols-4 mb-4">
              <TabsTrigger value="zillow" className="flex items-center gap-1">
                <Home className="w-4 h-4" /> Zillow/Realtor
              </TabsTrigger>
              <TabsTrigger value="social" className="flex items-center gap-1">
                <MessageCircle className="w-4 h-4" /> Social Posts
              </TabsTrigger>
              <TabsTrigger value="searches" className="flex items-center gap-1">
                <Search className="w-4 h-4" /> Property Searches
              </TabsTrigger>
              <TabsTrigger value="all" className="flex items-center gap-1">
                <Database className="w-4 h-4" /> All Data
              </TabsTrigger>
            </TabsList>

            {/* Zillow/Realtor/Redfin Tab */}
            <TabsContent value="zillow" className="space-y-3">
              {externalBehavior.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Globe className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p>No scraped data yet. Configure ZenRows to scrape Zillow, Realtor.com, Redfin.</p>
                </div>
              ) : (
                externalBehavior.map((lead) => (
                  <div key={lead.id} className="p-4 border rounded-lg hover:shadow-md transition-shadow bg-white">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-2">
                          {getSourceIcon(lead.source)}
                          <Badge className={getSourceBadgeColor(lead.source)}>{lead.source?.toUpperCase()}</Badge>
                          <Badge variant="outline">{lead.activity_type}</Badge>
                          {lead.detected_via_zenrows && (
                            <Badge className="bg-emerald-100 text-emerald-800">ZenRows</Badge>
                          )}
                          <span className="text-xs text-muted-foreground">Confidence: {lead.confidence_score}%</span>
                        </div>

                        <div className="mb-2">
                          {lead.first_name ? (
                            <h4 className="font-bold text-foreground">
                              {lead.first_name} {lead.last_name}
                            </h4>
                          ) : (
                            <h4 className="font-medium text-muted-foreground italic">Anonymous Visitor</h4>
                          )}
                        </div>

                        {lead.property_addresses_viewed?.length > 0 && (
                          <div className="mb-2">
                            <span className="text-sm font-medium">Properties Viewed:</span>
                            <div className="flex flex-wrap gap-1 mt-1">
                              {lead.property_addresses_viewed.slice(0, 3).map((addr, i) => (
                                <Badge key={i} variant="outline" className="text-xs">
                                  <MapPin className="w-3 h-3 mr-1" />
                                  {addr}
                                </Badge>
                              ))}
                              {lead.property_addresses_viewed.length > 3 && (
                                <Badge variant="outline" className="text-xs">
                                  +{lead.property_addresses_viewed.length - 3} more
                                </Badge>
                              )}
                            </div>
                          </div>
                        )}

                        <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
                          {lead.email && (
                            <span className="flex items-center gap-1">
                              <Mail size={14} /> {lead.email}
                            </span>
                          )}
                          {lead.phone && (
                            <span className="flex items-center gap-1">
                              <Phone size={14} /> {lead.phone}
                            </span>
                          )}
                          <span className="flex items-center gap-1">
                            <Calendar size={14} />
                            Scraped: {new Date(lead.scraped_at).toLocaleDateString()}
                          </span>
                        </div>
                      </div>

                      <div className="flex flex-col gap-2 ml-4">
                        <select
                          className="text-sm border rounded px-2 py-1 min-w-[140px]"
                          value={lead.assigned_agent_id || ""}
                          onChange={(e) => assignLeadToAgent(lead.contact_id, e.target.value)}
                          disabled={assigningLead === lead.contact_id || !lead.contact_id}
                        >
                          <option value="">Assign Agent...</option>
                          {agents.map((agent) => (
                            <option key={agent.id} value={agent.id}>
                              {agent.first_name} {agent.last_name}
                            </option>
                          ))}
                        </select>
                        {lead.email && (
                          <Button size="sm" variant="outline">
                            <Mail size={14} className="mr-1" /> Email
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </TabsContent>

            {/* Social Posts Tab (Facebook, Reddit, Nextdoor, Craigslist) */}
            <TabsContent value="social" className="space-y-3">
              {socialIntel.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <MessageCircle className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p>No social intelligence yet. Configure Apify to scrape Facebook, Reddit, Nextdoor, Craigslist.</p>
                </div>
              ) : (
                socialIntel.map((post) => (
                  <div key={post.id} className="p-4 border rounded-lg hover:shadow-md transition-shadow bg-white">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-2">
                          {getSourceIcon(post.source)}
                          <Badge className={getSourceBadgeColor(post.source)}>{post.source?.toUpperCase()}</Badge>
                          <Badge className={getUrgencyColor(post.urgency_level)}>
                            {post.urgency_level?.toUpperCase()}
                          </Badge>
                          <span className="text-xs text-muted-foreground">AI Score: {post.ai_intent_score}%</span>
                        </div>

                        <div className="mb-2">
                          <h4 className="font-bold text-foreground">{post.author_name}</h4>
                          {post.detected_location && (
                            <span className="text-sm text-muted-foreground flex items-center gap-1">
                              <MapPin size={12} /> {post.detected_location}
                            </span>
                          )}
                        </div>

                        <div className="p-3 bg-slate-50 rounded-lg mb-2">
                          <p className="text-sm text-foreground line-clamp-3">{post.post_content}</p>
                        </div>

                        {post.intent_summary && (
                          <p className="text-sm text-blue-600 mb-2">
                            <strong>AI Analysis:</strong> {post.intent_summary}
                          </p>
                        )}

                        {post.intent_keywords_matched?.length > 0 && (
                          <div className="flex flex-wrap gap-1 mb-2">
                            {post.intent_keywords_matched.map((keyword, i) => (
                              <Badge key={i} variant="outline" className="text-xs bg-yellow-50">
                                {keyword}
                              </Badge>
                            ))}
                          </div>
                        )}

                        <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                          {post.post_url && (
                            <a
                              href={post.post_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-1 text-blue-600 hover:underline"
                            >
                              <ExternalLink size={12} /> View Original
                            </a>
                          )}
                          <span>Posted: {new Date(post.posted_date).toLocaleDateString()}</span>
                          <span>Scraped: {new Date(post.scraped_at).toLocaleDateString()}</span>
                        </div>
                      </div>

                      <div className="flex flex-col gap-2 ml-4">
                        <select
                          className="text-sm border rounded px-2 py-1 min-w-[140px]"
                          value={post.assigned_agent_id || ""}
                          onChange={(e) => assignLeadToAgent(post.contact_id, e.target.value)}
                          disabled={assigningLead === post.contact_id || !post.contact_id}
                        >
                          <option value="">Assign Agent...</option>
                          {agents.map((agent) => (
                            <option key={agent.id} value={agent.id}>
                              {agent.first_name} {agent.last_name}
                            </option>
                          ))}
                        </select>
                        {post.email && (
                          <Button size="sm" variant="outline">
                            <Mail size={14} className="mr-1" /> Email
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </TabsContent>

            {/* Property Searches Tab */}
            <TabsContent value="searches" className="space-y-3">
              {propertySearches.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Search className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p>No property search data yet. OSINT data will appear as leads search for properties.</p>
                </div>
              ) : (
                propertySearches.map((search) => (
                  <div key={search.id} className="p-4 border rounded-lg hover:shadow-md transition-shadow bg-white">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-2">
                          {getSourceIcon(search.search_source)}
                          <Badge className={getSourceBadgeColor(search.search_source)}>
                            {search.search_source?.replace("_", ".").toUpperCase()}
                          </Badge>
                          <Badge variant="outline">{search.detected_via?.replace("_", " ")}</Badge>
                        </div>

                        <div className="mb-2">
                          {search.first_name ? (
                            <h4 className="font-bold text-foreground">
                              {search.first_name} {search.last_name}
                            </h4>
                          ) : (
                            <h4 className="font-medium text-muted-foreground italic">Unknown Lead</h4>
                          )}
                        </div>

                        {search.search_location && (
                          <p className="text-sm mb-2">
                            <MapPin className="w-4 h-4 inline mr-1" />
                            <strong>Location:</strong> {search.search_location}
                          </p>
                        )}

                        {search.search_query && (
                          <p className="text-sm mb-2">
                            <Search className="w-4 h-4 inline mr-1" />
                            <strong>Query:</strong> {search.search_query}
                          </p>
                        )}

                        {search.search_criteria && Object.keys(search.search_criteria).length > 0 && (
                          <div className="flex flex-wrap gap-2 mb-2">
                            {search.search_criteria.price_min && (
                              <Badge variant="outline">
                                <DollarSign className="w-3 h-3 mr-1" />
                                Min: ${search.search_criteria.price_min.toLocaleString()}
                              </Badge>
                            )}
                            {search.search_criteria.price_max && (
                              <Badge variant="outline">
                                <DollarSign className="w-3 h-3 mr-1" />
                                Max: ${search.search_criteria.price_max.toLocaleString()}
                              </Badge>
                            )}
                            {search.search_criteria.beds && (
                              <Badge variant="outline">{search.search_criteria.beds}+ beds</Badge>
                            )}
                          </div>
                        )}

                        <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
                          {search.email && (
                            <span className="flex items-center gap-1">
                              <Mail size={14} /> {search.email}
                            </span>
                          )}
                          {search.phone && (
                            <span className="flex items-center gap-1">
                              <Phone size={14} /> {search.phone}
                            </span>
                          )}
                          <span>Scraped: {new Date(search.scraped_at).toLocaleDateString()}</span>
                        </div>
                      </div>

                      <div className="flex flex-col gap-2 ml-4">
                        <select
                          className="text-sm border rounded px-2 py-1 min-w-[140px]"
                          value={search.assigned_agent_id || ""}
                          onChange={(e) => assignLeadToAgent(search.lead_id, e.target.value)}
                          disabled={assigningLead === search.lead_id}
                        >
                          <option value="">Assign Agent...</option>
                          {agents.map((agent) => (
                            <option key={agent.id} value={agent.id}>
                              {agent.first_name} {agent.last_name}
                            </option>
                          ))}
                        </select>
                        {search.email && (
                          <Button size="sm" variant="outline">
                            <Mail size={14} className="mr-1" /> Email
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </TabsContent>

            {/* All Data Combined Tab */}
            <TabsContent value="all" className="space-y-3">
              <div className="text-center py-4 text-muted-foreground border-b mb-4">
                <p className="text-sm">
                  Combined view of all {externalBehavior.length + socialIntel.length + propertySearches.length} scraped
                  intelligence records
                </p>
              </div>

              {externalBehavior.length + socialIntel.length + propertySearches.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Database className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p>
                    No scraped data available. Configure ZenRows and Apify integrations to begin collecting
                    intelligence.
                  </p>
                </div>
              ) : (
                <>
                  {externalBehavior.length > 0 && (
                    <div className="mb-4">
                      <h3 className="font-semibold mb-2 text-blue-600">
                        Real Estate Sites ({externalBehavior.length})
                      </h3>
                      <p className="text-sm text-muted-foreground">See Zillow/Realtor tab for details</p>
                    </div>
                  )}
                  {socialIntel.length > 0 && (
                    <div className="mb-4">
                      <h3 className="font-semibold mb-2 text-green-600">Social Posts ({socialIntel.length})</h3>
                      <p className="text-sm text-muted-foreground">See Social Posts tab for details</p>
                    </div>
                  )}
                  {propertySearches.length > 0 && (
                    <div className="mb-4">
                      <h3 className="font-semibold mb-2 text-purple-600">
                        Property Searches ({propertySearches.length})
                      </h3>
                      <p className="text-sm text-muted-foreground">See Property Searches tab for details</p>
                    </div>
                  )}
                </>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  )
}
