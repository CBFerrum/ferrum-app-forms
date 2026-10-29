# Changelog

## Unreleased

- Declares where it keeps people's personal data, so Administration → Personal data exports and
  erases it for a person (by email).
- Owner emails and autoresponses no longer need the Mail app: without it they go through the
  server's own mailer.

## 0.1.0

- First release: one engine for forms, surveys and quizzes. Forms hold 21 question types with lengths, bounds, linear-time patterns, defaults and CEL conditional logic over earlier answers (questions and whole pages), checked as a whole on every save with field-level errors; every answer is checked and normalized on the server, hidden questions are not required and their answers are dropped. Respondents use public links or signed-in (Internal) forms through the package's Site, with opening hours, response limits and one response per email or user decided exactly under concurrency, anonymous mode keeping no email, name, user or IP, spam traps (honeypot, minimum fill time, a daily cap), idempotent submits, prefill from links and uploads checked by type and content. Quizzes grade with points, all or nothing, exact passing scores and signed result links, never revealing answers beforehand. Each response can create a record of any installed entity through a field mapping checked against the live schema and the owner's rights; owners are notified in the app and, with the Mail app, by email, and respondents can get a throttled autoresponse. Analytics give per-question distributions, exact NPS, Likert and matrix breakdowns, rankings, completion rate and time, daily trends in the workspace's time zone, paged text answers, CSV exports and three reports.
