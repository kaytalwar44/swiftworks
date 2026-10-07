import { NavLink } from 'react-router';
import {
  Building2,
  CalendarDays,
  FileText,
  Gauge,
  HardHat,
  Handshake,
  Receipt,
  Settings,
  ShieldCheck,
} from 'lucide-react';

import { useAuth } from '@/features/auth/providers/auth-provider';
import { cn } from '@/lib/utils';

interface SidebarProps {
  onNavigate?: () => void;
}

interface NavItem {
  to: string;
  label: string;
  icon: typeof Gauge;
  /** Permission required to see this entry. Omitted means always visible. */
  permission?: string;
  /**
   * Hidden from technicians even when they hold the permission.
   *
   * A technician carries bookings.read, so permission alone would leave the
   * Bookings entry visible. These are operator screens: their layouts assume
   * tools a technician does not have, and a technician's own work lives in the
   * portal at /tech.
   */
  operatorOnly?: boolean;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

const SECTIONS: NavSection[] = [
  {
    title: 'Overview',
    items: [{ to: '/dashboard', label: 'Dashboard', icon: Gauge }],
  },
  {
    title: 'Operations',
    items: [
      {
        to: '/jobs',
        label: 'Jobs',
        icon: Building2,
        permission: 'jobs.read',
        operatorOnly: true,
      },
      {
        to: '/bookings',
        label: 'Bookings',
        icon: CalendarDays,
        permission: 'bookings.read',
        operatorOnly: true,
      },
    ],
  },
  {
    title: 'Directory',
    items: [
      {
        to: '/partners',
        label: 'Partners',
        icon: Handshake,
        permission: 'partners.read',
        operatorOnly: true,
      },
      {
        to: '/technicians',
        label: 'Technicians',
        icon: HardHat,
        permission: 'technicians.read',
        operatorOnly: true,
      },
    ],
  },
  {
    title: 'Finance',
    items: [
      {
        to: '/rates',
        label: 'Rate cards',
        icon: Receipt,
        permission: 'rates.read',
        operatorOnly: true,
      },
      {
        to: '/invoices',
        label: 'Invoices',
        icon: FileText,
        permission: 'invoices.read',
        operatorOnly: true,
      },
    ],
  },
  {
    title: 'Administration',
    items: [
      {
        to: '/team',
        label: 'Team',
        icon: ShieldCheck,
        permission: 'users.manage',
        operatorOnly: true,
      },
      { to: '/settings', label: 'Settings', icon: Settings, operatorOnly: true },
    ],
  },
];

export function Sidebar({ onNavigate }: SidebarProps) {
  const { hasPermission, hasRole } = useAuth();

  const isTechnician = hasRole('technician');

  return (
    <nav className="flex h-full flex-col gap-6 overflow-y-auto px-3 py-4">
      <div className="px-3 py-2">
        <span className="text-lg font-semibold tracking-tight">SwiftWorks</span>
      </div>

      {SECTIONS.map((section) => {
        // Hide a whole section when nothing in it is visible, so nobody is
        // shown a heading with nothing beneath it.
        const visible = section.items.filter(
          (item) =>
            (!item.permission || hasPermission(item.permission)) &&
            !(item.operatorOnly && isTechnician),
        );
        if (visible.length === 0) return null;

        return (
          <div key={section.title} className="flex flex-col gap-1">
            <p className="px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {section.title}
            </p>

            {visible.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={onNavigate}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )
                }
              >
                <item.icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </NavLink>
            ))}
          </div>
        );
      })}
    </nav>
  );
}
