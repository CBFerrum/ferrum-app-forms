# Ferrum Forms and Surveys

A native app for [Ferrum](https://github.com/CBFerrum/Ferrum), the open-source, AI-first ERP.

- One engine for forms, surveys and quizzes: 21 question types (text, email, phone, number, decimal, date, time, date-time, choices, checkboxes, ratings, NPS, Likert, matrix, ranking, file uploads, page breaks, statements) with lengths, bounds, linear-time patterns and defaults
- Conditional logic in CEL over the earlier answers, for questions and whole pages; hidden questions are never required and their answers are dropped
- Every answer checked and normalized on the server; the whole definition checked on save with field-level errors
- Public links and signed-in (internal) forms, opening hours, response limits and one response per email or per user — exact under concurrency — with anonymous mode that keeps no email, name, user or IP address
- Spam traps (honeypot, minimum fill time), idempotent submits, prefill from links, uploads checked by type and content
- A record created from each response through a field mapping checked against the live schema (a Lead, a Ticket, a Customer, any entity)
- Quizzes with points, all-or-nothing marking, exact passing scores and result links; correct answers never reach respondents before they submit
- Owner notifications in the app and by email (through the Mail app, or the server's mailer without it); a throttled autoresponse to the respondent
- Analytics: per-question distributions, exact NPS, Likert and matrix breakdowns, rankings, completion rate and time, daily trends in the workspace's time zone, paged text answers and CSV exports; three reports
- `packages/forms/README.md` documents every entity, action, endpoint, setting and background job

## Install

Workspace administrators install it from **Apps** in Ferrum; it ships in the official Ferrum
server image. Self-hosters building their own image enable the `forms` feature of the server.
Everything it adds is also available to AI agents over Ferrum's MCP server.

## Develop

Clone it next to the platform and point the platform dependencies at your checkout (this file
is git-ignored):

```toml
# .cargo/config.toml
[patch."https://github.com/CBFerrum/Ferrum"]
ferrum-kernel = { path = "../ferrum/crates/kernel" }
ferrum-meta = { path = "../ferrum/crates/meta" }
ferrum-domain = { path = "../ferrum/crates/domain" }
```

The integration test installs the Mail app too; to test against a local checkout of it, add
`[patch."https://github.com/CBFerrum/ferrum-app-comms"] ferrum-app-comms = { path = "../ferrum-app-comms" }`.

The tests need PostgreSQL with an ordinary (non-superuser) role — row-level security must apply:

```bash
createuser ferrum --pwprompt && createdb -O ferrum ferrum_forms_test
```

```bash
cargo test
```

`FERRUM_FORMS_TEST_DATABASE_URL` overrides the database URL. The app's metadata lives in `packages/` and is embedded
at build time; `app.yaml` is its manifest (see Ferrum's `docs/plan/apps.md`).

## License

AGPL-3.0-only, like the platform.
