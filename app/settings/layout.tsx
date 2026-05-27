'use client';

import React, { useEffect } from 'react';
import { SettingsSidebar } from '@/app/components/settings/SettingsSidebar';
import { useAuth } from '@/lib/auth/client';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Loader2 } from 'lucide-react';

// Personal "tech stack" sections every tier may manage (a solo agent inside a brokerage/team
// sets up their OWN email/phone/calendar/social/CRM, profile, brand voice, signature).
const PERSONAL_SECTIONS = new Set([
  'crm', 'integrations', 'brand-voice', 'branding', 'email-templates', 'notifications', 'general',
]);

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const { user, userContext, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  // /settings/<section>/... → section
  const section = (pathname ?? '').split('/').filter(Boolean)[1] ?? '';
  const isPersonalSection = PERSONAL_SECTIONS.has(section);
  const isBrokerageRole = !!userContext?.roles.some(r => ['admin', 'broker', 'superadmin'].includes(r));
  // Brokerage-wide sections (billing, users, global, commission, accounting, services, providers)
  // stay admin/broker; personal-stack sections are open to any authenticated tier.
  const hasAccess = isBrokerageRole || isPersonalSection

  useEffect(() => {
    if (!loading && (!user || !hasAccess)) {
      router.replace('/dashboard');
    }
  }, [loading, user, hasAccess, router])

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user || !hasAccess) {
    return null; // redirecting via useEffect
  }

  return (
    <div className="flex h-screen bg-gray-50">
      <SettingsSidebar />
      <div className="flex-1 overflow-auto">
        <div className="border-b border-gray-200 bg-white sticky top-0 z-10">
          <div className="max-w-7xl mx-auto px-8 py-4 flex items-center justify-between">
            <div></div>
            <Link 
              href="/dashboard"
              className="flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-gray-900 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Dashboard
            </Link>
          </div>
        </div>
        <div className="max-w-7xl mx-auto p-8">
          {children}
        </div>
      </div>
    </div>
  );
}
