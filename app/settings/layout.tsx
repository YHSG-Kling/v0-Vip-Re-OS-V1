'use client';

import React from 'react';
import { SettingsSidebar } from '@/app/components/settings/SettingsSidebar';
import { useAuth } from '@/lib/auth';
import { redirect } from 'next/navigation';

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
        <div className="max-w-7xl mx-auto p-8">
          {children}
        </div>
      </div>
    </div>
  );
}
