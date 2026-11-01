// FieldOps single-page app (vanilla JS, hash routing).
const $app = document.getElementById('app');

// ---------- utilities ----------
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (Number(n) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const LABELS = {
  new: 'New', converted: 'Converted', archived: 'Archived', draft: 'Draft', awaiting_response: 'Awaiting Response',
  changes_requested: 'Changes Requested', approved: 'Approved', unscheduled: 'Unscheduled', upcoming: 'Upcoming',
  today: 'Today', late: 'Late', requires_invoicing: 'Requires Invoicing', closed: 'Closed',
  awaiting_payment: 'Awaiting Payment', past_due: 'Past Due', paid: 'Paid', bad_debt: 'Bad Debt',
};
const badge = (s) => `<span class="badge b-${esc(s)}">${esc(LABELS[s] ?? s)}</span>`;
const fmtDT = (s) => (s ? s.replace('T', ' ') : '—');
const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
let toastTimer;
function toast(msg, err = false) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = `show${err ? ' err' : ''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ''; }, 2600);
}
const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };
function formValues(form) {
  const out = {};
  for (const el of form.querySelectorAll('[name]')) {
    if (el.closest('.items')) continue;
    out[el.name] = el.value;
  }
  const rows = form.querySelectorAll('.items tbody tr');
  if (form.querySelector('.items')) {
    out.items = [...rows].map((tr) => ({
      name: tr.querySelector('[data-f=name]').value,
      description: tr.querySelector('[data-f=description]').value,
      qty: Number(tr.querySelector('[data-f=qty]').value),
      unit_price: Number(tr.querySelector('[data-f=unit_price]').value),
    })).filter((it) => it.name.trim());
  }
  return out;
}

// ---------- shared fragments ----------
function table(cols, rows, onRow) {
  if (!rows.length) return '<div class="panel empty">Nothing here yet.</div>';
  const head = cols.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('');
  const body = rows.map((r) => `<tr class="${onRow ? 'click' : ''}" ${onRow ? `data-href="${esc(onRow(r))}"` : ''}>${
    cols.map((c) => `<td class="${c.num ? 'num' : ''}">${c.html ? c.html(r) : esc(c.get(r))}</td>`).join('')}</tr>`).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}
function tabs(base, current, list) {
  return `<div class="tabs">${[['', 'All'], ...list.map((s) => [s, LABELS[s]])].map(([s, l]) =>
    `<a href="${base}${s ? `?status=${s}` : ''}" class="${(current || '') === s ? 'active' : ''}">${esc(l)}</a>`).join('')}</div>`;
}
function itemRow(it = { name: '', description: '', qty: 1, unit_price: 0 }, editable = true) {
  if (!editable) {
    return `<tr><td>${esc(it.name)}<div class="muted">${esc(it.description)}</div></td><td class="num">${esc(it.qty)}</td><td class="num">${money(it.unit_price)}</td><td class="num">${money(it.qty * it.unit_price)}</td></tr>`;
  }
  return `<tr>
    <td><input data-f="name" value="${esc(it.name)}" placeholder="Product / service" aria-label="Item name"><input data-f="description" value="${esc(it.description)}" placeholder="Description" aria-label="Item description" style="margin-top:4px"></td>
    <td class="qty"><input data-f="qty" type="number" step="any" min="0" value="${esc(it.qty)}" aria-label="Quantity"></td>
    <td class="price"><input data-f="unit_price" type="number" step="0.01" min="0" value="${esc(it.unit_price)}" aria-label="Unit price"></td>
    <td class="num"><button type="button" data-act="del-item" class="danger" aria-label="Remove item">✕</button></td></tr>`;
}
function itemsEditor(items, editable) {
  return `<table class="items"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">${editable ? '' : 'Total'}</th></tr></thead>
    <tbody>${(items.length || !editable ? items : [undefined]).map((it) => itemRow(it, editable)).join('')}</tbody></table>
    ${editable ? '<p><button type="button" data-act="add-item">+ Add line item</button></p>' : ''}`;
}
const totalsBox = (d) => `<div class="totals"><div><span>Subtotal</span><span>${money(d.subtotal)}</span></div>
  <div><span>Tax (${esc(d.tax_rate)}%)</span><span>${money(d.tax)}</span></div>
  <div class="grand"><span>Total</span><span>${money(d.total)}</span></div>
  ${d.paid !== undefined ? `<div><span>Paid</span><span>${money(d.paid)}</span></div><div class="grand"><span>Balance</span><span>${money(d.balance)}</span></div>` : ''}</div>`;
async function clientSelect(selected) {
  const clients = await api('/clients');
  return `<label>Client<select name="client_id" required><option value="">Select a client…</option>${
    clients.map((c) => `<option value="${c.id}" ${String(c.id) === String(selected) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>`;
}

// ---------- views ----------
const views = {};

views.home = async () => {
  const d = await api('/dashboard');
  const w = d.workflow;
  return `<h1>Home</h1>
  <div class="grid cards">
    <div class="card"><div class="k">Requests</div><div class="v">${w.requests.new}</div><div class="row"><a href="#/requests?status=new">New</a><span>${w.requests.new}</span></div></div>
    <div class="card"><div class="k">Quotes</div><div class="v">${money(w.quotes.approved_value)}</div>
      <div class="row"><a href="#/quotes?status=approved">Approved</a><span>${w.quotes.approved}</span></div>
      <div class="row"><a href="#/quotes?status=awaiting_response">Awaiting response</a><span>${w.quotes.awaiting_response}</span></div>
      <div class="row"><a href="#/quotes?status=changes_requested">Changes requested</a><span>${w.quotes.changes_requested}</span></div>
      <div class="row"><a href="#/quotes?status=draft">Draft</a><span>${w.quotes.draft}</span></div></div>
    <div class="card"><div class="k">Jobs</div><div class="v">${money(w.jobs.requires_invoicing_value)}</div>
      <div class="row"><a href="#/jobs?status=requires_invoicing">Requires invoicing</a><span>${w.jobs.requires_invoicing}</span></div>
      <div class="row"><a href="#/jobs?status=late">Late</a><span>${w.jobs.late}</span></div>
      <div class="row"><a href="#/jobs?status=unscheduled">Unscheduled</a><span>${w.jobs.unscheduled}</span></div></div>
    <div class="card"><div class="k">Invoices</div><div class="v">${money(w.invoices.awaiting_payment_value + w.invoices.past_due_value)}</div>
      <div class="row"><a href="#/invoices?status=awaiting_payment">Awaiting payment</a><span>${w.invoices.awaiting_payment} · ${money(w.invoices.awaiting_payment_value)}</span></div>
      <div class="row"><a href="#/invoices?status=past_due">Past due</a><span>${w.invoices.past_due} · ${money(w.invoices.past_due_value)}</span></div>
      <div class="row"><a href="#/invoices?status=draft">Draft</a><span>${w.invoices.draft}</span></div></div>
  </div>
  <div class="grid cards" style="margin-top:12px"><div class="card"><div class="k">Payments received this month</div><div class="v">${money(d.revenue_this_month)}</div></div></div>
  <h2>Today's visits (${esc(d.today)})</h2>
  ${table([
    { label: 'Time', get: (j) => `${j.scheduled_start.slice(11)}–${(j.scheduled_end || '').slice(11)}` },
    { label: 'Job', get: (j) => `#${j.id} ${j.title}` }, { label: 'Client', get: (j) => j.client_name },
    { label: 'Assigned', get: (j) => j.assignee_name || 'Unassigned' }, { label: 'Status', html: (j) => badge(j.display_status) },
  ], d.todays_visits, (j) => `#/jobs/${j.id}`)}`;
};

views.schedule = async (_, q) => {
  const base = q.get('week') ? new Date(`${q.get('week')}T00:00:00`) : new Date();
  const monday = new Date(base); monday.setDate(base.getDate() - ((base.getDay() + 6) % 7));
  const days = [...Array(7)].map((_, i) => { const d = new Date(monday); d.setDate(monday.getDate() + i); return isoDate(d); });
  const shift = (n) => { const d = new Date(monday); d.setDate(d.getDate() + n); return isoDate(d); };
  const s = await api(`/schedule?from=${days[0]}&to=${days[6]}`);
  const todayStr = isoDate(new Date());
  const visit = (j) => `<a class="visit" href="#/jobs/${j.id}" style="border-left-color:${esc(j.assignee_color || '#9ca3af')}">
    <strong>${esc(j.scheduled_start.slice(11))}</strong> ${esc(j.title)}<br><span class="muted">${esc(j.client_name)} · ${esc(j.assignee_name || 'Unassigned')}</span></a>`;
  return `<div class="bar"><h1>Schedule</h1>
    <a class="btn" href="#/schedule?week=${shift(-7)}">← Prev</a><a class="btn" href="#/schedule">This week</a><a class="btn" href="#/schedule?week=${shift(7)}">Next →</a>
    <a class="btn" href="#/jobs/new">+ New job</a></div>
  <div class="week">${days.map((d) => {
    const dt = new Date(`${d}T00:00:00`);
    return `<div class="day ${d === todayStr ? 'today' : ''}"><div class="d">${dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</div>
      ${s.scheduled.filter((j) => j.scheduled_start.slice(0, 10) === d).map(visit).join('') || '<span class="muted">—</span>'}</div>`;
  }).join('')}</div>
  <h2>Unscheduled jobs</h2>
  ${table([{ label: 'Job', get: (j) => `#${j.id} ${j.title}` }, { label: 'Client', get: (j) => j.client_name }, { label: 'Total', num: true, get: (j) => money(j.total) }],
    s.unscheduled, (j) => `#/jobs/${j.id}`)}`;
};

// Clients
views.clients = async (_, q) => {
  const list = await api(`/clients?q=${encodeURIComponent(q.get('q') ?? '')}`);
  return `<div class="bar"><h1>Clients</h1>
    <form data-form="client-search"><input name="q" placeholder="Search clients" value="${esc(q.get('q') ?? '')}" aria-label="Search clients"></form>
    <a class="btn" href="#/clients/new"><strong>+ New client</strong></a></div>
  ${table([{ label: 'Name', get: (c) => c.name }, { label: 'Company', get: (c) => c.company }, { label: 'Email', get: (c) => c.email },
    { label: 'Phone', get: (c) => c.phone }, { label: 'Address', get: (c) => c.address }], list, (c) => `#/clients/${c.id}`)}`;
};
views.clientForm = async ([id]) => {
  const c = id ? await api(`/clients/${id}`) : {};
  const f = (name, label, type = 'text') => `<label>${label}<input name="${name}" type="${type}" value="${esc(c[name])}"></label>`;
  return `<h1>${id ? 'Edit client' : 'New client'}</h1>
  <form class="panel" data-form="client" data-id="${esc(id ?? '')}"><div class="fields">
    ${f('first_name', 'First name')}${f('last_name', 'Last name')}${f('company', 'Company')}${f('email', 'Email', 'email')}${f('phone', 'Phone')}${f('address', 'Property address')}
  </div><label style="margin-top:12px">Notes<textarea name="notes">${esc(c.notes)}</textarea></label>
  <p class="actions"><button class="primary">Save client</button><a class="btn" href="${id ? `#/clients/${id}` : '#/clients'}">Cancel</a></p></form>`;
};
views.clientDetail = async ([id]) => {
  const c = await api(`/clients/${id}`);
  const hubUrl = `${location.origin}/#/hub/${c.hub_token}`;
  const mini = (rows, href, title) => table([{ label: '#', get: (r) => r.id }, { label: 'Title', get: (r) => r.title ?? r.subject },
    { label: 'Status', html: (r) => badge(r.display_status ?? r.status) }, { label: 'Total', num: true, get: (r) => (r.total !== undefined ? money(r.total) : '') }],
  rows, (r) => `${href}/${r.id}`).replace('Nothing here yet.', `No ${title} yet.`);
  return `<div class="bar"><h1>${esc(c.name)}</h1>
    <a class="btn" href="#/requests/new?client=${c.id}">+ Request</a><a class="btn" href="#/quotes/new?client=${c.id}">+ Quote</a>
    <a class="btn" href="#/jobs/new?client=${c.id}">+ Job</a><a class="btn" href="#/invoices/new?client=${c.id}">+ Invoice</a>
    <a class="btn" href="#/clients/${c.id}/edit">Edit</a></div>
  <div class="panel"><dl class="kv"><dt>Company</dt><dd>${esc(c.company) || '—'}</dd><dt>Email</dt><dd>${esc(c.email) || '—'}</dd>
    <dt>Phone</dt><dd>${esc(c.phone) || '—'}</dd><dt>Address</dt><dd>${esc(c.address) || '—'}</dd><dt>Notes</dt><dd>${esc(c.notes) || '—'}</dd>
    <dt>Client Hub link</dt><dd><a href="${esc(hubUrl)}" target="_blank" rel="noopener">${esc(hubUrl)}</a></dd></dl></div>
  <h2>Requests</h2>${mini(c.requests, '#/requests', 'requests')}
  <h2>Quotes</h2>${mini(c.quotes, '#/quotes', 'quotes')}
  <h2>Jobs</h2>${mini(c.jobs, '#/jobs', 'jobs')}
  <h2>Invoices</h2>${mini(c.invoices, '#/invoices', 'invoices')}`;
};

// Requests
views.requests = async (_, q) => {
  const list = await api(`/requests${q.get('status') ? `?status=${q.get('status')}` : ''}`);
  return `<div class="bar"><h1>Requests</h1><a class="btn" href="#/requests/new"><strong>+ New request</strong></a></div>
  ${tabs('#/requests', q.get('status'), ['new', 'converted', 'archived'])}
  ${table([{ label: '#', get: (r) => r.id }, { label: 'Title', get: (r) => r.title }, { label: 'Client', get: (r) => r.client_name },
    { label: 'Preferred date', get: (r) => r.preferred_date || '—' }, { label: 'Source', get: (r) => (r.source === 'client_hub' ? 'Client Hub' : 'Internal') },
    { label: 'Status', html: (r) => badge(r.status) }], list, (r) => `#/requests/${r.id}`)}`;
};
views.requestNew = async (_, q) => `<h1>New request</h1>
  <form class="panel" data-form="request"><div class="fields">${await clientSelect(q.get('client'))}
    <label>Title<input name="title" required></label><label>Preferred date<input name="preferred_date" type="date"></label></div>
    <label style="margin-top:12px">Details<textarea name="details"></textarea></label>
    <p class="actions"><button class="primary">Save request</button><a class="btn" href="#/requests">Cancel</a></p></form>`;
views.requestDetail = async ([id]) => {
  const r = await api(`/requests/${id}`);
  return `<div class="bar"><h1>Request #${r.id}: ${esc(r.title)}</h1>${badge(r.status)}</div>
  <div class="panel"><dl class="kv"><dt>Client</dt><dd><a href="#/clients/${r.client_id}">${esc(r.client_name)}</a></dd>
    <dt>Preferred date</dt><dd>${esc(r.preferred_date) || '—'}</dd><dt>Source</dt><dd>${r.source === 'client_hub' ? 'Client Hub' : 'Internal'}</dd>
    <dt>Received</dt><dd>${fmtDT(r.created_at)}</dd><dt>Details</dt><dd style="white-space:pre-wrap">${esc(r.details) || '—'}</dd></dl></div>
  <div class="actions">
    ${r.status === 'new' ? `<button class="primary" data-act="req" data-id="${r.id}" data-a="convert" data-to="quote">Convert to quote</button>
      <button data-act="req" data-id="${r.id}" data-a="convert" data-to="job">Convert to job</button>
      <button data-act="req" data-id="${r.id}" data-a="archive">Archive</button>` : ''}
    ${r.status === 'archived' ? `<button data-act="req" data-id="${r.id}" data-a="unarchive">Unarchive</button>` : ''}
  </div>`;
};

// Quotes
views.quotes = async (_, q) => {
  const list = await api(`/quotes${q.get('status') ? `?status=${q.get('status')}` : ''}`);
  return `<div class="bar"><h1>Quotes</h1><a class="btn" href="#/quotes/new"><strong>+ New quote</strong></a></div>
  ${tabs('#/quotes', q.get('status'), ['draft', 'awaiting_response', 'changes_requested', 'approved', 'converted', 'archived'])}
  ${table([{ label: '#', get: (r) => r.id }, { label: 'Title', get: (r) => r.title }, { label: 'Client', get: (r) => r.client_name },
    { label: 'Created', get: (r) => r.created_at.slice(0, 10) }, { label: 'Status', html: (r) => badge(r.status) },
    { label: 'Total', num: true, get: (r) => money(r.total) }], list, (r) => `#/quotes/${r.id}`)}`;
};
async function docForm(kind, d, { editable, clientId }) {
  const titleField = kind === 'invoice' ? 'subject' : 'title';
  const extra = {
    quote: `<label>Client message<textarea name="client_message">${esc(d.client_message)}</textarea></label>`,
    job: `<div class="fields"><label>Start<input name="scheduled_start" type="datetime-local" value="${esc(d.scheduled_start)}"></label>
      <label>End<input name="scheduled_end" type="datetime-local" value="${esc(d.scheduled_end)}"></label>
      <label>Assigned to<select name="assignee_id"><option value="">Unassigned</option>${(await api('/team')).map((t) =>
        `<option value="${t.id}" ${t.id === d.assignee_id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label></div>
      <label style="margin-top:12px">Instructions<textarea name="instructions">${esc(d.instructions)}</textarea></label>`,
    invoice: `<label>Payment due<input name="due_date" type="date" value="${esc(d.due_date)}"></label>`,
  }[kind];
  return `<form class="panel" data-form="${kind}" data-id="${esc(d.id ?? '')}">
    <div class="fields">${d.id ? `<label>Client<input value="${esc(d.client_name)}" disabled></label>` : await clientSelect(clientId)}
      <label>${kind === 'invoice' ? 'Subject' : 'Title'}<input name="${titleField}" value="${esc(d[titleField])}" required ${editable ? '' : 'disabled'}></label>
      <label>Tax rate (%)<input name="tax_rate" type="number" step="0.01" min="0" value="${esc(d.tax_rate ?? 0)}" ${editable ? '' : 'disabled'}></label></div>
    <h2>Line items</h2>${itemsEditor(d.items ?? [], editable)}
    ${d.id ? totalsBox(d) : ''}
    <div style="margin-top:12px">${extra}</div>
    ${editable || kind === 'job' ? `<p class="actions"><button class="primary">Save ${kind}</button></p>` : ''}</form>`;
}
views.quoteNew = async (_, q) => `<h1>New quote</h1>${await docForm('quote', {}, { editable: true, clientId: q.get('client') })}`;
views.quoteDetail = async ([id]) => {
  const d = await api(`/quotes/${id}`);
  const editable = ['draft', 'changes_requested'].includes(d.status);
  const btn = (a, label, cls = '') => `<button class="${cls}" data-act="quote" data-id="${d.id}" data-a="${a}">${label}</button>`;
  const acts = {
    draft: [btn('send', 'Send to client', 'primary')],
    changes_requested: [btn('send', 'Resend to client', 'primary'), btn('archive', 'Archive')],
    awaiting_response: [btn('approve', 'Mark as approved', 'primary'), btn('request_changes', 'Record change request'), btn('archive', 'Archive')],
    approved: [btn('convert', 'Convert to job', 'primary'), btn('archive', 'Archive')],
  }[d.status] ?? [];
  return `<div class="bar"><h1>Quote #${d.id}</h1>${badge(d.status)}</div>
  ${d.change_request && d.status === 'changes_requested' ? `<div class="panel"><strong>Client requested changes:</strong> ${esc(d.change_request)}</div>` : ''}
  ${d.signature ? `<div class="panel">Approved by <strong>${esc(d.signature)}</strong> on ${fmtDT(d.approved_at)}</div>` : ''}
  <p class="actions">${acts.join('')}<a class="btn" href="#/clients/${d.client_id}">View client</a></p>
  ${await docForm('quote', d, { editable })}`;
};

// Jobs
views.jobs = async (_, q) => {
  const list = await api(`/jobs${q.get('status') ? `?status=${q.get('status')}` : ''}`);
  return `<div class="bar"><h1>Jobs</h1><a class="btn" href="#/jobs/new"><strong>+ New job</strong></a></div>
  ${tabs('#/jobs', q.get('status'), ['unscheduled', 'today', 'upcoming', 'late', 'requires_invoicing', 'closed', 'archived'])}
  ${table([{ label: '#', get: (r) => r.id }, { label: 'Title', get: (r) => r.title }, { label: 'Client', get: (r) => r.client_name },
    { label: 'Schedule', get: (r) => fmtDT(r.scheduled_start) }, { label: 'Assigned', get: (r) => r.assignee_name || '—' },
    { label: 'Status', html: (r) => badge(r.display_status) }, { label: 'Total', num: true, get: (r) => money(r.total) }], list, (r) => `#/jobs/${r.id}`)}`;
};
views.jobNew = async (_, q) => `<h1>New job</h1>${await docForm('job', {}, { editable: true, clientId: q.get('client') })}`;
views.jobDetail = async ([id]) => {
  const d = await api(`/jobs/${id}`);
  const btn = (a, label, cls = '') => `<button class="${cls}" data-act="job" data-id="${d.id}" data-a="${a}">${label}</button>`;
  const acts = [];
  if (d.status === 'active') acts.push(btn('complete', 'Mark complete', 'primary'));
  if (d.status === 'completed' && !d.invoiced) acts.push(btn('invoice', 'Create invoice', 'primary'));
  if (d.status === 'completed') acts.push(btn('reopen', 'Reopen'));
  if (d.status !== 'archived') acts.push(btn('archive', 'Archive'));
  return `<div class="bar"><h1>Job #${d.id}</h1>${badge(d.display_status)}</div>
  <p class="actions">${acts.join('')}<a class="btn" href="#/clients/${d.client_id}">View client</a>
    ${d.quote_id ? `<a class="btn" href="#/quotes/${d.quote_id}">From quote #${d.quote_id}</a>` : ''}</p>
  ${await docForm('job', d, { editable: d.status !== 'archived' })}`;
};

// Invoices
views.invoices = async (_, q) => {
  const list = await api(`/invoices${q.get('status') ? `?status=${q.get('status')}` : ''}`);
  return `<div class="bar"><h1>Invoices</h1><a class="btn" href="#/invoices/new"><strong>+ New invoice</strong></a></div>
  ${tabs('#/invoices', q.get('status'), ['draft', 'awaiting_payment', 'past_due', 'paid', 'bad_debt'])}
  ${table([{ label: '#', get: (r) => r.id }, { label: 'Subject', get: (r) => r.subject }, { label: 'Client', get: (r) => r.client_name },
    { label: 'Due', get: (r) => r.due_date || '—' }, { label: 'Status', html: (r) => badge(r.display_status) },
    { label: 'Total', num: true, get: (r) => money(r.total) }, { label: 'Balance', num: true, get: (r) => money(r.balance) }], list, (r) => `#/invoices/${r.id}`)}`;
};
views.invoiceNew = async (_, q) => `<h1>New invoice</h1>${await docForm('invoice', {}, { editable: true, clientId: q.get('client') })}`;
views.invoiceDetail = async ([id]) => {
  const d = await api(`/invoices/${id}`);
  const btn = (a, label, cls = '') => `<button class="${cls}" data-act="invoice" data-id="${d.id}" data-a="${a}">${label}</button>`;
  const acts = [];
  if (d.status === 'draft') acts.push(btn('send', 'Send to client', 'primary'));
  if (d.status === 'sent' && d.balance > 0) acts.push(btn('pay', 'Collect payment', 'primary'), btn('bad_debt', 'Mark as bad debt', 'danger'));
  if (d.status === 'bad_debt') acts.push(btn('unmark_bad_debt', 'Unmark as bad debt'));
  return `<div class="bar"><h1>Invoice #${d.id}</h1>${badge(d.display_status)}</div>
  <p class="actions">${acts.join('')}<a class="btn" href="#/clients/${d.client_id}">View client</a>
    ${d.job_id ? `<a class="btn" href="#/jobs/${d.job_id}">From job #${d.job_id}</a>` : ''}</p>
  ${d.status !== 'draft' ? `<div class="panel"><dl class="kv"><dt>Issued</dt><dd>${esc(d.issued_at) || '—'}</dd><dt>Due</dt><dd>${esc(d.due_date) || '—'}</dd></dl></div>` : ''}
  ${await docForm('invoice', d, { editable: d.status === 'draft' })}
  <h2>Payments</h2>${table([{ label: 'Date', get: (p) => fmtDT(p.paid_at) }, { label: 'Method', get: (p) => p.method },
    { label: 'Note', get: (p) => p.note }, { label: 'Amount', num: true, get: (p) => money(p.amount) }], d.payments)}`;
};

// Team
views.team = async () => {
  const list = await api('/team');
  return `<h1>Team</h1>
  ${table([{ label: 'Name', html: (t) => `<span class="badge" style="background:${esc(t.color)};color:#fff">●</span> ${esc(t.name)}` },
    { label: 'Email', get: (t) => t.email }, { label: 'Role', get: (t) => t.role },
    { label: '', html: (t) => `<button class="danger" data-act="team-del" data-id="${t.id}">Remove</button>` }], list)}
  <h2>Add team member</h2>
  <form class="panel" data-form="team"><div class="fields"><label>Name<input name="name" required></label><label>Email<input name="email" type="email"></label>
    <label>Role<select name="role"><option value="worker">Worker</option><option value="manager">Manager</option><option value="admin">Admin</option></select></label>
    <label>Calendar color<input name="color" type="color" value="#2563eb"></label></div>
    <p class="actions"><button class="primary">Add member</button></p></form>`;
};

// Client Hub (client-facing, token scoped)
views.hub = async ([token]) => {
  const h = await api(`/hub/${token}`);
  return `<h1>Client Hub · ${esc(h.client.name)}</h1>
  <h2>Quotes</h2>${h.quotes.length ? h.quotes.map((q) => `<div class="panel"><div class="bar"><strong style="flex:1">Quote #${q.id}: ${esc(q.title)}</strong>${badge(q.status)}</div>
    ${itemsEditor(q.items, false)}${totalsBox(q)}${q.client_message ? `<p>${esc(q.client_message)}</p>` : ''}
    ${q.status === 'awaiting_response' ? `<p class="actions"><button class="primary" data-act="hub-approve" data-token="${esc(token)}" data-id="${q.id}">Approve quote</button>
      <button data-act="hub-changes" data-token="${esc(token)}" data-id="${q.id}">Request changes</button></p>` : ''}</div>`).join('') : '<div class="panel empty">No quotes.</div>'}
  <h2>Invoices</h2>${table([{ label: '#', get: (i) => i.id }, { label: 'Subject', get: (i) => i.subject }, { label: 'Due', get: (i) => i.due_date || '—' },
    { label: 'Status', html: (i) => badge(i.display_status) }, { label: 'Balance', num: true, get: (i) => money(i.balance) },
    { label: '', html: (i) => (['awaiting_payment', 'past_due'].includes(i.display_status) ? `<button class="primary" data-act="hub-pay" data-token="${esc(token)}" data-id="${i.id}">Pay ${money(i.balance)}</button>` : '') }], h.invoices)}
  <h2>Request new work</h2>
  <form class="panel" data-form="hub-request" data-token="${esc(token)}"><div class="fields"><label>What do you need?<input name="title" required></label>
    <label>Preferred date<input name="preferred_date" type="date"></label></div><label style="margin-top:12px">Details<textarea name="details"></textarea></label>
    <p class="actions"><button class="primary">Submit request</button></p></form>
  <h2>Your requests</h2>${table([{ label: 'Title', get: (r) => r.title }, { label: 'Submitted', get: (r) => r.created_at.slice(0, 10) }, { label: 'Status', html: (r) => badge(r.status) }], h.requests)}`;
};

// ---------- router ----------
const ROUTES = [
  [/^\/?$/, 'home', 'home'], [/^\/schedule$/, 'schedule', 'schedule'],
  [/^\/clients$/, 'clients', 'clients'], [/^\/clients\/new$/, 'clientForm', 'clients'], [/^\/clients\/(\d+)\/edit$/, 'clientForm', 'clients'], [/^\/clients\/(\d+)$/, 'clientDetail', 'clients'],
  [/^\/requests$/, 'requests', 'requests'], [/^\/requests\/new$/, 'requestNew', 'requests'], [/^\/requests\/(\d+)$/, 'requestDetail', 'requests'],
  [/^\/quotes$/, 'quotes', 'quotes'], [/^\/quotes\/new$/, 'quoteNew', 'quotes'], [/^\/quotes\/(\d+)$/, 'quoteDetail', 'quotes'],
  [/^\/jobs$/, 'jobs', 'jobs'], [/^\/jobs\/new$/, 'jobNew', 'jobs'], [/^\/jobs\/(\d+)$/, 'jobDetail', 'jobs'],
  [/^\/invoices$/, 'invoices', 'invoices'], [/^\/invoices\/new$/, 'invoiceNew', 'invoices'], [/^\/invoices\/(\d+)$/, 'invoiceDetail', 'invoices'],
  [/^\/team$/, 'team', 'team'], [/^\/hub\/([0-9a-f]+)$/, 'hub', 'hub'],
];
async function render() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  const q = new URLSearchParams(qs ?? '');
  const match = ROUTES.map(([re, view, nav]) => ({ m: path.match(re), view, nav })).find((r) => r.m);
  document.body.classList.toggle('hub', match?.nav === 'hub');
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === match?.nav));
  if (!match) { $app.innerHTML = '<h1>Not found</h1>'; return; }
  try { $app.innerHTML = await views[match.view](match.m.slice(1), q); }
  catch (e) { $app.innerHTML = `<div class="panel">Error: ${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', render);

// ---------- events ----------
$app.addEventListener('click', async (e) => {
  const row = e.target.closest('tr[data-href]');
  if (row && !e.target.closest('button,a,input,select')) { go(row.dataset.href); return; }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const { act, id, a, to, token } = b.dataset;
  try {
    if (act === 'add-item') { b.closest('form').querySelector('.items tbody').insertAdjacentHTML('beforeend', itemRow()); return; }
    if (act === 'del-item') { b.closest('tr').remove(); return; }
    b.disabled = true;
    if (act === 'req') {
      const r = await api(`/requests/${id}/${a}`, { method: 'POST', body: { to } });
      toast('Request updated');
      return go(r.quote ? `#/quotes/${r.quote.id}` : r.job ? `#/jobs/${r.job.id}` : `#/requests/${id}`);
    }
    if (act === 'quote') {
      const body = {};
      if (a === 'approve') { body.signature = prompt('Approved by (name / signature):') ?? ''; }
      if (a === 'request_changes') { const m = prompt('What changes did the client request?'); if (m === null) { b.disabled = false; return; } body.message = m; }
      const r = await api(`/quotes/${id}/${a}`, { method: 'POST', body });
      toast(`Quote ${LABELS[r.quote.status].toLowerCase()}`);
      return go(r.job ? `#/jobs/${r.job.id}` : `#/quotes/${id}`);
    }
    if (act === 'job') {
      const r = await api(`/jobs/${id}/${a}`, { method: 'POST', body: {} });
      toast('Job updated');
      return go(r.invoice ? `#/invoices/${r.invoice.id}` : `#/jobs/${id}`);
    }
    if (act === 'invoice') {
      const body = {};
      if (a === 'pay') {
        const amt = prompt('Payment amount:', b.closest('main').querySelector('.totals .grand:last-child span:last-child')?.textContent.replace(/[^0-9.]/g, '') ?? '');
        if (amt === null) { b.disabled = false; return; }
        body.amount = Number(amt); body.method = prompt('Method (cash, check, card, bank transfer):', 'cash') || 'cash';
      }
      await api(`/invoices/${id}/${a}`, { method: 'POST', body });
      toast('Invoice updated');
      return go(`#/invoices/${id}`);
    }
    if (act === 'team-del') { if (!confirm('Remove this team member?')) { b.disabled = false; return; } await api(`/team/${id}`, { method: 'DELETE' }); toast('Removed'); return render(); }
    if (act === 'hub-approve') {
      const sig = prompt('Type your full name to approve:'); if (!sig) { b.disabled = false; return; }
      await api(`/hub/${token}/quotes/${id}/approve`, { method: 'POST', body: { signature: sig } }); toast('Quote approved. Thank you!'); return render();
    }
    if (act === 'hub-changes') {
      const m = prompt('What would you like changed?'); if (m === null) { b.disabled = false; return; }
      await api(`/hub/${token}/quotes/${id}/request_changes`, { method: 'POST', body: { message: m } }); toast('Change request sent'); return render();
    }
    if (act === 'hub-pay') { await api(`/hub/${token}/invoices/${id}/pay`, { method: 'POST' }); toast('Payment received. Thank you!'); return render(); }
  } catch (err) { toast(err.message, true); b.disabled = false; }
});

$app.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const kind = form.dataset.form;
  const v = formValues(form);
  const id = form.dataset.id;
  try {
    if (kind === 'client-search') return go(`#/clients?q=${encodeURIComponent(v.q)}`);
    if (kind === 'client') { const c = await api(id ? `/clients/${id}` : '/clients', { method: id ? 'PUT' : 'POST', body: v }); toast('Client saved'); return go(`#/clients/${c.id}`); }
    if (kind === 'request') { const r = await api('/requests', { method: 'POST', body: v }); toast('Request saved'); return go(`#/requests/${r.id}`); }
    if (kind === 'team') { await api('/team', { method: 'POST', body: v }); toast('Team member added'); return render(); }
    if (kind === 'hub-request') { await api(`/hub/${form.dataset.token}/requests`, { method: 'POST', body: v }); toast('Request submitted'); return render(); }
    if (['quote', 'job', 'invoice'].includes(kind)) {
      const d = await api(id ? `/${kind}s/${id}` : `/${kind}s`, { method: id ? 'PUT' : 'POST', body: v });
      toast(`${kind[0].toUpperCase()}${kind.slice(1)} saved`);
      return go(`#/${kind}s/${d.id}`);
    }
  } catch (err) { toast(err.message, true); }
});

render();
