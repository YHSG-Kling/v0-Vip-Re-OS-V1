/**
 * Central Component Exports for Next.js App Directory
 * 
 * This file provides barrel exports for commonly used components
 * to simplify imports throughout the application.
 * 
 * Usage:
 *   import { Sidebar, ChatWidget, Button } from '@/app/components'
 */

// Core Navigation & Layout
export { default as Sidebar } from './Sidebar'
export { default as ChatWidget } from './ChatWidget'
export { default as Providers } from './providers'
export { ThemeProvider } from './theme-provider'

// Notifications & Banners
export { ApprovalsBanner } from './ApprovalsBanner'

// Contact Management
export { default as ContactDetail } from './ContactDetail'
export { default as ContactDetailModal } from './ContactDetailModal'
export { default as ContactForm } from './ContactForm'
export { default as ContactsList } from './ContactsList'

// Content & Generation
export { default as ContentGeneratorHub } from './ContentGeneratorHub'
export { default as DealTeamSection } from './DealTeamSection'
export { default as JourneyCardsRenderer } from './JourneyCardsRenderer'
export { default as PersonaTools } from './PersonaTools'
export { default as ProspectQuestionnaire } from './ProspectQuestionnaire'
export { default as ThemFirstChatAssistant } from './ThemFirstChatAssistant'
export { default as TransparencyFeed } from './TransparencyFeed'
export { default as VideosDashboard } from './VideosDashboard'
export { default as VoiceAssistant } from './VoiceAssistant'

// UI Components (shadcn/ui & custom)
export { Button } from './ui/button'
export { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './ui/card'
export { Input } from './ui/input'
export { Label } from './ui/label'
export { Badge } from './ui/badge'
export { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from './ui/dialog'
export { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'
export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
export { Textarea } from './ui/textarea'
export { Checkbox } from './ui/checkbox'
export { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from './ui/table'
export { Spinner } from './ui/spinner'
export { Alert, AlertDescription, AlertTitle } from './ui/alert'
export { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion'
export { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'
export { Switch } from './ui/switch'
export { Skeleton } from './ui/skeleton'
export { Progress } from './ui/progress'
export { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious } from './ui/carousel'

// Portal Components
export { BuyerPropertiesDashboard } from './portal/BuyerPropertiesDashboard'
export { ClientDocumentsWidget } from './portal/ClientDocumentsWidget'
export { ClientMessagingWidget } from './portal/ClientMessagingWidget'
export { PortalNav } from './portal/PortalNav'
export { PortalUserMenu } from './portal/PortalUserMenu'
export { UnifiedPortalDashboard } from './portal/UnifiedPortalDashboard'

// AI Components
export { SmartGuide } from './AI/SmartGuide'
export { FloatingAIAssistant } from './AI/FloatingAIAssistant'
export { CMAGenerator } from './AI/CMAGenerator'
export { AIAssistantPanel } from './ai/AIAssistantPanel'

// Chat Components
export { ChatInterface } from './chat/ChatInterface'
export { ChatSessionsList } from './chat/ChatSessionsList'

// Compliance Components
export { ApprovedContentLibrary } from './compliance/approved-content-library'

// Dashboard Components
export { KPICards } from './dashboard/KPICards'
export { RiskTable } from './dashboard/RiskTable'

// Intelligence Components
export { LeadIntelligencePanel } from './intelligence/LeadIntelligencePanel'

// Mobile Components
export { QuickActionsFAB } from './mobile/QuickActionsFAB'

// Listing Components
export { ListingDetailTabs } from './listing/ListingDetailTabs'

// Marketing Components
export { PodcastStudio } from './marketing/PodcastStudio'
