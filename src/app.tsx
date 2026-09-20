import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router';

import { AppShell } from '@/components/layout/app-shell';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { ProtectedRoute } from '@/features/auth/components/protected-route';
import { AuthProvider } from '@/features/auth/providers/auth-provider';
import { NotFoundPage } from '@/pages/not-found';

// Route-level splitting: a resident scanning a QR never downloads the operator
// bundle, and an operator never downloads the booking wizard.
const LoginPage = lazy(() => import('@/features/auth/pages/login'));
const RegisterPage = lazy(() => import('@/features/auth/pages/register'));
const ForgotPasswordPage = lazy(() => import('@/features/auth/pages/forgot-password'));
const ResetPasswordPage = lazy(() => import('@/features/auth/pages/reset-password'));
const AcceptInvitePage = lazy(() => import('@/features/auth/pages/accept-invite'));

const DashboardPage = lazy(() => import('@/features/dashboard/pages/dashboard'));

const JobListPage = lazy(() => import('@/features/jobs/pages/job-list'));
const JobDetailPage = lazy(() => import('@/features/jobs/pages/job-detail'));
const JobCreatePage = lazy(() => import('@/features/jobs/pages/job-create'));
const JobEditPage = lazy(() => import('@/features/jobs/pages/job-edit'));

const BookingListPage = lazy(() => import('@/features/bookings/pages/booking-list'));
const BookingDetailPage = lazy(() => import('@/features/bookings/pages/booking-detail'));
const SchedulePage = lazy(() => import('@/features/schedule/pages/schedule-board'));

const CustomerListPage = lazy(() => import('@/features/customers/pages/customer-list'));
const CustomerDetailPage = lazy(() => import('@/features/customers/pages/customer-detail'));
const PartnerListPage = lazy(() => import('@/features/partners/pages/partner-list'));
const PartnerDetailPage = lazy(() => import('@/features/partners/pages/partner-detail'));
const TechnicianListPage = lazy(() => import('@/features/technicians/pages/technician-list'));
const TechnicianDetailPage = lazy(() => import('@/features/technicians/pages/technician-detail'));

const RateCardListPage = lazy(() => import('@/features/rates/pages/rate-card-list'));
const InvoiceListPage = lazy(() => import('@/features/invoices/pages/invoice-list'));
const InvoiceDetailPage = lazy(() => import('@/features/invoices/pages/invoice-detail'));

const TeamDirectoryPage = lazy(() => import('@/features/team/pages/team-directory'));
const RolesPage = lazy(() => import('@/features/team/pages/roles-permissions'));
const NotificationsPage = lazy(() => import('@/features/notifications/pages/notifications-page'));
const SettingsPage = lazy(() => import('@/features/settings/pages/settings'));

const BookingEntryPage = lazy(() => import('@/features/booking-public/pages/booking-entry'));
const BookingConfirmationPage = lazy(() => import('@/features/booking-public/pages/booking-confirmation'));
const ManageBookingPage = lazy(() => import('@/features/booking-public/pages/manage-booking'));

export default function App() {
  return (
    <AuthProvider>
      <Suspense fallback={<PageSkeleton />}>
        <Routes>
          {/* ---------- Public: no auth, no operator chrome ---------- */}
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/accept-invite" element={<AcceptInvitePage />} />

          {/* Residents land here from a QR scan. Never gated, never logged out. */}
          <Route path="/book/:token" element={<BookingEntryPage />} />
          <Route path="/book/confirmation/:bookingRef" element={<BookingConfirmationPage />} />
          <Route path="/book/manage/:bookingRef" element={<ManageBookingPage />} />

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

            <Route path="/jobs" element={<JobListPage />} />
            <Route path="/jobs/new" element={<JobCreatePage />} />
            <Route path="/jobs/:jobId" element={<JobDetailPage />} />
            <Route path="/jobs/:jobId/edit" element={<JobEditPage />} />

            <Route path="/bookings" element={<BookingListPage />} />
            <Route path="/bookings/:bookingId" element={<BookingDetailPage />} />
            <Route path="/schedule" element={<SchedulePage />} />

            <Route path="/customers" element={<CustomerListPage />} />
            <Route path="/customers/:customerId" element={<CustomerDetailPage />} />
            <Route path="/partners" element={<PartnerListPage />} />
            <Route path="/partners/:partnerId" element={<PartnerDetailPage />} />
            <Route path="/technicians" element={<TechnicianListPage />} />
            <Route path="/technicians/:technicianId" element={<TechnicianDetailPage />} />

            <Route path="/rates" element={<RateCardListPage />} />
            <Route path="/invoices" element={<InvoiceListPage />} />
            <Route path="/invoices/:invoiceId" element={<InvoiceDetailPage />} />

            <Route path="/team" element={<TeamDirectoryPage />} />
            <Route path="/team/roles" element={<RolesPage />} />
            <Route path="/notifications" element={<NotificationsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>

          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </AuthProvider>
  );
}
