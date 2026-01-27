"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import {
  Video,
  Home,
  User,
  TrendingUp,
  Users,
  Calendar,
  Heart,
  MessageSquare,
  Sparkles,
  Wand2,
  Play,
  Loader2,
  ArrowLeft,
  ArrowRight,
  Check,
  RefreshCw,
  Save,
  Send,
  Download,
  Share2,
  Volume2,
  Palette,
  Clock,
  AlertCircle,
  CheckCircle2,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useAuth } from "@/contexts/AuthContext"
import { getVideoScriptLibrary, getVideoTemplates, queueVideoGeneration, getAgentVideoProfile, getVideoBrandingPresets, saveVideoScript } from "@/app/actions/video-generation"

const VIDEO_TYPES = [
  { id: "listing_tour", label: "Listing Tour", icon: Home, description: "Property walkthrough video", requiresProperty: true },
  { id: "agent_intro", label: "Agent Introduction", icon: User, description: "Personal brand video", requiresProperty: false },
  { id: "market_update", label: "Market Update", icon: TrendingUp, description: "Area market analysis", requiresProperty: false },
  { id: "personalized_buyer", label: "Personalized Buyer Message", icon: Users, description: "Custom client message", requiresClient: true },
  { id: "open_house", label: "Open House Promo", icon: Calendar, description: "Event promotion", requiresProperty: true },
  { id: "memory_video", label: "Memory Video", icon: Heart, description: "Seller story video", requiresClient: true },
  { id: "testimonial", label: "Testimonial", icon: MessageSquare, description: "Client review video", requiresClient: true },
]

const AVATARS = [
  { id: "professional_male", name: "Professional Male", style: "Professional", image: "/avatars/pro-male.jpg" },
  { id: "professional_female", name: "Professional Female", style: "Professional", image: "/avatars/pro-female.jpg" },
  { id: "casual_male", name: "Casual Male", style: "Casual", image: "/avatars/casual-male.jpg" },
  { id: "casual_female", name: "Casual Female", style: "Casual", image: "/avatars/casual-female.jpg" },
  { id: "luxury_male", name: "Luxury Male", style: "Luxury", image: "/avatars/luxury-male.jpg" },
  { id: "luxury_female", name: "Luxury Female", style: "Luxury", image: "/avatars/luxury-female.jpg" },
]

const VOICES = [
  { id: "en-us-professional", name: "Professional (US)", accent: "American" },
  { id: "en-us-friendly", name: "Friendly (US)", accent: "American" },
  { id: "en-gb-professional", name: "Professional (UK)", accent: "British" },
  { id: "es-mx-professional", name: "Professional (Spanish)", accent: "Mexican Spanish" },
]

export default function VideoCreationWizardPage() {
  const router = useRouter()
  const { user } = useAuth()
  const [currentStep, setCurrentStep] = useState(1)
  const [isGeneratingScript, setIsGeneratingScript] = useState(false)
  const [isGeneratingVideo, setIsGeneratingVideo] = useState(false)
  const [videoReady, setVideoReady] = useState(false)
  const [generatedVideoUrl, setGeneratedVideoUrl] = useState<string | null>(null)

  // Step 1: Video Type
  const [videoType, setVideoType] = useState<string>("")

  // Step 2: Context
  const [selectedProperty, setSelectedProperty] = useState<string>("")
  const [selectedClient, setSelectedClient] = useState<string>("")
  const [selectedArea, setSelectedArea] = useState<string>("")
  const [eventDate, setEventDate] = useState<string>("")
  const [eventTime, setEventTime] = useState<string>("")

  // Step 3: Script
  const [script, setScript] = useState<string>("")
  const [scriptTone, setScriptTone] = useState<string>("professional")
  const [estimatedDuration, setEstimatedDuration] = useState(0)

  // Step 4: Avatar & Voice
  const [selectedAvatar, setSelectedAvatar] = useState<string>("")
  const [selectedVoice, setSelectedVoice] = useState<string>("")

  // Step 5: Customization
  const [backgroundMusic, setBackgroundMusic] = useState<string>("none")
  const [logoPlacement, setLogoPlacement] = useState<string>("bottom-right")
  const [ctaText, setCtaText] = useState<string>("")
  const [ctaLink, setCtaLink] = useState<string>("")

  // Data
  const [properties, setProperties] = useState<any[]>([])
  const [clients, setClients] = useState<any[]>([])
  const [templates, setTemplates] = useState<any[]>([])
  const [brandingPresets, setBrandingPresets] = useState<any[]>([])

  // Calculate estimated duration based on word count
  useEffect(() => {
    const wordCount = script.split(/\s+/).filter(Boolean).length
    const duration = Math.ceil(wordCount / 2.5) // ~150 words per minute = 2.5 words per second
    setEstimatedDuration(duration)
  }, [script])

  // Load initial data
  useEffect(() => {
    async function loadData() {
      try {
        const [templatesData, presetsData] = await Promise.all([
          getVideoTemplates(),
          user?.id ? getVideoBrandingPresets(user.id) : Promise.resolve([]),
        ])
        setTemplates(templatesData)
        setBrandingPresets(presetsData)

        // Load demo properties and clients
        setProperties([
          { id: "prop-1", address: "123 Main Street, Miami, FL 33101", price: 450000 },
          { id: "prop-2", address: "456 Ocean Drive, Fort Lauderdale, FL 33316", price: 675000 },
          { id: "prop-3", address: "789 Palm Ave, West Palm Beach, FL 33401", price: 325000 },
        ])
        setClients([
          { id: "client-1", name: "John Smith", persona: "first_time_buyer" },
          { id: "client-2", name: "Sarah Johnson", persona: "investor" },
          { id: "client-3", name: "Michael Brown", persona: "downsizer" },
        ])
      } catch (error) {
        console.error("Error loading data:", error)
      }
    }
    loadData()
  }, [user?.id])

  const selectedVideoType = VIDEO_TYPES.find((t) => t.id === videoType)

  async function handleGenerateScript() {
    setIsGeneratingScript(true)
    try {
      const response = await fetch("/api/ai/generate-video-script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoType,
          propertyId: selectedProperty,
          clientId: selectedClient,
          area: selectedArea,
          eventDate,
          eventTime,
          tone: scriptTone,
          agentId: user?.id,
        }),
      })

      if (response.ok) {
        const data = await response.json()
        setScript(data.script || "")
      } else {
        // Fallback demo script
        setScript(getDemoScript())
      }
    } catch (error) {
      console.error("Script generation error:", error)
      setScript(getDemoScript())
    } finally {
      setIsGeneratingScript(false)
    }
  }

  function getDemoScript(): string {
    const scripts: Record<string, string> = {
      listing_tour: `Welcome to this stunning property at ${properties.find((p) => p.id === selectedProperty)?.address || "123 Main Street"}. 

As you step inside, you'll immediately notice the open floor plan that's perfect for modern living. The natural light flooding through the oversized windows creates an inviting atmosphere throughout.

The kitchen features granite countertops, stainless steel appliances, and ample cabinet space - ideal for both everyday cooking and entertaining guests.

Moving to the primary suite, you'll find a spacious retreat with walk-in closet and an en-suite bathroom with dual vanities.

The backyard offers a private oasis with mature landscaping and room for outdoor entertaining.

This home is priced at $${(properties.find((p) => p.id === selectedProperty)?.price || 450000).toLocaleString()} and won't last long. Schedule your private showing today!`,
      
      agent_intro: `Hi, I'm your dedicated real estate professional, and I'm thrilled to connect with you today.

What sets me apart? I believe in putting YOU first. Your goals, your timeline, your dreams - that's what drives every decision I make.

With extensive market knowledge and a commitment to honest communication, I'll guide you through every step of your real estate journey.

Whether you're buying your first home, selling a cherished property, or investing in your future, I'm here to make the process smooth and successful.

Let's chat about your real estate goals. Reach out today - I'm ready to help you make your next move your best move!`,
      
      personalized_buyer: `Hi ${clients.find((c) => c.id === selectedClient)?.name || "there"}! I was thinking of you today.

I know you've been searching for the perfect home that fits your specific needs, and I wanted to share some exciting news.

I've found a few properties that match exactly what you're looking for - the right price range, the neighborhood you love, and those must-have features we discussed.

I'd love to show you these homes this week. When works best for your schedule? Let me know and I'll set up private showings just for you.

Looking forward to helping you find your perfect home!`,
      
      market_update: `Let's talk about what's happening in the ${selectedArea || "local"} real estate market.

This month, we're seeing some interesting trends. Home prices have remained stable, with the median price holding steady compared to last month.

Inventory levels are showing slight improvements, giving buyers more options to choose from. However, well-priced homes in desirable locations are still moving quickly.

For sellers, this means pricing your home correctly from day one is crucial. For buyers, being pre-approved and ready to act can give you a competitive edge.

Want a personalized market analysis for your specific situation? Reach out - I'm happy to provide detailed insights for your neighborhood!`,
      
      open_house: `Don't miss this incredible opportunity! Join me this ${eventDate || "Saturday"} from ${eventTime || "1-4 PM"} for an exclusive open house.

This stunning property features everything you've been looking for and more. From the moment you walk in, you'll feel right at home.

Mark your calendar, bring your questions, and come see why this could be your next home sweet home.

I'll be there to answer all your questions and give you a personal tour. See you there!`,
      
      memory_video: `This home has been more than just a house - it's been the backdrop for countless memories, celebrations, and everyday moments that make life special.

From holiday gatherings in the living room to summer evenings in the backyard, these walls have witnessed so many beautiful chapters.

Now, as this home prepares to welcome its next family, we celebrate the memories made here and look forward to the new stories waiting to be written.

Thank you for sharing your home's story with us. Here's to new beginnings!`,
      
      testimonial: `Working with my agent was an absolute game-changer. From our first meeting, I felt heard and understood.

They took the time to really understand what I was looking for, and their market knowledge was incredible. Every step of the way, I felt supported and informed.

What impressed me most was their dedication. They went above and beyond to make sure I found not just any home, but the perfect home for me.

If you're thinking about buying or selling, I can't recommend them highly enough. They truly put their clients first!`,
    }
    return scripts[videoType] || scripts.agent_intro
  }

  async function handleGenerateVideo() {
    setIsGeneratingVideo(true)
    try {
      const response = await fetch("/api/heygen/generate-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: user?.id,
          script,
          videoType,
          avatarId: selectedAvatar,
          voiceId: selectedVoice,
          propertyId: selectedProperty,
          clientId: selectedClient,
          branding: {
            logoPlacement,
            backgroundMusic,
            ctaText,
            ctaLink,
          },
        }),
      })

      if (response.ok) {
        const data = await response.json()
        // In real implementation, we'd poll for status
        // For now, simulate completion after a delay
        setTimeout(() => {
          setVideoReady(true)
          setGeneratedVideoUrl(data.videoUrl || "/demo-video.mp4")
          setIsGeneratingVideo(false)
        }, 3000)
      } else {
        setIsGeneratingVideo(false)
        alert("Video generation failed. Please try again.")
      }
    } catch (error) {
      console.error("Video generation error:", error)
      setIsGeneratingVideo(false)
    }
  }

  async function handleSaveAsTemplate() {
    if (!user?.id) return
    try {
      await saveVideoScript({
        agentId: user.id,
        scriptName: `${selectedVideoType?.label} Template`,
        scriptType: videoType,
        category: selectedVideoType?.label || "General",
        scriptContent: script,
        duration: estimatedDuration,
        isTemplate: true,
      })
      alert("Script saved as template!")
    } catch (error) {
      console.error("Error saving template:", error)
    }
  }

  const canProceed = () => {
    switch (currentStep) {
      case 1:
        return !!videoType
      case 2:
        if (selectedVideoType?.requiresProperty) return !!selectedProperty
        if (selectedVideoType?.requiresClient) return !!selectedClient
        if (videoType === "market_update") return !!selectedArea
        if (videoType === "open_house") return !!selectedProperty && !!eventDate
        return true
      case 3:
        return script.length >= 50
      case 4:
        return !!selectedAvatar && !!selectedVoice
      case 5:
        return true
      default:
        return true
    }
  }

  const steps = [
    { number: 1, label: "Video Type" },
    { number: 2, label: "Context" },
    { number: 3, label: "Script" },
    { number: 4, label: "Avatar & Voice" },
    { number: 5, label: "Customize" },
    { number: 6, label: "Generate" },
    { number: 7, label: "Share" },
  ]

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="container mx-auto py-8 px-4 max-w-5xl">
        {/* Header */}
        <div className="mb-8">
          <Button variant="outline" onClick={() => router.back()} className="mb-4">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>
          <h1 className="text-3xl font-bold text-slate-900">Create AI Video</h1>
          <p className="text-slate-600 mt-1">Step-by-step wizard to create personalized videos</p>
        </div>

        {/* Progress Steps */}
        <div className="mb-8">
          <div className="flex items-center justify-between">
            {steps.map((step, index) => (
              <div key={step.number} className="flex items-center">
                <div
                  className={cn(
                    "w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium transition-colors",
                    currentStep > step.number
                      ? "bg-green-600 text-white"
                      : currentStep === step.number
                        ? "bg-blue-600 text-white"
                        : "bg-slate-200 text-slate-600"
                  )}
                >
                  {currentStep > step.number ? <Check className="h-5 w-5" /> : step.number}
                </div>
                {index < steps.length - 1 && (
                  <div
                    className={cn(
                      "w-12 md:w-20 h-1 mx-1",
                      currentStep > step.number ? "bg-green-600" : "bg-slate-200"
                    )}
                  />
                )}
              </div>
            ))}
          </div>
          <div className="flex justify-between mt-2 px-1">
            {steps.map((step) => (
              <span
                key={step.number}
                className={cn(
                  "text-xs hidden md:block",
                  currentStep >= step.number ? "text-slate-900" : "text-slate-400"
                )}
              >
                {step.label}
              </span>
            ))}
          </div>
        </div>

        {/* Step Content */}
        <Card className="mb-6">
          <CardContent className="p-6">
            {/* Step 1: Video Type Selection */}
            {currentStep === 1 && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-xl font-semibold mb-2">Select Video Type</h2>
                  <p className="text-slate-600">Choose the type of video you want to create</p>
                </div>
                <RadioGroup value={videoType} onValueChange={setVideoType} className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {VIDEO_TYPES.map((type) => (
                    <Label
                      key={type.id}
                      htmlFor={type.id}
                      className={cn(
                        "flex items-start gap-4 p-4 rounded-lg border-2 cursor-pointer transition-colors",
                        videoType === type.id
                          ? "border-blue-600 bg-blue-50"
                          : "border-slate-200 hover:border-slate-300"
                      )}
                    >
                      <RadioGroupItem value={type.id} id={type.id} className="mt-1" />
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <type.icon className="h-5 w-5 text-slate-600" />
                          <span className="font-medium">{type.label}</span>
                        </div>
                        <p className="text-sm text-slate-500 mt-1">{type.description}</p>
                      </div>
                    </Label>
                  ))}
                </RadioGroup>
              </div>
            )}

            {/* Step 2: Context Selection */}
            {currentStep === 2 && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-xl font-semibold mb-2">Add Context</h2>
                  <p className="text-slate-600">Provide details for your {selectedVideoType?.label} video</p>
                </div>

                {selectedVideoType?.requiresProperty && (
                  <div className="space-y-2">
                    <Label>Select Property</Label>
                    <Select value={selectedProperty} onValueChange={setSelectedProperty}>
                      <SelectTrigger>
                        <SelectValue placeholder="Choose a property" />
                      </SelectTrigger>
                      <SelectContent>
                        {properties.map((prop) => (
                          <SelectItem key={prop.id} value={prop.id}>
                            {prop.address} - ${prop.price.toLocaleString()}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {selectedVideoType?.requiresClient && (
                  <div className="space-y-2">
                    <Label>Select Client</Label>
                    <Select value={selectedClient} onValueChange={setSelectedClient}>
                      <SelectTrigger>
                        <SelectValue placeholder="Choose a client" />
                      </SelectTrigger>
                      <SelectContent>
                        {clients.map((client) => (
                          <SelectItem key={client.id} value={client.id}>
                            {client.name} ({client.persona.replace("_", " ")})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {videoType === "market_update" && (
                  <div className="space-y-2">
                    <Label>Area / ZIP Code</Label>
                    <Input
                      value={selectedArea}
                      onChange={(e) => setSelectedArea(e.target.value)}
                      placeholder="e.g., Miami Beach or 33139"
                    />
                  </div>
                )}

                {videoType === "open_house" && (
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Event Date</Label>
                      <Input type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label>Event Time</Label>
                      <Input
                        value={eventTime}
                        onChange={(e) => setEventTime(e.target.value)}
                        placeholder="e.g., 1:00 PM - 4:00 PM"
                      />
                    </div>
                  </div>
                )}

                {videoType === "agent_intro" && (
                  <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                    <p className="text-sm text-blue-700">
                      No additional context needed for Agent Introduction videos. We'll use your profile information to create a personalized script.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Step 3: AI Script Generation */}
            {currentStep === 3 && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-xl font-semibold mb-2">AI Script Generation</h2>
                  <p className="text-slate-600">Generate and customize your video script</p>
                </div>

                <div className="flex items-center gap-4 mb-4">
                  <div className="flex-1">
                    <Label>Script Tone</Label>
                    <Select value={scriptTone} onValueChange={setScriptTone}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="professional">Professional</SelectItem>
                        <SelectItem value="friendly">Friendly & Warm</SelectItem>
                        <SelectItem value="luxury">Luxury & Sophisticated</SelectItem>
                        <SelectItem value="energetic">Energetic & Exciting</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Button onClick={handleGenerateScript} disabled={isGeneratingScript} className="mt-6">
                    {isGeneratingScript ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Generating...
                      </>
                    ) : (
                      <>
                        <Wand2 className="h-4 w-4 mr-2" />
                        Generate Script
                      </>
                    )}
                  </Button>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Script</Label>
                    <div className="flex items-center gap-2 text-sm text-slate-500">
                      <Clock className="h-4 w-4" />
                      <span>~{estimatedDuration} seconds</span>
                      <span className="mx-2">|</span>
                      <span>{script.split(/\s+/).filter(Boolean).length} words</span>
                    </div>
                  </div>
                  <Textarea
                    value={script}
                    onChange={(e) => setScript(e.target.value)}
                    placeholder="Your video script will appear here..."
                    className="min-h-[300px] font-mono text-sm"
                  />
                </div>

                <div className="flex items-center gap-2">
                  <Button variant="outline" onClick={handleGenerateScript} disabled={isGeneratingScript}>
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Regenerate
                  </Button>
                  <Button variant="outline" onClick={handleSaveAsTemplate}>
                    <Save className="h-4 w-4 mr-2" />
                    Save as Template
                  </Button>
                </div>
              </div>
            )}

            {/* Step 4: Avatar & Voice Selection */}
            {currentStep === 4 && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-xl font-semibold mb-2">Choose Avatar & Voice</h2>
                  <p className="text-slate-600">Select the AI presenter for your video</p>
                </div>

                <div className="space-y-4">
                  <Label>Avatar Style</Label>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                    {AVATARS.map((avatar) => (
                      <div
                        key={avatar.id}
                        onClick={() => setSelectedAvatar(avatar.id)}
                        className={cn(
                          "p-4 rounded-lg border-2 cursor-pointer transition-colors text-center",
                          selectedAvatar === avatar.id
                            ? "border-blue-600 bg-blue-50"
                            : "border-slate-200 hover:border-slate-300"
                        )}
                      >
                        <div className="w-20 h-20 mx-auto bg-slate-200 rounded-full mb-3 flex items-center justify-center">
                          <User className="h-10 w-10 text-slate-400" />
                        </div>
                        <p className="font-medium">{avatar.name}</p>
                        <Badge variant="secondary" className="mt-1">
                          {avatar.style}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Voice</Label>
                  <Select value={selectedVoice} onValueChange={setSelectedVoice}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a voice" />
                    </SelectTrigger>
                    <SelectContent>
                      {VOICES.map((voice) => (
                        <SelectItem key={voice.id} value={voice.id}>
                          <div className="flex items-center gap-2">
                            <Volume2 className="h-4 w-4" />
                            {voice.name} - {voice.accent}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {/* Step 5: Preview & Customize */}
            {currentStep === 5 && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-xl font-semibold mb-2">Customize Your Video</h2>
                  <p className="text-slate-600">Add branding and finishing touches</p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <Label>Background Music</Label>
                    <Select value={backgroundMusic} onValueChange={setBackgroundMusic}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No Music</SelectItem>
                        <SelectItem value="upbeat">Upbeat & Modern</SelectItem>
                        <SelectItem value="corporate">Corporate & Professional</SelectItem>
                        <SelectItem value="luxury">Luxury & Elegant</SelectItem>
                        <SelectItem value="inspiring">Inspiring & Emotional</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Logo Placement</Label>
                    <Select value={logoPlacement} onValueChange={setLogoPlacement}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="top-left">Top Left</SelectItem>
                        <SelectItem value="top-right">Top Right</SelectItem>
                        <SelectItem value="bottom-left">Bottom Left</SelectItem>
                        <SelectItem value="bottom-right">Bottom Right</SelectItem>
                        <SelectItem value="none">No Logo</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Call-to-Action Text</Label>
                    <Input
                      value={ctaText}
                      onChange={(e) => setCtaText(e.target.value)}
                      placeholder="e.g., Schedule a Showing"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>CTA Link</Label>
                    <Input
                      value={ctaLink}
                      onChange={(e) => setCtaLink(e.target.value)}
                      placeholder="https://..."
                    />
                  </div>
                </div>

                <div className="p-4 bg-slate-50 rounded-lg border">
                  <h3 className="font-medium mb-3">Video Preview Summary</h3>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-slate-500">Type:</span> {selectedVideoType?.label}
                    </div>
                    <div>
                      <span className="text-slate-500">Duration:</span> ~{estimatedDuration} seconds
                    </div>
                    <div>
                      <span className="text-slate-500">Avatar:</span> {AVATARS.find((a) => a.id === selectedAvatar)?.name || "Not selected"}
                    </div>
                    <div>
                      <span className="text-slate-500">Voice:</span> {VOICES.find((v) => v.id === selectedVoice)?.name || "Not selected"}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Step 6: Generate Video */}
            {currentStep === 6 && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-xl font-semibold mb-2">Generate Your Video</h2>
                  <p className="text-slate-600">Review and start video generation</p>
                </div>

                {!isGeneratingVideo && !videoReady && (
                  <>
                    <div className="p-4 bg-amber-50 rounded-lg border border-amber-200">
                      <div className="flex items-start gap-3">
                        <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5" />
                        <div>
                          <p className="font-medium text-amber-800">Estimated Generation Time</p>
                          <p className="text-sm text-amber-700">
                            Video generation typically takes 15-30 minutes. You'll receive a notification when it's ready.
                          </p>
                        </div>
                      </div>
                    </div>

                    <Button onClick={handleGenerateVideo} size="lg" className="w-full">
                      <Sparkles className="h-5 w-5 mr-2" />
                      Generate Video
                    </Button>
                  </>
                )}

                {isGeneratingVideo && (
                  <div className="text-center py-12">
                    <Loader2 className="h-16 w-16 animate-spin text-blue-600 mx-auto mb-4" />
                    <h3 className="text-lg font-medium mb-2">Generating Your Video</h3>
                    <p className="text-slate-500 mb-6">This may take 15-30 minutes. Feel free to navigate away.</p>
                    <div className="space-y-2 text-left max-w-sm mx-auto">
                      <div className="flex items-center gap-2 text-green-600">
                        <CheckCircle2 className="h-4 w-4" />
                        <span className="text-sm">Script submitted</span>
                      </div>
                      <div className="flex items-center gap-2 text-blue-600">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span className="text-sm">Video rendering...</span>
                      </div>
                      <div className="flex items-center gap-2 text-slate-400">
                        <Clock className="h-4 w-4" />
                        <span className="text-sm">Processing complete</span>
                      </div>
                      <div className="flex items-center gap-2 text-slate-400">
                        <Check className="h-4 w-4" />
                        <span className="text-sm">Video ready</span>
                      </div>
                    </div>
                  </div>
                )}

                {videoReady && (
                  <div className="text-center py-8">
                    <div className="w-20 h-20 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
                      <CheckCircle2 className="h-10 w-10 text-green-600" />
                    </div>
                    <h3 className="text-lg font-medium mb-2">Video Ready!</h3>
                    <p className="text-slate-500 mb-6">Your video has been generated successfully.</p>
                    <Button onClick={() => setCurrentStep(7)} size="lg">
                      Review & Share
                      <ArrowRight className="h-4 w-4 ml-2" />
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Step 7: Review & Share */}
            {currentStep === 7 && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-xl font-semibold mb-2">Review & Share</h2>
                  <p className="text-slate-600">Preview your video and share it with clients</p>
                </div>

                <div className="aspect-video bg-slate-900 rounded-lg flex items-center justify-center">
                  <div className="text-center text-white">
                    <Play className="h-16 w-16 mx-auto mb-4 opacity-80" />
                    <p>Video Preview</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <Button variant="outline" className="w-full bg-transparent">
                    <Download className="h-4 w-4 mr-2" />
                    Download
                  </Button>
                  <Button variant="outline" className="w-full bg-transparent">
                    <Send className="h-4 w-4 mr-2" />
                    Email to Client
                  </Button>
                  <Button variant="outline" className="w-full bg-transparent">
                    <MessageSquare className="h-4 w-4 mr-2" />
                    SMS to Client
                  </Button>
                  <Button variant="outline" className="w-full bg-transparent">
                    <Share2 className="h-4 w-4 mr-2" />
                    Share Link
                  </Button>
                </div>

                <div className="p-4 bg-slate-50 rounded-lg border">
                  <h3 className="font-medium mb-3">Share Options</h3>
                  <div className="space-y-2">
                    <label className="flex items-center gap-2">
                      <input type="checkbox" className="rounded" />
                      <span className="text-sm">Add to client portal</span>
                    </label>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" className="rounded" />
                      <span className="text-sm">Post to social media</span>
                    </label>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" className="rounded" />
                      <span className="text-sm">Include in email campaign</span>
                    </label>
                  </div>
                </div>

                <Button onClick={() => router.push("/dashboard/videos/library")} className="w-full">
                  Go to Video Library
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Navigation Buttons */}
        <div className="flex justify-between">
          <Button
            variant="outline"
            onClick={() => setCurrentStep((prev) => Math.max(1, prev - 1))}
            disabled={currentStep === 1}
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Previous
          </Button>
          {currentStep < 6 && (
            <Button
              onClick={() => setCurrentStep((prev) => Math.min(7, prev + 1))}
              disabled={!canProceed()}
            >
              Next
              <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
