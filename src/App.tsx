import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router';
import JobCreatePage from './pages/JobCreate';

import { AppShell } from '@/layouts/app-shell';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { ProtectedRoute } from '@/features/auth/components/protected-route';
import { AuthProvider } from '@/features/auth/providers/auth-provider';
import { NotFoundPage } from '@/pages/not-found';

const LoginPage = lazy(() => import('@/pages/Login'));
const DashboardPage = lazy(() => import('@/pages/Dashboard'));

const JobsPage = lazy(() => import('@/pages/Jobs'));
const BookingsPage = lazy(() => import('@/pages/Bookings'));
const SchedulePage = lazy(() => import('@/pages/Schedule'));
const CustomersPage = lazy(() => import('@/pages/Customers'));
const PartnersPage = lazy(() => import('@/pages/Partners'));
const TechniciansPage = lazy(() => import('@/pages/Technicians'));
const RateCardsPage = lazy(() => import('@/pages/RateCards'));
const InvoicesPage = lazy(() => import('@/pages/Invoices'));
const TeamPage = lazy(() => import('@/pages/Team'));
const SettingsPage = lazy(() => import('@/pages/Settings'));

export default function App() {
  return (
    <AuthProvider>
      <Suspense fallback={<PageSkeleton />}>
        <Routes>
          {/* ---------- Public ---------- */}
          <Route path="/login" element={<LoginPage />} />

          {/* ---------- Authenticated operator console ---------- */}
          <Route
            element={
              <ProtectedRoute>
                <AppShell />
              </ProtectedRoute>
            }
          >
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<DashboardPage />} />

            <Route path="/jobs" element={<JobsPage />} />
            <Route path="/jobs/new" element={<JobCreatePage />} />
            <Route path="/bookings" element={<BookingsPage />} />
            <Route path="/schedule" element={<SchedulePage />} />

            <Route path="/customers" element={<CustomersPage />} />
            <Route path="/partners" element={<PartnersPage />} />
            <Route path="/technicians" element={<TechniciansPage />} />

            <Route path="/rates" element={<RateCardsPage />} />
            <Route path="/invoices" element={<InvoicesPage />} />

            <Route path="/team" element={<TeamPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>

          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </AuthProvider>
  );
}
