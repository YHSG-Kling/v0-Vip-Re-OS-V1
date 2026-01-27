"use client"

import type React from "react"
import { useState, useCallback, useEffect, lazy, Suspense } from "react"
import Sidebar from "./components/Sidebar"
import { permissionsService } from "./services/permissionsService"
import { ToastContainer, type ToastMessage } from "./components/ui/Toast"
import { UserRole, type Listing, type UserContext } from "./types"
import { AuthProvider, useAuth } from "./contexts/AuthContext"
import { LayoutDashboard, MessageSquare, Briefcase, Navigation, Calendar, ShieldAlert, Loader2 } from "lucide-react"
import { VoiceAssistant } from "./components/VoiceAssistant"

// Only LoginPage is loaded eagerly since it's the first screen
import LoginPage from "./pages/auth/LoginPage"
import OnboardingDashboard from "./pages/agent/OnboardingDashboard" // Declare OnboardingDashboard variable

// Lazy load all other components - they'll only be loaded when needed
const AgentDashboard = lazy(() => import("./pages/agent/AgentDashboard"))
const BrokerDashboard = lazy(() => import("./pages/admin/BrokerDashboard"))
const UserManagement = lazy(() => import("./pages/admin/UserManagement"))
const ListingApprovals = lazy(() => import("./pages/admin/ListingApprovals"))
const ListingDistribution = lazy(() => import("./pages/admin/ListingDistribution"))
const OpenHouseManager = lazy(() => import("./pages/agent/OpenHouseManager"))
const ShowingsDesk = lazy(() => import("./pages/agent/ShowingsDesk"))
const FeedbackDesk = lazy(() => import("./pages/agent/FeedbackDesk"))
const CalendarDashboard = lazy(() => import("./pages/common/CalendarDashboard"))
const SegmentationDesk = lazy(() => import("./pages/admin/SegmentationDesk"))
const LeadDistribution = lazy(() => import("./pages/admin/LeadDistribution"))
const ListingReports = lazy(() => import("./pages/agent/ListingReports"))
const NotificationSettings = lazy(() => import("./pages/agent/NotificationSettings"))
const DataHealth = lazy(() => import("./pages/admin/DataHealth"))
const ComplianceManager = lazy(() => import("./pages/admin/ComplianceManager"))
const RiskManagement = lazy(() => import("./pages/admin/RiskManagement"))
const BuyerPortal = lazy(() => import("./pages/client/BuyerPortal"))
const ClientPlaybook = lazy(() => import("./pages/client/ClientPlaybook"))
const SmartCMA = lazy(() => import("./components/AI/CMAGenerator"))
const MarketingStudio = lazy(() => import("./pages/agent/MarketingStudio"))
const SmartGuide = lazy(() => import("./components/AI/SmartGuide"))
const TransactionManager = lazy(() => import("./pages/agent/TransactionManager"))
const PartnersManager = lazy(() => import("./pages/admin/PartnersManager"))
const VendorMarketplace = lazy(() => import("./pages/client/VendorMarketplace"))
const VendorCompliance = lazy(() => import("./pages/admin/VendorCompliance"))
const SystemConfig = lazy(() => import("./pages/admin/SystemConfig"))
const UnifiedInbox = lazy(() => import("./pages/agent/UnifiedInbox"))
const SellerDashboard = lazy(() => import("./pages/seller/SellerDashboard"))
const ListingJourney = lazy(() => import("./pages/seller/ListingJourney"))
const Financials = lazy(() => import("./pages/admin/Financials"))
const FinancialsView = lazy(() => import("./pages/agent/FinancialsView"))
const AgentRoster = lazy(() => import("./pages/admin/AgentRoster"))
const SmartMatches = lazy(() => import("./pages/client/SmartMatches"))
const Documents = lazy(() => import("./pages/common/Documents"))
const ListingIntake = lazy(() => import("./pages/agent/ListingIntake"))
const SphereManager = lazy(() => import("./pages/agent/SphereManager"))
const SystemHealth = lazy(() => import("./pages/admin/SystemHealth"))
const MapIntelligence = lazy(() => import("./pages/agent/MapIntelligence"))
const AIAudit = lazy(() => import("./pages/admin/AIAudit"))
const OpenHouseKiosk = lazy(() => import("./pages/public/OpenHouseKiosk"))
const QuickActionsFAB = lazy(() => import("./components/mobile/QuickActionsFAB"))
const SmartListingLanding = lazy(() => import("./pages/public/SmartListingLanding"))
const Events = lazy(() => import("./pages/common/Events"))
const ReferralPartnerPortal = lazy(() => import("./pages/public/ReferralPartnerPortal"))
const ClosingDashboard = lazy(() => import("./pages/agent/ClosingDashboard"))
const HomeValuePortal = lazy(() => import("./pages/client/HomeValuePortal"))
const SocialScheduler = lazy(() => import("./pages/common/SocialScheduler"))
const ShareableAssets = lazy(() => import("./pages/seller/ShareableAssets"))
const BuyerTours = lazy(() => import("./pages/agent/BuyerTours"))
const OfferLab = lazy(() => import("./pages/agent/OfferLab"))
const RecruitingHub = lazy(() => import("./pages/admin/RecruitingHub"))
const AIToolsHub = lazy(() => import("./pages/agent/AIToolsHub"))
const InvestorDashboard = lazy(() => import("./pages/investor/InvestorDashboard"))
const FSBODashboard = lazy(() => import("./pages/contact/FSBODashboard"))
const MotivatedSellerDashboard = lazy(() => import("./pages/contact/MotivatedSellerDashboard"))
const FirstTimeBuyerDashboard = lazy(() => import("./pages/contact/FirstTimeBuyerDashboard"))
const LuxuryBuyerDashboard = lazy(() => import("./pages/contact/LuxuryBuyerDashboard"))
const LuxurySellerDashboard = lazy(() => import("./pages/contact/LuxurySellerDashboard"))
const RelocatingDashboard = lazy(() => import("./pages/contact/RelocatingDashboard"))
const ProbateDashboard = lazy(() => import("./pages/contact/ProbateDashboard"))
const DivorceDashboard = lazy(() => import("./pages/contact/DivorceDashboard"))
const SeniorDashboard = lazy(() => import("./pages/contact/SeniorDashboard"))
const RemoteSellerDashboard = lazy(() => import("./pages/contact/RemoteSellerDashboard"))
const ExpiredListingDashboard = lazy(() => import("./pages/contact/ExpiredListingDashboard"))
const DefaultContactDashboard = lazy(() => import("./pages/contact/DefaultContactDashboard"))
const TCDashboard = lazy(() => import("./pages/tc/TCDashboard"))
const FloatingAIAssistant = lazy(() =>
  import("./components/AI/FloatingAIAssistant").then((m) => ({ default: m.FloatingAIAssistant })),
)
const VoiceCommandButton = lazy(() =>
  import("./components/AI/VoiceCommandButton").then((m) => ({ default: m.VoiceCommandButton })),
)
const ContentStudioPage = lazy(() => import("./app/content-studio/content-studio-client"))
const SocialPlannerPage = lazy(() => import("./app/social-planner/social-planner-content"))
const CRM = lazy(() => import("./pages/agent/CRM"))
const LeadIntelligenceDashboard = lazy(() => import("./pages/intelligence/LeadIntelligenceDashboard"))
const AIChatDashboard = lazy(() => import("./pages/chat/AIChatDashboard"))
const IntelligenceDashboard = lazy(() => import("./pages/intelligence/IntelligenceDashboard"))
const LeadScrapingConfig = lazy(() => import("./pages/admin/LeadScrapingConfig"))
const MilitaryBuyerDashboard = lazy(() => import("./pages/contact/MilitaryBuyerDashboard"))
const UpsizingDashboard = lazy(() => import("./pages/contact/UpsizingDashboard"))
const DownsizingDashboard = lazy(() => import("./pages/contact/DownsizingDashboard"))
const ConversationAnalytics = lazy(() => import("./pages/admin/ConversationAnalytics"))
const VoiceCallBridge = lazy(() => import("./pages/agent/VoiceCallBridge"))
const AIISADashboard = lazy(() => import("./pages/agent/AIISADashboard"))
const LeadScoringDashboard = lazy(() => import("./pages/agent/LeadScoringDashboard"))
const IntegrationHub = lazy(() => import("./pages/admin/IntegrationHub"))

const LoadingSpinner = () => (
  <div className="flex items-center justify-center h-full min-h-[400px]">
    <div className="flex flex-col items-center gap-3">
      <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      <span className="text-sm text-slate-500">Loading...</span>
    </div>
  </div>
)

const MobileNavItem: React.FC<{ icon: any; active: boolean; onClick: () => void }> = ({
  icon: Icon,
  active,
  onClick,
}) => (
  <button
    onClick={onClick}
    className={`p-3 rounded-2xl transition-all ${active ? "bg-indigo-50 text-indigo-600 shadow-inner" : "text-slate-400 hover:text-slate-600"}`}
  >
    <Icon size={24} />
  </button>
)

const SmartEngineApp: React.FC = () => {
  const { user, role, isLoading, signIn, signOut } = useAuth()
  const [currentView, setCurrentView] = useState("agent-dashboard")
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const [activeListingForReport, setActiveListingForReport] = useState<Listing | null>(null)
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768)
  const [userContext, setUserContext] = useState<UserContext | null>(null)
  const [initialDeepLink, setInitialDeepLink] = useState<{ action: string; id: string } | null>(null)
  const [isQRView, setIsQRView] = useState(false)
  const [isPartnerView, setIsPartnerView] = useState(false)
  const [userPersona, setUserPersona] = useState<string | null>(null)
  const [isLoggedIn, setIsLoggedIn] = useState(false); // Declare isLoggedIn variable

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener("resize", handleResize)

    const handleNavigate = (e: any) => {
      setCurrentView(e.detail)
    }
    window.addEventListener("smart-engine-navigate", handleNavigate)

    return () => {
      window.removeEventListener("resize", handleResize)
      window.removeEventListener("smart-engine-navigate", handleNavigate)
    }
  }, [])

  const canAccessView = (view: string): boolean => {
    return permissionsService.canAccessView(role as UserRole, view)
  }

  const AccessDenied = () => (
    <div className="flex flex-col items-center justify-center h-[60vh] text-slate-400 p-12 text-center">
      <ShieldAlert size={64} className="opacity-20 mb-6" />
      <h3 className="text-2xl font-black text-slate-800 uppercase italic">Access Restricted</h3>
      <p className="text-[10px] font-black uppercase tracking-[0.2em] mt-4">
        You don't have permission to view this page.
      </p>
      <p className="text-sm text-slate-500 mt-2">Contact your administrator if you believe this is an error.</p>
    </div>
  )

  const renderContent = () => {
    if (isQRView) return <SmartListingLanding />
    if (isPartnerView) return <ReferralPartnerPortal />

    if (!canAccessView(currentView) && !["agent-dashboard", "broker-dashboard"].includes(currentView)) {
      const isContactPersonaView = currentView.includes("-dashboard") && role === UserRole.CONTACT
      if (!isContactPersonaView) {
        return <AccessDenied />
      }
    }

    if (role === UserRole.CONTACT) {
      const personaMap: { [key: string]: React.ReactNode } = {
        first_time_buyer: <FirstTimeBuyerDashboard />,
        luxury_buyer: <LuxuryBuyerDashboard />,
        luxury_seller: <LuxurySellerDashboard />,
        investor: <InvestorDashboard />,
        motivated_seller: <MotivatedSellerDashboard />,
        relocating: <RelocatingDashboard />,
        probate: <ProbateDashboard />,
        divorce: <DivorceDashboard />,
        senior: <SeniorDashboard />,
        empty_nester: <SeniorDashboard />,
        remote_seller: <RemoteSellerDashboard />,
        expired: <ExpiredListingDashboard />,
        fsbo: <FSBODashboard />,
        military_buyer: <MilitaryBuyerDashboard />,
        upsizing: <UpsizingDashboard />,
        downsizing: <DownsizingDashboard />,
      }

      return personaMap[userPersona || "default"] || <DefaultContactDashboard />
    }

    if (role === UserRole.TC) {
      return <TCDashboard />
    }

    switch (currentView) {
      case "agent-dashboard":
        return <AgentDashboard userContext={userContext} onNavigate={setCurrentView} />
      case "broker-dashboard":
        return permissionsService.isAdminOrBroker(role as UserRole) ? (
          <BrokerDashboard />
        ) : (
          <AgentDashboard userContext={userContext} onNavigate={setCurrentView} />
        )
      case "financials":
        return permissionsService.isAdminOrBroker(role as UserRole) ? <Financials /> : <FinancialsView />
      case "user-management":
        return <UserManagement />
      case "recruiting-hub":
        return <RecruitingHub />
      case "offer-lab":
        return <OfferLab initialLeadId={initialDeepLink?.id} />
      case "risk-management":
        return <RiskManagement />
      case "listing-approvals":
        return <ListingApprovals />
      case "listing-distribution":
        return <ListingDistribution />
      case "oh-manager":
        return <OpenHouseManager />
      case "showings":
        return <ShowingsDesk />
      case "buyer-tours":
        return <BuyerTours />
      case "feedback-log":
        return <FeedbackDesk />
      case "voice-call-bridge":
        return <VoiceCallBridge />
      case "ai-isa":
        return <AIISADashboard />
      case "agent-onboarding":
        return <OnboardingDashboard />
      case "calendar":
        return <CalendarDashboard />
      case "segmentation":
        return <SegmentationDesk />
      case "data-health":
        return <DataHealth />
      case "lead-distribution":
        return <LeadDistribution />
      case "notifications":
        return <NotificationSettings />
      case "listing-intake":
        return <ListingIntake />
      case "crm":
        return (
          <CRM
            onGenerateOffer={(id) => {
              setInitialDeepLink({ action: "generate_offer", id })
              setCurrentView("offer-lab")
            }}
            onNavigate={setCurrentView}
          />
        )
      case "lead-intelligence":
      case "lead-insights":
        return <LeadIntelligenceDashboard userId={user?.id} userRole={role as string} />
      case "lead-scoring":
        return <LeadScoringDashboard />
      case "transactions":
        return <TransactionManager initialDealId={initialDeepLink?.id} />
      case "closing-dashboard":
        return <ClosingDashboard />
      case "sphere":
        return <SphereManager />
      case "documents":
        return <Documents />
      case "marketing":
        return <MarketingStudio />
      case "social-scheduler":
        return <SocialScheduler />
      case "shareable-assets":
        return <ShareableAssets />
      case "cma":
        return <SmartCMA />
      case "inbox":
        return <UnifiedInbox isMobile={isMobile} />
      case "partners":
        return <PartnersManager />
      case "map-intelligence":
        return <MapIntelligence />
      case "listing-reports":
        return activeListingForReport ? (
          <ListingReports listing={activeListingForReport} onBack={() => setCurrentView("agent-dashboard")} />
        ) : (
          <AgentDashboard userContext={userContext} />
        )
      case "compliance":
        return <ComplianceManager />
      case "agents":
      case "agent-roster":
        return <AgentRoster />
      case "system-health":
        return <SystemHealth />
      case "settings":
        return <SystemConfig />
      case "knowledge-base":
        return <div>Knowledge Base Content</div> // Placeholder for Knowledge Base content
      case "ai-audit":
        return <AIAudit />
      case "conversation-analytics":
        return <ConversationAnalytics />
      case "vendor-compliance":
        return <VendorCompliance />
      case "buyer-dashboard":
        return <BuyerPortal onNavigate={setCurrentView} isMobile={isMobile} />
      case "home-value":
        return <HomeValuePortal />
      case "playbook":
        return <ClientPlaybook />
      case "matches":
        return <SmartMatches />
      case "marketplace":
        return <VendorMarketplace />
      case "listing-journey":
        return <ListingJourney />
      case "seller-dashboard":
        return <SellerDashboard onNavigate={setCurrentView} initialAction={initialDeepLink?.action} />
      case "open-house":
        return <OpenHouseKiosk />
      case "events":
        return <Events />
      case "ai-tools":
        return <AIToolsHub />
      case "content-studio":
        return <ContentStudioPage userId={user?.id} userRole={role as string} />
      case "social-planner":
        return <SocialPlannerPage userId={user?.id} userRole={role as string} />
      case "ai-chat":
        return <AIChatDashboard userId={user?.id} userRole={role as string} />
      case "intelligence":
        return <IntelligenceDashboard />
      case "lead-scraping-config":
        return <LeadScrapingConfig />
      case "integrations":
        return <IntegrationHub />
      default:
        return (
          <div className="flex items-center justify-center h-[50vh] text-slate-400 font-bold uppercase tracking-widest">
            Initializing: {currentView}
          </div>
        )
    }
  }

  useEffect(() => {
    setIsLoggedIn(!!user);
  }, [user]);

  if (isLoading)
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600"></div>
      </div>
    )

  if (!user && !isQRView && !isPartnerView)
    return (
      <>
        <ToastContainer toasts={toasts} removeToast={removeToast} />
        <LoginPage
          onLogin={(r, email, persona) => {
            if (r === "contact" && persona) {
              setUserPersona(persona)
            }
            signIn(email, r as UserRole)
          }}
        />
      </>
    )

  return (
    <div className={`flex min-h-screen bg-slate-50 ${isMobile ? "flex-col" : ""}`}>
      <ToastContainer toasts={toasts} removeToast={removeToast} />

      {!isMobile && !isQRView && !isPartnerView && (
        <Sidebar role={role as UserRole} currentView={currentView} onChangeView={setCurrentView} onLogout={signOut} />
      )}

      <main
        className={`flex-1 overflow-y-auto h-screen relative ${
          isQRView || isPartnerView ? "" : isMobile ? "pb-24 pt-4 px-4" : "ml-64 p-8"
        }`}
      >
        <Suspense fallback={<LoadingSpinner />}>{renderContent()}</Suspense>

        {isMobile && role === UserRole.AGENT && !isQRView && !isPartnerView && (
          <QuickActionsFAB onNavigate={setCurrentView} />
        )}

        {(role === UserRole.AGENT || role === UserRole.BROKER || role === UserRole.ADMIN) &&
          !isQRView &&
          !isPartnerView && (
            <>
              <VoiceCommandButton onNavigate={setCurrentView} />
              <FloatingAIAssistant currentView={currentView} userRole={role as UserRole} />
            </>
          )}
      </main>

      {isMobile && !isQRView && !isPartnerView && (
        <nav className="fixed bottom-0 left-0 right-0 h-20 bg-white border-t border-slate-200 z-[100] px-6 flex items-center justify-between shadow-[0_-10px_30px_rgba(0,0,0,0.05)]">
          <MobileNavItem
            icon={LayoutDashboard}
            active={currentView.includes("dashboard") || currentView === "listing-journey"}
            onClick={() =>
              setCurrentView(
                role === UserRole.AGENT
                  ? "agent-dashboard"
                  : role === UserRole.BUYER
                    ? "buyer-dashboard"
                    : "listing-journey",
              )
            }
          />
          <MobileNavItem icon={Calendar} active={currentView === "events"} onClick={() => setCurrentView("events")} />
          <MobileNavItem
            icon={MessageSquare}
            active={currentView === "inbox"}
            onClick={() => setCurrentView("inbox")}
          />
          <MobileNavItem
            icon={Briefcase}
            active={currentView === "transactions"}
            onClick={() => setCurrentView("transactions")}
          />
          <MobileNavItem
            icon={Navigation}
            active={currentView === "map-intelligence"}
            onClick={() => setCurrentView("map-intelligence")}
          />
        </nav>
      )}

      {!isMobile && !isQRView && !isPartnerView && <SmartGuide />}
      {!isQRView && !isPartnerView && isLoggedIn && <VoiceAssistant />}
    </div>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <SmartEngineApp />
    </AuthProvider>
  )
}
