/**
 * send-invitation
 * ---------------------------------------------------------------------------
 * Delivers the invitation email for a row in public.user_invitations.
 *
 * Called from the Users page straight after invite_user() succeeds:
 *
 *   await supabase.functions.invoke('send-invitation', {
 *     body: { email, token, role, company_name, expires_at, full_name },
 *   });
 *
 * Deploy:
 *   supabase functions deploy send-invitation
 *   supabase secrets set RESEND_API_KEY=re_... APP_URL=[your-app](https://your-app)
 *   supabase secrets set INVITE_FROM="SwiftWorks <invites@yourdomain.com>"
 */

import { Resend } from "npm:resend";

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const APP_URL = (Deno.env.get('APP_URL') ?? '').replace(/\/+$/, '');
const INVITE_FROM =
  Deno.env.get('INVITE_FROM') ?? 'SwiftWorks <onboarding@resend.dev>';

/** Roles this app knows how to name in an email. */
const ROLE_LABELS: Record<string, string> = {
  company_admin: 'an administrator',
  technician: 'a technician',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

/** 2026-10-17T04:00:00Z or 2026-10-17 -> 17 October 2026 (Sydney). */
function formatExpiry(value: string | null | undefined): string | null {
  if (!value) return null;

  const d = new Date(value.includes('T') ? value : value + 'T23:59:59Z');
  if (Number.isNaN(d.getTime())) return null;

  return new Intl.DateTimeFormat('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Australia/Sydney',
  }).format(d);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildHtml(args: {
  link: string;
  company: string;
  role: string;
  expires: string | null;
}) {
  const { link, company, role, expires } = args;

  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#111827;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;">
      <tr>
        <td style="padding:28px 28px 8px;">
          <p style="margin:0;font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#6b7280;">SwiftWorks</p>
          <h1 style="margin:8px 0 0;font-size:20px;line-height:1.3;">You have been invited to ${escapeHtml(company)}</h1>
        </td>
      </tr>
      <tr>
        <td style="padding:8px 28px 0;">
          <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">
            You have been added to <strong>${escapeHtml(company)}</strong> as ${escapeHtml(role)}.
            Choose a password to finish setting up your account.
          </p>
          <p style="margin:0 0 24px;">
            <a href="${link}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px;font-weight:600;">Accept invitation</a>
          </p>
          <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#6b7280;">
            Or paste this link into your browser:<br />
            <span style="word-break:break-all;color:#374151;">${link}</span>
          </p>
          ${
            expires
              ? `<p style="margin:16px 0 0;font-size:13px;color:#6b7280;">This invitation expires on <strong>${escapeHtml(expires)}</strong>.</p>`
              : ''
          }
        </td>
      </tr>
      <tr>
        <td style="padding:24px 28px 28px;">
          <p style="margin:0;font-size:12px;line-height:1.6;color:#9ca3af;">
            If you were not expecting this, you can ignore this email.
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function buildText(args: {
  link: string;
  company: string;
  role: string;
  expires: string | null;
}) {
  const { link, company, role, expires } = args;

  return [
    `You have been invited to ${company}`,
    '',
    `You have been added to ${company} as ${role}.`,
    'Choose a password to finish setting up your account:',
    '',
    link,
    '',
    expires ? `This invitation expires on ${expires}.` : '',
    'If you were not expecting this, you can ignore this email.',
  ]
    .filter(Boolean)
    .join('\n');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  if (!RESEND_API_KEY) {
    return json({ error: 'RESEND_API_KEY is not set on this function.' }, 500);
  }

  if (!APP_URL) {
    return json({ error: 'APP_URL is not set on this function.' }, 500);
  }

  let payload: {
    email?: string;
    token?: string;
    role?: string;
    company_name?: string;
    full_name?: string;
    expires_at?: string | null;
  };

  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Expected a JSON body.' }, 400);
  }

  const email = (payload.email ?? '').trim().toLowerCase();
  const token = (payload.token ?? '').trim();
  const roleRaw = (payload.role ?? 'technician').trim();
  const company = (payload.company_name ?? 'your company').trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'A valid email address is required.' }, 400);
  }

  if (token === '') {
    return json({ error: 'A token is required.' }, 400);
  }

  const role = ROLE_LABELS[roleRaw] ?? roleRaw.replace(/_/g, ' ');
  const link = `${APP_URL}/invite/${encodeURIComponent(token)}`;
  const expires = formatExpiry(payload.expires_at);

  const resend = new Resend(RESEND_API_KEY);

  const { data, error } = await resend.emails.send({
    from: INVITE_FROM,
    to: email,
    subject: `You have been invited to ${company}`,
    html: buildHtml({ link, company, role, expires }),
    text: buildText({ link, company, role, expires }),
  });

  if (error) {
    return json({ error: error.message ?? 'The email was not sent.' }, 502);
  }

  return json({ ok: true, id: data?.id ?? null, to: email });
});
