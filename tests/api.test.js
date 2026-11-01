import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { startServer } from '../src/server.js';

let server; let base;
before(async () => {
  server = await startServer({ db: openDb(':memory:'), port: 0 });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

async function call(method, path, body) {
  const res = await fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}
const ok = async (...a) => { const r = await call(...a); assert.ok(r.status < 300, `${a[0]} ${a[1]} -> ${r.status} ${JSON.stringify(r.body)}`); return r.body; };

test('end-to-end workflow: request -> quote -> client hub approval -> job -> invoice -> payment', async () => {
  const member = await ok('POST', '/team', { name: 'Alex', role: 'worker' });
  const client = await ok('POST', '/clients', { first_name: 'Sarah', last_name: 'Park', email: 's@example.com' });
  assert.match(client.hub_token, /^[0-9a-f]{32}$/);

  // Client submits a request through the hub.
  const req = await ok('POST', `/hub/${client.hub_token}/requests`, { title: 'Lawn care' });
  assert.equal(req.source, 'client_hub');
  assert.equal((await ok('GET', '/dashboard')).workflow.requests.new, 1);

  // Convert request to quote and price it.
  const conv = await ok('POST', `/requests/${req.id}/convert`, { to: 'quote' });
  assert.equal(conv.request.status, 'converted');
  const quoteId = conv.quote.id;
  await ok('PUT', `/quotes/${quoteId}`, { items: [{ name: 'Mowing', qty: 4, unit_price: 50 }], tax_rate: 10 });

  // Draft quotes are hidden from the hub; sending makes them visible.
  assert.equal((await ok('GET', `/hub/${client.hub_token}`)).quotes.length, 0);
  await ok('POST', `/quotes/${quoteId}/send`);
  const hub = await ok('GET', `/hub/${client.hub_token}`);
  assert.equal(hub.quotes[0].total, 220);

  // Client requests changes -> hidden again; resend; client approves with signature.
  await ok('POST', `/hub/${client.hub_token}/quotes/${quoteId}/request_changes`, { message: 'Only 3 visits' });
  assert.equal((await ok('GET', `/hub/${client.hub_token}`)).quotes.length, 0);
  await ok('PUT', `/quotes/${quoteId}`, { items: [{ name: 'Mowing', qty: 3, unit_price: 50 }] });
  await ok('POST', `/quotes/${quoteId}/send`);
  const approved = await ok('POST', `/hub/${client.hub_token}/quotes/${quoteId}/approve`, { signature: 'Sarah Park' });
  assert.equal(approved.quote.status, 'approved');
  assert.equal(approved.quote.signature, 'Sarah Park');

  // Approved quotes are locked.
  assert.equal((await call('PUT', `/quotes/${quoteId}`, { title: 'x' })).status, 409);

  // Convert to job, schedule, complete.
  const { job } = await ok('POST', `/quotes/${quoteId}/convert`);
  assert.equal(job.display_status, 'unscheduled');
  assert.equal(job.total, 165);
  const scheduled = await ok('PUT', `/jobs/${job.id}`, { scheduled_start: '2099-01-05T09:00', scheduled_end: '2099-01-05T11:00', assignee_id: member.id });
  assert.equal(scheduled.display_status, 'upcoming');
  assert.equal(scheduled.assignee_name, 'Alex');
  const sched = await ok('GET', '/schedule?from=2099-01-05&to=2099-01-11');
  assert.equal(sched.scheduled.length, 1);
  const done = await ok('POST', `/jobs/${job.id}/complete`);
  assert.equal(done.job.display_status, 'requires_invoicing');

  // Invoice from job, send, partial + full payment.
  const { invoice } = await ok('POST', `/jobs/${job.id}/invoice`);
  assert.equal(invoice.total, 165);
  assert.equal(invoice.display_status, 'draft');
  assert.equal((await ok('GET', `/jobs/${job.id}`)).display_status, 'closed');
  assert.equal((await call('POST', `/jobs/${job.id}/invoice`)).status, 409);
  assert.equal((await call('POST', `/invoices/${invoice.id}/pay`, { amount: 10 })).status, 409, 'cannot pay a draft');
  await ok('POST', `/invoices/${invoice.id}/send`);
  const partial = await ok('POST', `/invoices/${invoice.id}/pay`, { amount: 65, method: 'check' });
  assert.equal(partial.invoice.balance, 100);
  assert.equal(partial.invoice.display_status, 'awaiting_payment');
  assert.equal((await call('POST', `/invoices/${invoice.id}/pay`, { amount: 1000 })).status, 400);
  const paid = await ok('POST', `/hub/${client.hub_token}/invoices/${invoice.id}/pay`);
  assert.equal(paid.invoice.display_status, 'paid');
  assert.equal((await ok('GET', '/dashboard')).revenue_this_month, 165);
});

test('validation and isolation', async () => {
  assert.equal((await call('POST', '/clients', {})).status, 400);
  assert.equal((await call('POST', '/quotes', { client_id: 999, title: 'x' })).status, 404);
  assert.equal((await call('GET', '/hub/deadbeef')).status, 404);

  const a = await ok('POST', '/clients', { company: 'A Co' });
  const b = await ok('POST', '/clients', { company: 'B Co' });
  const q = await ok('POST', '/quotes', { client_id: b.id, title: 'B quote', items: [{ name: 'x', qty: 1, unit_price: 1 }] });
  await ok('POST', `/quotes/${q.id}/send`);
  // Client A's hub token cannot act on client B's quote.
  assert.equal((await call('POST', `/hub/${a.hub_token}/quotes/${q.id}/approve`, { signature: 'A' })).status, 404);
  assert.equal((await call('POST', `/quotes/${q.id}/convert`)).status, 409);
  assert.equal((await call('PUT', '/jobs/1', { scheduled_start: '2099-01-02T10:00', scheduled_end: '2099-01-01T10:00' })).status, 400);
});

test('bad debt can be marked and reversed', async () => {
  const c = await ok('POST', '/clients', { company: 'Late Payer' });
  const inv = await ok('POST', '/invoices', { client_id: c.id, subject: 'Work', items: [{ name: 'x', qty: 1, unit_price: 50 }], due_date: '2000-01-01' });
  await ok('POST', `/invoices/${inv.id}/send`);
  assert.equal((await ok('GET', `/invoices/${inv.id}`)).display_status, 'past_due');
  assert.equal((await ok('POST', `/invoices/${inv.id}/bad_debt`)).invoice.display_status, 'bad_debt');
  assert.equal((await ok('POST', `/invoices/${inv.id}/unmark_bad_debt`)).invoice.display_status, 'past_due');
});
