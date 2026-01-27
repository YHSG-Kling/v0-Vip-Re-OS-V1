/**
 * Central Component Exports for Next.js App Directory
 * 
 * This file provides barrel exports for commonly used components
 * to simplify imports throughout the application.
 * 
 * Usage:
 *   import { Sidebar, ChatWidget, ContactForm } from '@/app/components'
 */

// Core Navigation & Layout
export { default as Sidebar } from './Sidebar'

// Notifications & Banners
export { ApprovalsBanner } from './ApprovalsBanner'

// Chat & Communication
export { default as ChatWidget } from './ChatWidget'

// Contact Management
export { default as ContactDetail } from './ContactDetail'
export { default as ContactForm } from './ContactForm'
export { default as ContactsList } from './ContactsList'

// Providers
export { default as Providers } from './providers'
export { ThemeProvider } from './theme-provider'

// Re-export commonly used UI components
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

// Note: Add more exports as components are migrated to app/components/
// Organize by category for better maintainability
