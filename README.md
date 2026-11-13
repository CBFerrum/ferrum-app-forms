<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg">
  <img alt="Ferrum Forms: forms, surveys and quizzes whose answers go straight into your records" src="docs/assets/banner-light.svg" width="100%">
</picture>

<br>

[![Version](https://img.shields.io/badge/version-0.3.0-30a67d?style=flat-square)](CHANGELOG.md)
[![Licence: AGPL-3.0](https://img.shields.io/badge/licence-AGPL--3.0-blue?style=flat-square)](LICENSE)
[![Ferrum platform](https://img.shields.io/badge/runs%20on-Ferrum-2f5bea?style=flat-square)](https://github.com/CBFerrum/Ferrum)
[![CI](https://github.com/CBFerrum/ferrum-app-forms/actions/workflows/ci.yml/badge.svg)](https://github.com/CBFerrum/ferrum-app-forms/actions/workflows/ci.yml)
![Rust](https://img.shields.io/badge/Rust-server-b7410e?style=flat-square&logo=rust)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-data-336791?style=flat-square&logo=postgresql&logoColor=white)
![React](https://img.shields.io/badge/React%20%2B%20TypeScript-interface-0ea5e9?style=flat-square&logo=react&logoColor=white)
![Tests](https://img.shields.io/badge/tests-32%20Rust%20%C2%B7%2072%20interface-16a34a?style=flat-square)

### Build a form, survey or quiz, share a link, and turn every answer into a record.

Ferrum Forms is for teams that collect information from customers, applicants, members and staff, and want it to land in the same system as the rest of their business instead of in a separate survey tool. It replaces Google Forms, Microsoft Forms, Typeform, Jotform and SurveyMonkey for most uses, and it can create a lead, a ticket or any other record from each response.

[💡 Why](#-why-ferrum-forms) · [📸 Screenshots](#-screenshots) · [✨ Features](#-features) · [📊 Compare](#-how-it-compares) · [📍 Roadmap](#-roadmap) · [🚀 Install](#-install) · [🔧 Develop](#-develop)

</div>

## 💡 Why Ferrum Forms

- 🔗 **Answers become records.** Map a form's questions to the fields of any record type (a Lead, a Ticket, a Customer) and each response creates one, checked against the live schema so a form can never promise something the record would refuse.
- ✅ **Checked on the server.** Every answer is validated and normalised on the server against the form, hidden questions are not required, and nobody, not even an administrator or an automation, can write a response around those checks.
- 🕵️ **Privacy built in.** Anonymous forms keep no email, name, user or address, and a person's personal-data request reaches their responses.
- 🏠 **Self-hosted, open source, AGPL-3.0.** No per-response limits and no per-seat fee; the data stays on your servers.
- 🧠 **Real logic.** 21 question types, conditions over earlier answers written as rules or as CEL, quizzes with scores and pass marks, NPS, matrices and rankings.
- 📱 **A respondent page that works anywhere.** No sign-in, page by page or one question at a time, from a phone to a desktop, with a keyboard, wearing your colour and logo.
- 🤖 **For people and AI agents.** Forms and responses are Ferrum records in the REST and MCP APIs, and an agent can enter a response on a person's behalf under the same checks.

## 🎯 At a glance

| | |
|---|---|
| 📦 **Version** | 0.3.0 |
| 🖥️ **Kind** | Its own interface at `/forms/` (builder, results) and a respondent page at `/forms/f/{workspace}/{form}`, with Ferrum's records screens for the rest |
| ➕ **What it adds** | 6 entities in one package (Form, Form Question, Form Field Map, Form Notify User, Form Response, Forms Settings), 2 roles, 3 reports, a launcher app, a Create menu entry, an assistant |
| 🧱 **Depends on** | The platform's `core` package. Nothing else is required |
| 🤝 **Works with** | Mail (owner emails and autoresponses) and any record type a response can create |
| 🌍 **Languages** | English, Arabic, Hindi (the app's own screens; a form's questions have one language each) |
| 🧪 **Tests** | 32 Rust test functions and 72 interface tests, counted from the source |
| 📄 **Licence** | AGPL-3.0-only |

## 📸 Screenshots

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/forms-forms-dark.webp"><img alt="Forms — all forms" src="docs/assets/screens/forms-forms-light.webp" width="100%"></picture>
<p align="center"><b>📋 Forms — all forms</b><br><sub>See your forms with their status and number of responses.</sub></p>

<table>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/forms-new-form-dark.webp"><img alt="Forms — new form" src="docs/assets/screens/forms-new-form-light.webp"></picture>
<p><b>📋 Forms — new form</b><br><sub>Start a form and choose its questions.</sub></p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/forms-builder-dark.webp"><img alt="Forms — the form builder" src="docs/assets/screens/forms-builder-light.webp"></picture>
<p><b>📋 Forms — the form builder</b><br><sub>Add questions, set which are required and preview the form.</sub></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/forms-results-dark.webp"><img alt="Forms — results" src="docs/assets/screens/forms-results-light.webp"></picture>
<p><b>📋 Forms — results</b><br><sub>Read the responses a form collected and a summary per question.</sub></p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/forms-responses-list-dark.webp"><img alt="Forms — responses" src="docs/assets/screens/forms-responses-list-light.webp"></picture>
<p><b>📋 Forms — responses</b><br><sub>Browse every response to every form.</sub></p>
</td>
</tr>
</table>

### 📱 On a phone

<p align="center">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/forms-forms-phone-dark.webp"><img alt="Forms — all forms" src="docs/assets/screens/forms-forms-phone-light.webp" width="260"></picture>
</p>
<p align="center"><sub>See your forms with their status and number of responses.</sub></p>

> [!TIP]
> The screenshots follow your GitHub theme: switch between light and dark to see both.

## ✨ Features

### 🧱 Building

- **Three kinds.** A Form, a Survey or a Quiz. All share one engine. A form is a Draft, then Published, then Closed, and takes responses only while Published.
- **21 question types.** Short text, long text, email, phone, number, decimal, date, time, date and time, single choice, multiple choice, checkbox, dropdown, rating, NPS (0 to 10), Likert, matrix, ranking, file upload, page break and statement.
- **A builder, not a grid.** Add questions from a list of the types, open one to write it, and move it by dragging, with Alt and the arrow keys, or from its menu. Options are written one per line.
- **Checks on every question.** Required, help text, default value, minimum and maximum, minimum and maximum length, a pattern with its own error message (patterns run in linear time), an "other" option, and for files the accepted types and the biggest size.
- **Show only if.** A question or a whole page can depend on earlier answers. Write it as rules (a question, what to compare, a value) or as any other condition in CEL, for example `answers.country == 'IN' && answers.age >= 18`. A condition can read only earlier questions, so loops are impossible. The server evaluates every condition again.
- **The form says what is wrong with it first.** Each card shows its problems before the server does, and what the server refuses lands on the card or the setting it is about. Saving checks the whole definition and returns every problem at once.
- **Preview** as a phone or a computer sees it.
- **Publish, close, reopen and duplicate** from one page.
- **Start from a template.** A blank form, a contact form, an event registration, a feedback survey or a quiz.
- **A form closes itself** when its closing time passes or its response limit is reached.

### ⚙️ Settings

- **Who can answer.** Public (anyone with the link) or Internal (signed-in users only, at the same link).
- **When and how often.** An opening and closing time, a response limit that holds exactly under concurrency, and one response per email or one per signed-in user.
- **The respondent's page.** Pages or one question at a time, an accent colour and a logo, a thank-you message, an address to send people to next, and a message for a closed form.
- **Anonymous mode.** No respondent email, name, user id or address is kept, and the audit trail and events never name the respondent. On an anonymous form only "one response per user" is allowed, which records that someone took part but never which response is theirs.
- **Who is told.** The owner and a list of workspace users are notified of each response, in the app and, when email is set up, by email. Users who may not read the response are skipped.
- **An email to the respondent.** A fixed plain-text autoresponse to the address in a chosen email question, at most one per address and form a day, never for spam or anonymous forms.
- **Quiz settings.** A pass mark (checked exactly) and whether the result reveals the correct answers.
- **Hidden fields.** Name the keys a link may pass (such as a campaign, a source or a record id). They are kept with the response, not shown to the respondent, mappable to record fields and erased with the respondent's personal data.

### 📝 Answering

- **No sign-in.** A form's link opens a page anyone can fill in, with a progress bar and Back and Next, page by page (page breaks end a page) or one question at a time.
- **Questions come and go** as the answers before them say. Mistakes are explained under the question in plain words.
- **Nothing lost by accident.** What was typed is kept in the tab if the page reloads or runs out, files can be attached, and a Send that is safe to press twice stores one response.
- **Clear states.** A closed form, a full one, one that is not open yet, and a link that leads nowhere each say so.
- **Quizzes show their result** with points per question, and a link to come back to it for 30 days. Answers are never revealed before submitting, and only afterwards if the form says so.
- **Prefilled links.** A question that allows it can be filled from `?key=value` in the link. Invalid values are ignored.
- **Signed prefill.** A Prefill Link action makes a link that carries signed values for a number of days, so a respondent cannot tamper with them.
- **Phones and keyboards.** It works at 375 pixels and with the keyboard alone.
- **A respondent's own clock.** A public form keeps the respondent's time zone.

### 🧾 Answers into records

- **Pick a record type and map the fields.** Each response can create a record of any master or document type, setting the fields you map from answers (or a fixed value). The mapping is checked against the live schema on every save: the type is installed, the field exists and is writable, the saving user may create that record and write that field, every required field is mapped, fixed values are valid, and the answer's type fits the field.
- **Exact fits.** Text and long text answers to text fields, email and phone to their fields, numbers and ratings to numbers, dates, checkboxes, choices to select fields whose options all exist, a file to an attachment field, anything to a JSON field, and fixed values only for links.
- **Created once.** After the response is stored, the record is created once and linked from the response (a refusal is kept, with its reason, on the response). The record's own workflow applies, so a response that creates a record of a type with approvals gets them.
- **Make the record later.** A person can create the record from a response by hand.
- **Find or create, and lines.** Finding an existing record or making one and linking another is configuration (an automation on Form Response), and is tested.
- **Hand entry.** "Enter a Response" puts in a response by hand (from a phone call, a paper form or an AI agent) with the same checks, limits and duplicate rules, without the opening hours and spam traps. The audit trail names the person who entered it.

### 📊 Results

- **A summary for a period.** Responses, how many finished (per view), the average and median time, and for quizzes the average score, passed and failed.
- **A chart for each question.** Bars for choices, columns for ratings, a score for NPS (promoters, passives, detractors and the NPS), averages for Likert and numbers, a table for grids, the average rank for rankings, and the words people wrote.
- **Every response to read,** with Reviewed and Spam marks and "make the record", in a panel that moves from one response to the next.
- **Export to CSV** keeps the period and the filter (up to 100,000 rows) with one column per question.
- **Reports.** Three reports for the Reports screen: Forms Overview, Form Question Summary and Form Response Trend.
- **Exact figures.** Percentages and averages are exact decimals rounded half away from zero to two places, and spam never counts.

### 🛡️ Abuse protection and spam

- **Honeypot and minimum fill time.** A hidden field real people leave empty, and responses sent sooner after opening than a limit (3 seconds by default) are kept as spam.
- **Rate limit.** A limit on responses per hour (30 by default), set in Forms Settings.
- **Proof of work.** An optional small computation the respondent's browser does before sending (18 bits by default), per form.
- **Your own check.** A plug-in point (`guard::Check` and `guard::register`) for an extra check such as a captcha provider.
- **Spam is held, not lost.** Responses marked as spam stay for 30 days (a setting), free the respondent's one-response claim, and get no notifications, no autoresponse and no record until they are marked "not spam".

### 🔐 Privacy, roles and languages

- **Roles.** Forms User (builds forms and works the responses of the forms they own) and Forms Manager (every form and response, ownership and settings).
- **Respondents need no role.** Anyone with the link answers public forms, and any signed-in user answers internal ones.
- **Personal data.** A request by email exports and erases a person's responses, including their answers, hidden values, quiz detail and address hash.
- **Languages.** The builder, results and respondent page come in English, Arabic and Hindi, with right to left mirrored.
- **Assistant.** It knows what a Form, a Response, a Quiz and an NPS mean and suggests "How many responses did each form get this week?".

## 🧭 How it works

### From a form to a record

```mermaid
flowchart LR
    B["Builder - questions, logic, settings"] --> P["Published form"]
    P --> L["Link or internal page"]
    L --> R["Respondent"]
    R --> V{"Server checks answers"}
    V -->|invalid| E["Errors under the question"]
    V -->|valid| S["Response stored"]
    S --> N["Notifications and autoresponse"]
    S --> REC["Record created from the field map"]
    S --> A["Results and reports"]
```

A respondent opens the link and gets the form's definition. On submit, the server validates every answer again, drops answers to hidden questions and stores the response. Once it is stored, the record is created once, people are told and the results update.

### Inside Ferrum

```mermaid
flowchart LR
    subgraph Browser
        UI["Forms interface - /forms/"]
        RP["Respondent page - no sign-in"]
    end
    subgraph Server["Ferrum server"]
        API["REST, MCP, public endpoints"]
        K["Kernel - permissions, RLS, audit"]
        APP["Forms - 6 entities, 2 roles"]
        OB[("Outbox")]
    end
    DB[("PostgreSQL")]
    UI --> API --> K --> DB
    RP --> API
    K <--> APP
    K --> OB --> EV["Record creation, mail, - webhooks, automations"]
```

Forms is ordinary Ferrum metadata and Rust, so its records get lists, forms, search, permissions, an audit trail and the REST and MCP APIs. Record creation, notifications and mail run from the outbox at least once and are idempotent, and the same events reach webhooks and automations.

## 🧱 Data model

| Entity | What it is | Key fields and states |
|---|---|---|
| Form | A form, survey or quiz | title, kind (Form, Survey, Quiz), status (Draft, Published, Closed), address, owner, access (Public or Internal), anonymous, opening and closing times, response limit, one response per (Email or User), hidden fields, layout, accent colour, logo, passing score, target record type |
| Form Question | A question (a row of a form) | key, label, type (21), required, help text, options, matrix rows, bounds, pattern, default, visible if, allow prefill, accepted files, points, correct answer |
| Form Field Map | One mapped field of the record to create | target field, question or fixed value |
| Form Notify User | A user told of each response | email |
| Form Response | One response, never changed after it is sent | form, status (New, Reviewed, Spam), source (Public Link, Signed In, Manual Entry), submitted at, respondent email and name, answers, hidden values, score, quiz result, completion seconds, spam reason, record created |
| Forms Settings | One per workspace | spam retention days (30), responses per hour (30), proof-of-work bits (18) |

### 👥 Roles

| Role | What it can do |
|---|---|
| **Forms User** | Creates forms, surveys and quizzes; edits, publishes, closes, duplicates and deletes the forms they own (created or named as owner); reads, reviews, marks as spam, deletes and exports the responses of those forms |
| **Forms Manager** | Every form and every response, changes a form's owner, and edits Forms Settings |

Nobody creates, edits or imports responses through the generic API, so every response was checked against its form.

### 🎬 Actions

| Entity | Action | What it does |
|---|---|---|
| Form | Publish | Publishes a Draft or Closed form (refused with the reasons when the definition is not ready) |
| Form | Close | Stops accepting responses |
| Form | Duplicate | A Draft copy owned by the caller |
| Form | Enter a Response | Enters a response by hand, with the same checks |
| Form | Prefill Link | A link carrying signed values for a number of days |
| Form Response | Mark Reviewed, Mark Spam, Not Spam | Moves a response between states |
| Form Response | Create Record | Makes the mapped record for a response that has none |

### 📊 Reports and jobs

- **Reports:** Forms Overview (per form: responses, spam, views, completion, average time, last response), Form Question Summary (each question and its options, values and statistics) and Form Response Trend (responses per day).
- **Every minute:** close published forms past their closing time, delete spam older than the retention period, and forget autoresponse limits older than two days.

## 🔌 Integrations

| With | How | Needs |
|---|---|---|
| Any record type | Each response can create a record through the field map; automations can find or make records and link them | The record type's app |
| Mail (Comms) | Owner and recipient emails and the autoresponse are Communications | The Mail app, or the server's own mailer |
| Webhooks and automations | Response events reach them through the outbox | Platform webhooks |
| Respondent page | A public link or a signed-in internal link | A public URL |
| Plug-in checks | `guard::Check` for captcha-like extra checks | A developer |

## 📊 How it compares

Forms is compared with Google Forms, Microsoft Forms, Typeform, Jotform, SurveyMonkey and Formbricks, the open-source option.

| Capability | Ferrum Forms | Google Forms | Microsoft Forms | Typeform | Jotform | SurveyMonkey | Formbricks |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Wide choice of question types | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Conditional logic on questions and pages | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Jump to a page or ending chosen by answer or score | 🟡 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Piping an earlier answer into later text | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |
| Hidden fields and signed prefill links | ✅ | 🟡 | ❌ | ✅ | ✅ | ✅ | ✅ |
| Quizzes with scores and pass marks | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 |
| NPS, rating, Likert, matrix and ranking | ✅ | 🟡 | ✅ | ✅ | ✅ | ✅ | ✅ |
| File uploads | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Calculated fields and running totals | ❌ | ❌ | ❌ | ✅ | ✅ | 🟡 | ✅ |
| Payment and signature questions | ❌ | ❌ | ❌ | ✅ | ✅ | 🟡 | ❌ |
| Public link, no sign-in | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Limit to signed-in people of your organisation | ✅ | ✅ | ✅ | 🟡 | 🟡 | 🟡 | 🟡 |
| Opening and closing times, response limit | ✅ | 🟡 | 🟡 | ✅ | ✅ | ✅ | ✅ |
| One response per person | ✅ | ✅ | ✅ | 🟡 | 🟡 | 🟡 | 🟡 |
| Anonymous responses | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | ✅ |
| Spam protection | 🟡 ¹ | 🟡 | 🟡 | ✅ | ✅ | ✅ | ✅ |
| One question at a time layout | ✅ | ❌ | 🟡 | ✅ | ✅ | 🟡 | ✅ |
| Save and resume later | 🟡 ² | 🟡 | 🟡 | ✅ | ✅ | ✅ | 🟡 |
| Respondent edits an answer after sending | ❌ | ✅ | ✅ | 🟡 | ✅ | 🟡 | 🟡 |
| Theme with fonts, images and custom styles | 🟡 ³ | 🟡 | 🟡 | ✅ | ✅ | ✅ | ✅ |
| Embed on another website | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Forms in several languages for respondents | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |
| Template gallery | 🟡 ⁴ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Charts per question, NPS and completion rate | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Cross-tabs and filtering results by an answer | ❌ | ❌ | ❌ | 🟡 | 🟡 | ✅ | ✅ |
| Export to CSV | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Export to a spreadsheet or Sheets directly | ❌ | ✅ | ✅ | 🟡 | ✅ | ✅ | 🟡 |
| Notify the owner and email a receipt | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Answers create records in your business apps | ✅ | ❌ | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 |
| Enter a response by hand or by an AI agent | ✅ | ❌ | ❌ | ❌ | 🟡 | ❌ | 🟡 |
| Outbound connectors (Slack, Sheets, Zapier) | 🟡 ⁵ | 🟡 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Personal-data export and erase of responses | ✅ | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | ✅ |
| Self-hosted | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Open source | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| No per-response or per-seat fee | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ |

¹ Honeypot, a minimum fill time, a rate limit and an optional proof of work are built in. There is no captcha yet, but a developer can plug one in.
² What was typed is kept in the browser tab while it is open; it is not saved on the server, so it is lost when the tab is closed.
³ One accent colour, a logo and the page or one-question layout.
⁴ A blank form, a contact form, an event registration, a feedback survey and a quiz.
⁵ Response events reach webhooks and automations through the platform's outbox; there is no built-in outbound HTTP step or connector library yet.

### 🏆 Where Forms stands out

- 🔗 Answers become records in any Ferrum app, with the mapping checked against the live schema and the record's own workflow applied.
- ✅ Validation and conditions are re-run on the server, so a response is always valid, and nobody can write one around the checks.
- 🕵️ Anonymous forms that truly keep no respondent data, and personal-data requests that reach responses.
- 🔍 A real CEL condition language, with rules for people who do not write code.
- 🧯 Spam is held rather than lost, and a person can enter a response on someone's behalf, such as from a phone call.
- 🏠 Open source and self-hosted, with no limit on responses.

### 🚧 Where the leaders are still ahead

- 🌐 Embedding a form in another site, custom domains and short links.
- 🎨 Deeper themes, cover images and custom styles.
- 🧮 Calculated fields, answer piping, jump logic, payments and signature questions.
- 🌍 Forms translated question by question for respondents.
- 💾 Saving a partial response on the server so people can resume.
- 📈 Cross-tabs and segmenting results by an answer, and direct export to spreadsheets.
- 🔌 A library of outbound connectors.

> [!NOTE]
> Leader columns are from public product information as of November 2026 and may change.

## 📍 Roadmap

### ✅ Recently shipped

- [x] **0.3.0**: Hidden fields, signed prefill links, and abuse protection (a rate limit, an optional proof of work and a plug-in point for extra checks).
- [x] **0.2.18 and 0.2.17**: The upgraded design system and a lighter first page.
- [x] **0.2.16 to 0.2.9**: Names, words and reports in Arabic and Hindi, right to left, times on the workspace's and a person's own clock.
- [x] **0.2.0**: The respondent's page, the builder, settings in one place, results with a chart per question, and page-by-page or one-question-at-a-time layouts.
- [x] **0.1.0**: First release: one engine for forms, surveys and quizzes with 21 question types, CEL logic, quizzes, record creation and analytics.

### 🔜 Next up

**Sharing**
- [ ] Embed a form in another site (a snippet and a policy for the public page), and a QR code.
- [ ] Custom domains and short links for public forms (needs the platform).

**Questions**
- [ ] Piping an earlier answer into later questions, page text and the confirmation.
- [ ] A signature question, reusing Sign's pad.
- [ ] Calculated answers, totals and score bands on any form.
- [ ] More kinds: address, website, slider, yes and no, picture choice and a consent block.
- [ ] Jump to a page or an ending, with several endings chosen by answer or score band.

**Responses**
- [ ] Save and resume by link or email, with partial responses kept on the server.
- [ ] Respondents who can edit an answer after sending.
- [ ] A real captcha through the plug-in point.

**Records**
- [ ] Let a mapped value be an expression over answers (join a first and last name).
- [ ] Find or create a record by an answer, and create several records or lines from one response.

### 🔭 Later

- [ ] Payments through the Commerce payment connector.
- [ ] Questions in several languages with the respondent's language chosen by the browser.
- [ ] Randomised options and question order, and quotas by answer.
- [ ] Invitations sent to a list with personal links and reminders to non-responders.
- [ ] A retention schedule for responses and consent text.
- [ ] Notifications routed by answer and richer autoresponses with the answers or a PDF copy.
- [ ] Cross-tabs, segmenting results by an answer, drop-off per question, and device and source splits.
- [ ] Results in Studio and direct export to XLSX or Sheets.
- [ ] Theme with fonts, cover images, button styles and a workspace brand kit.
- [ ] A larger gallery of templates.
- [ ] Kiosk mode and offline capture.
- [ ] Notifications by text message.
- [ ] An accessibility audit of the respondent page.
- [ ] Text analysis of open answers.

## 🚀 Install

Forms is a native app compiled into the official Ferrum server image. A workspace administrator installs it from **Apps** (`/store/`). Self-hosters who build their own image enable the `forms` feature of the server. It needs Ferrum platform `>=0.3, <0.4`.

**First steps**

1. Give people the **Forms User** role, and the people who oversee every form and the settings **Forms Manager**.
2. Open **Forms Settings** and check the spam retention (30 days), the responses per hour (30) and the proof-of-work bits (18).
3. For owner emails and autoresponses, install the Mail app, or rely on the server's own mailer.
4. Build a form from **Forms**, set who may answer and when, and **Publish**. Share the link at `/forms/f/{workspace}/{form}` or use the form's Share page.
5. To create records from responses, choose a record type in the form's settings and map the questions to its fields.

## 🔧 Develop

Clone it next to the platform:

```text
work/
├── ferrum/              https://github.com/CBFerrum/Ferrum (with Ferrum-Frontend cloned into ferrum/web)
└── ferrum-app-forms/
```

Point the platform dependencies at your checkout (this file is git-ignored):

```toml
# .cargo/config.toml
[patch."https://github.com/CBFerrum/Ferrum"]
ferrum-apps = { path = "../ferrum/crates/apps" }
ferrum-domain = { path = "../ferrum/crates/domain" }
ferrum-kernel = { path = "../ferrum/crates/kernel" }
ferrum-meta = { path = "../ferrum/crates/meta" }
```

The tests need PostgreSQL with an ordinary (non-superuser) role, so row-level security applies:

```bash
createuser ferrum --pwprompt && createdb -O ferrum ferrum_forms_test
export FERRUM_FORMS_TEST_DATABASE_URL=postgres://ferrum:ferrum@localhost:5432/ferrum_forms_test
cargo fmt -- --check
cargo clippy --all-targets -- -D warnings
cargo test
```

The interface lives in `ui/` and builds with Ferrum-Frontend's packages from the sibling checkout:

```bash
cd ui
npm run check       # UI lint and the size budget
npm run typecheck
npm test
npm run build       # writes ui/dist, which the crate embeds and which is committed
```

With a development server started with `FERRUM_DEV_UI=1`, `ferrum-app dev --ui` serves the pages from Vite behind the real bar and session, with hot reload. CI (`.github/workflows/ci.yml`) runs the Rust checks and the interface checks on every push and pull request.

## 📂 Project layout

```text
app.yaml              the manifest: id, version, launcher entry, respondent page, Create menu
packages/forms/       entities, roles, reports, SQL, README with the full API
src/                  Rust: form and question model, answer checks, logic (CEL), responses,
                      record mapping, analytics, spam guard, tokens, upkeep jobs
ui/src/               React interface: home, builder, logic, settings, share, results,
                      responses and the respondent page
ui/src/locales/       Arabic and Hindi words
tests/                integration tests against PostgreSQL
docs/                 banner and screenshots
CHANGELOG.md          what changed in each version
```

## 📜 Changelog

Every release is described in [CHANGELOG.md](CHANGELOG.md). The latest is **0.3.0**, which added hidden fields, signed prefill links and abuse protection.

## 🤝 Contributing

Issues and pull requests are welcome at [github.com/CBFerrum/ferrum-app-forms](https://github.com/CBFerrum/ferrum-app-forms/issues). Run the checks in [Develop](#-develop) before you open a pull request.

## 📄 License

[AGPL-3.0-only](LICENSE), like the platform.

<div align="center">

<sub>Part of <a href="https://github.com/CBFerrum/Ferrum">Ferrum</a>, the open business platform · Made with 🦀 Rust and 🐘 PostgreSQL</sub>

</div>
