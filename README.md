# FieldOps

Internal field-service management tool covering requests, quotes, jobs, scheduling, invoices, payments and a client hub.
It uses only the Node.js standard library plus the built-in SQLite, so there is no `npm install`.

## Run

Requires Node.js 22.13 or later.

```bash
npm run start:demo
```

Open http://127.0.0.1:3000. `start:demo` seeds demo data on first run; use `npm start` for an empty database.
Environment variables: `PORT` (default 3000), `HOST` (default 127.0.0.1), `DB_FILE` (default `data/fsm.db`).

```bash
npm test
```

## Features

| Area | What it does |
|---|---|
| Home | Workflow cards (requests, quotes, jobs, invoices), payments this month, today's visits |
| Schedule | Week calendar by assignee color, unscheduled job list |
| Clients | CRUD, search, related requests/quotes/jobs/invoices, Client Hub link |
| Requests | New → convert to quote or job / archive |
| Quotes | Line items and tax; Draft → Awaiting Response → Changes Requested / Approved (signature) → Converted; Archive |
| Jobs | Schedule, assign, complete; derived Unscheduled / Today / Upcoming / Late / Requires Invoicing / Closed |
| Invoices | Create from job or standalone; Draft → Awaiting Payment / Past Due / Paid; partial payments; Bad Debt |
| Team | Members, roles, calendar colors |
| Client Hub | Token link per client: submit requests, approve or request changes on quotes, pay invoices (demo) |

The analysis basis, the evidence sources and the REA verification are in [docs/ANALYSIS.md](docs/ANALYSIS.md).

## Limitations

- No login. Keep it on localhost or put it behind SSO before sharing.
- Client Hub payment only records a payment; there is no payment processor.
- Email/SMS sending is not implemented. "Send" changes status only.

## REA (Reverse Engineer Anything)

`.claude/settings.json` enables the [REA](https://github.com/morluto/rea) Claude Code plugin for this repository. To use the CLI:

```bash
npx rea-agents setup
```
