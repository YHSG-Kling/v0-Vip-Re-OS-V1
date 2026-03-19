'use client';

import React from 'react';
import { SettingsSidebar } from '@/app/components/settings/SettingsSidebar';
import { useAuth } from '@/lib/auth/client';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const { user, userContext, loading } = useAuth();

  if (loading) {
    return <div className="flex items-center justify-center min-h-screen">Loading...</div>;
  }

  if (!user || !userContext?.roles.includes('admin' as any) && !userContext?.roles.includes('broker' as any)) {
    redirect('/dashboard');
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
