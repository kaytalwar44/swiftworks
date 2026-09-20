import { useState } from 'react';
import { Outlet } from 'react-router';

import { Navbar } from '@/components/Navbar';
import { Sidebar } from '@/components/Sidebar';
import { cn } from '@/lib/utils';

/**
 * Shell for every authenticated operator route.
 *
 * The sidebar is fixed on desktop and a slide-over on mobile. Children render
 * into <Outlet />, so individual pages never manage chrome.
 */
export function AppLayout() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-muted/30">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 border-r bg-background lg:block">
        <div className="sticky top-0 h-screen">
          <Sidebar />
        </div>
      </aside>

      {/* Mobile slide-over */}
      <div
        className={cn(
          'fixed inset-0 z-40 lg:hidden',
          mobileNavOpen ? 'pointer-events-auto' : 'pointer-events-none',
        )}
        aria-hidden={!mobileNavOpen}
      >
        <div
          className={cn(
            'absolute inset-0 bg-black/50 transition-opacity',
            mobileNavOpen ? 'opacity-100' : 'opacity-0',
          )}
          onClick={() => setMobileNavOpen(false)}
        />
        <div
          className={cn(
            'absolute inset-y-0 left-0 w-64 bg-background shadow-xl transition-transform duration-200',
            mobileNavOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <Sidebar onNavigate={() => setMobileNavOpen(false)} />
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <Navbar onMenuClick={() => setMobileNavOpen(true)} />

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto w-full max-w-7xl">
            <Outlet />
          </div>
        </main>

        <footer className="border-t px-4 py-4 text-xs text-muted-foreground sm:px-6 lg:px-8">
          <div className="mx-auto flex w-full max-w-7xl items-center justify-between">
            <span>SwiftWorks</span>
            {__APP_VERSION__ && <span>v{__APP_VERSION__}</span>}
          </div>
        </footer>
      </div>
    </div>
  );
}

export default AppLayout;
