# Changelog

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

Rebuilt with Ferrum-Frontend 45dad7f, the design system as tuned after the landed build was reviewed. The left menu's icons are chosen so that none repeats on more than three rows and each fits its row; their drawings load beside the first page instead of inside it, so the page starts lighter; a row that scrolls sideways fades at the edge where there is more, in every browser and with reduced motion; a printed record leaves out empty fields and keeps its totals with the table; menus and popovers sit inside the page's landmarks for assistive technology; a selection bar folds what does not fit into More on a narrow screen. Nothing else changes.

## 0.2.17

The interface follows the upgraded design system, rebuilt with Ferrum-Frontend 0a47157. Text uses the kit's type roles (nothing under 12px) and controls its height tokens; loading shows skeletons shaped like what is coming; empty, no matches, denied, offline and failed are told apart; status colours come from stored state ids. The interface check now runs the UI lint against an empty baseline. The builder shows the kit's save status; filter pills have their own class. The results figures use the kit's Stat, and two words that were fixed in English are now translated.

## 0.2.16

The reports it defines in code (their titles and parameters) have names in Arabic and Hindi too, with its models' and manifest's (196 each in ui/src/locales/names). Translated by the model, to be reviewed by native speakers.

## 0.2.15

Rebuilt with Ferrum-Frontend c59c9a2: the names of its models, fields and manifest in Arabic and Hindi (193 each in ui/src/locales/names, which the platform serves to every page of the workspace, so a record's labels, the launcher and the bar read in the person's language), and the sentences its pages still showed in English (split around a link or a figure, built in code from a template or word by word) whole and translated (591 words each in ui/src/locales). Translated by the model, to be reviewed by native speakers.

## 0.2.14

Rebuilt with Ferrum-Frontend 155518c: the sentences its pages built in code (counts, dates, what a toast or a screen reader says) go through t() too, as whole sentences where code chose a word, and carry built-in Arabic and Hindi (491 words each in ui/src/locales, translated by the model and to be reviewed by native speakers).

## 0.2.13

The assistant knows what its records mean in its pages (contributes.shell.assistant): their states, what counts and where figures come from, with questions it suggests asking there.

## 0.2.12

Rebuilt with Ferrum-Frontend 5b22e7b: its own words carry built-in Arabic and Hindi (445 words each, ui/src/locales, translated by the model and to be reviewed by native speakers), fetched for the page's language only. The labels it keeps in objects, its dialogs, its page titles and the words it keeps in variables go through t() as well, and the names and sizes it shows as they are keep their order right to left. Its pages are drawn once their words are in, and its entry carries only the parts of the kit it uses.

## 0.2.11

Rebuilt with Ferrum-Frontend 6537d65: an action's link, code or token shown once is kept in a dialog to copy, and on a page that reads right to left, English left untranslated keeps its own order. Its own words go through the kit's t() (362 places), so a workspace's own words for its language reach them, and Admin, Interface words lists them under it (dist/words.json).

## 0.2.10

Rebuilt with Ferrum-Frontend d5d98f2: a workspace's own words for its interface (Admin, Interface words) reach its pages as they load; an attachment field that holds a picture shows it; and a value another record already has is said so, where the form said the record had been changed by someone else. Its own screens' margins, paddings, borders, alignment and insets go by the line's start and end, so they mirror right to left as the kit's do; what it places by coordinates (boards, timelines, charts, handles) stays as it was.

## 0.2.9

Rebuilt with Ferrum-Frontend 63280d3: right to left, its pages mirror as they read (icons that point along the line, margins and alignment by the line's start and end, arrow keys along it), and the records pages' words are in Arabic and Hindi.

## 0.2.8

Rebuilt with Ferrum-Frontend a64416a: a new record's box whose default is 1 shows ticked, as it is saved.

## 0.2.7

Rebuilt with Ferrum-Frontend 922fcfb: an action's dialog says every refusal, the errors on what the action made (another record's rows) among them, and an action with parameters and a confirmation asks once.

## 0.2.6

Rebuilt with Ferrum-Frontend a76295e: its pages show times on a person's own clock when they chose one on their Account page, while today and due dates stay on the workspace's day.

## 0.2.5

Responses' and share links' times are on the workspace's clock; a public form keeps the respondent's own. Rebuilt with Ferrum-Frontend 24c3951, so its records' pages show times on the workspace's clock too, a draft numbered on submit is headed as a draft, and a record of an app that is not installed says so.

## 0.2.4

Rebuilt with Ferrum-Frontend bb60115: a record page reads an empty number or check as the server does, so an action whose condition needs one shows, and a workspace's settings open as their one record.

## 0.2.3

Rebuilt with Ferrum-Frontend 00dea07: in a workflow state that names what may change, the other fields show read-only, and the fields the state needs show required.

## 0.2.2

Rebuilt with Ferrum-Frontend daeadda: after an action runs, a record page shows what the action said it did rather than only that it is done.

## 0.2.1

Rebuilt with Ferrum-Frontend 80ff179: a field's label names its control for assistive technology, and a record whose title is a link shows that record's title, not its id.

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
