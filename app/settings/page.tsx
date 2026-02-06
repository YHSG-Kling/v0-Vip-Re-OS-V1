import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Settings, Palette, DollarSign, Mail, Bell, Link2, Users } from 'lucide-react';

export default function SettingsDashboard() {
  const settingsCards = [
    {
      title: 'General Settings',
      description: 'Configure app name, timezone, date format, and currency',
      href: '/settings/general',
      icon: Settings,
    },
    {
      title: 'Branding',
      description: 'Customize your app logo, colors, and visual identity',
      href: '/settings/branding',
      icon: Palette,
    },
    {
      title: 'Commission Structures',
      description: 'Manage commission rates, tiers, and payment structures',
      href: '/settings/commission',
      icon: DollarSign,
    },
    {
      title: 'Email Templates',
      description: 'Create and manage email templates for automated communications',
      href: '/settings/email-templates',
      icon: Mail,
    },
    {
      title: 'Notifications',
      description: 'Configure notification rules and delivery preferences',
      href: '/settings/notifications',
      icon: Bell,
    },
    {
      title: 'Integrations',
      description: 'Connect third-party services and manage API credentials',
      href: '/settings/integrations',
      icon: Link2,
    },
    {
      title: 'User Management',
      description: 'Manage users, roles, and permissions',
      href: '/settings/users',
      icon: Users,
    },
  ];

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Settings</h1>
        <p className="text-gray-600 mt-2">Manage your brokerage configuration and preferences</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {settingsCards.map((card) => {
          const Icon = card.icon;
          return (
            <Link key={card.href} href={card.href}>
              <Card className="p-6 hover:shadow-md transition-shadow cursor-pointer h-full">
                <div className="flex items-start gap-4">
                  <div className="p-3 bg-blue-50 rounded-lg">
                    <Icon className="h-6 w-6 text-blue-600" />
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-1">{card.title}</h3>
                    <p className="text-sm text-gray-600">{card.description}</p>
                  </div>
                </div>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
