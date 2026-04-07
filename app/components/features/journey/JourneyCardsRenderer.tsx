"use client"

import type React from "react"
import { useState, useEffect } from "react"
import {
  Home,
  CheckCircle,
  Search,
  TrendingUp,
  Play,
  Calendar,
  Shield,
  Clock,
  Map,
  DollarSign,
  Wrench,
  Loader2,
  Bot,
  Sparkles,
  ArrowRight,
} from "lucide-react"
import { supabaseService } from "../services/supabaseService"
import { executeWorkflow } from "../app/actions/workflows"
import type { JourneyState, JourneyBlueprint, JourneyStage } from "../types"
import { toast } from "sonner"

interface JourneyCardsRendererProps {
  userId: string
  userRole: string
  onNavigate?: (view: string) => void
}

const getStageProgress = (stage: JourneyStage) => {
  const stageMap: Record<JourneyStage, number> = {
    lead: 15,
    qualifying: 30,
    active: 50,
    under_contract: 75,
    closing: 90,
    post_close: 100,
  }
  return stageMap[stage] || 0
}

export const JourneyCardsRenderer: React.FC<JourneyCardsRendererProps> = ({ userId, userRole, onNavigate }) => {
  const [journeyState, setJourneyState] = useState<JourneyState | null>(null)
  const [blueprint, setBlueprint] = useState<JourneyBlueprint | null>(null)
  const [cards, setCards] = useState<any[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    loadJourneyData()
  }, [userId])

  const loadJourneyData = async () => {
    setIsLoading(true)

    let state = await supabaseService.getJourneyStateByUserId(userId)

    if (!state) {
      const leads = await supabaseService.getLeads()
      const contact = leads?.find((l) => l.id === userId)

      const transactions = await supabaseService.getTransactions()
      const transaction = transactions?.find((t) => t.clientName.includes(contact?.name || ""))

      const listings = await supabaseService.getListings()
      const listing = listings?.find((l) => l.sellerEmail === contact?.email)

      const persona = determinePersona(contact, transaction)
      const stage = determineStage(contact, transaction, listing)

      const newState = await supabaseService.createJourneyState({
        userId,
        persona,
        contactId: contact?.id,
        listingId: listing?.id,
        dealId: transaction?.id,
        currentStage: stage,
      })

      state = newState
    }

    if (state) {
      setJourneyState(state)
      const bp = await supabaseService.getBlueprintByPersonaStage(state.persona, state.currentStage)

      if (bp) {
        setBlueprint(bp)
        const parsedCards = JSON.parse(bp.cardsJson || "[]")
        setCards(parsedCards.sort((a: any, b: any) => (a.priority || 0) - (b.priority || 0)))
      }
    }

    setIsLoading(false)
  }

  const handleCardAction = async (card: any, action: any) => {
    if (action.type === "trigger_workflow") {
      await executeWorkflow(action.workflow, {
        userId,
        context: card.card_id,
      })
      toast.success(`${action.label} initiated`)
    } else if (action.type === "navigate") {
      if (onNavigate) onNavigate(action.url)
    } else if (action.type === "schedule_meeting") {
      toast.info("Opening meeting scheduler")
    }
  }

  if (isLoading) {
    return (
      <div className="py-20 text-center flex flex-col items-center justify-center animate-pulse">
        <Loader2 className="animate-spin text-indigo-600 mb-4" size={40} />
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Synthesizing Your Journey...</p>
      </div>
    )
  }

  if (!journeyState || !blueprint || cards.length === 0) {
    return (
      <div className="py-12 text-center bg-white rounded-3xl border border-dashed border-slate-200">
        <Bot size={40} className="mx-auto text-slate-200 mb-4" />
        <p className="text-slate-400 font-bold text-sm uppercase tracking-tight">
          Awaiting Personalized Protocol Generation.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Journey Progress Bar */}
      <div className="bg-slate-900 rounded-[2.5rem] p-8 text-white shadow-xl relative overflow-hidden border-b-8 border-indigo-600">
        <div className="absolute right-[-20px] top-[-20px] p-4 opacity-5">
          <ActivityIcon size={180} />
        </div>
        <div className="relative z-10">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-indigo-600 rounded-xl shadow-lg shadow-indigo-900/40">
                <Sparkles size={16} />
              </div>
              <div>
                <span className="text-[10px] font-black text-indigo-400 uppercase tracking-widest">Active Roadmap</span>
                <h4 className="text-xl font-black italic tracking-tighter uppercase leading-none">
                  {journeyState.persona.replace("_", " ")} •{" "}
                  <span className="text-indigo-400">{journeyState.currentStage}</span>
                </h4>
              </div>
            </div>
            <div className="text-right">
              <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest leading-none mb-1">
                COMPLETION
              </p>
              <span className="text-3xl font-black tabular-nums">{getStageProgress(journeyState.currentStage)}%</span>
            </div>
          </div>
          <div className="w-full bg-white/10 h-3 rounded-full overflow-hidden p-0.5 shadow-inner">
            <div
              className="h-full bg-indigo-500 rounded-full transition-all duration-1000 ease-out shadow-[0_0_10px_rgba(99,102,241,0.5)]"
              style={{ width: getStageProgress(journeyState.currentStage) + "%" }}
            />
          </div>
        </div>
      </div>

      {/* Dynamic Journey Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {cards.map((card) => (
          <JourneyCard key={card.card_id} card={card} onAction={handleCardAction} journeyState={journeyState} />
        ))}
      </div>
    </div>
  )
}

// Properly defined the props interface to include key indirectly and fix error on line 152
interface JourneyCardProps {
  card: any
  onAction: (card: any, action: any) => Promise<void>
  journeyState: JourneyState
}

// Changed to const React.FC to fix the "Property 'key' does not exist" type error when used in a map
const JourneyCard: React.FC<JourneyCardProps> = ({ card, onAction, journeyState }) => {
  const getIcon = (iconName: string) => {
    const icons: Record<string, any> = {
      home: Home,
      check: CheckCircle,
      search: Search,
      trending_up: TrendingUp,
      play: Play,
      calendar: Calendar,
      military: Shield,
      clock: Clock,
      map: Map,
      dollar: DollarSign,
      tool: Wrench,
    }
    return icons[iconName] || Home
  }

  const Icon = getIcon(card.icon)

  return (
    <div className="bg-white rounded-[2rem] p-8 border border-slate-200 shadow-sm hover:border-indigo-400 hover:shadow-xl transition-all group flex flex-col">
      <div className="flex items-start gap-5 mb-6">
        <div className="p-4 bg-indigo-50 rounded-2xl group-hover:scale-110 transition-transform shadow-inner">
          <Icon className="w-6 h-6 text-indigo-600" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-black text-slate-900 uppercase tracking-tight text-lg italic leading-none mb-2">
            {card.title}
          </h3>
          <p className="text-xs text-slate-500 font-medium leading-relaxed italic">"{card.description}"</p>
        </div>
      </div>

      {card.videoUrl && (
        <div className="mb-6 rounded-2xl overflow-hidden aspect-video bg-slate-900 relative group/video cursor-pointer">
          <img
            src={card.thumbnailUrl || "https://images.unsplash.com/photo-1560518883-ce09059eeffa?w=800"}
            className="w-full h-full object-cover opacity-60 group-hover/video:scale-105 transition-transform duration-700"
          />
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-16 h-16 bg-white/20 backdrop-blur-md rounded-full flex items-center justify-center border-2 border-white group-hover/video:scale-110 transition-transform shadow-2xl">
              <Play size={28} className="text-white fill-current ml-1" />
            </div>
          </div>
        </div>
      )}

      <div className="mt-auto space-y-3">
        {card.actions &&
          card.actions.length > 0 &&
          card.actions.map((action: any, idx: number) => (
            <button
              key={idx}
              onClick={() => onAction(card, action)}
              className="w-full py-4 bg-indigo-600 text-white rounded-2xl font-black uppercase text-[10px] tracking-widest shadow-xl hover:bg-indigo-700 active:scale-95 transition-all flex items-center justify-center gap-2 border-b-4 border-indigo-900"
            >
              {action.label} <ArrowRight size={14} />
            </button>
          ))}

        {card.status_field && JSON.parse(journeyState.metadataJson || "{}")[card.status_field] && (
          <div className="bg-emerald-50 text-emerald-700 px-4 py-2 rounded-xl border border-emerald-100 flex items-center justify-center gap-2 text-[10px] font-black uppercase tracking-widest">
            <CheckCircle size={14} /> Completed
          </div>
        )}
      </div>
    </div>
  )
}

const ActivityIcon = ({ size }: { size: number }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
  </svg>
)

function determinePersona(contact: any, transaction: any): string {
  if (transaction?.type === "seller" || contact?.intent?.toLowerCase().includes("sell")) {
    return "seller"
  }
  if (transaction?.type === "buyer" || contact?.intent?.toLowerCase().includes("buy")) {
    return "buyer"
  }
  return "lead"
}

function determineStage(contact: any, transaction: any, listing: any): JourneyStage {
  if (transaction?.status === "closed") return "post_close"
  if (transaction?.status === "closing") return "closing"
  if (transaction?.status === "under_contract") return "under_contract"
  if (listing || transaction) return "active"
  if (contact?.status === "qualifying") return "qualifying"
  return "lead"
}
