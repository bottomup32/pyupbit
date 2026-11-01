# FieldOps: analysis basis and verification

## 1. Scope and method (Option A)

- **Goal:** an internal field-service management (FSM) tool covering the standard workflow: Request → Quote → Job → Invoice → Payment, plus scheduling and a client-facing hub.
- **Method:** public documentation only. We did **not** log in to, capture, decompile or copy any part of the Jobber application (code, UI assets, branding or copy).
  - The logged-in browser session lives on the user's PC and is not reachable from the build environment.
  - `getjobber.com` / `help.getjobber.com` are blocked by the build environment's network policy (proxy 403), so pages were read only through web-search summaries.
- **REA usage:** REA (`rea-agents` 6.8.0, [morluto/rea](https://github.com/morluto/rea)) is used to **verify our own app** through an end-to-end Playwright browser scenario with an Evidence record (section 4).

## 2. Evidence: publicly documented workflow concepts

| Concept | Public source (summary) | Our implementation |
|---|---|---|
| Workflow building blocks | Help Center describes requests, quotes, jobs, invoices, then payment; requests are the entry point. [Work category](https://help.getjobber.com/hc/en-us/categories/115001328167-Work), [Requests list](https://help.getjobber.com/hc/en-us/articles/39132874167959-Requests-List-Page-and-Key-Metrics) | `requests → quotes → jobs → invoices → payments` tables; convert actions between each stage |
| Request "New" status | Requests list documents a **New** status for requests with no action taken. (same source) | Request statuses `new → converted / archived` |
| Quote: Draft → Awaiting Response | "Sending the quote to your client will change the status from Draft to Awaiting Response." [Quote Basics (mirror)](https://prototype-help-center.pages.dev/hc/en-us/articles/115009378727) | `send` action; only `draft` / `changes_requested` quotes are editable |
| Quote: Changes Requested, hidden from hub | Client change request sets **Changes requested**; the quote is no longer visible in Client Hub. [Quote Approvals (mirror)](https://prototype-help-center.pages.dev/hc/en-us/articles/115012715008) | `request_changes` action; hub shows only `awaiting_response / approved / converted` |
| Quote: Approved with signature | Signature saved on the quote; status becomes **Approved**. (same source) | `approve` stores `signature`, `approved_at` |
| Quote: Archived, not from Draft | Archive is only available once the quote is no longer a Draft. (same source) | `archive` allowed from `awaiting_response / changes_requested / approved` |
| Approved quote → job | Approved quotes can be converted into jobs. *(web-search summary; exact page not pinned. Candidate: [Quote list](https://help.getjobber.com/hc/en-us/articles/39133000691095-Quote-List-Page-and-Key-Metrics))* | `convert` creates a job and copies line items |
| Job "Requires Invoicing" | Finished jobs that are not yet billed show as **requires invoicing**. *(web-search summary; exact page not pinned. Candidates: [Invoices list](https://help.getjobber.com/en/articles/invoices-list-page-and-key-metrics/), [Job Basics (mirror)](https://prototype-help-center.pages.dev/articles/work/jobs/job-basics))* | Derived status `requires_invoicing` = completed with no invoice |
| Invoice statuses | **Draft**, **Awaiting Payment**, **Past Due**, **Paid**, **Bad Debt** (reversible with "Unmark as bad debt"). [Invoices list](https://help.getjobber.com/en/articles/invoices-list-page-and-key-metrics/), [Bad debt](https://help.getjobber.com/es/articles/bad-debt/) | Stored `draft / sent / bad_debt`; display status derived from payments and due date |
| Client Hub | Clients submit requests, view quotes and invoices, and pay invoices if payments are set up. [Client Hub (mirror)](https://prototype-help-center.pages.dev/hc/en-us/articles/1500011237822) | `#/hub/<token>`: submit request, approve / request changes, pay (demo) |

**Reliability note:** rows marked *(mirror)* come from `prototype-help-center.pages.dev`, which we could not confirm as official. Treat those as lower-confidence evidence.

## 3. Our own design decisions (not from Jobber)

These are inferences or choices, not documented Jobber behavior:

- Job display statuses `unscheduled / today / upcoming / late / closed`.
- Partial payments are allowed; overpayment is rejected.
- Default payment terms are 30 days.
- Client Hub payment is a **demo stub** that records an "online" payment. Real use needs a payment processor.
- **No authentication.** The server binds to `127.0.0.1` by default. Anyone with a client's hub link can view and act on that client's quotes and invoices. Add login/SSO before exposing this beyond a single machine.

## 4. Verification

| Check | Result |
|---|---|
| `npm test`: domain rules plus a full API workflow including hub isolation | 11 / 11 pass |
| REA `capture-browser-scenario` ([scenario](../rea-evidence/scenario-e2e.json), [summary](../rea-evidence/e2e-summary.json)) | 23 / 23 steps `completed`: create client → quote with line item → send → approve → convert to job → complete → create invoice → send → API check |
| Post-scenario API check | Invoice #5 `$180.00`, `awaiting_payment`; job #7 `closed` |
| Final screen captured by REA | [e2e-final-invoice.png](../rea-evidence/e2e-final-invoice.png) |

Re-run the REA scenario (requires the app on port 3000 and REA installed):

```bash
rea capture-browser-scenario rea-evidence/scenario-e2e.json --format json > rea-evidence/raw/e2e.json
```
