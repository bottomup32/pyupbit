import { randomBytes } from 'node:crypto';
import { nowLocal, todayLocal, addDays } from './domain.js';

// Demo data that exercises every status in the workflow.
export function seed(db) {
  const ins = (sql, ...a) => Number(db.prepare(sql).run(...a).lastInsertRowid);
  const now = nowLocal();
  const today = todayLocal();
  const at = (days, hm) => `${addDays(today, days)}T${hm}`;
  const items = (...rows) => JSON.stringify(rows.map(([name, qty, unit_price]) => ({ name, description: '', qty, unit_price })));

  const t1 = ins("INSERT INTO team(name,email,role,color) VALUES('Alex Kim','alex@example.com','admin','#2563eb')");
  const t2 = ins("INSERT INTO team(name,email,role,color) VALUES('Jordan Lee','jordan@example.com','worker','#16a34a')");

  const client = (first, last, company, email, phone, address) => ins(
    'INSERT INTO clients(first_name,last_name,company,email,phone,address,notes,hub_token,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    first, last, company, email, phone, address, '', randomBytes(16).toString('hex'), now);
  const c1 = client('Sarah', 'Park', '', 'sarah@example.com', '555-0101', '12 Oak St, Irvine, CA');
  const c2 = client('', '', 'Green Leaf Cafe', 'ops@greenleaf.example', '555-0102', '88 Main St, Irvine, CA');
  const c3 = client('Daniel', 'Cho', '', 'daniel@example.com', '555-0103', '5 Pine Ave, Tustin, CA');

  ins('INSERT INTO requests(client_id,title,details,preferred_date,source,created_at) VALUES(?,?,?,?,?,?)', c3, 'Gutter cleaning', 'Two-story house, back side clogged.', addDays(today, 5), 'client_hub', now);
  ins('INSERT INTO requests(client_id,title,details,preferred_date,source,created_at) VALUES(?,?,?,?,?,?)', c1, 'Lawn care estimate', 'Weekly mowing for summer.', null, 'internal', now);

  ins("INSERT INTO quotes(client_id,title,items,tax_rate,status,created_at) VALUES(?,?,?,?,'draft',?)", c1, 'Weekly lawn care', items(['Mowing (per visit)', 4, 45]), 0, now);
  ins("INSERT INTO quotes(client_id,title,items,tax_rate,status,created_at) VALUES(?,?,?,?,'awaiting_response',?)", c2, 'Patio pressure wash', items(['Pressure washing', 1, 320], ['Sealant', 2, 60]), 7.75, now);
  const qApproved = ins("INSERT INTO quotes(client_id,title,items,tax_rate,status,signature,approved_at,created_at) VALUES(?,?,?,?,'approved','Daniel Cho',?,?)", c3, 'Window cleaning', items(['Exterior windows', 18, 12]), 0, now, now);

  ins('INSERT INTO jobs(client_id,quote_id,title,items,tax_rate,scheduled_start,scheduled_end,assignee_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)', c3, qApproved, 'Window cleaning', items(['Exterior windows', 18, 12]), 0, at(0, '10:00'), at(0, '12:00'), t2, now);
  ins('INSERT INTO jobs(client_id,title,items,tax_rate,scheduled_start,scheduled_end,assignee_id,created_at) VALUES(?,?,?,?,?,?,?,?)', c2, 'Monthly HVAC filter swap', items(['Filter replacement', 6, 25]), 7.75, at(2, '09:00'), at(2, '10:30'), t1, now);
  ins('INSERT INTO jobs(client_id,title,items,tax_rate,scheduled_start,scheduled_end,assignee_id,created_at) VALUES(?,?,?,?,?,?,?,?)', c1, 'Hedge trimming', items(['Hedge trimming', 3, 40]), 0, at(-2, '13:00'), at(-2, '15:00'), t2, now);
  ins('INSERT INTO jobs(client_id,title,items,tax_rate,created_at) VALUES(?,?,?,?,?)', c2, 'Sprinkler repair', items(['Labor (hr)', 2, 85]), 7.75, now);
  const jDone = ins("INSERT INTO jobs(client_id,title,items,tax_rate,status,scheduled_start,scheduled_end,assignee_id,completed_at,created_at) VALUES(?,?,?,?,'completed',?,?,?,?,?)", c1, 'Spring cleanup', items(['Yard cleanup', 1, 280]), 0, at(-5, '08:00'), at(-5, '12:00'), t2, at(-5, '12:00'), now);
  const jBilled = ins("INSERT INTO jobs(client_id,title,items,tax_rate,status,scheduled_start,scheduled_end,assignee_id,completed_at,created_at) VALUES(?,?,?,?,'completed',?,?,?,?,?)", c2, 'Deep clean', items(['Kitchen deep clean', 1, 450]), 7.75, at(-20, '07:00'), at(-20, '11:00'), t1, at(-20, '11:00'), now);
  void jDone;

  const inv = (clientId, jobId, subject, it, tax, status, issued, due) => ins(
    'INSERT INTO invoices(client_id,job_id,subject,items,tax_rate,status,issued_at,due_date,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    clientId, jobId, subject, it, tax, status, issued, due, now);
  inv(c2, jBilled, 'For services rendered: Deep clean', items(['Kitchen deep clean', 1, 450]), 7.75, 'sent', addDays(today, -40), addDays(today, -10));
  const iPaid = inv(c3, null, 'Consultation', items(['On-site consultation', 1, 150]), 0, 'sent', addDays(today, -3), addDays(today, 27));
  db.prepare('INSERT INTO payments(invoice_id,amount,method,note,paid_at) VALUES(?,?,?,?,?)').run(iPaid, 150, 'card', '', now);
  inv(c1, null, 'Tree removal deposit', items(['Deposit', 1, 200]), 0, 'sent', today, addDays(today, 30));
  inv(c1, null, 'Gate repair', items(['Labor (hr)', 1.5, 85]), 0, 'draft', null, addDays(today, 30));
}
