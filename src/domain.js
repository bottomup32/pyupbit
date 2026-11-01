// Pure business rules for the field-service workflow:
// Request -> Quote -> Job -> Invoice -> Payment.
// Status names follow the public Jobber Help Center where documented
// (see docs/ANALYSIS.md); the rest are our own design.

export class DomainError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export function normalizeItems(items) {
  if (items === undefined) return [];
  if (!Array.isArray(items)) throw new DomainError('items must be an array');
  return items.map((it, i) => {
    const name = String(it?.name ?? '').trim();
    const qty = Number(it?.qty ?? 1);
    const unit_price = Number(it?.unit_price ?? 0);
    if (!name) throw new DomainError(`items[${i}].name is required`);
    if (!Number.isFinite(qty) || qty < 0) throw new DomainError(`items[${i}].qty must be >= 0`);
    if (!Number.isFinite(unit_price) || unit_price < 0) throw new DomainError(`items[${i}].unit_price must be >= 0`);
    return { name, description: String(it?.description ?? ''), qty, unit_price };
  });
}

export function totals(items, taxRate = 0) {
  const subtotal = round2(items.reduce((s, it) => s + it.qty * it.unit_price, 0));
  const tax = round2((subtotal * (Number(taxRate) || 0)) / 100);
  return { subtotal, tax, total: round2(subtotal + tax) };
}

// ---- Requests ---------------------------------------------------------------
export const REQUEST_STATUSES = ['new', 'converted', 'archived'];
const REQUEST_TRANSITIONS = {
  convert: { from: ['new'], to: 'converted' },
  archive: { from: ['new'], to: 'archived' },
  unarchive: { from: ['archived'], to: 'new' },
};
export function nextRequestStatus(status, action) {
  return transition(REQUEST_TRANSITIONS, 'request', status, action);
}

// ---- Quotes -----------------------------------------------------------------
// Draft -> Awaiting Response -> (Changes Requested -> Awaiting Response) -> Approved -> Converted; Archived.
export const QUOTE_STATUSES = ['draft', 'awaiting_response', 'changes_requested', 'approved', 'converted', 'archived'];
const QUOTE_TRANSITIONS = {
  send: { from: ['draft', 'changes_requested'], to: 'awaiting_response' },
  approve: { from: ['awaiting_response'], to: 'approved' },
  request_changes: { from: ['awaiting_response'], to: 'changes_requested' },
  convert: { from: ['approved'], to: 'converted' },
  // Jobber: archiving is only available once the quote is no longer a draft.
  archive: { from: ['awaiting_response', 'changes_requested', 'approved'], to: 'archived' },
};
export const QUOTE_EDITABLE = ['draft', 'changes_requested'];
export function nextQuoteStatus(status, action) {
  return transition(QUOTE_TRANSITIONS, 'quote', status, action);
}
// Quotes the client may see in Client Hub (hidden while changes are requested).
export const QUOTE_HUB_VISIBLE = ['awaiting_response', 'approved', 'converted'];

// ---- Jobs -------------------------------------------------------------------
// Stored: active | completed | archived. Displayed status is derived.
export function jobDisplayStatus(job, { invoiced, now }) {
  if (job.status === 'archived') return 'archived';
  if (job.status === 'completed') return invoiced ? 'closed' : 'requires_invoicing';
  if (!job.scheduled_start) return 'unscheduled';
  const end = job.scheduled_end || job.scheduled_start;
  if (end < now) return 'late';
  if (job.scheduled_start.slice(0, 10) === now.slice(0, 10)) return 'today';
  return 'upcoming';
}

// ---- Invoices ---------------------------------------------------------------
// Stored: draft | sent | bad_debt. Displayed: Draft, Awaiting Payment, Past Due, Paid, Bad Debt.
export function invoiceDisplayStatus(inv, paid, total, today) {
  if (inv.status === 'draft') return 'draft';
  if (inv.status === 'bad_debt') return 'bad_debt';
  if (total > 0 && paid >= total) return 'paid';
  if (inv.due_date && inv.due_date < today) return 'past_due';
  return 'awaiting_payment';
}

function transition(table, kind, status, action) {
  const t = table[action];
  if (!t) throw new DomainError(`unknown ${kind} action: ${action}`);
  if (!t.from.includes(status)) {
    throw new DomainError(`cannot ${action} a ${kind} in status "${status}"`, 409);
  }
  return t.to;
}

// Local time strings in the same format as <input type="datetime-local">.
export function nowLocal(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export const todayLocal = (d = new Date()) => nowLocal(d).slice(0, 10);
export function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return todayLocal(d);
}
