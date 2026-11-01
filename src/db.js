import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS team (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'worker',
  color TEXT NOT NULL DEFAULT '#2563eb'
);
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  hub_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  preferred_date TEXT,
  source TEXT NOT NULL DEFAULT 'internal',
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  request_id INTEGER REFERENCES requests(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  items TEXT NOT NULL DEFAULT '[]',
  tax_rate REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  client_message TEXT NOT NULL DEFAULT '',
  change_request TEXT NOT NULL DEFAULT '',
  signature TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  quote_id INTEGER REFERENCES quotes(id) ON DELETE SET NULL,
  request_id INTEGER REFERENCES requests(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  items TEXT NOT NULL DEFAULT '[]',
  tax_rate REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  scheduled_start TEXT,
  scheduled_end TEXT,
  assignee_id INTEGER REFERENCES team(id) ON DELETE SET NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  subject TEXT NOT NULL,
  items TEXT NOT NULL DEFAULT '[]',
  tax_rate REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  issued_at TEXT,
  due_date TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  method TEXT NOT NULL DEFAULT 'cash',
  note TEXT NOT NULL DEFAULT '',
  paid_at TEXT NOT NULL
);
`;

export function openDb(file = ':memory:') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}
