import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  DomainError, normalizeItems, totals, nextRequestStatus, nextQuoteStatus,
  QUOTE_EDITABLE, QUOTE_HUB_VISIBLE, jobDisplayStatus, invoiceDisplayStatus,
  nowLocal, todayLocal, addDays,
} from './domain.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const DEFAULT_DUE_DAYS = 30;

export function createApp(db, { clock = () => new Date() } = {}) {
  const now = () => nowLocal(clock());
  const today = () => todayLocal(clock());
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  const insert = (sql, ...a) => Number(run(sql, ...a).lastInsertRowid);

  function tx(fn) {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  const need = (row, what) => { if (!row) throw new DomainError(`${what} not found`, 404); return row; };
  const str = (v, d = '') => (v === undefined || v === null ? d : String(v).trim());
  const required = (v, field) => { const s = str(v); if (!s) throw new DomainError(`${field} is required`); return s; };
  const optDate = (v) => (str(v) ? str(v) : null);

  // ---- hydrators: attach totals and derived statuses ------------------------
  const clientName = (c) => c ? ([c.first_name, c.last_name].filter(Boolean).join(' ') || c.company || `Client #${c.id}`) : '';
  const withMoney = (row) => { const items = JSON.parse(row.items); return { ...row, items, ...totals(items, row.tax_rate) }; };
  const clientRef = (id) => { const c = one('SELECT * FROM clients WHERE id=?', id); return { client_name: clientName(c) }; };

  const hydrateClient = (c) => ({ ...c, name: clientName(c) });
  const hydrateRequest = (r) => ({ ...r, ...clientRef(r.client_id) });
  const hydrateQuote = (q) => ({ ...withMoney(q), ...clientRef(q.client_id) });
  function hydrateJob(j) {
    const invoiced = !!one('SELECT 1 x FROM invoices WHERE job_id=?', j.id);
    const assignee = j.assignee_id ? one('SELECT name, color FROM team WHERE id=?', j.assignee_id) : null;
    return {
      ...withMoney(j), ...clientRef(j.client_id), invoiced,
      assignee_name: assignee?.name ?? null, assignee_color: assignee?.color ?? null,
      display_status: jobDisplayStatus(j, { invoiced, now: now() }),
    };
  }
  function hydrateInvoice(i) {
    const base = withMoney(i);
    const payments = all('SELECT * FROM payments WHERE invoice_id=? ORDER BY paid_at, id', i.id);
    const paid = Math.round(payments.reduce((s, p) => s + p.amount, 0) * 100) / 100;
    return {
      ...base, ...clientRef(i.client_id), payments, paid,
      balance: Math.round((base.total - paid) * 100) / 100,
      display_status: invoiceDisplayStatus(i, paid, base.total, today()),
    };
  }

  const getClient = (id) => hydrateClient(need(one('SELECT * FROM clients WHERE id=?', id), 'client'));
  const getRequest = (id) => hydrateRequest(need(one('SELECT * FROM requests WHERE id=?', id), 'request'));
  const getQuote = (id) => hydrateQuote(need(one('SELECT * FROM quotes WHERE id=?', id), 'quote'));
  const getJob = (id) => hydrateJob(need(one('SELECT * FROM jobs WHERE id=?', id), 'job'));
  const getInvoice = (id) => hydrateInvoice(need(one('SELECT * FROM invoices WHERE id=?', id), 'invoice'));
  const assertClient = (id) => need(one('SELECT id FROM clients WHERE id=?', Number(id)), 'client').id;
  const assertAssignee = (id) => (id ? need(one('SELECT id FROM team WHERE id=?', Number(id)), 'team member').id : null);

  // ---- clients --------------------------------------------------------------
  function saveClient(b, id) {
    const f = {
      first_name: str(b.first_name), last_name: str(b.last_name), company: str(b.company),
      email: str(b.email), phone: str(b.phone), address: str(b.address), notes: str(b.notes),
    };
    if (!f.first_name && !f.last_name && !f.company) throw new DomainError('client name or company is required');
    if (id) {
      need(one('SELECT id FROM clients WHERE id=?', id), 'client');
      run('UPDATE clients SET first_name=?,last_name=?,company=?,email=?,phone=?,address=?,notes=? WHERE id=?',
        f.first_name, f.last_name, f.company, f.email, f.phone, f.address, f.notes, id);
      return getClient(id);
    }
    const newId = insert('INSERT INTO clients(first_name,last_name,company,email,phone,address,notes,hub_token,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      f.first_name, f.last_name, f.company, f.email, f.phone, f.address, f.notes, randomBytes(16).toString('hex'), now());
    return getClient(newId);
  }
  function clientDetail(id) {
    return {
      ...getClient(id),
      requests: all('SELECT * FROM requests WHERE client_id=? ORDER BY id DESC', id).map(hydrateRequest),
      quotes: all('SELECT * FROM quotes WHERE client_id=? ORDER BY id DESC', id).map(hydrateQuote),
      jobs: all('SELECT * FROM jobs WHERE client_id=? ORDER BY id DESC', id).map(hydrateJob),
      invoices: all('SELECT * FROM invoices WHERE client_id=? ORDER BY id DESC', id).map(hydrateInvoice),
    };
  }

  // ---- requests -------------------------------------------------------------
  function createRequest(b, source = 'internal') {
    const id = insert('INSERT INTO requests(client_id,title,details,preferred_date,source,created_at) VALUES(?,?,?,?,?,?)',
      assertClient(b.client_id), required(b.title, 'title'), str(b.details), optDate(b.preferred_date), source, now());
    return getRequest(id);
  }
  function updateRequest(id, b) {
    const r = getRequest(id);
    if (r.status !== 'new') throw new DomainError('only new requests can be edited', 409);
    run('UPDATE requests SET title=?,details=?,preferred_date=? WHERE id=?',
      required(b.title ?? r.title, 'title'), str(b.details ?? r.details), optDate(b.preferred_date ?? r.preferred_date), id);
    return getRequest(id);
  }
  function requestAction(id, action, b) {
    const r = getRequest(id);
    const to = nextRequestStatus(r.status, action);
    if (action !== 'convert') { run('UPDATE requests SET status=? WHERE id=?', to, id); return { request: getRequest(id) }; }
    const target = b.to === 'job' ? 'job' : 'quote';
    return tx(() => {
      run('UPDATE requests SET status=? WHERE id=?', to, id);
      if (target === 'job') {
        const jid = insert('INSERT INTO jobs(client_id,request_id,title,instructions,created_at) VALUES(?,?,?,?,?)', r.client_id, id, r.title, r.details, now());
        return { request: getRequest(id), job: getJob(jid) };
      }
      const qid = insert('INSERT INTO quotes(client_id,request_id,title,created_at) VALUES(?,?,?,?)', r.client_id, id, r.title, now());
      return { request: getRequest(id), quote: getQuote(qid) };
    });
  }

  // ---- quotes ---------------------------------------------------------------
  function createQuote(b) {
    const id = insert('INSERT INTO quotes(client_id,request_id,title,items,tax_rate,client_message,created_at) VALUES(?,?,?,?,?,?,?)',
      assertClient(b.client_id), b.request_id ? Number(b.request_id) : null, required(b.title, 'title'),
      JSON.stringify(normalizeItems(b.items)), Number(b.tax_rate) || 0, str(b.client_message), now());
    return getQuote(id);
  }
  function updateQuote(id, b) {
    const q = getQuote(id);
    if (!QUOTE_EDITABLE.includes(q.status)) throw new DomainError(`quote in status "${q.status}" cannot be edited`, 409);
    run('UPDATE quotes SET title=?,items=?,tax_rate=?,client_message=? WHERE id=?',
      required(b.title ?? q.title, 'title'), JSON.stringify(normalizeItems(b.items ?? q.items)),
      Number(b.tax_rate ?? q.tax_rate) || 0, str(b.client_message ?? q.client_message), id);
    return getQuote(id);
  }
  function quoteAction(id, action, b = {}) {
    const q = getQuote(id);
    const to = nextQuoteStatus(q.status, action);
    if (action === 'send' && q.items.length === 0) throw new DomainError('add at least one line item before sending');
    return tx(() => {
      if (action === 'approve') {
        run('UPDATE quotes SET status=?, signature=?, approved_at=? WHERE id=?', to, str(b.signature) || null, now(), id);
      } else if (action === 'request_changes') {
        run('UPDATE quotes SET status=?, change_request=? WHERE id=?', to, str(b.message), id);
      } else {
        run('UPDATE quotes SET status=? WHERE id=?', to, id);
      }
      if (action === 'convert') {
        const jid = insert('INSERT INTO jobs(client_id,quote_id,request_id,title,items,tax_rate,created_at) VALUES(?,?,?,?,?,?,?)',
          q.client_id, id, q.request_id, q.title, JSON.stringify(q.items), q.tax_rate, now());
        return { quote: getQuote(id), job: getJob(jid) };
      }
      return { quote: getQuote(id) };
    });
  }

  // ---- jobs -----------------------------------------------------------------
  function scheduleFields(b, prev = {}) {
    const start = optDate(b.scheduled_start !== undefined ? b.scheduled_start : prev.scheduled_start);
    let end = optDate(b.scheduled_end !== undefined ? b.scheduled_end : prev.scheduled_end);
    if (!start) end = null;
    if (start && end && end < start) throw new DomainError('scheduled_end must be after scheduled_start');
    return { start, end };
  }
  function createJob(b) {
    const { start, end } = scheduleFields(b);
    const id = insert('INSERT INTO jobs(client_id,title,instructions,items,tax_rate,scheduled_start,scheduled_end,assignee_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      assertClient(b.client_id), required(b.title, 'title'), str(b.instructions), JSON.stringify(normalizeItems(b.items)),
      Number(b.tax_rate) || 0, start, end, assertAssignee(b.assignee_id), now());
    return getJob(id);
  }
  function updateJob(id, b) {
    const j = getJob(id);
    if (j.status === 'archived') throw new DomainError('archived jobs cannot be edited', 409);
    const { start, end } = scheduleFields(b, j);
    run('UPDATE jobs SET title=?,instructions=?,items=?,tax_rate=?,scheduled_start=?,scheduled_end=?,assignee_id=? WHERE id=?',
      required(b.title ?? j.title, 'title'), str(b.instructions ?? j.instructions), JSON.stringify(normalizeItems(b.items ?? j.items)),
      Number(b.tax_rate ?? j.tax_rate) || 0, start, end, b.assignee_id !== undefined ? assertAssignee(b.assignee_id) : j.assignee_id, id);
    return getJob(id);
  }
  function jobAction(id, action, b = {}) {
    const j = getJob(id);
    switch (action) {
      case 'complete':
        if (j.status !== 'active') throw new DomainError('only active jobs can be completed', 409);
        run("UPDATE jobs SET status='completed', completed_at=? WHERE id=?", now(), id);
        return { job: getJob(id) };
      case 'reopen':
        if (j.status !== 'completed') throw new DomainError('only completed jobs can be reopened', 409);
        run("UPDATE jobs SET status='active', completed_at=NULL WHERE id=?", id);
        return { job: getJob(id) };
      case 'archive':
        if (j.status === 'archived') throw new DomainError('job already archived', 409);
        run("UPDATE jobs SET status='archived' WHERE id=?", id);
        return { job: getJob(id) };
      case 'invoice': {
        if (j.invoiced) throw new DomainError('job already has an invoice', 409);
        const iid = insert('INSERT INTO invoices(client_id,job_id,subject,items,tax_rate,due_date,created_at) VALUES(?,?,?,?,?,?,?)',
          j.client_id, id, `For services rendered: ${j.title}`, JSON.stringify(j.items), j.tax_rate,
          addDays(today(), Number(b.due_days) || DEFAULT_DUE_DAYS), now());
        return { job: getJob(id), invoice: getInvoice(iid) };
      }
      default: throw new DomainError(`unknown job action: ${action}`);
    }
  }

  // ---- invoices -------------------------------------------------------------
  function createInvoice(b) {
    const id = insert('INSERT INTO invoices(client_id,subject,items,tax_rate,due_date,created_at) VALUES(?,?,?,?,?,?)',
      assertClient(b.client_id), required(b.subject, 'subject'), JSON.stringify(normalizeItems(b.items)),
      Number(b.tax_rate) || 0, optDate(b.due_date) ?? addDays(today(), DEFAULT_DUE_DAYS), now());
    return getInvoice(id);
  }
  function updateInvoice(id, b) {
    const i = getInvoice(id);
    if (i.status !== 'draft') throw new DomainError('only draft invoices can be edited', 409);
    run('UPDATE invoices SET subject=?,items=?,tax_rate=?,due_date=? WHERE id=?',
      required(b.subject ?? i.subject, 'subject'), JSON.stringify(normalizeItems(b.items ?? i.items)),
      Number(b.tax_rate ?? i.tax_rate) || 0, optDate(b.due_date ?? i.due_date), id);
    return getInvoice(id);
  }
  function addPayment(id, b, defaultMethod = 'cash') {
    const i = getInvoice(id);
    if (i.status === 'draft') throw new DomainError('send the invoice before recording payments', 409);
    if (i.status === 'bad_debt') throw new DomainError('invoice is marked as bad debt', 409);
    const amount = b.amount === undefined ? i.balance : Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new DomainError('amount must be > 0');
    if (amount > i.balance + 0.001) throw new DomainError(`amount exceeds balance (${i.balance})`);
    run('INSERT INTO payments(invoice_id,amount,method,note,paid_at) VALUES(?,?,?,?,?)', id, amount, str(b.method) || defaultMethod, str(b.note), now());
    return { invoice: getInvoice(id) };
  }
  function invoiceAction(id, action, b = {}) {
    const i = getInvoice(id);
    switch (action) {
      case 'send':
        if (i.status !== 'draft') throw new DomainError('invoice already sent', 409);
        if (i.items.length === 0) throw new DomainError('add at least one line item before sending');
        run("UPDATE invoices SET status='sent', issued_at=? WHERE id=?", today(), id);
        return { invoice: getInvoice(id) };
      case 'pay': return addPayment(id, b);
      case 'bad_debt':
        if (i.status !== 'sent' || i.display_status === 'paid') throw new DomainError('only unpaid sent invoices can be marked bad debt', 409);
        run("UPDATE invoices SET status='bad_debt' WHERE id=?", id);
        return { invoice: getInvoice(id) };
      case 'unmark_bad_debt':
        if (i.status !== 'bad_debt') throw new DomainError('invoice is not bad debt', 409);
        run("UPDATE invoices SET status='sent' WHERE id=?", id);
        return { invoice: getInvoice(id) };
      default: throw new DomainError(`unknown invoice action: ${action}`);
    }
  }

  // ---- team -----------------------------------------------------------------
  function saveTeam(b, id) {
    const name = required(b.name, 'name');
    const role = ['admin', 'manager', 'worker'].includes(b.role) ? b.role : 'worker';
    const color = /^#[0-9a-f]{6}$/i.test(b.color ?? '') ? b.color : '#2563eb';
    if (id) {
      need(one('SELECT id FROM team WHERE id=?', id), 'team member');
      run('UPDATE team SET name=?,email=?,role=?,color=? WHERE id=?', name, str(b.email), role, color, id);
      return one('SELECT * FROM team WHERE id=?', id);
    }
    return one('SELECT * FROM team WHERE id=?', insert('INSERT INTO team(name,email,role,color) VALUES(?,?,?,?)', name, str(b.email), role, color));
  }

  // ---- dashboard & schedule ---------------------------------------------------
  function dashboard() {
    const jobs = all("SELECT * FROM jobs WHERE status!='archived'").map(hydrateJob);
    const invoices = all('SELECT * FROM invoices').map(hydrateInvoice);
    const quotes = all('SELECT * FROM quotes').map(hydrateQuote);
    const sum = (arr, k) => Math.round(arr.reduce((s, x) => s + x[k], 0) * 100) / 100;
    const by = (arr, k, v) => arr.filter((x) => x[k] === v);
    const monthPrefix = today().slice(0, 7);
    const paymentsThisMonth = all('SELECT amount FROM payments WHERE substr(paid_at,1,7)=?', monthPrefix);
    return {
      today: today(),
      workflow: {
        requests: { new: one("SELECT count(*) n FROM requests WHERE status='new'").n },
        quotes: {
          draft: by(quotes, 'status', 'draft').length,
          awaiting_response: by(quotes, 'status', 'awaiting_response').length,
          changes_requested: by(quotes, 'status', 'changes_requested').length,
          approved: by(quotes, 'status', 'approved').length,
          approved_value: sum(by(quotes, 'status', 'approved'), 'total'),
        },
        jobs: {
          requires_invoicing: by(jobs, 'display_status', 'requires_invoicing').length,
          requires_invoicing_value: sum(by(jobs, 'display_status', 'requires_invoicing'), 'total'),
          late: by(jobs, 'display_status', 'late').length,
          unscheduled: by(jobs, 'display_status', 'unscheduled').length,
        },
        invoices: {
          draft: by(invoices, 'display_status', 'draft').length,
          awaiting_payment: by(invoices, 'display_status', 'awaiting_payment').length,
          awaiting_payment_value: sum(by(invoices, 'display_status', 'awaiting_payment'), 'balance'),
          past_due: by(invoices, 'display_status', 'past_due').length,
          past_due_value: sum(by(invoices, 'display_status', 'past_due'), 'balance'),
        },
      },
      revenue_this_month: Math.round(paymentsThisMonth.reduce((s, p) => s + p.amount, 0) * 100) / 100,
      todays_visits: jobs.filter((j) => j.status !== 'archived' && j.scheduled_start?.slice(0, 10) === today())
        .sort((a, b) => a.scheduled_start.localeCompare(b.scheduled_start)),
    };
  }
  function schedule(from, to) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(to ?? '')) throw new DomainError('from and to (YYYY-MM-DD) are required');
    return {
      scheduled: all("SELECT * FROM jobs WHERE status!='archived' AND scheduled_start IS NOT NULL AND substr(scheduled_start,1,10) BETWEEN ? AND ? ORDER BY scheduled_start", from, to).map(hydrateJob),
      unscheduled: all("SELECT * FROM jobs WHERE status='active' AND scheduled_start IS NULL ORDER BY id").map(hydrateJob),
    };
  }

  // ---- client hub (token-scoped, client-facing) -------------------------------
  function hubClient(token) {
    return need(one('SELECT * FROM clients WHERE hub_token=?', token), 'client hub');
  }
  function hub(token) {
    const c = hubClient(token);
    const ph = QUOTE_HUB_VISIBLE.map(() => '?').join(',');
    return {
      client: { name: clientName(c), company: c.company, email: c.email },
      requests: all('SELECT * FROM requests WHERE client_id=? ORDER BY id DESC', c.id),
      quotes: all(`SELECT * FROM quotes WHERE client_id=? AND status IN (${ph}) ORDER BY id DESC`, c.id, ...QUOTE_HUB_VISIBLE).map(hydrateQuote),
      invoices: all("SELECT * FROM invoices WHERE client_id=? AND status!='draft' ORDER BY id DESC", c.id).map(hydrateInvoice),
    };
  }
  const hubOwned = (token, table, id) => {
    const c = hubClient(token);
    return need(one(`SELECT * FROM ${table} WHERE id=? AND client_id=?`, id, c.id), table.slice(0, -1));
  };

  // ---- routing ----------------------------------------------------------------
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler });
  };
  const id = (p) => Number(p.id);

  route('GET', '/api/dashboard', () => dashboard());
  route('GET', '/api/schedule', (p, b, q) => schedule(q.get('from'), q.get('to')));

  route('GET', '/api/team', () => all('SELECT * FROM team ORDER BY name'));
  route('POST', '/api/team', (p, b) => saveTeam(b));
  route('PUT', '/api/team/:id', (p, b) => saveTeam(b, id(p)));
  route('DELETE', '/api/team/:id', (p) => { need(one('SELECT id FROM team WHERE id=?', id(p)), 'team member'); run('DELETE FROM team WHERE id=?', id(p)); return { ok: true }; });

  route('GET', '/api/clients', (p, b, q) => {
    const s = `%${q.get('q') ?? ''}%`;
    return all("SELECT * FROM clients WHERE first_name||' '||last_name||' '||company||' '||email||' '||phone LIKE ? ORDER BY id DESC", s).map(hydrateClient);
  });
  route('POST', '/api/clients', (p, b) => saveClient(b));
  route('GET', '/api/clients/:id', (p) => clientDetail(id(p)));
  route('PUT', '/api/clients/:id', (p, b) => saveClient(b, id(p)));
  route('DELETE', '/api/clients/:id', (p) => { getClient(id(p)); run('DELETE FROM clients WHERE id=?', id(p)); return { ok: true }; });

  const listBy = (table, hydrate) => (p, b, q) => {
    const rows = all(`SELECT * FROM ${table} ORDER BY id DESC`).map(hydrate);
    const st = q.get('status');
    return st ? rows.filter((r) => (r.display_status ?? r.status) === st) : rows;
  };
  route('GET', '/api/requests', listBy('requests', hydrateRequest));
  route('POST', '/api/requests', (p, b) => createRequest(b));
  route('GET', '/api/requests/:id', (p) => getRequest(id(p)));
  route('PUT', '/api/requests/:id', (p, b) => updateRequest(id(p), b));
  route('POST', '/api/requests/:id/:action', (p, b) => requestAction(id(p), p.action, b));

  route('GET', '/api/quotes', listBy('quotes', hydrateQuote));
  route('POST', '/api/quotes', (p, b) => createQuote(b));
  route('GET', '/api/quotes/:id', (p) => getQuote(id(p)));
  route('PUT', '/api/quotes/:id', (p, b) => updateQuote(id(p), b));
  route('POST', '/api/quotes/:id/:action', (p, b) => quoteAction(id(p), p.action, b));

  route('GET', '/api/jobs', listBy('jobs', hydrateJob));
  route('POST', '/api/jobs', (p, b) => createJob(b));
  route('GET', '/api/jobs/:id', (p) => getJob(id(p)));
  route('PUT', '/api/jobs/:id', (p, b) => updateJob(id(p), b));
  route('POST', '/api/jobs/:id/:action', (p, b) => jobAction(id(p), p.action, b));

  route('GET', '/api/invoices', listBy('invoices', hydrateInvoice));
  route('POST', '/api/invoices', (p, b) => createInvoice(b));
  route('GET', '/api/invoices/:id', (p) => getInvoice(id(p)));
  route('PUT', '/api/invoices/:id', (p, b) => updateInvoice(id(p), b));
  route('POST', '/api/invoices/:id/:action', (p, b) => invoiceAction(id(p), p.action, b));

  route('GET', '/api/hub/:token', (p) => hub(p.token));
  route('POST', '/api/hub/:token/requests', (p, b) => createRequest({ ...b, client_id: hubClient(p.token).id }, 'client_hub'));
  route('POST', '/api/hub/:token/quotes/:id/approve', (p, b) => { hubOwned(p.token, 'quotes', id(p)); return quoteAction(id(p), 'approve', b); });
  route('POST', '/api/hub/:token/quotes/:id/request_changes', (p, b) => { hubOwned(p.token, 'quotes', id(p)); return quoteAction(id(p), 'request_changes', b); });
  // Demo only: a real deployment would hand off to a payment processor here.
  route('POST', '/api/hub/:token/invoices/:id/pay', (p) => { hubOwned(p.token, 'invoices', id(p)); return addPayment(id(p), {}, 'online'); });

  // ---- HTTP plumbing ------------------------------------------------------------
  async function readBody(req) {
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > 1_000_000) throw new DomainError('body too large', 413); chunks.push(c); }
    if (!chunks.length) return {};
    try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); return v && typeof v === 'object' ? v : {}; }
    catch { throw new DomainError('invalid JSON body'); }
  }
  const send = (res, status, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
  };

  async function serveStatic(pathname, res) {
    const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
    const file = join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'forbidden' });
    try { send(res, 200, await readFile(file), MIME[extname(file)] ?? 'application/octet-stream'); }
    catch { send(res, 200, await readFile(join(PUBLIC_DIR, 'index.html')), MIME['.html']); }
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
        return await serveStatic(url.pathname, res);
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
        const out = r.handler(params, body, url.searchParams);
        return send(res, req.method === 'POST' && !params.action && !url.pathname.includes('/hub/') ? 201 : 200, out);
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      if (e instanceof DomainError) return send(res, e.status, { error: e.message });
      if (String(e?.code ?? '').startsWith('ERR_SQLITE')) return send(res, 400, { error: e.message });
      console.error(e);
      send(res, 500, { error: 'internal error' });
    }
  };
}

export function startServer({ db, port = 3000, host = '127.0.0.1', clock } = {}) {
  const server = createServer(createApp(db, { clock }));
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
