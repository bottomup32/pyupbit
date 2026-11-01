import { openDb } from './db.js';
import { startServer } from './server.js';
import { seed } from './seed.js';

const dbFile = process.env.DB_FILE ?? 'data/fsm.db';
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';

const db = openDb(dbFile);
if (process.argv.includes('--seed')) {
  const n = db.prepare('SELECT count(*) n FROM clients').get().n;
  if (n === 0) { seed(db); console.log('Seeded demo data.'); }
  else console.log('Database not empty; skipping seed.');
}
await startServer({ db, port, host });
console.log(`Field service app running at http://${host}:${port}  (db: ${dbFile})`);
