/** Local visual/journey check. All API traffic is synthetic; external hosts are blocked.
 * Install Playwright outside the repo, set PLAYWRIGHT_MODULE to its index.mjs, and run with
 * a local Vite server at BILLING_QA_URL (default http://127.0.0.1:5179).
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const base = process.env.BILLING_QA_URL ?? 'http://127.0.0.1:5179';
assert.equal(new URL(base).hostname, '127.0.0.1', 'Only a local QA server is permitted');
const artifacts = process.env.QA_ARTIFACT_DIR ?? path.join(os.tmpdir(), 'vistaar-release-browser-qa', 'artifacts');
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const permissions = ['invoices.read', 'invoices.manage', 'payments.record', 'settings.manage', 'conversations.read_all'];
const id = '000000000000000000000101';
const contactId = '000000000000000000000102';
const templateId = '000000000000000000000103';
const stamp = '2026-11-19T12:00:00.000Z';
const fixture = {
  id, contactId, conversationId: null, invoiceNumber: 'QA-2026-0001', status: 'issued',
  billTo: { name: 'Synthetic QA Customer', state: 'Karnataka', gstin: null, address: 'Synthetic address' },
  supplier: { name: 'Synthetic QA Workspace', state: 'Karnataka' },
  items: [{ description: 'Synthetic retainer', quantity: '1', rate: '1000.00', ratePaise: 100000,
    taxRate: '18', discountPercent: '0', subtotal: '1000.00', subtotalPaise: 100000,
    total: '1180.00', totalPaise: 118000, tax: '180.00', taxPaise: 18000 }],
  subtotal: '1000.00', subtotalPaise: 100000, discount: '0.00', discountPaise: 0,
  taxable: '1000.00', taxablePaise: 100000, tax: '180.00', taxPaise: 18000,
  cgst: '90.00', cgstPaise: 9000, sgst: '90.00', sgstPaise: 9000, igst: '0.00', igstPaise: 0,
  roundOff: '0.00', roundOffPaise: 0, total: '1180.00', totalPaise: 118000,
  amountPaid: '0.00', amountPaidPaise: 0, balance: '1180.00', balancePaise: 118000,
  dueDate: '2026-12-05T00:00:00.000Z', isInterstate: false, hasPdf: true,
  issuedAt: stamp, createdAt: stamp, updatedAt: stamp, notes: null, terms: null,
  remindersSentCount: 0, paymentFollowUp: { state: null, remindersSent: 0, nextAt: null }, promiseDate: null,
};
let invoice = structuredClone(fixture);
let invoices = [invoice];
let payments = [];
let activePermissions = permissions;
let failList = false;
const writes = [];
const pageErrors = [];
const template = { id: templateId, contactId, name: 'Synthetic recurring retainer', items: fixture.items,
  discount: '0.00', discountPaise: 0, billTo: fixture.billTo, intervalMonths: 1,
  intervalLabel: 'Monthly', dayOfMonth: 5, dueInDays: 15, generateAs: 'draft', active: true,
  nextRunAt: '2026-12-05T00:00:00.000Z', nextPeriod: '2026-12', generatedCount: 1,
  lastError: null, notes: null, terms: null };

async function installMocks(context) {
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== new URL(base).origin) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const api = url.pathname.replace('/api/v1', '');
    const method = request.method();
    const body = request.postDataJSON();
    if (!['GET', 'OPTIONS'].includes(method) && api !== '/auth/refresh') writes.push({ api, method, body });
    const json = (data, meta) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data, meta }) });
    if (api === '/auth/refresh') return json({ accessToken: 'synthetic-local-token',
      user: { id: '000000000000000000000105', name: 'Synthetic QA Admin', role: 'admin' },
      organization: { id: '000000000000000000000106', name: 'Synthetic QA Workspace' }, permissions: activePermissions });
    if (api === '/invoices' && method === 'GET') {
      if (failList) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic unavailable' } }) });
      return json(invoices, { total: invoices.length, count: invoices.length });
    }
    if (api === '/invoices' && method === 'POST') {
      assert.equal(body.items[0].rate, '1000');
      assert.equal(body.totalPaise, undefined);
      invoice = { ...structuredClone(fixture), status: 'draft', invoiceNumber: null };
      invoices = [invoice];
      return json(invoice);
    }
    if (api === `/invoices/${id}`) return json(invoice);
    if (api === `/invoices/${id}/issue`) {
      invoice = { ...invoice, status: 'issued', invoiceNumber: 'QA-2026-0002' }; invoices = [invoice];
      return json(invoice);
    }
    if (api === `/invoices/${id}/pdf`) return route.fulfill({ contentType: 'application/pdf', body: '%PDF-1.4\n% Synthetic QA download fixture\n%%EOF' });
    if (api === `/invoices/${id}/payments` && method === 'GET') return json(payments);
    if (api === `/invoices/${id}/payments` && method === 'POST') {
      assert.ok(body.idempotencyKey?.length >= 8);
      const payment = { id: '000000000000000000000104', invoiceId: id, amount: '500.00', amountPaise: 50000,
        mode: 'cash', isVoided: false, isProviderPayment: false, paidAt: stamp };
      payments.push(payment);
      invoice = { ...invoice, amountPaid: '500.00', amountPaidPaise: 50000, balance: '680.00', balancePaise: 68000 };
      return json({ payment, invoice });
    }
    if (api.endsWith('/payment-links')) return json([]);
    if (api === '/recurring-invoices') return json([template]);
    if (api === `/recurring-invoices/${templateId}`) return json({ ...template, ...body });
    if (api === '/settings/billing') return json({ name: 'Synthetic QA Workspace', state: 'Karnataka', invoicePrefix: 'QA' });
    if (api === '/settings/razorpay') return json({ connected: true, mode: 'test', keyId: 'rzp_test_synthetic', webhookPath: '/api/v1/payments/razorpay/webhook/synthetic' });
    if (api === '/conversations') return json([{ id: '000000000000000000000107', contactId, displayName: 'Synthetic QA Customer', stage: 'won' }], { total: 1 });
    if (api.includes('realtime')) return route.fulfill({ contentType: 'text/event-stream', body: ': synthetic QA\n\n' });
    return json([], { total: 0, count: 0 });
  });
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  await installMocks(context);
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(base);
  await page.getByRole('button', { name: 'Billing', exact: true }).click();
  await page.getByRole('button', { name: /QA-2026-0001/ }).waitFor();
  await page.screenshot({ path: path.join(artifacts, 'billing-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: /New invoice/ }).click();
  const form = page.getByRole('dialog', { name: 'New invoice', exact: true });
  assert.ok(await form.evaluate(element => document.activeElement === element));
  await page.keyboard.press('Tab');
  assert.ok(await form.evaluate(element => element.contains(document.activeElement)));
  await page.keyboard.press('Escape');
  await form.waitFor({ state: 'hidden' });
  assert.ok(await page.getByRole('button', { name: /New invoice/ }).evaluate(element => document.activeElement === element));
  await page.getByRole('button', { name: /New invoice/ }).click();
  await form.getByLabel('Client', { exact: true }).selectOption(contactId);
  await form.locator('#row-desc-0').fill('Synthetic retainer');
  await form.locator('#row-rate-0').fill('1000');
  await form.getByRole('button', { name: 'Save draft', exact: true }).click();
  const detail = page.getByRole('dialog', { name: 'Invoice', exact: true });
  await detail.getByRole('button', { name: 'Issue', exact: true }).click();
  const pdfResponse = page.waitForResponse(response => response.url().endsWith(`/invoices/${id}/pdf`));
  const previewPromise = context.waitForEvent('page');
  await detail.getByRole('button', { name: /PDF/ }).click();
  assert.equal((await pdfResponse).headers()['content-type'], 'application/pdf');
  const preview = await previewPromise;
  await preview.waitForURL('blob:**');
  await preview.close();
  await detail.getByRole('button', { name: 'Record payment', exact: true }).click();
  await detail.getByLabel('Amount (₹)').fill('500');
  await detail.getByRole('button', { name: 'Record', exact: true }).click();
  await detail.getByText('₹680.00', { exact: true }).first().waitFor();
  await page.screenshot({ path: path.join(artifacts, 'invoice-desktop.png'), fullPage: true });
  await detail.getByRole('button', { name: 'Close', exact: true }).first().click();
  await page.getByRole('tab', { name: 'Recurring', exact: true }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const recurring = page.getByRole('dialog', { name: 'Edit recurring invoice', exact: true });
  await recurring.getByLabel('Schedule name').fill('Edited synthetic schedule');
  await recurring.getByRole('button', { name: 'Save changes', exact: true }).click();
  await recurring.waitFor({ state: 'hidden' });
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await page.getByText(/Razorpay/).first().waitFor();
  assert.equal(await page.locator('input[type=password]').evaluateAll(fields => fields.every(field => field.value === '')), true);
  await page.screenshot({ path: path.join(artifacts, 'settings-desktop.png'), fullPage: true });
  await page.getByRole('tab', { name: 'Invoices', exact: true }).click();
  await page.getByRole('button', { name: /QA-2026-0002/ }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('dialog', { name: 'Sections', exact: true }).getByRole('button', { name: 'Billing', exact: true }).click();
  await page.screenshot({ path: path.join(artifacts, 'billing-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile page overflows horizontally');
  await page.getByRole('button', { name: /QA-2026-0002/ }).click();
  await detail.waitFor();
  await page.screenshot({ path: path.join(artifacts, 'invoice-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile dialog overflows horizontally');
  await detail.getByRole('button', { name: 'Close', exact: true }).first().click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  failList = true;
  await page.getByLabel('Filter by status').selectOption('issued');
  await page.getByRole('alert').filter({ hasText: 'Synthetic unavailable' }).waitFor();
  failList = false;
  invoices = [];
  await page.getByLabel('Filter by status').selectOption('all');
  await page.getByText('No invoices yet', { exact: true }).waitFor();
  invoices = [invoice];
  activePermissions = ['invoices.read'];
  const reader = await context.newPage();
  reader.on('pageerror', error => pageErrors.push(error.message));
  await reader.goto(base, { waitUntil: 'domcontentloaded' });
  await reader.getByRole('button', { name: 'Billing', exact: true }).click();
  await reader.getByRole('button', { name: /QA-2026-0002/ }).click();
  assert.equal(await reader.getByRole('button', { name: 'Record payment', exact: true }).count(), 0);
  assert.equal(await reader.getByRole('button', { name: 'New invoice', exact: true }).count(), 0);
  assert.equal(await reader.getByRole('tab', { name: 'Settings', exact: true }).count(), 0);
  assert.ok(writes.some(write => write.api.endsWith('/payments')));
  assert.ok(writes.some(write => write.method === 'PUT' && write.api.startsWith('/recurring-invoices/')));
  assert.equal(writes.some(write => /send|messages|payment-links/.test(write.api)), false, 'Journey must not send or create links');
  assert.deepEqual(pageErrors, []);
  console.log(`PASS: desktop/mobile synthetic browser journey, keyboard focus/Escape, mobile menu, invoice create/issue/PDF/payment, schedule edit, settings secrets, empty/failure states, read-only permissions; screenshots: ${artifacts}`);
} finally {
  await browser.close();
}
