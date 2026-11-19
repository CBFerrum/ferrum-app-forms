# Changelog

## 0.8.0

Needs the same platform as 0.7.0. Database change: the `FormTemplate` entity (seeded with four templates). Interface
changed; `ui/dist` rebuilt, carrying 0.6.1 to 0.8.0.

**Templates are records.** The starting points of a new form were written into the interface: nobody could add one,
and an agent could not list or use them. They are now Form Template records, which anyone building forms may read
and a Forms Manager keeps; Use This Template makes a Draft form from one, owned by whoever asks.

## 0.7.0

Needs Ferrum with S4's Brand and Embedding (0.4.x at `b029f83a` or later). Database change: `Form.brand`. Interface
source changed; `ui/dist` is rebuilt with 0.8.0.

- **A form wears the workspace's brand.** A form may name a Brand: its page links the brand's stylesheet (colours and
  typeface) and shows its logo unless the form has its own; the form's own colour, when set, goes over the brand's,
  nudged by the platform's own contrast rule (the page's copy of it is gone).
- **Other sites may show a form.** Allow Embedding (a published public form) names the sites that may show the form
  in a frame, kept in the workspace's Embedding for the form's own page only; the sites follow the form to a new
  address and go with it. The Share tab has the sites box and the code to paste.

## 0.6.3

Needs the same platform as 0.6.2. No database change, interface unchanged.

**Every action says what it promises.** The nine actions a person can press carry a contract (what they do, what they
give back, what "done" means, which action undoes them), so agents, processes and the builder read them as people do.
Enter a Response declares its parameters; the gate passes its answers as JSON text.

## 0.6.2

Needs the same platform as 0.6.1. No database change. Interface source changed; `ui/dist` is rebuilt with 0.8.0
(with 0.6.1's screens).

- **Someone from outside the workspace is the public.** A person signed in to the workspace's portal (an account
  anyone may make) was taken for one of its people: an Internal form opened for them, and their responses skipped the
  proof of work and the hourly limit per address. Now they are the public to Forms: Internal forms are not theirs,
  and their responses pass every public check and keep no user.
- **The page sends what the link gave it.** The respondent's page sent only the answers: the link's hidden values
  (campaign marks, a record id) and a signed prefill link's values never reached the response, and a form asking for
  proof of work refused every response because the page never did the work. Now the page sends the hidden values, the
  prefill link's token and the work (done in the page, as the server checks it).

## 0.6.1

Needs the same platform as 0.6.0. No database change. Interface source changed (wording, the day shown for an anonymous form's responses); `ui/dist` is rebuilt with 0.6.2.

**An anonymous form keeps nothing that singles its respondent out.** Its responses kept the session they were sent
from, the exact moment and the seconds taken, and the values its link passed; its owner could also send per-person
links. Now a response to an anonymous form keeps no session (a repeated send is told apart by a claim that names no
response), no time taken, no link values and only the day it came; an anonymous form refuses hidden fields, answers
filled by a link and signed prefill links; nobody is notified per response; the results and the CSV show and export
the day only, never the moment. What the platform stamps on every record (its creation time, its audit entry and its
event) stays exact and is said in the README.

## 0.6.0

Needs Ferrum 0.4.0 (apps' upkeep runs one workspace at a time, on whichever replica is free). No database or interface change.

**Upkeep is one workspace's.** `maintenance(k, tenant)` closes forms past their closing time, deletes old spam and forgets old throttles in the one workspace the platform hands it; the list of workspaces and the installation check are the platform's.

## 0.5.3

Needs the same platform as 0.5.2. No database change, interface unchanged.

- **Only a response can be large.** Every route accepted a body of up to 28 MB, so each public request made the server
  read that much. Now every route takes at most 256 KB, except `POST /f/{slug}/responses`, which keeps 28 MB because a
  form with file questions sends its files in the body (the form is only known after the body is read; a form without
  files still refuses more than 256 KB).

## 0.5.2

Needs the same platform as 0.5.1. Interface unchanged. Database change: the package's SQL is one file, `001_forms.sql`
(`forms_rate` is made with Forms' other tables; no more `002_rate.sql`). No installation was ever made from it: a
development database that applied the old files needs resetting. The suites run on today's platform, ERP and Comms.

- **A response without the robot check's answer is always refused.** A form that asks the browser for proof of work
  took a response that sent none whenever the session's token alone happened to hash low enough: one time in 256 at
  the lowest setting, one in 262,144 at the default. No answer is now no work.

## 0.5.1

Needs the same platform as 0.5.0. No database change. Interface only, `ui/dist` rebuilt with Ferrum-Frontend `06bd1a2`.

- When a form opens ("It opens on …", on the page of a form not open yet) and until when it is open ("Open until …")
  are written on the workspace's clock, its zone named when the browser's is another; they were the browser's, so near
  midnight the day could be another. A form's settings take its opening and closing times on the same clock and name
  the zone they are in (they said "your time zone", the browser's).
- A day in a message or under the responses chart is written as the platform writes a day, in the chosen language's
  format.
- The two routes to the screens apps no longer have (`apps/:app/settings`, `x/:app/:page`) are gone; nothing linked to
  them. The page starts through the frontend's `mountApp`; the interface lint has no baseline file any more.

## 0.5.0

Needs the same platform as 0.4.0. No interface change. The package's SQL reads as its final schema: `forms_secret` and
`003_old_key.sql` are gone, and `forms_rate` enforces row-level security like Forms' other tables. No installation was
ever made from them, so a database is made afresh.

**One way to sign and check sessions, result links and prefill links.** Before the vault, one key per workspace did all
of it, unsealed in `forms_secret`; 0.4.0 kept it to check what it had signed, moved into the vault as `old-signing-key`
at the first check or by upkeep (under its row's lock, taken without waiting and retried), for a year and a day. No such
key ever signed anything someone outside holds, so it goes with its table, its move, its expiry and its upkeep step. A
session and a result link name the version of Forms' key in four bytes before the MAC (60 bytes), a prefill link as
`{body}.v{n}.{mac}`; one that names none (a 56-byte session or result link, a prefill link of two parts) is refused like
any other malformed one.

**`forms_rate` enforces row-level security.** The hourly count of responses per address (0.3.0) was the one table of
Forms' without it, which the platform's doctor reports as a blocker (`isolation.row_security`). Forms' own queries always
named the workspace, so nothing was read across workspaces through them.

Tests: the end-to-end suite checks first that every table of Forms' enforces row-level security, refuses a session, a
result link and a prefill link without their version, makes a new version of Forms' key (what the version before signed
still works, what is signed after names version 2), and keeps the sandbox check (the live workspace's result link does
not open the copy). The checks of the old key went with it.

## 0.4.0

Needs a platform with the vault (Ferrum `8e6b1f0` or later). A database change (`forms/003_old_key.sql`: the column
`forms_secret.retired_at`) is applied at startup; nothing existing moves. No interface change.

**What Forms signs, it signs with keys from the vault.** A form's session, a quiz-result link and a signed prefill link
were signed, and senders' addresses hashed, with one key per workspace kept unsealed in `forms_secret`: whoever could
read the database, or a dump of it, could forge prefill links (with hidden values a form trusts), result links and
sessions. Each is now signed with a key derived from Forms' own key in the vault for its purpose (`form-sessions`,
`result-links`, `prefill-links`; the hashes with `address-hashes`), made when needed and kept nowhere. What is signed
names the version of Forms' key it came from: a session and a result link carry it in four more bytes (60 instead of
56), a prefill link as `{body}.v1.{mac}`. A new version of the key (`ferrum task vault_rotate level:owner … owner:forms`)
leaves what was signed before working until it expires.

**What was signed before keeps working.** A session lives a day, a result link 30 days, a prefill link up to a year. The
old key moves into the vault, sealed, as Forms' secret `old-signing-key`, and checks what it signed until a year and a
day after it stopped signing (`forms_secret.retired_at`; the day covers replicas of the previous build still signing with
it while an upgrade rolls out, or after a rollback), and nothing after. It moves the first time something it signed is
checked, or at Forms' next upkeep, a minute after the first start at most: once, even with replicas starting together
(its row is locked without waiting; a replica that finds it locked waits without holding a connection). From then on
this build never reads `forms_secret`. The build before still does, so its rows stay until the release after this one
deletes them. The keyed hashes have no old form: the hourly count of responses per address and the daily limit of
autoresponses per address start again once, at the upgrade.

**When the vault is closed** (an installation with nothing to open its root with), opening a form, sending a response,
opening a result link and making a prefill link are refused with "Forms cannot sign or check its links right now: its
keys are unavailable". Nothing is signed another way.

**A sandbox** never takes the old key, and its own keys are not the live workspace's: no session, result link or prefill
link of the live workspace opens the copy.

**A workspace moved to another installation**: the platform's move copies the workspace's tables, not its keys in the
vault, so sessions, result links and prefill links made before the move do not work after it. The old key travels in
`forms_secret`, keeps its moment, and moves into the new installation's vault.

**For other apps' tests**: Forms takes its vault handle as it registers, so register it as the server does,
`hooks.app("forms", &[], ferrum_app_forms::register)`; called outside that, the kernel refuses to boot. The suite
registers ERP and Mail the same way.

Tests: the end-to-end suite opens the vault as a server does. It honours a prefill link, a session and a result link the
previous build made with its key in `forms_secret` (eight opened at once move the key once), signs and checks with that
table out of reach (nothing new matches the old key), refuses the old key's links past its time, never moves the old
key in a sandbox, lets upkeep move what is left, and refuses plainly on a replica whose vault is closed.

Not in this release: the rows of `forms_secret` (the release after this one); links that survive a move to another
installation (the platform's move would have to carry the workspace's keys in the vault).

## 0.3.0

Closes the documents audit's tier-1 rows DC-1, DC-17 and DC-25 for Forms (DC-11, embedding, is not done: see the
README's platform note).

* **Hidden fields**: Form `hidden_fields` (keys a link may pass), Form Response `hidden`, the public definition's
  `hidden`, the submit body's `hidden`; mappable in the field mapping (text, choice, link by id); erased with the
  respondent's personal data.
* **Signed prefill**: the Form action `prefill_link` (`values`, `days`), the definition's `?prefill=` and the submit
  body's `prefill_token`.
* **Abuse protection**: Forms Settings `responses_per_hour` (30) and `proof_of_work_bits` (18); Form `proof_of_work`
  and `extra_check`; the table `forms_rate` (`sql/002_rate.sql`), cleared by upkeep after two hours; the trait
  `guard::Check` and `guard::register`.
* Finding or making a record and linking another to it is configuration (an automation on Form Response), tested.
* The mapping unit test builds an entity with the platform's `document_approvals`.

## 0.2.18

Rebuilt with Ferrum-Frontend 9e7190c, the design system as tuned after the landed build was reviewed. The left menu's icons are chosen so that none repeats on more than three rows and each fits its row; their drawings load beside the first page instead of inside it, so the page starts lighter; a row that scrolls sideways fades at the edge where there is more, in every browser and with reduced motion; a printed record leaves out empty fields and keeps its totals with the table; menus and popovers sit inside the page's landmarks for assistive technology; a selection bar folds what does not fit into More on a narrow screen. Nothing else changes.

## 0.2.17

The interface follows the upgraded design system, rebuilt with Ferrum-Frontend 76c4fad. Text uses the kit's type roles (nothing under 12px) and controls its height tokens; loading shows skeletons shaped like what is coming; empty, no matches, denied, offline and failed are told apart; status colours come from stored state ids. The interface check now runs the UI lint against an empty baseline. The builder shows the kit's save status; filter pills have their own class. The results figures use the kit's Stat, and two words that were fixed in English are now translated.

## 0.2.16

The reports it defines in code (their titles and parameters) have names in Arabic and Hindi too, with its models' and manifest's (196 each in ui/src/locales/names). Translated by the model, to be reviewed by native speakers.

## 0.2.15

Rebuilt with Ferrum-Frontend 43d7779: the names of its models, fields and manifest in Arabic and Hindi (193 each in ui/src/locales/names, which the platform serves to every page of the workspace, so a record's labels, the launcher and the bar read in the person's language), and the sentences its pages still showed in English (split around a link or a figure, built in code from a template or word by word) whole and translated (591 words each in ui/src/locales). Translated by the model, to be reviewed by native speakers.

## 0.2.14

Rebuilt with Ferrum-Frontend 046a3a2: the sentences its pages built in code (counts, dates, what a toast or a screen reader says) go through t() too, as whole sentences where code chose a word, and carry built-in Arabic and Hindi (491 words each in ui/src/locales, translated by the model and to be reviewed by native speakers).

## 0.2.13

The assistant knows what its records mean in its pages (contributes.shell.assistant): their states, what counts and where figures come from, with questions it suggests asking there.

## 0.2.12

Rebuilt with Ferrum-Frontend 389b2af: its own words carry built-in Arabic and Hindi (445 words each, ui/src/locales, translated by the model and to be reviewed by native speakers), fetched for the page's language only. The labels it keeps in objects, its dialogs, its page titles and the words it keeps in variables go through t() as well, and the names and sizes it shows as they are keep their order right to left. Its pages are drawn once their words are in, and its entry carries only the parts of the kit it uses.

## 0.2.11

Rebuilt with Ferrum-Frontend 1f5981d: an action's link, code or token shown once is kept in a dialog to copy, and on a page that reads right to left, English left untranslated keeps its own order. Its own words go through the kit's t() (362 places), so a workspace's own words for its language reach them, and Admin, Interface words lists them under it (dist/words.json).

## 0.2.10

Rebuilt with Ferrum-Frontend 8a1c2e7: a workspace's own words for its interface (Admin, Interface words) reach its pages as they load; an attachment field that holds a picture shows it; and a value another record already has is said so, where the form said the record had been changed by someone else. Its own screens' margins, paddings, borders, alignment and insets go by the line's start and end, so they mirror right to left as the kit's do; what it places by coordinates (boards, timelines, charts, handles) stays as it was.

## 0.2.9

Rebuilt with Ferrum-Frontend 9d80f4f: right to left, its pages mirror as they read (icons that point along the line, margins and alignment by the line's start and end, arrow keys along it), and the records pages' words are in Arabic and Hindi.

## 0.2.8

Rebuilt with Ferrum-Frontend 204b713: a new record's box whose default is 1 shows ticked, as it is saved.

## 0.2.7

Rebuilt with Ferrum-Frontend 6cfda39: an action's dialog says every refusal, the errors on what the action made (another record's rows) among them, and an action with parameters and a confirmation asks once.

## 0.2.6

Rebuilt with Ferrum-Frontend b39fffb: its pages show times on a person's own clock when they chose one on their Account page, while today and due dates stay on the workspace's day.

## 0.2.5

Responses' and share links' times are on the workspace's clock; a public form keeps the respondent's own. Rebuilt with Ferrum-Frontend d350579, so its records' pages show times on the workspace's clock too, a draft numbered on submit is headed as a draft, and a record of an app that is not installed says so.

## 0.2.4

Rebuilt with Ferrum-Frontend 20d08e5: a record page reads an empty number or check as the server does, so an action whose condition needs one shows, and a workspace's settings open as their one record.

## 0.2.3

Rebuilt with Ferrum-Frontend ae13c69: in a workflow state that names what may change, the other fields show read-only, and the fields the state needs show required.

## 0.2.2

Rebuilt with Ferrum-Frontend daeadda: after an action runs, a record page shows what the action said it did rather than only that it is done.

## 0.2.1

Rebuilt with Ferrum-Frontend 89b7cc7: a field's label names its control for assistive technology, and a record whose title is a link shows that record's title, not its id.

## 0.2.0

- **A page for the people who answer.** A form's link now opens a page anyone can fill in, with no
  sign-in: page by page (page breaks end a page) or one question at a time, with a progress bar,
  Back and Next, and a Send that is safe to press twice. Questions appear and go away as the
  answers before them say; mistakes are explained under the question, in plain words; what was
  typed is kept in the tab if the page reloads or runs out; files can be attached; quizzes show
  their result and a link to come back to it. A closed form, a full one, one that is not open yet,
  and a link that leads nowhere each say so. It works at 375 pixels and with a keyboard, and it
  wears the form's colour and logo. Forms for the workspace's own people open at the same link
  once the person has signed in.
- **A builder instead of a grid of cells.** Add questions from a list of the 21 types, open one to
  write it, and move it by dragging, with Alt and the arrow keys, or from its menu. Options are
  written one per line. "Show only if…" takes rules (a question, what to compare, a value) and any
  other condition as CEL. Each card says what is wrong with it before the server does, and what
  the server refuses lands on the card or the setting it is about. Preview the form as a phone or a
  computer sees it, publish, close, reopen and copy it from the same page, and start a new one from
  a contact form, a registration, a feedback survey or a quiz.
- **Settings, in one place.** Who can answer and how often, when it opens and closes, the
  thank-you message and where people go next, who is told, the email to respondents, the colour
  and logo, a quiz's pass mark, and the record each response creates.
- **Results.** The numbers for a chosen period (responses, how many finished, how long it took),
  a chart for each question (bars for choices, columns for ratings, a score for NPS, a table for
  grids, the words people wrote), and every response to read, with review, spam and "make the
  record" in a panel that moves from one response to the next. Export keeps the period and the
  filter. Share the form from its page: the link, copy, and a link that fills in an answer.
- A form can now go **page by page or one question at a time** (a new setting, "layout").
- Declares where it keeps people's personal data, so Administration → Personal data exports and
  erases it for a person (by email).
- Owner emails and autoresponses no longer need the Mail app: without it they go through the
  server's own mailer.

## 0.1.0

- First release: one engine for forms, surveys and quizzes. Forms hold 21 question types with lengths, bounds, linear-time patterns, defaults and CEL conditional logic over earlier answers (questions and whole pages), checked as a whole on every save with field-level errors; every answer is checked and normalized on the server, hidden questions are not required and their answers are dropped. Respondents use public links or signed-in (Internal) forms through the package's Site, with opening hours, response limits and one response per email or user decided exactly under concurrency, anonymous mode keeping no email, name, user or IP, spam traps (honeypot, minimum fill time, a daily cap), idempotent submits, prefill from links and uploads checked by type and content. Quizzes grade with points, all or nothing, exact passing scores and signed result links, never revealing answers beforehand. Each response can create a record of any installed entity through a field mapping checked against the live schema and the owner's rights; owners are notified in the app and, with the Mail app, by email, and respondents can get a throttled autoresponse. Analytics give per-question distributions, exact NPS, Likert and matrix breakdowns, rankings, completion rate and time, daily trends in the workspace's time zone, paged text answers, CSV exports and three reports.
