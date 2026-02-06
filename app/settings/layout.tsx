import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import Link from 'next/link';
import { Settings, Palette, DollarSign, Mail, Bell, Link2, Users } from 'lucide-react';

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    redirect('/login');
  }

  const { data: userProfile } = await supabase
    .from('users')
    .select('user_type')
    .eq('id', user.id)
    .single();

  if (!userProfile || !['admin', 'broker'].includes(userProfile.user_type)) {
    redirect('/dashboard');
  }

  const navItems = [
    { href: '/settings', label: 'Overview', icon: Settings },
    { href: '/settings/general', label: 'General', icon: Settings },
    { href: '/settings/branding', label: 'Branding', icon: Palette },
    { href: '/settings/commission', label: 'Commission', icon: DollarSign },
    { href: '/settings/email-templates', label: 'Email Templates', icon: Mail },
    { href: '/settings/notifications', label: 'Notifications', icon: Bell },
    { href: '/settings/integrations', label: 'Integrations', icon: Link2 },
    { href: '/settings/users', label: 'Users', icon: Users },
  ];

  return (
    <div className="flex h-full">
      <aside className="w-64 border-r border-gray-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Settings</h2>
        <nav className="space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className="flex items-center gap-3 px-3 py-2 text-sm text-gray-700 rounded-md hover:bg-gray-100 hover:text-gray-900 transition-colors"
              >
                <Icon className="h-5 w-5" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <main className="flex-1 overflow-auto bg-gray-50 p-8">
        {children}
      </main>
    </div>
  );
}
