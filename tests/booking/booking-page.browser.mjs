// Run with Playwright installed, against a local Vite server configured with
// dummy Supabase settings only. All non-local requests are intercepted below.
// BOOKING_TEST_URL defaults to http://127.0.0.1:5173.
// Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH for a system Chromium installation.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { chromium, devices } from 'playwright';

const baseURL = process.env.BOOKING_TEST_URL ?? 'http://127.0.0.1:5173';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname),
  'These mocked booking tests must not target a deployed application');
const token = 'ui-test-token';
const job = {
  link_id: 'ui-link', job_id: 'ui-job', job_title: 'Fibre installation appointment',
  job_number: 'JOB-TEST-1042', company_name: 'Example Installation Company',
  site_name: 'Example Apartments', address_line1: '123 Example Street',
  suburb: 'Sydney', state: 'NSW', postcode: '2000',
};
const slots = [
  { id: 'slot-1', slot_date: '2035-12-03', local_start: '08:00:00', local_end: '12:00:00',
    capacity: 4, booked_count: 1, status: 'open' },
  { id: 'slot-2', slot_date: '2035-12-04', local_start: '13:00:00', local_end: '17:00:00',
    capacity: 2, booked_count: 1, status: 'open' },
];
let browser;
before(async () => {
  browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
    args: ['--no-sandbox'],
  });
});
after(async () => { await browser?.close(); });

async function openPage({ width = 390, dark = false, jobData = job,
  slotData = slots, loadError = false, bookingError = false, device } = {}) {
  const context = await browser.newContext({
    ...(device ? devices[device] : {}),
    viewport: { width, height: 844 },
    colorScheme: dark ? 'dark' : 'light',
  });
  const calls = [];
  const unexpected = [];
  const pageErrors = [];
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === new URL(baseURL).origin) return route.continue();
    const name = url.pathname.split('/').at(-1);
    if (!url.pathname.startsWith('/rest/v1/rpc/') ||
      !['booking_link_job', 'booking_slots', 'booking_create'].includes(name)) {
      unexpected.push(url.origin + url.pathname);
      return route.abort();
    }
    calls.push({ name, body: request.postDataJSON() });
    const failed = (loadError && name === 'booking_link_job') ||
      (bookingError && name === 'booking_create');
    const data = failed ? { message: 'This slot has reached capacity', code: 'P0001' }
      : name === 'booking_link_job' ? [jobData]
        : name === 'booking_slots' ? slotData : null;
    return route.fulfill({
      status: failed ? 400 : 200,
      contentType: 'application/json', body: JSON.stringify(data),
    });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${baseURL}/book/${token}`);
  await page.getByRole('heading', { name: loadError
    ? 'Booking unavailable' : jobData.job_title }).waitFor();
  if (dark) await page.evaluate(() => document.documentElement.classList.add('dark'));
  return { page, context, calls, unexpected, pageErrors };
}

async function assertNoOverflow(page) {
  const size = await page.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  assert.ok(size.document <= size.viewport && size.body <= size.viewport,
    `Horizontal overflow: ${JSON.stringify(size)}`);
}

for (const [width, device] of [[320], [360, 'Pixel 7'], [375, 'iPhone SE'],
  [390, 'iPhone 13'], [430], [768], [1440]]) {
  test(`booking layout fits ${width}px viewport${device ? ` (${device} emulation)` : ''}`, async () => {
    const fixture = await openPage({ width, device, dark: true, jobData: {
      ...job, company_name: 'LongCompanyName'.repeat(10),
      job_number: 'LONGREFERENCE'.repeat(10), address_line1: 'LongAddress'.repeat(20),
    } });
    const { page, context } = fixture;
    try {
      await assertNoOverflow(page);
      const appearance = await page.getByRole('heading', { name: 'Customer details' })
        .evaluate((heading) => {
          const card = heading.parentElement.parentElement.parentElement;
          return { background: getComputedStyle(card).backgroundColor,
            foreground: getComputedStyle(card).color };
        });
      assert.deepEqual(appearance, { background: 'rgb(255, 255, 255)', foreground: 'rgb(15, 23, 42)' });
      for (const label of ['Full name', 'Mobile number', 'Email address', 'Unit number']) {
        const input = page.getByLabel(label, { exact: true });
        const metrics = await input.evaluate((el) => ({
          height: el.getBoundingClientRect().height,
          font: Number.parseFloat(getComputedStyle(el).fontSize),
        }));
        assert.ok(metrics.height >= 44 && metrics.font >= 16, `${label} touch/zoom sizing`);
      }
      const options = page.getByRole('button', { name: /places? remaining/ });
      const first = await options.nth(0).boundingBox();
      const second = await options.nth(1).boundingBox();
      assert.ok(first.height >= 44);
      if (width < 640) {
        assert.equal(first.x, second.x, 'Mobile slot cards must stack');
        assert.ok(second.y > first.y);
        const submit = await page.getByRole('button', { name: 'Book Appointment' }).boundingBox();
        const form = await page.locator('form').boundingBox();
        assert.ok(Math.abs(submit.width - form.width) < 1, 'Mobile submit must be full width');
      } else {
        assert.equal(first.y, second.y, 'Wider screens use two slot columns');
      }
      // React StrictMode repeats mount effects in the development server.
      assert.deepEqual([...new Set(fixture.calls.map(c => c.name))], ['booking_link_job', 'booking_slots']);
      assert.deepEqual(fixture.unexpected, []);
      assert.deepEqual(fixture.pageErrors, []);
    } finally { await context.close(); }
  });
}

test('anonymous selection and submission preserve the existing RPC payload and confirmation', async () => {
  const fixture = await openPage();
  const { page, context, calls } = fixture;
  try {
    const submit = page.getByRole('button', { name: 'Book Appointment' });
    assert.equal(await submit.isDisabled(), true);
    const option = page.getByRole('button', { name: /3 places remaining/ });
    await option.focus();
    await page.keyboard.press('Enter');
    assert.equal(await option.getAttribute('aria-pressed'), 'true');
    assert.equal(await submit.isEnabled(), true);
    await page.getByLabel('Full name', { exact: true }).fill('Sample Customer');
    await page.getByLabel('Mobile number', { exact: true }).fill('0412 345 678');
    await page.getByLabel('Email address', { exact: true }).fill('customer@example.test');
    await page.getByLabel('Unit number', { exact: true }).fill('7');
    await assertNoOverflow(page);
    if (process.env.BOOKING_SCREENSHOT_DIR) {
      await mkdir(process.env.BOOKING_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: `${process.env.BOOKING_SCREENSHOT_DIR}/booking-mobile.png`, fullPage: true });
    }
    await submit.click();
    await page.getByRole('heading', { name: 'Appointment booked' }).waitFor();
    assert.deepEqual([...new Set(calls.map(c => c.name))], ['booking_link_job', 'booking_slots', 'booking_create']);
    assert.deepEqual(calls[0].body, { p_token: token });
    assert.equal(calls.find(c => c.name === 'booking_slots').body.p_token, token);
    assert.equal(calls.filter(c => c.name === 'booking_create').length, 1);
    assert.deepEqual(calls.find(c => c.name === 'booking_create').body, {
      p_token: token, p_slot_id: 'slot-1', p_full_name: 'Sample Customer',
      p_mobile: '0412345678', p_email: 'customer@example.test', p_unit_number: '7',
    });
    assert.ok(page.url().endsWith(`/book/${token}`));
    await assertNoOverflow(page);
    assert.deepEqual(fixture.unexpected, []);
    assert.deepEqual(fixture.pageErrors, []);
  } finally { await context.close(); }
});

test('company metadata is optional; desktop reference and address remain visible', async () => {
  const fixture = await openPage({ width: 1440, jobData: { ...job, company_name: null } });
  try {
    const { page } = fixture;
    assert.equal(await page.getByText('Example Installation Company', { exact: true }).count(), 0);
    assert.equal(await page.getByText(`Job reference: ${job.job_number}`).isVisible(), true);
    assert.equal(await page.getByText(job.site_name, { exact: true }).isVisible(), true);
    assert.equal(await page.getByText('123 Example Street, Sydney, NSW, 2000', { exact: true }).isVisible(), true);
    if (process.env.BOOKING_SCREENSHOT_DIR) {
      await mkdir(process.env.BOOKING_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: `${process.env.BOOKING_SCREENSHOT_DIR}/booking-desktop.png`, fullPage: true });
    }
  } finally { await fixture.context.close(); }
});

test('empty availability shows the existing empty state without a form', async () => {
  const fixture = await openPage({ slotData: [] });
  try {
    assert.equal(await fixture.page.getByText(/There are no available slots/).isVisible(), true);
    assert.equal(await fixture.page.locator('form').count(), 0);
    await assertNoOverflow(fixture.page);
  } finally { await fixture.context.close(); }
});

test('invalid links retain the unavailable state without login', async () => {
  const fixture = await openPage({ loadError: true });
  try {
    assert.equal(await fixture.page.getByRole('alert').isVisible(), true);
    assert.ok(fixture.page.url().endsWith(`/book/${token}`));
    await assertNoOverflow(fixture.page);
  } finally { await fixture.context.close(); }
});

test('booking RPC failures keep the existing form and show the error', async () => {
  const fixture = await openPage({ bookingError: true });
  try {
    const { page } = fixture;
    await page.getByRole('button', { name: /3 places remaining/ }).click();
    await page.getByLabel('Full name', { exact: true }).fill('Sample Customer');
    await page.getByLabel('Mobile number', { exact: true }).fill('0412345678');
    await page.getByLabel('Email address', { exact: true }).fill('customer@example.test');
    await page.getByLabel('Unit number', { exact: true }).fill('7');
    await page.getByRole('button', { name: 'Book Appointment' }).click();
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').textContent(), /capacity/);
    assert.equal(await page.getByLabel('Full name', { exact: true }).inputValue(), 'Sample Customer');
    await assertNoOverflow(page);
  } finally { await fixture.context.close(); }
});
