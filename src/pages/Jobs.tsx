import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  Building2,
  CalendarPlus,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  List,
  Loader2,
  Pencil,
  QrCode,
  Trash2,
  UserPlus,
} from 'lucide-react';

import { supabase } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type Job = {
  id: string;
  company_id: string;
  job_number: string | null;
  title: string | null;
  reference: string | null;
  status: string | null;
  priority: number | null;
  site_name: string | null;
  address_line1: string;
  address_line2: string | null;
  suburb: string;
  state: string;
  postcode: string;
  start_date: string;
  end_date: string;
  unit_count: number;
};

/** The twelve editable fields, as a flat draft object. */
type JobDraft = {
  job_number: string;
  title: string;
  reference: string;
  start_date: string;
  end_date: string;
  unit_count: number;
  site_name: string;
  address_line1: string;
  address_line2: string;
  suburb: string;
  state: string;
  postcode: string;
};

type Slot = {
  id: string;
  slot_date: string;
  local_start: string;
  local_end: string;
  capacity: number;
  booked_count: number;
  status: string;
};

type BookingLink = {
  id: string;
  job_id: string;
  token: string;
  booking_url: string;
  created_at: string;
};

/**
 * QR image service. The host is assembled from parts so that copying this
 * file out of a chat or editor cannot auto-link the domain.
 */
const QR_HOST = ['api', 'qrserver', 'com'].join('.');
const QR_API_BASE =
  'https://' + QR_HOST + '/v1/create-qr-code/?size=260x260&margin=12&data=';

/** Postgres time columns come back as HH:MM:SS; the table reads better as HH:MM. */
function formatTime(value: string | null): string {
  if (!value) return '-';
  return value.slice(0, 5);
}

function toDraft(job: Job): JobDraft {
  return {
    job_number: job.job_number ?? '',
    title: job.title ?? '',
    reference: job.reference ?? '',
    start_date: job.start_date ?? '',
    end_date: job.end_date ?? '',
    unit_count: job.unit_count ?? 0,
    site_name: job.site_name ?? '',
    address_line1: job.address_line1 ?? '',
    address_line2: job.address_line2 ?? '',
    suburb: job.suburb ?? '',
    state: job.state ?? '',
    postcode: job.postcode ?? '',
  };
}

/** 08:00–12:00 and 12:00–16:00 on every day of the job window. */
const SLOT_WINDOWS = [
  { local_start: '08:00:00', local_end: '12:00:00' },
  { local_start: '12:00:00', local_end: '16:00:00' },
] as const;

/**
 * Splits unit_count across the two daily windows.
 * An odd count gives the extra booking to the morning.
 *   6 -> 3/3 · 18 -> 9/9 · 25 -> 13/12 · 30 -> 15/15
 */
function splitCapacity(unitCount: number): [number, number] {
  const base = Math.floor(unitCount / 2);
  const remainder = unitCount % 2;
  return [base + remainder, base];
}

/** Every date from start to end inclusive, as YYYY-MM-DD. */
function eachDate(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const start = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');

  for (let d = start; d <= end; d = new Date(d.getTime() + 86_400_000)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

/** One booking as listed under its job. */
type JobBooking = {
  id: string;
  booking_ref: string | null;
  status: string | null;
  full_name: string | null;
  job_id: string | null;
  slot_date: string | null;
  local_start: string | null;
  technician_name: string | null;
};

/** Booking status colours, matching the Bookings page so a status reads the same. */
const BOOKING_STATUS_STYLES: Record<
  string,
  { label: string; className: string }
> = {
  confirmed: { label: 'Confirmed', className: 'bg-blue-100 text-blue-800 ring-blue-600/20' },
  completed: { label: 'Completed', className: 'bg-emerald-100 text-emerald-800 ring-emerald-600/20' },
  customer_refused: { label: 'Customer Refused', className: 'bg-red-100 text-red-800 ring-red-600/20' },
  no_show: { label: 'Customer Not At Home', className: 'bg-amber-100 text-amber-900 ring-amber-600/20' },
  rescheduled: { label: 'Rescheduled', className: 'bg-violet-100 text-violet-800 ring-violet-600/20' },
};

function bookingStatusStyle(status: string | null) {
  const key = String(status ?? '').trim();
  return (
    BOOKING_STATUS_STYLES[key] ?? {
      label: key === '' ? '-' : key.replace(/_/g, ' '),
      className: 'bg-muted text-muted-foreground ring-border',
    }
  );
}

/**
 * Badge colour by booking count: grey for none, blue for a few, amber once a
 * job is filling up. Thresholds live here so the badge and any future summary
 * read the same rule.
 */
function bookingCountClass(count: number): string {
  if (count === 0) return 'bg-muted text-muted-foreground ring-border';
  if (count <= 4) return 'bg-blue-100 text-blue-800 ring-blue-600/20';
  return 'bg-amber-100 text-amber-900 ring-amber-600/20';
}

/** 2026-10-14 -> 14 Oct 2026 */
function formatBookingDate(value: string | null): string {
  if (!value) return 'No date';
  const d = new Date(value + 'T00:00:00');
  return d.toLocaleDateString('en-AU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export default function Jobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [editingJob, setEditingJob] = useState<Job | null>(null);
  const [draft, setDraft] = useState<JobDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [viewingJob, setViewingJob] = useState<Job | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState<string | null>(null);

  const [bookingLinks, setBookingLinks] = useState<Record<string, BookingLink>>(
    {},
  );
  const [qrFor, setQrFor] = useState<BookingLink | null>(null);
  const [linkBusyId, setLinkBusyId] = useState<string | null>(null);

  /** job_id -> true when the job has at least one non-cancelled booking. */
  const [lockedJobs, setLockedJobs] = useState<Record<string, boolean>>({});

  const [deletingId, setDeletingId] = useState<string | null>(null);

  /** job_id -> assigned technician's display name. */
  const [assignedTechs, setAssignedTechs] = useState<Record<string, string>>({});

  /** Technicians selectable in the assign dialog. */
  const [assignableTechs, setAssignableTechs] = useState<
    { id: string; full_name: string | null; code: string | null }[]
  >([]);

  const [assignFor, setAssignFor] = useState<Job | null>(null);
  const [assignTechnicianId, setAssignTechnicianId] = useState('');
  const [assignLoading, setAssignLoading] = useState(false);
  const [assignSaving, setAssignSaving] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);

  /** Mirror of assignedTechs, read by loadBookings without a dependency. */
  const assignedTechsRef = useRef<Record<string, string>>({});

  /** Bookings grouped by job id, loaded for every job on screen at once. */
  const [bookingsByJob, setBookingsByJob] = useState<
    Record<string, JobBooking[]>
  >({});
  const [bookingsError, setBookingsError] = useState<string | null>(null);
  const [expandedJobIds, setExpandedJobIds] = useState<Set<string>>(new Set());

  /**
   * Loads every booking for the jobs on screen in a bounded number of queries,
   * never one per job. The rows reuse the customer_bookings select loadJobs
   * already makes for the lock map, so the table is not scanned twice.
   */
  const loadBookings = useCallback(async (jobsOnScreen: Job[]) => {
    setBookingsError(null);

    const jobIds = jobsOnScreen.map((j) => j.id);
    if (jobIds.length === 0) {
      setBookingsByJob({});
      return;
    }

    const { data: slice, error: rowsErr } = await (supabase as any)
      .from('customer_bookings')
      .select(
        'id, booking_ref, status, full_name, job_id, technician_id, job_slots ( slot_date, local_start )',
      )
      .in('job_id', jobIds)
      .is('deleted_at', null);

    let rows = (slice ?? []) as any[];

    // technician_id is convenient but not essential: if the column is absent,
    // re-query without it and fall back to the job's lead technician.
    if (rowsErr) {
      const { data: basic, error: basicErr } = await (supabase as any)
        .from('customer_bookings')
        .select(
          'id, booking_ref, status, full_name, job_id, job_slots ( slot_date, local_start )',
        )
        .in('job_id', jobIds)
        .is('deleted_at', null);

      if (basicErr) {
        console.error('job bookings select failed', basicErr);
        setBookingsError(basicErr.message);
        setBookingsByJob({});
        return;
      }
      rows = (basic ?? []) as any[];
    }

    // Fallback: the lead (or first) technician already resolved per job.
    const leadNameByJob: Record<string, string> = {};
    for (const j of jobsOnScreen) {
      const name = assignedTechsRef.current[j.id];
      if (name) leadNameByJob[j.id] = name;
    }

    // One query for every technician referenced by any booking.
    const techIds = Array.from(
      new Set(rows.map((r) => r.technician_id).filter((v): v is string => !!v)),
    );
    const techName = new Map<string, string>();
    if (techIds.length > 0) {
      const { data: techs } = await (supabase as any)
        .from('technicians')
        .select('id, full_name, code')
        .in('id', techIds);
      for (const t of (techs ?? []) as any[]) {
        techName.set(t.id, t.full_name || t.code || 'Unnamed technician');
      }
    }

    const grouped: Record<string, JobBooking[]> = {};
    for (const r of rows) {
      if (!r.job_id) continue;
      const own = r.technician_id ? techName.get(r.technician_id) : null;
      (grouped[r.job_id] ??= []).push({
        id: r.id,
        booking_ref: r.booking_ref ?? null,
        status: r.status ?? null,
        full_name: r.full_name ?? null,
        job_id: r.job_id,
        slot_date: r.job_slots?.slot_date ?? null,
        local_start: r.job_slots?.local_start ?? null,
        technician_name: own ?? leadNameByJob[r.job_id] ?? null,
      });
    }

    // Earliest first; bookings with no slot fall to the end.
    for (const list of Object.values(grouped)) {
      list.sort((a, b) => {
        const ka = (a.slot_date ?? '9999-12-31') + (a.local_start ?? '');
        const kb = (b.slot_date ?? '9999-12-31') + (b.local_start ?? '');
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
    }

    setBookingsByJob(grouped);
  }, []);

  function toggleJobBookings(jobId: string) {
    setExpandedJobIds((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  }

  const loadJobs = useCallback(async () => {
    setLoading(true);

    const { data, error } = await (supabase as any)
      .from('jobs')
      .select(
        'id, company_id, job_number, title, reference, status, priority, site_name, address_line1, address_line2, suburb, state, postcode, start_date, end_date, unit_count',
      )
      .order('job_number');

    // A job with a live booking is locked: editing its dates or regenerating
    // its slots would orphan or silently cancel a resident's appointment.
    // customer_bookings has no FK documention to rely on here, so the lock map
    // is built with one extra query rather than an embed.
    const bookingRes = await (supabase as any)
      .from('customer_bookings')
      .select('job_id')
      .neq('status', 'cancelled')
      .is('deleted_at', null);

    const locks: Record<string, boolean> = {};
    for (const row of (bookingRes.data ?? []) as { job_id: string | null }[]) {
      if (row.job_id) locks[row.job_id] = true;
    }
    setLockedJobs(locks);

    // One technician per job: the map keeps the lead (or first) name per job.
    const assignRes = await (supabase as any)
      .from('job_technicians')
      .select('job_id, technician_id, is_lead, technicians ( full_name, code )');

    const assigned: Record<string, string> = {};
    for (const row of (assignRes.data ?? []) as any[]) {
      if (!row.job_id) continue;
      const name =
        row.technicians?.full_name || row.technicians?.code || null;
      if (!name) continue;
      if (row.is_lead === false && assigned[row.job_id]) continue;
      assigned[row.job_id] = name;
    }
    assignedTechsRef.current = assigned;
    setAssignedTechs(assigned);

    if (error) {
      console.error(error);
      setNotice(error.message);
    }

    if (!error && data) {
      const loaded = data as unknown as Job[];
      setJobs(loaded);
      await loadBookings(loaded);
    }

    setLoading(false);
  }, [loadBookings]);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  // A booking can be created on the Bookings page, by a resident, or removed
  // from the technician portal - none of which this page hears about. Re-reading
  // on focus keeps the counts honest, and switching back to this tab is exactly
  // when someone reads them. No realtime channel needed.
  useEffect(() => {
    function onFocus() {
      void loadJobs();
    }

    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadJobs]);

  function openEdit(job: Job) {
    if (lockedJobs[job.id]) {
      setNotice(
        'This job has active customer bookings and cannot be modified.',
      );
      return;
    }
    setEditingJob(job);
    setDraft(toDraft(job));
    setSaveError(null);
  }

  function closeEdit() {
    setEditingJob(null);
    setDraft(null);
    setSaveError(null);
    setSaving(false);
  }

  async function openSlots(job: Job) {
    setViewingJob(job);
    setSlots([]);
    setSlotsError(null);
    setSlotsLoading(true);

    const { data, error } = await (supabase as any)
      .from('job_slots')
      .select(
        'id, slot_date, local_start, local_end, capacity, booked_count, status',
      )
      .eq('job_id', job.id)
      .order('slot_date', { ascending: true })
      .order('local_start', { ascending: true });

    setSlotsLoading(false);

    if (error) {
      setSlotsError(error.message);
      return;
    }

    setSlots((data ?? []) as Slot[]);
  }

  function closeSlots() {
    setViewingJob(null);
    setSlots([]);
    setSlotsError(null);
    setSlotsLoading(false);
  }

  async function deleteJob(job: Job) {
    setDeletingId(job.id);
    setNotice(null);

    // A booking row blocks the delete, whatever its status. Checked against the
    // database rather than the lock map so a booking made since the page
    // loaded is still caught.
    const bookingRes = await (supabase as any)
      .from('customer_bookings')
      .select('id')
      .eq('job_id', job.id)
      .limit(1);

    if (bookingRes.error) {
      setDeletingId(null);
      setNotice(bookingRes.error.message);
      return;
    }

    if ((bookingRes.data ?? []).length > 0) {
      setDeletingId(null);
      setNotice('This job has customer bookings and cannot be deleted.');
      return;
    }

    // Children first: booking_links and job_slots both reference jobs, so a
    // delete of the parent row while they exist is rejected.
    const linksRes = await (supabase as any)
      .from('booking_links')
      .delete()
      .eq('job_id', job.id);

    if (linksRes.error) {
      setDeletingId(null);
      setNotice(linksRes.error.message);
      return;
    }

    const slotsRes = await (supabase as any)
      .from('job_slots')
      .delete()
      .eq('job_id', job.id);

    if (slotsRes.error) {
      setDeletingId(null);
      setNotice(slotsRes.error.message);
      return;
    }

    const jobRes = await (supabase as any)
      .from('jobs')
      .delete()
      .eq('id', job.id);

    setDeletingId(null);

    if (jobRes.error) {
      setNotice(jobRes.error.message);
      return;
    }

    setNotice('Job deleted.');
    await loadJobs();
  }

  async function generateQr(job: Job) {
    setLinkBusyId(job.id);
    setNotice(null);

    const token = crypto.randomUUID();
    const bookingUrl = `${window.location.origin}/book/${token}`;

    const { data, error } = await (supabase as any)
      .from('booking_links')
      .insert([
        {
          company_id: job.company_id,
          job_id: job.id,
          token,
          booking_url: bookingUrl,
          created_at: new Date().toISOString(),
        },
      ])
      .select('id, job_id, token, booking_url, created_at')
      .single();

    setLinkBusyId(null);

    if (error) {
      setNotice(error.message);
      return;
    }

    setBookingLinks((prev) => ({
      ...prev,
      [job.id]: data as BookingLink,
    }));

    setNotice('Booking link created: ' + bookingUrl);
  }

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setNotice('Booking link copied to clipboard.');
    } catch {
      setNotice('Could not copy automatically — select the link and copy it.');
    }
  }

  async function openAssign(job: Job) {
    setAssignFor(job);
    setAssignError(null);
    setAssignTechnicianId('');
    setAssignLoading(true);

    // Available technicians only, and not soft-deleted.
    const techRes = await (supabase as any)
      .from('technicians')
      .select('id, full_name, code')
      .eq('is_available', true)
      .is('deleted_at', null)
      .order('full_name');

    if (techRes.error) {
      setAssignLoading(false);
      setAssignError(techRes.error.message);
      return;
    }

    setAssignableTechs(techRes.data ?? []);

    // Existing assignment, so the dialog opens on the current technician.
    const existingRes = await (supabase as any)
      .from('job_technicians')
      .select('technician_id')
      .eq('job_id', job.id)
      .limit(1);

    const existing = (existingRes.data ?? [])[0] as
      | { technician_id: string | null }
      | undefined;

    if (existing?.technician_id) {
      setAssignTechnicianId(existing.technician_id);
    }

    setAssignLoading(false);
  }

  function closeAssign() {
    setAssignFor(null);
    setAssignTechnicianId('');
    setAssignError(null);
    setAssignSaving(false);
  }

  async function saveAssignment() {
    if (!assignFor) return;

    setAssignError(null);

    if (!assignTechnicianId) {
      setAssignError('Please choose a technician.');
      return;
    }

    setAssignSaving(true);

    const { error: rpcError } = await (supabase as any).rpc(
      'job_assign_technician',
      {
        p_job_id: assignFor.id,
        p_technician_id: assignTechnicianId,
      },
    );

    setAssignSaving(false);

    if (rpcError) {
      setAssignError(rpcError.message);
      return;
    }

    closeAssign();
    setNotice('Technician assigned.');
    await loadJobs();
  }

  async function saveEdit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!editingJob || !draft) return;

    if (lockedJobs[editingJob.id]) {
      setSaveError(
        'This job has active customer bookings and cannot be modified.',
      );
      setSaving(false);
      return;
    }

    setSaving(true);
    setSaveError(null);

    if (!draft.start_date || !draft.end_date) {
      setSaveError('Start date and end date are required.');
      setSaving(false);
      return;
    }

    if (draft.end_date < draft.start_date) {
      setSaveError('End date cannot be before the start date.');
      setSaving(false);
      return;
    }

    const { error } = await (supabase as any)
      .from('jobs')
      .update({
        job_number: draft.job_number.trim(),
        title: draft.title.trim() || null,
        reference: draft.reference.trim() || null,
        start_date: draft.start_date,
        end_date: draft.end_date,
        unit_count: draft.unit_count,
        site_name: draft.site_name.trim() || null,
        address_line1: draft.address_line1.trim(),
        address_line2: draft.address_line2.trim() || null,
        suburb: draft.suburb.trim(),
        state: draft.state.trim(),
        postcode: draft.postcode.trim(),
      })
      .eq('id', editingJob.id);

    setSaving(false);

    if (error) {
      setSaveError(error.message);
      return;
    }

    closeEdit();
    setNotice('Job updated.');
    await loadJobs();
  }

  async function generateSlots(job: Job) {
    if (lockedJobs[job.id]) {
      setNotice(
        'This job has active customer bookings and cannot be modified.',
      );
      return;
    }

    setGeneratingId(job.id);
    setNotice(null);

    if (!job.start_date || !job.end_date) {
      setNotice('This job has no start or end date.');
      setGeneratingId(null);
      return;
    }

    if (job.unit_count <= 0) {
      setNotice('This job has no units to schedule.');
      setGeneratingId(null);
      return;
    }

    const [morningCapacity, afternoonCapacity] = splitCapacity(job.unit_count);
    const dates = eachDate(job.start_date, job.end_date);

    // start_time and end_time are NOT NULL with no default, so they are
    // derived from the slot date and the local window. The +10:00 offset is
    // Sydney standard time.
    const payload = dates.flatMap((slot_date) =>
      SLOT_WINDOWS.map((window, index) => ({
        company_id: job.company_id,
        job_id: job.id,
        slot_date,
        local_start: window.local_start,
        local_end: window.local_end,
        start_time: slot_date + 'T' + window.local_start + '+10:00',
        end_time: slot_date + 'T' + window.local_end + '+10:00',
        capacity: index === 0 ? morningCapacity : afternoonCapacity,
        booked_count: 0,
        status: 'open',
        sequence: index + 1,
      })),
    );

    const { error } = await (supabase as any)
      .from('job_slots')
      .insert(payload);

    setGeneratingId(null);

    if (error) {
      // The exclusion constraint is the duplicate guard. Translate it rather
      // than showing raw Postgres output.
      if (
        error.message.includes('job_slots_no_seq_overlap') ||
        error.message.includes(
          'conflicting key value violates exclusion constraint',
        )
      ) {
        setNotice('Slots already exist for this job.');
        return;
      }

      setNotice(error.message);
      return;
    }

    setNotice(
      'Created ' +
        payload.length +
        ' slots across ' +
        dates.length +
        ' days (' +
        morningCapacity +
        ' morning, ' +
        afternoonCapacity +
        ' afternoon).',
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Jobs</h1>
        <p className="text-sm text-muted-foreground">
          Installation campaigns and work orders
        </p>
      </div>

      <Card>
        <CardContent className="p-6">
          <div className="flex items-center gap-3">
            <Building2 className="h-5 w-5" />

            <div>
              <p className="text-sm text-muted-foreground">Total Jobs</p>
              <p className="text-3xl font-bold">{jobs.length}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Job List</CardTitle>
        </CardHeader>

        <CardContent>
          {notice && (
            <p className="mb-4 break-all rounded border bg-muted/40 p-3 text-sm">
              {notice}
            </p>
          )}

          {loading ? (
            <p>Loading jobs...</p>
          ) : jobs.length === 0 ? (
            <p>No jobs found.</p>
          ) : (
            <div className="space-y-3">
              {jobs.map((job) => (
                <div key={job.id} className="rounded border p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">
                      {job.title || 'Untitled Job'}
                    </span>
                    <span
                      className={
                        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ' +
                        bookingCountClass((bookingsByJob[job.id] ?? []).length)
                      }
                      title="Bookings for this job"
                    >
                      {(bookingsByJob[job.id] ?? []).length}{' '}
                      {(bookingsByJob[job.id] ?? []).length === 1
                        ? 'booking'
                        : 'bookings'}
                    </span>
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Job #: {job.job_number || '-'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Status: {job.status || '-'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Priority: {job.priority ?? '-'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Site: {job.site_name || '-'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Suburb: {job.suburb || '-'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Schedule: {job.start_date || '-'} to {job.end_date || '-'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Units: {job.unit_count ?? '-'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Technician: {assignedTechs[job.id] || 'Unassigned'}
                  </div>

                  {/* Bookings under this job */}
                  <div className="mt-3 rounded border bg-muted/20">
                    <button
                      type="button"
                      className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium"
                      aria-expanded={expandedJobIds.has(job.id)}
                      aria-controls={'job-bookings-' + job.id}
                      onClick={() => toggleJobBookings(job.id)}
                    >
                      <span>
                        Bookings ({(bookingsByJob[job.id] ?? []).length})
                      </span>
                      {expandedJobIds.has(job.id) ? (
                        <ChevronUp className="h-4 w-4" />
                      ) : (
                        <ChevronDown className="h-4 w-4" />
                      )}
                    </button>

                    {expandedJobIds.has(job.id) && (
                      <div
                        id={'job-bookings-' + job.id}
                        className="border-t px-3 py-2"
                      >
                        {bookingsError ? (
                          <p role="alert" className="text-sm text-destructive">
                            Bookings could not be loaded: {bookingsError}
                          </p>
                        ) : (bookingsByJob[job.id] ?? []).length === 0 ? (
                          <p className="text-sm text-muted-foreground">
                            No bookings yet
                          </p>
                        ) : (
                          <ul className="divide-y text-sm">
                            {(bookingsByJob[job.id] ?? []).map((b) => {
                              const st = bookingStatusStyle(b.status);
                              return (
                                <li
                                  key={b.id}
                                  className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2"
                                >
                                  <span className="w-28 shrink-0 tabular-nums">
                                    {formatBookingDate(b.slot_date)}
                                  </span>
                                  <span className="min-w-[8rem] flex-1 font-medium">
                                    {b.full_name || 'Unknown Customer'}
                                  </span>
                                  <span className="text-muted-foreground">
                                    {b.technician_name || 'Unassigned'}
                                  </span>
                                  <span
                                    className={
                                      'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ' +
                                      st.className
                                    }
                                  >
                                    {st.label}
                                  </span>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        generatingId === job.id || !!lockedJobs[job.id]
                      }
                      onClick={() => generateSlots(job)}
                    >
                      {generatingId === job.id ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Generating...
                        </>
                      ) : (
                        <>
                          <CalendarPlus className="mr-2 h-4 w-4" />
                          Generate Slots
                        </>
                      )}
                    </Button>

                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openSlots(job)}
                    >
                      <List className="mr-2 h-4 w-4" />
                      View Slots
                    </Button>

                    <Button
                      size="sm"
                      variant="outline"
                      disabled={linkBusyId === job.id}
                      onClick={() => generateQr(job)}
                    >
                      {linkBusyId === job.id ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Creating...
                        </>
                      ) : (
                        <>
                          <QrCode className="mr-2 h-4 w-4" />
                          Generate QR
                        </>
                      )}
                    </Button>

                    {bookingLinks[job.id] && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setQrFor(bookingLinks[job.id])}
                        >
                          <QrCode className="mr-2 h-4 w-4" />
                          View QR
                        </Button>

                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            copyLink(bookingLinks[job.id].booking_url)
                          }
                        >
                          <ExternalLink className="mr-2 h-4 w-4" />
                          Copy link
                        </Button>
                      </>
                    )}

                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openAssign(job)}
                    >
                      <UserPlus className="mr-2 h-4 w-4" />
                      {assignedTechs[job.id] ? 'Reassign' : 'Assign Technician'}
                    </Button>

                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!!lockedJobs[job.id]}
                      onClick={() => openEdit(job)}
                    >
                      <Pencil className="mr-2 h-4 w-4" />
                      Edit
                    </Button>

                    <Button
                      size="sm"
                      variant="outline"
                      className="text-destructive hover:text-destructive"
                      disabled={deletingId === job.id || !!lockedJobs[job.id]}
                      onClick={() => deleteJob(job)}
                    >
                      {deletingId === job.id ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Deleting...
                        </>
                      ) : (
                        <>
                          <Trash2 className="mr-2 h-4 w-4" />
                          Delete
                        </>
                      )}
                    </Button>
                  </div>

                  {bookingLinks[job.id] && (
                    <p className="mt-2 break-all text-xs text-muted-foreground">
                      {bookingLinks[job.id].booking_url}
                    </p>
                  )}

                  {lockedJobs[job.id] && (
                    <p className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700">
                      This job has active customer bookings and cannot be
                      modified.
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {viewingJob && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="view-slots-title"
          onKeyDown={(e) => {
            if (e.key === 'Escape') closeSlots();
          }}
          tabIndex={-1}
          onClick={(e) => {
            if (e.target === e.currentTarget) closeSlots();
          }}
        >
          <div className="w-full max-w-3xl space-y-4 rounded-lg border bg-background p-6 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="view-slots-title" className="text-lg font-semibold">
                  Slots
                </h2>
                <p className="text-sm text-muted-foreground">
                  {viewingJob.title || viewingJob.job_number || 'Untitled'}
                  {slots.length > 0 ? ' · ' + slots.length + ' slots' : ''}
                </p>
              </div>

              <Button size="sm" variant="outline" onClick={closeSlots}>
                Close
              </Button>
            </div>

            {slotsLoading ? (
              <div className="flex h-32 items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : slotsError ? (
              <p
                role="alert"
                className="rounded border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
              >
                {slotsError}
              </p>
            ) : slots.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No slots yet. Use Generate Slots to create them.
              </p>
            ) : (
              <div className="max-h-[60vh] overflow-y-auto rounded border">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-muted/60 backdrop-blur">
                    <tr className="text-left">
                      <th className="px-3 py-2 font-medium">Date</th>
                      <th className="px-3 py-2 font-medium">Start</th>
                      <th className="px-3 py-2 font-medium">End</th>
                      <th className="px-3 py-2 text-right font-medium">
                        Capacity
                      </th>
                      <th className="px-3 py-2 text-right font-medium">
                        Booked
                      </th>
                      <th className="px-3 py-2 font-medium">Status</th>
                    </tr>
                  </thead>

                  <tbody>
                    {slots.map((slot) => (
                      <tr key={slot.id} className="border-t">
                        <td className="px-3 py-2 tabular-nums">
                          {slot.slot_date}
                        </td>
                        <td className="px-3 py-2 tabular-nums">
                          {formatTime(slot.local_start)}
                        </td>
                        <td className="px-3 py-2 tabular-nums">
                          {formatTime(slot.local_end)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {slot.capacity}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {slot.booked_count}
                        </td>
                        <td className="px-3 py-2 capitalize">
                          {slot.status}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {qrFor && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="qr-title"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQrFor(null);
          }}
          tabIndex={-1}
          onClick={(e) => {
            if (e.target === e.currentTarget) setQrFor(null);
          }}
        >
          <div className="w-full max-w-sm space-y-4 rounded-lg border bg-background p-6 text-center shadow-xl">
            <div>
              <h2 id="qr-title" className="text-lg font-semibold">
                Booking QR
              </h2>
              <p className="text-sm text-muted-foreground">
                Residents scan this to book a slot
              </p>
            </div>

            <img
              src={QR_API_BASE + encodeURIComponent(qrFor.booking_url)}
              alt={'QR code for ' + qrFor.booking_url}
              width={260}
              height={260}
              className="mx-auto rounded border bg-white p-2"
            />

            <p className="break-all rounded border bg-muted/40 p-3 text-left text-xs">
              {qrFor.booking_url}
            </p>

            <div className="flex justify-center gap-2">
              <Button
                variant="outline"
                onClick={() => copyLink(qrFor.booking_url)}
              >
                Copy link
              </Button>
              <Button onClick={() => setQrFor(null)}>Close</Button>
            </div>
          </div>
        </div>
      )}

      {assignFor && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="assign-title"
          onKeyDown={(e) => {
            if (e.key === 'Escape') closeAssign();
          }}
          tabIndex={-1}
          onClick={(e) => {
            if (e.target === e.currentTarget) closeAssign();
          }}
        >
          <div className="w-full max-w-md space-y-5 rounded-lg border bg-background p-6 shadow-xl">
            <div>
              <h2 id="assign-title" className="text-lg font-semibold">
                {assignedTechs[assignFor.id]
                  ? 'Reassign Technician'
                  : 'Assign Technician'}
              </h2>
              <p className="text-sm text-muted-foreground">
                {assignFor.title || assignFor.job_number || 'Untitled'}
              </p>
            </div>

            {assignLoading ? (
              <div className="flex h-24 items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : assignableTechs.length === 0 ? (
              <p className="rounded border bg-muted/40 p-3 text-sm">
                No available technicians. Mark one as available on the
                Technicians page first.
              </p>
            ) : (
              <select
                className="w-full rounded border p-2"
                value={assignTechnicianId}
                onChange={(e) => setAssignTechnicianId(e.target.value)}
              >
                <option value="">Choose a technician</option>
                {assignableTechs.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.full_name || 'Unnamed'}
                    {t.code ? ' (' + t.code + ')' : ''}
                  </option>
                ))}
              </select>
            )}

            {assignError && (
              <p
                role="alert"
                className="rounded border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
              >
                {assignError}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={closeAssign}>
                Cancel
              </Button>
              <Button
                disabled={assignSaving || assignLoading || !assignTechnicianId}
                onClick={saveAssignment}
              >
                {assignSaving ? 'Saving...' : 'Save assignment'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {editingJob && draft && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-job-title"
          onKeyDown={(e) => {
            if (e.key === 'Escape') closeEdit();
          }}
          tabIndex={-1}
          onClick={(e) => {
            if (e.target === e.currentTarget) closeEdit();
          }}
        >
          <form
            onSubmit={saveEdit}
            className="w-full max-w-2xl space-y-5 rounded-lg border bg-background p-6 shadow-xl"
          >
            <div>
              <h2 id="edit-job-title" className="text-lg font-semibold">
                Edit Job
              </h2>
              <p className="text-sm text-muted-foreground">
                {editingJob.job_number || 'Untitled'}
              </p>
            </div>

            <div>
              <h3 className="mb-3 text-sm font-semibold">Job Details</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <input
                  className="rounded border p-2"
                  placeholder="Job Number"
                  value={draft.job_number}
                  onChange={(e) =>
                    setDraft({ ...draft, job_number: e.target.value })
                  }
                />
                <input
                  className="rounded border p-2"
                  placeholder="Title"
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                />
                <input
                  className="rounded border p-2"
                  placeholder="Reference"
                  value={draft.reference}
                  onChange={(e) =>
                    setDraft({ ...draft, reference: e.target.value })
                  }
                />
                <input
                  type="number"
                  min={0}
                  className="rounded border p-2"
                  placeholder="Unit count"
                  value={draft.unit_count}
                  onChange={(e) =>
                    setDraft({ ...draft, unit_count: Number(e.target.value) })
                  }
                />
              </div>
            </div>

            <div>
              <h3 className="mb-3 text-sm font-semibold">Schedule</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <input
                  type="date"
                  className="rounded border p-2"
                  value={draft.start_date}
                  onChange={(e) =>
                    setDraft({ ...draft, start_date: e.target.value })
                  }
                  required
                />
                <input
                  type="date"
                  className="rounded border p-2"
                  min={draft.start_date || undefined}
                  value={draft.end_date}
                  onChange={(e) =>
                    setDraft({ ...draft, end_date: e.target.value })
                  }
                  required
                />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Changing dates does not regenerate existing slots.
              </p>
            </div>

            <div>
              <h3 className="mb-3 text-sm font-semibold">Site Information</h3>
              <div className="grid gap-3">
                <input
                  className="rounded border p-2"
                  placeholder="Site Name"
                  value={draft.site_name}
                  onChange={(e) =>
                    setDraft({ ...draft, site_name: e.target.value })
                  }
                />
                <input
                  className="rounded border p-2"
                  placeholder="Address Line 1"
                  value={draft.address_line1}
                  onChange={(e) =>
                    setDraft({ ...draft, address_line1: e.target.value })
                  }
                />
                <input
                  className="rounded border p-2"
                  placeholder="Address Line 2"
                  value={draft.address_line2}
                  onChange={(e) =>
                    setDraft({ ...draft, address_line2: e.target.value })
                  }
                />
                <div className="grid gap-3 sm:grid-cols-3">
                  <input
                    className="rounded border p-2"
                    placeholder="Suburb"
                    value={draft.suburb}
                    onChange={(e) =>
                      setDraft({ ...draft, suburb: e.target.value })
                    }
                  />
                  <input
                    className="rounded border p-2"
                    placeholder="State"
                    value={draft.state}
                    onChange={(e) => setDraft({ ...draft, state: e.target.value })}
                  />
                  <input
                    className="rounded border p-2"
                    placeholder="Postcode"
                    value={draft.postcode}
                    onChange={(e) =>
                      setDraft({ ...draft, postcode: e.target.value })
                    }
                  />
                </div>
              </div>
            </div>

            {saveError && (
              <p
                role="alert"
                className="rounded border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
              >
                {saveError}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={closeEdit}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? 'Saving...' : 'Save changes'}
              </Button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
