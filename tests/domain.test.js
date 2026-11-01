import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  totals, normalizeItems, nextQuoteStatus, nextRequestStatus, jobDisplayStatus, invoiceDisplayStatus, DomainError, addDays,
} from '../src/domain.js';

test('totals rounds to cents and applies tax', () => {
  const items = normalizeItems([{ name: 'A', qty: 3, unit_price: 19.99 }, { name: 'B', qty: 1, unit_price: 0.1 }]);
  assert.deepEqual(totals(items, 7.75), { subtotal: 60.07, tax: 4.66, total: 64.73 });
});

test('normalizeItems rejects bad input', () => {
  assert.throws(() => normalizeItems([{ name: '', qty: 1, unit_price: 1 }]), DomainError);
  assert.throws(() => normalizeItems([{ name: 'x', qty: -1, unit_price: 1 }]), DomainError);
  assert.throws(() => normalizeItems('nope'), DomainError);
});

test('quote lifecycle follows Draft -> Awaiting Response -> Approved -> Converted', () => {
  let s = 'draft';
  s = nextQuoteStatus(s, 'send'); assert.equal(s, 'awaiting_response');
  s = nextQuoteStatus(s, 'request_changes'); assert.equal(s, 'changes_requested');
  s = nextQuoteStatus(s, 'send'); assert.equal(s, 'awaiting_response');
  s = nextQuoteStatus(s, 'approve'); assert.equal(s, 'approved');
  s = nextQuoteStatus(s, 'convert'); assert.equal(s, 'converted');
});

test('draft quotes cannot be archived or approved', () => {
  assert.throws(() => nextQuoteStatus('draft', 'archive'), /cannot archive/);
  assert.throws(() => nextQuoteStatus('draft', 'approve'), /cannot approve/);
  assert.throws(() => nextQuoteStatus('converted', 'convert'), /cannot convert/);
});

test('request transitions', () => {
  assert.equal(nextRequestStatus('new', 'convert'), 'converted');
  assert.equal(nextRequestStatus('archived', 'unarchive'), 'new');
  assert.throws(() => nextRequestStatus('converted', 'archive'));
});

test('job display status', () => {
  const now = '2026-11-01T12:00';
  const s = (job, invoiced = false) => jobDisplayStatus({ status: 'active', ...job }, { invoiced, now });
  assert.equal(s({}), 'unscheduled');
  assert.equal(s({ scheduled_start: '2026-10-30T09:00', scheduled_end: '2026-10-30T10:00' }), 'late');
  assert.equal(s({ scheduled_start: '2026-11-01T14:00', scheduled_end: '2026-11-01T15:00' }), 'today');
  assert.equal(s({ scheduled_start: '2026-11-03T09:00' }), 'upcoming');
  assert.equal(s({ status: 'completed' }), 'requires_invoicing');
  assert.equal(s({ status: 'completed' }, true), 'closed');
});

test('invoice display status', () => {
  const today = '2026-11-01';
  assert.equal(invoiceDisplayStatus({ status: 'draft' }, 0, 100, today), 'draft');
  assert.equal(invoiceDisplayStatus({ status: 'sent', due_date: '2026-11-30' }, 0, 100, today), 'awaiting_payment');
  assert.equal(invoiceDisplayStatus({ status: 'sent', due_date: '2026-10-01' }, 50, 100, today), 'past_due');
  assert.equal(invoiceDisplayStatus({ status: 'sent', due_date: '2026-10-01' }, 100, 100, today), 'paid');
  assert.equal(invoiceDisplayStatus({ status: 'bad_debt' }, 0, 100, today), 'bad_debt');
});

test('addDays crosses month boundaries', () => {
  assert.equal(addDays('2026-10-30', 3), '2026-11-02');
});
