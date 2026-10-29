# forms — forms, surveys and quizzes

Package `forms` (depends on `core`). One engine for forms, surveys and quizzes: a **Form** holds
the questions and the rules of responding; each **Form Response** is checked and normalized on
the server against the form; a record can be created from every response; owners get
notifications, analytics, exports and reports.

Times are RFC 3339 UTC with milliseconds (`2026-11-02T09:00:00.000Z`); decimals are strings.
Errors use the usual API shape (`{"error", "message", "fields"?}`): `not_found` (404), `forbidden`
(403), `unauthorized` (401), `invalid` / `validation_failed` (422), `conflict` (409). Answer errors
name the question key as `field`; definition errors point at rows (`"row": ["questions", 3]`).

## Roles

| Role | Can |
|---|---|
| Forms User | create forms, surveys and quizzes; edit, publish, close, duplicate and delete the forms they own; read, review, mark spam, delete and export the responses of those forms (own = created the form, or named as its `owner`; responses follow the form's `owner`) |
| Forms Manager | every form and every response; change a form's `owner`; Forms Settings |

Administrators can do everything. Respondents need no role: anyone with the link answers public
forms, any signed-in user answers Internal forms. Nobody creates, edits or imports responses
through the generic API — not even administrators or automations — so every response was
checked against its form.

## Entities

### Form

| Field | |
|---|---|
| `title`, `description` | shown to respondents |
| `kind` | `Form` \| `Survey` \| `Quiz` (quizzes grade answers) |
| `status` | `Draft` → `Published` → `Closed`, read-only: changed by the actions; a form also closes when its `closes_at` passes (maintenance) or its `response_limit` is reached |
| `slug` | the address (`/f/<slug>`): lower-case letters, digits, hyphens, at most 80; unique; derived from the title when empty (`my-survey`, `my-survey-2`, …) |
| `owner` | email of the owning user (default: the creator). Only Forms Managers change it, and only to an active user; the form's responses follow |
| `questions` | rows of **Form Question** (below) |
| `access` | `Public` (anyone with the link) \| `Internal` (signed-in users only) |
| `anonymous` | keep no respondent email, name, user id or IP hash (responses are written by the engine, so neither `created_by`, the audit trail nor events name the respondent) |
| `opens_at`, `closes_at` | the window responses are accepted in |
| `response_limit` | the form closes after this many responses (spam excluded); exact under concurrency |
| `one_response_per` | `Email`: one response per respondent email (the signed-in user's, or the answer to `email_question`); `User`: one per signed-in user (Internal forms). On anonymous forms only `User` is allowed: the form keeps *that* someone took part, never which response is theirs. Turning it on claims the respondents who already answered |
| `email_question` | key of a required, always-shown email question naming the respondent (one response per email, autoresponse) |
| `min_fill_seconds` | responses sent sooner after the form was opened are kept as spam (default 3; 0 = off) |
| `confirmation_message`, `redirect_url` (http/https), `closed_message` | what respondents see |
| `notify_on_response`, `notify_users` | tell the owner and the listed users (child rows `{email}`, active users) about each response: in the app, and by email when the Mail app is installed. Users who may not read the response are skipped |
| `autoresponder`, `autoresponder_subject`, `autoresponder_message` | email the respondent (the `email_question` answer) a fixed plain-text message; needs the Mail app; at most one per address and form a day; never for spam or anonymous forms |
| `accent_color` (hex), `logo` | look: the logo is an https URL or a public image `/files/public/<id>` (upload with `POST /api/files`, `public=true`, attached to the form) |
| `passing_score` | quizzes: % of the points needed to pass (exact: `score × 100 ≥ passing × maximum`) |
| `reveal_answers` | quizzes: show the correct answers in the result after submitting |
| `target_entity`, `field_map` | create a record of this entity from each response (below) |
| `published_at` | read-only |

Saving checks the whole definition and returns every problem at once: keys unique and well
formed, options present and distinct where the type needs them, bounds and lengths consistent,
patterns valid, defaults and correct answers valid answers, conditions compiling and reading only
earlier questions, settings agreeing (e.g. `one_response_per: User` needs `access: Internal`;
anonymous forms take no `email_question`), recipients active users, the logo a public image, the
mapping valid. Publishing also needs one answerable question (quizzes: one correct answer). Once
a question has answers its type cannot change (add a new question instead). A form with responses
cannot be deleted — close it, or delete its responses first.

### Form Question (`questions` rows)

| Field | Used by |
|---|---|
| `key` | identifier of the answer (`[a-z][a-z0-9_]{0,39}`), derived from the label when empty |
| `label`, `help_text` | all (page breaks: page title; statements: the text) |
| `question_type` | one of the types below |
| `required` | answerable types; hidden questions are never required |
| `options` | list of texts: choices (`select`, `dropdown`, `multi_select`, `ranking`), scale labels (`likert`; default *Strongly disagree … Strongly agree*), columns (`matrix`). One entry per line is accepted and stored as a list |
| `matrix_rows` | `matrix` statements |
| `allow_other` | `select`, `dropdown`, `multi_select`: accept one free-text answer besides the options |
| `min_value`, `max_value` | `number`/`decimal`/`date` (YYYY-MM-DD)/`time` (HH:MM)/`datetime` bounds; `multi_select` fewest/most selections; `rating` `max_value` = scale 3–10 (default 5); `file` `max_value` = most files 1–10 (default 1) |
| `min_length`, `max_length` | `short_text` (default 500, at most 2000), `long_text` (default 10000, at most 50000), in characters |
| `pattern`, `pattern_message` | `short_text`/`long_text`: a regular expression the whole answer must match — the linear-time `regex` engine (no look-around, no back-references), compiled size capped |
| `default_value` | pre-filled answer (must be a valid answer) |
| `visible_if` | CEL condition, below. On a `page_break` it shows or skips the whole page |
| `allow_prefill` | links may fill the answer: `?<key>=value` (`multi_select`: comma-separated) |
| `accept`, `max_file_mb` | `file`: extensions from pdf, png, jpg, jpeg, gif, webp, txt, csv, docx, xlsx, pptx, odt, ods, doc, xls, ppt, zip (default: all but zip); largest file 1–20 MB (default 10) |
| `points`, `correct_answer` | quizzes: the correct answer written like a response (`short_text`: a text or a list of accepted texts, compared case-insensitively with single spaces) and its points (default 1). Gradable: short_text, number, decimal, date, select, dropdown, multi_select (all or nothing), checkbox, likert, ranking (exact order). Never sent to respondents |

#### Question types and answers

| `question_type` | Send | Stored |
|---|---|---|
| `short_text` | text (one line) | trimmed |
| `long_text` | text | trimmed, line breaks as `\n` |
| `email` | address | lower-case |
| `phone` | `+`, digits, spaces, `()-./` | as sent, trimmed |
| `number` | whole number (or its text) | number |
| `decimal` | number or text (`"1,250.50"`) | decimal string (`"1250.5"`) |
| `date` | `YYYY-MM-DD` | same |
| `time` | `HH:MM` or `HH:MM:SS` | `HH:MM` (seconds kept when not 0) |
| `datetime` | RFC 3339 with an offset, or a local `YYYY-MM-DDTHH:MM[:SS]` read in the workspace's time zone — a time the clocks skip is refused, a repeated hour is the earlier one | UTC instant |
| `select`, `dropdown`, `likert` | one option (or the other text) | the option |
| `multi_select` | list of options (+ one other text) | in option order, other last |
| `checkbox` | `true`/`false` (`"yes"`, `1`, …); required = must be checked | boolean |
| `rating` | 1 to the scale | number |
| `nps` | 0 to 10 | number |
| `matrix` | `{row: column}`; required = every row | same |
| `ranking` | every option once, in order | list |
| `file` | `[{file_name, content_base64}]` (a `data:` URL works too); type from the extension and confirmed by the content | `[{id, file_name, content_type, size, url}]` — the files are attached to the response and download through `/files/{id}` for whoever may read it |
| `page_break`, `statement` | nothing | nothing |

#### Conditional logic

`visible_if` is CEL over `answers` (question key → normalized answer, `null` when unanswered or
hidden; numbers as numbers, `multi_select`/`ranking` as lists, `matrix` as a map, `file` as the
list of file names), `today` (YYYY-MM-DD) and `now` in the workspace's time zone. Examples:
`answers.country == 'IN' && answers.age >= 18`, `'Other' in answers.sources`,
`answers.grid['Speed'] == 'Bad'`, `answers.budget > 1000.0`. A condition may read only questions
before it (so evaluation order is fixed and loops are impossible), uses at most two loops
(`all`, `exists`, `exists_one`, `map`, `filter`), never one inside another, and is at most 1000
characters. A failing evaluation (comparing an unanswered question) counts as false. The server
evaluates every condition again; hidden questions are not required and their answers are dropped.

### Form Field Mapping (`field_map` rows)

`{target_field, question | value}`: the answer to `question`, or the fixed `value`, fills
`target_field` of `target_entity`. Checked against the live schema on every save: the entity is
installed and is a master or document (not Form/Form Response); the field exists and is writable
(not read-only, computed, a table or a secret); the saving user may create that entity, write that
field and read records named by fixed links; every required field without a default is mapped;
fixed values are valid for their field; the answer type fits:

| Target field | Questions |
|---|---|
| data / text / markdown / code | any but matrix and file (data: no long text) — choices joined with `, `, rankings with ` > `, checkboxes as Yes/No |
| email / phone / url | email / phone / short_text |
| int | number, rating, nps |
| decimal / currency / percent | number, decimal, rating, nps |
| date / datetime / check | date / datetime / checkbox |
| select | select, dropdown or likert whose options are all options of the field (no other answers) |
| attach | file (the first file) |
| json | any |
| link | fixed values only |

After the response commits, the record is created once with the engine's context, setting only
the mapped fields that have a value (the kernel normalizes and validates them like any input).
`record_entity` / `record_id` link it from the response; a refusal is kept in `record_error`.

### Form Notification Recipient (`notify_users` rows)

`{email}` of an active workspace user.

### Form Response

| Field | |
|---|---|
| `number` | `RESP-<year>-<seq>` |
| `form`, `form_title` | the form (title kept current) |
| `status` | `New` → `Reviewed`; `Spam` (read-only: the actions change it) |
| `source` | `Public Link` \| `Signed In` \| `Manual Entry` |
| `submitted_at`, `completion_seconds` | when, and seconds from opening the form to sending it |
| `respondent_email`, `respondent_name`, `respondent_user` | the signed-in user (or, for public forms, the `email_question` answer); empty on anonymous forms |
| `answers` | key → normalized answer; hidden and unanswered questions are absent |
| `score`, `max_score`, `quiz_result` (`Passed`/`Failed`) | quizzes (hidden questions do not count) |
| `ip_hash` | HMAC-SHA256 of the sender's IP under the workspace's key (128 bits, hex): equal addresses match, none is stored; empty on anonymous forms |
| `spam_reason` | why it was kept as spam |
| `record_entity`, `record_id`, `record_error` | the record created from it |

Spam (a filled honeypot, or sent faster than `min_fill_seconds`) is stored for review with
`status: Spam` and gets the same answer as any response; it is not counted against the limit or
in analytics, claims nothing, notifies nobody, creates no record and keeps no uploaded files. At
most 500 spam responses per form and day are kept; beyond that they are dropped unseen.

### Forms Settings

`spam_retention_days` (default 30): spam older than this is deleted.

## Actions

| Entity | Action | Params → result |
|---|---|---|
| Form | `publish` (Draft or Closed) | → `{status, slug}`; refused with field errors when the definition is not ready |
| Form | `close` (Published) | → `{status}` |
| Form | `duplicate` (create permission) | → `{entity, id, slug}`: a Draft copy "… (copy)" owned by the caller |
| Form | `record_response` (Published) | `{answers: {key: answer}, respondent_email?, respondent_name?}` → `{entity, id, number}`. Enter a response by hand (phone, paper, AI agents): the same checks, limits and duplicate rules, without the opening hours and spam traps; the audit trail names the person who entered it |
| Form Response | `mark_reviewed` (New) | → `{status}` |
| Form Response | `mark_spam` | → `{status}`; frees the respondent's one-response claim |
| Form Response | `not_spam` (Spam) | → `{status}`; the record and notifications it missed follow |
| Form Response | `create_record` (no record yet) | → `{entity, id}`, or 422 with the target's reason |

Run them with `POST /api/v1/{Entity}/{id}/actions/{action}` (or MCP).

## Respondent endpoints

Public: `/api/site/{tenant}/forms/...` (tenant = workspace slug). Signed in:
`/api/app/forms/...` (Bearer auth) — the same routes; Internal forms answer only there, and the
signed-in user is the respondent (unless the form is anonymous). Draft forms, Internal forms asked
for publicly and unknown slugs all answer 404. Responses carry `Cache-Control: no-store`.

### `GET /f/{slug}`

Query: `?<key>=value` for questions that allow prefill. →
`{form: {slug, title, description, kind, access, anonymous, closes_at, theme: {accent_color, logo},
questions: [Question]}, token, prefill: {key: answer}}`. **Question**: `{key, type, label,
required, help_text?, options? | columns? (matrix), rows?, allow_other?, scale? (rating, nps),
min_length?, max_length?, pattern?, pattern_message?, min?, max?, accept?, max_file_mb?,
max_files?, default?, visible_if?, allow_prefill?}` — never points, correct answers, the passing
score, owners, recipients or mappings. `token` is the form session (valid 24 hours). Invalid
prefill values are ignored. Errors: 404; 409 (not open yet, closed, full — `message` is the
form's `closed_message` when set). Each call counts a view (for the completion rate).

### `POST /f/{slug}/responses`

Body: `{token, answers: {key: answer}, honeypot?}` (at most 256 KB; 28 MB on forms with file
questions). `honeypot` is the value of a hidden input the page renders: real people leave it empty.
→ `201 {status: "received", message, redirect_url, replayed: false, number, result?, result_token?}`
(`result`/`result_token` for quizzes, below). Sending the same `token` again — a retry, a double
click, even at the same moment — returns the first response's receipt with `200` and
`replayed: true`. Errors: 422 `validation_failed` with one entry per wrong answer (`field` = the
key; also `token` when it is missing, forged — reload the form — or older than 24 hours, and
`answers`); 422 `invalid` (body); 409 (closed, full — the form's `closed_message` — or already
answered by this email/user); 401 (`one_response_per: User` without signing in); 404.

### `GET /results/{result_token}`

A quiz response's result, for 30 days: `{form: {title, slug}, number, result}`. **Result**:
`{score, max_score, percent, passed (null without a passing score), questions: [{key, label,
points, earned, correct, correct_answer? (when the form reveals answers)}]}`. Unknown, forged or
expired tokens: 404.

## Owner endpoints — `/api/app/forms/forms/{form id}/...`

Signed in; the caller must be able to read the form (404 otherwise) and its responses (403). Every
number covers the responses the caller may read; spam never counts. `from` / `to` (YYYY-MM-DD,
workspace dates, both optional) limit the period.

| Method & path | → |
|---|---|
| `GET /summary?from=&to=` | `{form, from, to, responses, spam, views, completion_rate (responses per view, %), completion_time: {average_seconds, median_seconds}, quiz (quizzes: {graded, average_score, average_percent, passed, failed, pass_rate}), trend: [{date, responses}] (the period, or the last 30 days; at most 400), questions: [Summary]}` |
| `GET /answers/{key}?limit=&cursor=` | one question's answers, newest first: `{question: {key, label, type}, answers: [{response, number, submitted_at, text, answer}], next_cursor}`; `limit` 1–200 (default 50) |
| `GET /export.csv?from=&to=&status=` | needs export permission. CSV (UTF-8 with BOM, RFC 4180): `number, submitted_at, status, source, respondent_email, respondent_name` (not on anonymous forms)`, completion_seconds, score, max_score, quiz_result` (quizzes), then one column per question key — matrix rows as `key[row]`, choices joined with `, `, rankings with ` > `, files as `name url`. Cells a spreadsheet would run as formulas get a leading `'`. `status` = New \| Reviewed \| Spam (default: all but spam). At most 100 000 rows (`X-Ferrum-Truncated` says when cut) |

**Summary** per question: `{key, label, type, answered, skipped}` and, by type — choices
`options: [{option, count, percent}]`, `other` when allowed, Likert `average` (scale position
1…n); `multi_select` percentages of those who answered; checkbox `yes`, `no`; rating and NPS
`distribution: [{value, count, percent}]`, `average`, NPS `promoters` (9–10), `passives` (7–8),
`detractors` (0–6) and `nps` = % promoters − % detractors, computed from the counts; numbers `sum`,
`min`, `max`, `average`; matrix `rows: [{row, answered, columns: [{column, count, percent}]}]`;
ranking `items: [{item, average_rank, first_place}]` best first; file `files`. Percentages and
averages are exact decimals rounded half away from zero to 2 places.

## Reports

| Report | Entity read | Params | Rows |
|---|---|---|---|
| `forms_overview` | Form | `from_date`, `to_date` | per form: responses, spam, views, completion %, average seconds, last response |
| `form_question_summary` | Form Response | `form` (required), `from_date`, `to_date` | each question (answered) then its options, values, statistics (NPS, averages) |
| `form_response_trend` | Form Response | `form` (required), `from_date`, `to_date` (default: last 30 days) | responses per workspace day |

## After a response

When a response commits, an outbox sink (at least once, idempotent: claimed in the same
transaction) creates its record, sends the in-app notifications and queues the emails: one
`Communication` (Mail app) to the owner and recipients with the answers (escaped), and the
autoresponse. Spam gets none of it until marked `not_spam`. Mail delivery, retries and threading
are the Mail app's; a mail the Mail app refuses is logged and does not undo the response.

## Background work

Every minute (`maintenance`, one replica at a time), per workspace with Forms: mark Published
forms past `closes_at` Closed (500 per round), delete spam older than `spam_retention_days` (200
per round), forget autoresponse limits older than two days. Each step is idempotent; a failing
workspace or step does not stop the others.

## Storage outside entities

`forms_secret` (the workspace's key for session and result tokens and keyed hashes),
`forms_claim` (one-response claims), `forms_view` (views per form and day),
`forms_autoresponse` (autoresponse limits), all under row-level tenant isolation.
