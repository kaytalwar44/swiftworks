/**
 * SwiftWorks — Supabase database types
 *
 * Derived from the deployed phase migrations:
 *   bootstrap.sql · phase2_tables.sql · phase3_auth.sql
 *   phase4_rls.sql · phase5_prerequisites.sql · phase5_api.sql
 *   phase6_notifications_v2.sql
 *
 * Surface: 27 public tables · 15 app enums · 37 app functions · 36 public RPCs
 *
 * Shape matters: client.ts does `createClient<Database>(...)`, so `Database`
 * must carry the Tables / Views / Functions / Enums / CompositeTypes keys the
 * Supabase client expects. The named row interfaces below are re-exported for
 * application code; the client only reads `Database`.
 *
 * Regenerate against the live database once the CLI is linked:
 *   supabase gen types typescript --linked > src/lib/supabase/database.types.ts
 */
export type UserStatus = 'invited' | 'active' | 'suspended' | 'disabled';
export type MemberType = 'staff' | 'partner' | 'technician' | 'customer_service';
export type JobStatus = 'draft' | 'scheduled' | 'published' | 'in_progress' | 'completed' | 'cancelled' | 'archived';
export type SlotStatus = 'open' | 'held' | 'booked' | 'completed' | 'cancelled' | 'blocked';
export type BookingStatus = 'pending' | 'confirmed' | 'rescheduled' | 'in_progress' | 'completed' | 'cancelled' | 'no_show';
export type QrStatus = 'active' | 'paused' | 'expired' | 'revoked';
export type RateUnit = 'each' | 'hour' | 'half_day' | 'day' | 'metre' | 'kilometre' | 'fixed' | 'percent';
export type InvoiceDirection = 'payable' | 'receivable';
export type InvoiceStatus = 'draft' | 'submitted' | 'approved' | 'sent' | 'part_paid' | 'paid' | 'void' | 'disputed';
export type NotificationChannel = 'email' | 'sms' | 'push' | 'in_app' | 'webhook';
export type NotificationStatus = 'queued' | 'sending' | 'sent' | 'delivered' | 'failed' | 'cancelled' | 'read' | 'processing' | 'dead_letter';
export type EmailStatus = 'queued' | 'sending' | 'sent' | 'delivered' | 'bounced' | 'failed' | 'complained';
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'unpaid' | 'canceled' | 'incomplete' | 'incomplete_expired' | 'paused';
export type BillingInterval = 'day' | 'week' | 'month' | 'year';
export type BookingError = 'invalid_token' | 'qr_inactive' | 'qr_expired' | 'job_not_found' | 'job_not_published' | 'job_closed' | 'job_cancelled' | 'slot_not_found' | 'slot_unavailable' | 'slot_full' | 'unit_already_booked' | 'verification_required' | 'verification_invalid' | 'rate_limited' | 'invalid_input';
export interface CompanyRow {
    id: string;
    slug: string;
    legal_name: string;
    trading_name: string | null;
    abn: string | null;
    email: string | null;
    phone: string | null;
    website: string | null;
    logo_url: string | null;
    timezone: string;
    currency: string;
    locale: string;
    default_tax_rate: number;
    address_line1: string | null;
    address_line2: string | null;
    suburb: string | null;
    state: string | null;
    postcode: string | null;
    country: string;
    settings: Record<string, unknown>;
    branding: Record<string, unknown>;
    onboarding_status: 'pending' | 'in_progress' | 'complete';
    is_active: boolean;
    created_at: string;
    created_by: string | null;
    updated_at: string;
    updated_by: string | null;
    deleted_at: string | null;
    deleted_by: string | null;
}
export interface RoleRow {
    id: string;
    company_id: string | null;
    code: string;
    name: string;
    description: string | null;
    permissions: string[];
    is_system: boolean;
    rank: number;
    created_at: string;
    created_by: string | null;
    updated_at: string;
    updated_by: string | null;
    deleted_at: string | null;
    deleted_by: string | null;
}
export interface UserRow {
    id: string;
    company_id: string;
    partner_id: string | null;
    email: string;
    full_name: string | null;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
    avatar_url: string | null;
    job_title: string | null;
    status: UserStatus;
    member_type: MemberType;
    is_platform_admin: boolean;
    timezone: string;
    locale: string;
    notification_prefs: {
        email: boolean;
        sms: boolean;
        push: boolean;
        in_app: boolean;
    };
    ms_graph_user_id: string | null;
    ms_upn: string | null;
    last_seen_at: string | null;
    invited_at: string | null;
    accepted_at: string | null;
    metadata: Record<string, unknown>;
    created_at: string;
    created_by: string | null;
    updated_at: string;
    updated_by: string | null;
    deleted_at: string | null;
    deleted_by: string | null;
}
export interface UserRoleRow {
    id: string;
    company_id: string;
    user_id: string;
    role_id: string;
    granted_at: string;
    granted_by: string | null;
    expires_at: string | null;
    created_at: string;
    created_by: string | null;
    updated_at: string;
    updated_by: string | null;
    deleted_at: string | null;
    deleted_by: string | null;
}
export interface UserInvitationRow {
    id: string;
    company_id: string;
    email: string;
    token: string;
    role_id: string | null;
    partner_id: string | null;
    member_type: MemberType;
    invited_by: string | null;
    expires_at: string;
    accepted_at: string | null;
    accepted_by: string | null;
    revoked_at: string | null;
    revoked_by: string | null;
    send_count: number;
    last_sent_at: string | null;
    created_at: string;
    created_by: string | null;
    updated_at: string;
    updated_by: string | null;
}
export interface PartnerRow {
    id: string;
    company_id: string;
    code: string;
    name: string;
    legal_name: string | null;
    trading_name: string | null;
    abn: string | null;
    contact_name: string | null;
    contact_email: string | null;
    contact_phone: string | null;
    billing_email: string | null;
    portal_enabled: boolean;
    default_rate_card_id: string | null;
    payment_terms_days: number;
    address_line1: string | null;
    address_line2: string | null;
    suburb: string | null;
    state: string | null;
    postcode: string | null;
    country: string;
    notes: string | null;
    settings: Record<string, unknown>;
    is_active: boolean;
    created_at: string;
    created_by: string | null;
    updated_at: string;
    updated_by: string | null;
    deleted_at: string | null;
    deleted_by: string | null;
}
export interface TechnicianRow {
    id: string;
    company_id: string;
    partner_id: string | null;
    user_id: string | null;
    code: string;
    full_name: string;
    email: string | null;
    phone: string | null;
    abn: string | null;
    employment_type: 'employee' | 'contractor' | 'subcontractor';
    skills: string[];
    service_areas: string[];
    max_installs_per_day: number;
    colour: string | null;
    is_available: boolean;
    rating: number | null;
    notes: string | null;
    metadata: Record<string, unknown>;
    created_at: string;
    created_by: string | null;
    updated_at: string;
    updated_by: string | null;
    deleted_at: string | null;
    deleted_by: string | null;
}
export interface CustomerRow {
    id: string;
    company_id: string;
    email: string | null;
    phone: string | null;
    full_name: string | null;
    first_name: string | null;
    last_name: string | null;
    unit_number: string | null;
    address_line1: string | null;
    address_line2: string | null;
    suburb: string | null;
    state: string | null;
    postcode: string | null;
    country: string;
    marketing_opt_in: boolean;
    sms_opt_in: boolean;
    email_verified_at: string | null;
    phone_verified_at: string | null;
    first_seen_at: string;
    last_booking_at: string | null;
    booking_count: number;
    no_show_count: number;
    notes: string | null;
    metadata: Record<string, unknown>;
    created_at: string;
    created_by: string | null;
    updated_at: string;
    updated_by: string | null;
    deleted_at: string | null;
    deleted_by: string | null;
}
export interface JobRow {
    id: string;
    company_id: string;
    partner_id: string;
    job_number: string;
    title: string | null;
    reference: string | null;
    status: JobStatus;
    priority: number;
    site_name: string | null;
    address_line1: string;
    address_line2: string | null;
    suburb: string;
    state: string;
    postcode: string;
    country: string;
    latitude: number | null;
    longitude: number | null;
    access_notes: string | null;
    unit_count: number;
    installs_per_day: number;
    slot_minutes: number;
    day_start_time: string;
    day_end_time: string;
    working_days: number[];
    start_date: string;
    end_date: string;
    booking_opens_at: string | null;
    booking_closes_at: string | null;
    published_at: string | null;
    completed_at: string | null;
    cancelled_at: string | null;
    cancellation_reason: string | null;
    require_sms_verification: boolean;
    require_email: boolean;
    require_unit_number: boolean;
    allow_waitlist: boolean;
    max_units_per_booking: number;
    instructions: string | null;
    contact_name: string | null;
    contact_phone: string | null;
    settings: Record<string, unknown>;
    metadata: Record<string, unknown>;
    created_at: string;
    created_by: string | null;
    updated_at: string;
    updated_by: string | null;
    deleted_at: string | null;
    deleted_by: string | null;
}
export interface JobTechnicianRow {
    id: string;
    company_id: string;
    job_id: string;
    technician_id: string;
    is_lead: boolean;
    assigned_from: string | null;
    assigned_to: string | null;
    daily_capacity: number | null;
    notes: string | null;
    created_at: string;
    created_by: string | null;
    updated_at: string;
    updated_by: string | null;
    deleted_at: string | null;
    deleted_by: string | null;
}
export interface QrCodeRow {
    id: string;
    company_id: string;
    job_id: string;
    token: string;
    label: string | null;
    scope: 'job' | 'unit' | 'batch';
    unit_number: string | null;
    status: QrStatus;
    target_url: string | null;
    image_path: string | null;
    image_url: string | null;
    max_scans: number | null;
    max_bookings: number | null;
    scan_count: number;
    booking_count: number;
    last_scanned_at: string | null;
    opens_at: string | null;
    expires_at: string | null;
    revoked_at: string | null;
    revoked_reason: string | null;
    created_via: 'partner_portal' | 'api' | 'import' | 'admin';
    metadata: Record<string, unknown>;
    created_at: string;
    created_by: string | null;
    updated_at: string;
    updated_by: string | null;
    deleted_at: string | null;
    deleted_by: string | null;
}
export interface QrCodeScanRow {
    id: string;
    company_id: string;
    qr_code_id: string;
    scanned_at: string;
    ip_address: string | null;
    user_agent: string | null;
    referrer: string | null;
    device_type: 'mobile' | 'tablet' | 'desktop' | 'bot' | 'unknown' | null;
    os: string | null;
    browser: string | null;
    country: string | null;
    region: string | null;
    city: string | null;
    session_id: string | null;
    converted: boolean;
    booking_id: string | null;
    utm_source: string | null;
    utm_medium: string | null;
    utm_campaign: string | null;
    metadata: Record<string, unknown>;
}
export interface JobSlotRow {
    id: string;
    company_id: string;
    job_id: string;
    technician_id: string | null;
    slot_date: string;
    start_time: string;
    end_time: string;
    local_start: string;
    local_end: string;
    capacity: number;
    booked_count: number;
    status: SlotStatus;
    hold_token: string | null;
    hold_expires_at: string | null;
    sequence: number;
    notes: string | null;
    created_at: string;
    created_by: string | null;
    updated_at: string;
    updated_by: string | null;
    deleted_at: string | null;
    deleted_by: string | null;
}
export interface CustomerBookingRow {
    id: string;
    company_id: string;
    job_id: string;
    slot_id: string | null;
    technician_id: string | null;
    customer_id: string | null;
    qr_code_id: string | null;
    booking_ref: string;
    status: BookingStatus;
    unit_number: string | null;
    phone: string;
    email: string | null;
    full_name: string | null;
    special_comments: string | null;
    scheduled_date: string | null;
    scheduled_start: string | null;
    scheduled_end: string | null;
    sms_verified: boolean;
    sms_verified_at: string | null;
    email_verified: boolean;
    email_verified_at: string | null;
    confirmed_at: string | null;
    reminder_sent_at: string | null;
    checked_in_at: string | null;
    started_at: string | null;
    completed_at: string | null;
    cancelled_at: string | null;
    cancellation_reason: string | null;
    cancelled_by: 'customer' | 'partner' | 'technician' | 'system' | null;
    rescheduled_from_id: string | null;
    reschedule_count: number;
    source: 'qr' | 'link' | 'phone' | 'email' | 'walk_in' | 'import' | 'api';
    technician_notes: string | null;
    completed_notes: string | null;
    signature_url: string | null;
    photo_urls: string[];
    metadata: Record<string, unknown>;
    created_at: string;
    created_by: string | null;
    updated_at: string;
    updated_by: string | null;
    deleted_at: string | null;
    deleted_by: string | null;
}
export interface RateCardRow {
    id: string;
    company_id: string;
    technician_id: string | null;
    partner_id: string | null;
    name: string;
    code: string | null;
    scope: 'technician' | 'partner' | 'company';
    effective_from: string;
    effective_to: string | null;
    currency: string;
    tax_rate: number;
    tax_inclusive: boolean;
    is_active: boolean;
    source: 'manual' | 'csv' | 'xlsx' | 'api' | 'template';
    source_filename: string | null;
    source_checksum: string | null;
    imported_at: string | null;
    imported_by: string | null;
    import_summary: Record<string, unknown>;
    notes: string | null;
    created_at: string;
    created_by: string | null;
    updated_at: string;
    updated_by: string | null;
    deleted_at: string | null;
    deleted_by: string | null;
}
export interface RateCardItemRow {
    id: string;
    company_id: string;
    rate_card_id: string;
    code: string;
    description: string;
    category: string | null;
    unit: RateUnit;
    rate: number;
    min_quantity: number;
    max_quantity: number | null;
    technician_pay: number | null;
    is_taxable: boolean;
    is_active: boolean;
    sort_order: number;
    external_code: string | null;
    source_row: number | null;
    metadata: Record<string, unknown>;
    created_at: string;
    created_by: string | null;
    updated_at: string;
    updated_by: string | null;
    deleted_at: string | null;
    deleted_by: string | null;
}
export interface InvoiceRow {
    id: string;
    company_id: string;
    invoice_number: string;
    direction: InvoiceDirection;
    status: InvoiceStatus;
    technician_id: string | null;
    partner_id: string | null;
    customer_id: string | null;
    job_id: string | null;
    rate_card_id: string | null;
    subscription_id: string | null;
    period_start: string | null;
    period_end: string | null;
    issue_date: string;
    due_date: string | null;
    paid_date: string | null;
    currency: string;
    subtotal: number;
    discount_total: number;
    tax_total: number;
    total: number;
    amount_paid: number;
    /** Generated column: total - amount_paid. Never written directly. */
    amount_due: number;
    tax_rate: number;
    tax_inclusive: boolean;
    supply_date: string | null;
    place_of_supply: string;
    supplier_abn: string | null;
    supplier_name: string | null;
    buyer_abn: string | null;
    buyer_name: string | null;
    purchase_order: string | null;
    notes: string | null;
    terms: string | null;
    pdf_path: string | null;
    pdf_url: string | null;
    pdf_generated_at: string | null;
    submitted_at: string | null;
    approved_at: string | null;
    approved_by: string | null;
    sent_at: string | null;
    voided_at: string | null;
    void_reason: string | null;
    dispute_reason: string | null;
    xero_invoice_id: string | null;
    myob_invoice_id: string | null;
    quickbooks_id: string | null;
    external_reference: string | null;
    line_count: number;
    metadata: Record<string, unknown>;
    created_at: string;
    created_by: string | null;
    updated_at: string;
    updated_by: string | null;
    deleted_at: string | null;
    deleted_by: string | null;
}
export interface InvoiceItemRow {
    id: string;
    company_id: string;
    invoice_id: string;
    customer_booking_id: string | null;
    job_id: string | null;
    technician_id: string | null;
    rate_card_item_id: string | null;
    line_number: number;
    code: string | null;
    description: string;
    category: string | null;
    unit: RateUnit;
    quantity: number;
    unit_rate: number;
    discount_rate: number;
    discount_amount: number;
    tax_rate: number;
    is_taxable: boolean;
    technician_pay: number | null;
    service_date: string | null;
    install_completed_at: string | null;
    source: 'booking' | 'rate_card' | 'manual' | 'rollup' | 'adjustment' | 'import';
    notes: string | null;
    metadata: Record<string, unknown>;
    /** Generated columns. Never written directly. */
    line_subtotal: number;
    line_tax: number;
    line_total: number;
    created_at: string;
    created_by: string | null;
    updated_at: string;
    updated_by: string | null;
    deleted_at: string | null;
    deleted_by: string | null;
}
export interface NotificationRow {
    id: string;
    company_id: string;
    channel: NotificationChannel;
    status: NotificationStatus;
    template_key: string | null;
    event_key: string | null;
    subject: string | null;
    body: string | null;
    body_html: string | null;
    variables: Record<string, unknown>;
    recipient_user_id: string | null;
    recipient_customer_id: string | null;
    recipient_technician_id: string | null;
    recipient_partner_id: string | null;
    recipient_email: string | null;
    recipient_phone: string | null;
    recipient_name: string | null;
    customer_booking_id: string | null;
    job_id: string | null;
    technician_id: string | null;
    invoice_id: string | null;
    priority: number;
    scheduled_for: string;
    expires_at: string | null;
    attempt_count: number;
    max_attempts: number;
    last_attempt_at: string | null;
    next_attempt_at: string | null;
    sent_at: string | null;
    delivered_at: string | null;
    read_at: string | null;
    failed_at: string | null;
    error_code: string | null;
    error_message: string | null;
    provider: string | null;
    provider_message_id: string | null;
    dedupe_key: string | null;
    metadata: Record<string, unknown>;
    created_at: string;
    created_by: string | null;
    updated_at: string;
    updated_by: string | null;
}
export interface EmailAccountRow {
    id: string;
    company_id: string;
    label: string;
    provider: 'microsoft_graph' | 'smtp' | 'resend' | 'sendgrid' | 'ses';
    from_name: string;
    from_email: string;
    reply_to_email: string | null;
    ms_tenant_id: string | null;
    ms_client_id: string | null;
    ms_token_secret_ref: string | null;
    ms_mailbox_upn: string | null;
    ms_mailbox_user_id: string | null;
    ms_scope: string;
    ms_auth_mode: 'client_credentials' | 'delegated' | 'shared_mailbox';
    ms_save_to_sent: boolean;
    smtp_host: string | null;
    smtp_port: number | null;
    smtp_secure: boolean;
    smtp_username: string | null;
    smtp_password_ref: string | null;
    api_key_ref: string | null;
    daily_send_limit: number;
    daily_sent_count: number;
    quota_reset_at: string | null;
    is_default: boolean;
    is_verified: boolean;
    verified_at: string | null;
    last_send_at: string | null;
    last_error: string | null;
    connection_meta: Record<string, unknown>;
    settings: Record<string, unknown>;
    created_at: string;
    created_by: string | null;
    updated_at: string;
    updated_by: string | null;
    deleted_at: string | null;
    deleted_by: string | null;
}
export interface EmailLogRow {
    id: string;
    company_id: string;
    notification_id: string | null;
    email_account_id: string | null;
    status: EmailStatus;
    direction: 'outbound' | 'inbound';
    from_email: string;
    from_name: string | null;
    to_emails: string[];
    cc_emails: string[];
    bcc_emails: string[];
    reply_to: string | null;
    subject: string | null;
    body_preview: string | null;
    template_key: string | null;
    event_key: string | null;
    has_attachments: boolean;
    attachment_count: number;
    recipient_user_id: string | null;
    customer_booking_id: string | null;
    job_id: string | null;
    invoice_id: string | null;
    provider: string;
    graph_message_id: string | null;
    internet_message_id: string | null;
    conversation_id: string | null;
    conversation_index: string | null;
    graph_request_id: string | null;
    graph_status_code: number | null;
    graph_error_code: string | null;
    graph_error_message: string | null;
    smtp_response: string | null;
    queued_at: string;
    sent_at: string | null;
    delivered_at: string | null;
    opened_at: string | null;
    bounced_at: string | null;
    failed_at: string | null;
    retry_count: number;
    latency_ms: number | null;
    created_at: string;
    created_by: string | null;
}
export interface SubscriptionPlanRow {
    id: string;
    code: string;
    name: string;
    description: string | null;
    tier: number;
    stripe_product_id: string | null;
    stripe_price_id: string | null;
    price: number;
    currency: string;
    billing_interval: BillingInterval;
    interval_count: number;
    trial_days: number;
    included_users: number;
    included_technicians: number;
    included_jobs_per_month: number;
    included_bookings_per_month: number;
    included_sms: number;
    included_emails: number;
    max_storage_mb: number;
    features: string[];
    limits: Record<string, unknown>;
    is_public: boolean;
    is_active: boolean;
    sort_order: number;
    metadata: Record<string, unknown>;
    created_at: string;
    created_by: string | null;
    updated_at: string;
    updated_by: string | null;
    deleted_at: string | null;
    deleted_by: string | null;
}
export interface SubscriptionRow {
    id: string;
    company_id: string;
    plan_id: string;
    status: SubscriptionStatus;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    stripe_price_id: string | null;
    stripe_product_id: string | null;
    stripe_latest_invoice_id: string | null;
    stripe_default_payment_method_id: string | null;
    quantity: number;
    currency: string;
    unit_amount: number | null;
    billing_interval: BillingInterval;
    interval_count: number;
    trial_start: string | null;
    trial_end: string | null;
    current_period_start: string | null;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    cancel_at: string | null;
    canceled_at: string | null;
    ended_at: string | null;
    paused_at: string | null;
    resumed_at: string | null;
    grace_period_ends_at: string | null;
    seats_used: number;
    sms_used_this_period: number;
    emails_used_this_period: number;
    bookings_used_this_period: number;
    storage_used_mb: number;
    overage_amount: number;
    billing_email: string | null;
    billing_name: string | null;
    billing_address: Record<string, unknown>;
    tax_id: string | null;
    tax_exempt: 'none' | 'exempt' | 'reverse';
    discount_code: string | null;
    coupon_id: string | null;
    last_webhook_at: string | null;
    last_webhook_event: string | null;
    cancelled_reason: string | null;
    cancellation_feedback: string | null;
    metadata: Record<string, unknown>;
    created_at: string;
    created_by: string | null;
    updated_at: string;
    updated_by: string | null;
    deleted_at: string | null;
    deleted_by: string | null;
}
export interface AuditLogRow {
    id: string;
    company_id: string | null;
    table_name: string;
    record_id: string;
    operation: 'INSERT' | 'UPDATE' | 'DELETE';
    actor_id: string | null;
    actor_role: string | null;
    changed_at: string;
    old_data: Record<string, unknown> | null;
    new_data: Record<string, unknown> | null;
    changed_keys: string[] | null;
}
export interface SmsChallengeRow {
    id: string;
    company_id: string;
    qr_code_id: string | null;
    phone: string;
    code_hash: string;
    attempts: number;
    max_attempts: number;
    verified_at: string | null;
    consumed_at: string | null;
    expires_at: string;
    created_at: string;
}
export interface BookingIdempotencyRow {
    key: string;
    booking_id: string;
    company_id: string;
    created_at: string;
}
export interface BookingRateLimitRow {
    id: number;
    company_id: string;
    bucket: string;
    occurred_at: string;
}
type TableShape<Row, Insert = Partial<Row>, Update = Partial<Row>> = {
    Row: Row;
    Insert: Insert;
    Update: Update;
    Relationships: [];
};
export interface Database {
    public: {
        Tables: {
            audit_logs: TableShape<AuditLogRow>;
            booking_idempotency: TableShape<BookingIdempotencyRow>;
            booking_rate_limit: TableShape<BookingRateLimitRow>;
            companies: TableShape<CompanyRow>;
            customer_bookings: TableShape<CustomerBookingRow>;
            customers: TableShape<CustomerRow>;
            email_accounts: TableShape<EmailAccountRow>;
            email_logs: TableShape<EmailLogRow>;
            invoice_items: TableShape<InvoiceItemRow>;
            invoices: TableShape<InvoiceRow>;
            job_slots: TableShape<JobSlotRow>;
            job_technicians: TableShape<JobTechnicianRow>;
            jobs: TableShape<JobRow>;
            notifications: TableShape<NotificationRow>;
            partners: TableShape<PartnerRow>;
            qr_code_scans: TableShape<QrCodeScanRow>;
            qr_codes: TableShape<QrCodeRow>;
            rate_card_items: TableShape<RateCardItemRow>;
            rate_cards: TableShape<RateCardRow>;
            roles: TableShape<RoleRow>;
            sms_challenges: TableShape<SmsChallengeRow>;
            subscription_plans: TableShape<SubscriptionPlanRow>;
            subscriptions: TableShape<SubscriptionRow>;
            technicians: TableShape<TechnicianRow>;
            user_invitations: TableShape<UserInvitationRow>;
            user_roles: TableShape<UserRoleRow>;
            users: TableShape<UserRow>;
        };
        Views: Record<string, never>;
        Functions: {
            create_booking: {
                Args: Record<string, unknown>;
                Returns: unknown;
            };
            cancel_booking: {
                Args: Record<string, unknown>;
                Returns: unknown;
            };
            reschedule_booking: {
                Args: Record<string, unknown>;
                Returns: unknown;
            };
            booking_lookup: {
                Args: {
                    p_token: string;
                };
                Returns: unknown;
            };
            available_slots: {
                Args: {
                    p_token: string;
                };
                Returns: unknown;
            };
            create_job: {
                Args: Record<string, unknown>;
                Returns: string;
            };
            generate_slots: {
                Args: {
                    p_job_id: string;
                };
                Returns: number;
            };
            publish_job: {
                Args: Record<string, unknown>;
                Returns: unknown;
            };
            assign_technician: {
                Args: Record<string, unknown>;
                Returns: string;
            };
            complete_job: {
                Args: {
                    p_job_id: string;
                };
                Returns: unknown;
            };
            create_customer: {
                Args: Record<string, unknown>;
                Returns: string;
            };
            search_customers: {
                Args: Record<string, unknown>;
                Returns: unknown;
            };
            create_invoice: {
                Args: Record<string, unknown>;
                Returns: string;
            };
            add_invoice_item: {
                Args: Record<string, unknown>;
                Returns: string;
            };
            build_pay_run: {
                Args: Record<string, unknown>;
                Returns: unknown;
            };
            finalize_invoice: {
                Args: {
                    p_invoice_id: string;
                };
                Returns: unknown;
            };
            dashboard_summary: {
                Args: Record<string, unknown>;
                Returns: unknown;
            };
            partner_dashboard: {
                Args: Record<string, unknown>;
                Returns: unknown;
            };
            technician_dashboard: {
                Args: Record<string, unknown>;
                Returns: unknown;
            };
            notification_metrics: {
                Args: Record<string, unknown>;
                Returns: unknown;
            };
            create_tenant: {
                Args: Record<string, unknown>;
                Returns: string;
            };
            handle_new_user: {
                Args: Record<string, unknown>;
                Returns: string;
            };
            invite_user: {
                Args: Record<string, unknown>;
                Returns: unknown;
            };
            revoke_invitation: {
                Args: {
                    p_invitation_id: string;
                };
                Returns: boolean;
            };
            invitation_lookup: {
                Args: {
                    p_token: string;
                };
                Returns: unknown;
            };
            accept_invitation: {
                Args: {
                    p_token: string;
                };
                Returns: string;
            };
            complete_onboarding: {
                Args: Record<string, unknown>;
                Returns: boolean;
            };
            queue_email: {
                Args: Record<string, unknown>;
                Returns: string;
            };
            queue_sms: {
                Args: Record<string, unknown>;
                Returns: string;
            };
            queue_push: {
                Args: Record<string, unknown>;
                Returns: string;
            };
            process_notifications: {
                Args: Record<string, unknown>;
                Returns: unknown;
            };
            complete_notification: {
                Args: Record<string, unknown>;
                Returns: unknown;
            };
            retry_failed_notifications: {
                Args: Record<string, unknown>;
                Returns: number;
            };
            schedule_booking_reminders: {
                Args: Record<string, unknown>;
                Returns: unknown;
            };
            schedule_technician_run_sheets: {
                Args: Record<string, unknown>;
                Returns: unknown;
            };
            expire_notifications: {
                Args: Record<string, unknown>;
                Returns: unknown;
            };
            booking_housekeeping: {
                Args: Record<string, never>;
                Returns: unknown;
            };
        };
        Enums: {
            user_status: UserStatus;
            member_type: MemberType;
            job_status: JobStatus;
            slot_status: SlotStatus;
            booking_status: BookingStatus;
            qr_status: QrStatus;
            rate_unit: RateUnit;
            invoice_direction: InvoiceDirection;
            invoice_status: InvoiceStatus;
            notification_channel: NotificationChannel;
            notification_status: NotificationStatus;
            email_status: EmailStatus;
            subscription_status: SubscriptionStatus;
            billing_interval: BillingInterval;
            booking_error: BookingError;
        };
        CompositeTypes: Record<string, never>;
    };
}
export interface BookingLookupResult {
    job_id: string;
    job_number: string;
    title: string | null;
    site_name: string | null;
    address_line1: string;
    suburb: string;
    state: string;
    postcode: string;
    access_notes: string | null;
    instructions: string | null;
    unit_count: number;
    require_unit_number: boolean;
    require_sms_verification: boolean;
    booking_opens_at: string | null;
    booking_closes_at: string | null;
    qr_scope: 'job' | 'unit' | 'batch';
    prefilled_unit: string | null;
    is_open: boolean;
    closed_reason: BookingError | null;
}
export interface AvailableSlotResult {
    slot_id: string;
    slot_date: string;
    local_start: string;
    local_end: string;
    start_time: string;
    end_time: string;
    capacity: number;
    remaining: number;
    technician_name: string | null;
}
export interface CreateBookingResult {
    booking_id: string;
    booking_ref: string;
    status: BookingStatus;
    scheduled_date: string;
    scheduled_start: string;
    scheduled_end: string;
    unit_number: string | null;
    job_id: string;
    job_number: string;
    site_address: string;
    technician_name: string | null;
    already_existed: boolean;
}
export interface CancelBookingResult {
    booking_id: string;
    booking_ref: string;
    status: BookingStatus;
    cancelled_at: string;
}
export interface RescheduleBookingResult {
    booking_id: string;
    booking_ref: string;
    scheduled_date: string;
    scheduled_start: string;
    scheduled_end: string;
    technician_name: string | null;
}
export interface PublishJobResult {
    job_id: string;
    status: JobStatus;
    qr_token: string | null;
    published_at: string;
}
export interface CompleteJobResult {
    job_id: string;
    status: JobStatus;
    completed_at: string;
    outstanding_bookings: number;
}
export interface SearchCustomerResult {
    customer_id: string;
    full_name: string | null;
    phone: string | null;
    email: string | null;
    unit_number: string | null;
    booking_count: number;
    last_booking_at: string | null;
}
export interface BuildPayRunResult {
    invoice_id: string;
    invoice_number: string;
    line_count: number;
    total: number;
}
export interface FinalizeInvoiceResult {
    invoice_id: string;
    invoice_number: string;
    status: InvoiceStatus;
    subtotal: number;
    tax_total: number;
    total: number;
    line_count: number;
    finalised_at: string;
}
export interface InviteUserResult {
    invitation_id: string;
    token: string;
    email: string;
    role_id: string | null;
    expires_at: string;
    is_resend: boolean;
}
export interface InvitationLookupResult {
    email: string;
    company_name: string | null;
    company_slug: string;
    role_name: string | null;
    member_type: MemberType;
    invited_at: string;
    expires_at: string;
    is_valid: boolean;
    reason: 'already_accepted' | 'revoked' | 'expired' | null;
}
export interface ProcessNotificationResult {
    notification_id: string;
    channel: NotificationChannel;
    provider: string | null;
    recipient: string;
    subject: string | null;
    body: string | null;
    variables: Record<string, unknown>;
    attempt_count: number;
    max_attempts: number;
    action: 'ready' | 'dispatched' | 'expired' | 'dead_lettered';
}
export interface CompleteNotificationResult {
    notification_id: string;
    status: NotificationStatus;
    attempt_count: number;
    next_attempt_at?: string;
    action: 'sent' | 'retry_scheduled' | 'dead_lettered';
}
export interface DashboardSummary {
    period: {
        from: string;
        to: string;
    };
    jobs: {
        total: number;
        published: number;
        in_progress: number;
        completed: number;
    };
    bookings: {
        total: number;
        today: number;
        confirmed: number;
        completed: number;
        no_show: number;
    };
    slots: {
        open: number;
        capacity: number;
    };
    qr: {
        active: number;
        scans: number;
        conversion_rate: number;
    };
    invoices: {
        draft: number;
        payable_outstanding: number;
        receivable_outstanding: number;
    };
    customers: {
        total: number;
        new: number;
    };
}
export interface PartnerDashboard {
    partner_id: string | null;
    period: {
        from: string;
        to: string;
    };
    jobs: {
        total: number;
        published: number;
        active: number;
    };
    bookings: {
        total: number;
        today: number;
        completed: number;
    };
    capacity: {
        open_slots: number;
        remaining: number;
    };
    units: {
        contracted: number;
        booked: number;
    };
    progress_pct: number;
}
export interface TechnicianDashboard {
    technician_id: string;
    date: string;
    today: {
        total: number;
        completed: number;
        remaining: number;
    };
    next_booking: {
        booking_id: string;
        booking_ref: string;
        unit_number: string | null;
        local_start: string | null;
        local_end: string | null;
        site_name: string | null;
        address: string;
        special_comments: string | null;
        access_notes: string | null;
    } | null;
    week: {
        total: number;
        completed: number;
    };
    earnings: {
        current_period: {
            invoice_id: string;
            invoice_number: string;
            status: InvoiceStatus;
            total: number;
            period_start: string | null;
            period_end: string | null;
        } | null;
        lifetime_installs: number;
        rating: number | null;
    };
}
export interface NotificationMetrics {
    period: {
        from: string;
        to: string;
    };
    company_id: string | null;
    totals: {
        queued: number;
        processing: number;
        sent: number;
        failed: number;
        dead_letter: number;
        cancelled: number;
        delivered: number;
    };
    by_channel: Record<string, {
        total: number;
        sent: number;
        failed: number;
        dead_letter: number;
        success_rate: number;
    }>;
    top_failures: Array<{
        code: string;
        channel: string;
        count: number;
    }>;
    retry_pressure: {
        attempt_1: number;
        attempt_2: number;
        attempt_3_plus: number;
    };
    latency: {
        avg_seconds: number;
        p95_seconds: number;
    };
}
export {};
//# sourceMappingURL=database.types.d.ts.map