// The form builder: write the questions, set the logic and the rules, preview it as a respondent
// would meet it (phone or computer), publish it. Nothing is saved until you say so (Save, or Ctrl+S):
// a half-written question is not a form, and the server checks the whole definition. What it refuses
// shows on the question or the setting it is about.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, BarChart3, Copy, Ellipsis, Eye, ExternalLink, Lock, RotateCcw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { api, ApiError, bootstrap, docPath, errorMessage, t as tr, isolate } from "@ferrum/client";
import { Alert, Badge, Button, confirmDialog, FormSkeleton, SaveStatus, StatePanel, TabPanel, Tabs, toast, useDebounced, useLiveEntity, useShellTitle, useUnsavedGuard } from "@ferrum/kit";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@ferrum/kit/primitives";
import { type Basics, problems, type QRow, toPublic } from "./rows";
import { Questions } from "./Cards";
import { type Draft, draftOf, dirty as differs, type Fields, type FormDoc, patchOf, refusal, type Refusal, refused, STATUS_LABEL, STATUS_TONE, type Status } from "./formdoc";
import type { Receipt } from "./model";
import { Runner } from "./Runner";
import { Settings, Seg } from "./Settings";
import { copy, linkOf, Share } from "./Share";

const key = (id: string) => ["forms", "doc", id];
/** The list of forms and its counts show what changed when the person goes back to them. */
const staleList = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: ["forms", "list"] });
  void qc.invalidateQueries({ queryKey: ["forms", "overview"] });
};
type TabId = "questions" | "settings" | "share";

const basics = (f: Fields): Basics => ({ title: f.title, description: f.description, kind: f.kind, access: f.access, anonymous: f.anonymous, closes_at: f.closes_at, accent_color: f.accent_color, logo: f.logo, layout: f.layout });

// ───────────────────────────── the preview ─────────────────────────────


function Preview({ draft, onClose }: { draft: Draft; onClose: () => void }) {
  const [device, setDevice] = useState<"phone" | "computer">("phone");
  const [run, setRun] = useState(0);
  const form = useDebounced(useMemo(() => toPublic(basics(draft.fields), draft.rows), [draft]), 250);
  const boot = bootstrap();
  const message = draft.fields.confirmation_message.trim() || tr("Thank you! Your response was recorded.");
  // Nothing is sent: the preview answers as the server would after a good response.
  const send = useCallback(async (): Promise<Receipt> => ({ status: "received", message, redirect_url: null, replayed: false }), [message]);
  return (
    <aside className="fm-preview" aria-label={tr("Preview of the form")}>
      <div className="fm-preview-bar">
        <strong>{tr("Preview")}</strong>
        <Seg label={tr("Device")} value={device} options={[["phone", "Phone"], ["computer", "Computer"]]} onChange={setDevice} />
        <span className="spacer" />
        <button type="button" className="icon-btn" aria-label={tr("Start the preview again")} title={tr("Start again")} onClick={() => setRun((n) => n + 1)}>
          <RotateCcw size={16} aria-hidden="true" />
        </button>
        <button type="button" className="icon-btn" aria-label={tr("Close the preview")} onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="fm-device" data-device={device} data-scroll>
        <Runner key={run} form={form} zone={boot?.locale.timezone ?? "UTC"} workspace={boot?.workspace.name} send={send} preview />
      </div>
      <p className="faint fm-preview-note">{tr("Answer it as a respondent would: questions appear and go away as the rules say.")}</p>
    </aside>
  );
}

// ───────────────────────────── the page ─────────────────────────────

function BuilderPage({ doc }: { doc: FormDoc }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  const tab: TabId = sp.get("tab") === "settings" ? "settings" : sp.get("tab") === "share" ? "share" : "questions";
  const preview = sp.get("preview") === "1";
  const status: Status = doc.status ?? "Draft";

  const [saved, setSaved] = useState<Draft>(() => draftOf(doc));
  const [draft, setDraft] = useState<Draft>(saved);
  const [version, setVersion] = useState(doc.version);
  const [open, setOpen] = useState<string | null>(null);
  const [no, setNo] = useState<Refusal | null>(null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState<"save" | "publish" | "close" | null>(null);
  const [stale, setStale] = useState(false);

  const isDirty = useMemo(() => differs(saved, draft), [saved, draft]);
  const found = useMemo(() => problems(draft.rows), [draft.rows]);
  const flagged = found.reduce((n, p) => n + (p.length ? 1 : 0), 0);
  const { allowLeave, dialog } = useUnsavedGuard(isDirty);
  useShellTitle(draft.fields.title.trim() || tr("Untitled form"));

  // The server has a newer form (a save elsewhere, a publish): take it if nothing here is unsaved.
  useEffect(() => {
    if (doc.version === version) return;
    if (isDirty) {
      setStale(true);
      return;
    }
    const d = draftOf(doc, draft.rows);
    setSaved(d);
    setDraft(d);
    setVersion(doc.version);
    setStale(false);
  }, [doc, version, isDirty, draft.rows]);

  useLiveEntity("Form", useCallback((e) => void (e.id === doc.id && qc.invalidateQueries({ queryKey: key(doc.id) })), [qc, doc.id]));

  const params = (p: Record<string, string | null>) =>
    setSp(
      (cur) => {
        const next = new URLSearchParams(cur);
        for (const [k, v] of Object.entries(p)) v === null ? next.delete(k) : next.set(k, v);
        return next;
      },
      { replace: true },
    );

  // What the server refused stays on a setting or a card until that setting or card is changed.
  const setFields = (p: Partial<Fields>) => {
    setDraft((d) => ({ ...d, fields: { ...d.fields, ...p } }));
    setNo((cur) => {
      if (!cur || !Object.keys(p).some((k) => k in cur.fields)) return cur;
      const fields = { ...cur.fields };
      for (const k of Object.keys(p)) delete fields[k];
      return { ...cur, fields };
    });
  };
  const setRows = (rows: QRow[]) => {
    setDraft((d) => ({ ...d, rows }));
    setNo((cur) => {
      const touched = cur ? rows.filter((r) => cur.cards[r.uid] && draft.rows.find((x) => x.uid === r.uid) !== r) : [];
      if (!cur || !touched.length) return cur;
      const cards = { ...cur.cards };
      for (const r of touched) delete cards[r.uid];
      return { ...cur, cards };
    });
  };

  /** What the server refused: onto the settings and the cards, and to the first of them. */
  const refuse = (e: ApiError) => {
    const r = refusal(e, draft.rows);
    setNo(r);
    setTried(true);
    if (refused(r) === 0) {
      toast(errorMessage(e), "error");
      return;
    }
    const first = draft.rows.find((row) => r.cards[row.uid]);
    if (first) {
      params({ tab: null });
      setOpen(first.uid);
    } else if (Object.keys(r.fields).length) params({ tab: r.fields.slug ? "share" : "settings" });
    toast(refused(r) === 1 ? tr("1 thing needs another look before this can be saved.") : tr("{n} things need another look before this can be saved.", { n: refused(r) }), "error");
  };

  const save = async (): Promise<boolean> => {
    const patch = patchOf(saved, draft);
    if (!Object.keys(patch).length) return true;
    const sent = draft;
    setBusy("save");
    try {
      const next = await api.patch<FormDoc>(docPath("Form", doc.id), patch, { ifMatch: version });
      const fresh = draftOf(next, sent.rows);
      qc.setQueryData(key(doc.id), next);
      staleList(qc);
      setSaved(fresh);
      setVersion(next.version);
      setNo(null);
      // Whatever was typed while the save ran stays; what was sent takes the server's wording.
      setDraft((cur) => {
        const fields = { ...cur.fields };
        for (const k of Object.keys(fields) as (keyof Fields)[]) if (JSON.stringify(cur.fields[k]) === JSON.stringify(sent.fields[k])) (fields as Record<string, unknown>)[k] = fresh.fields[k];
        const ids = new Map(sent.rows.map((r, i) => [r.uid, fresh.rows[i]?.id]));
        return { fields, rows: cur.rows.map((r) => (ids.has(r.uid) ? { ...r, id: r.id ?? ids.get(r.uid), keyAuto: false } : r)) };
      });
      return true;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 409 || e.status === 412)) {
        void qc.invalidateQueries({ queryKey: key(doc.id) });
        toast(tr("Someone else changed this form. Reload to see their version."), "error");
      } else if (e instanceof ApiError && e.status === 422) refuse(e);
      else toast(errorMessage(e), "error");
      return false;
    } finally {
      setBusy(null);
    }
  };

  const publish = async () => {
    setTried(true);
    if (flagged) {
      const first = draft.rows.find((_, i) => found[i].length);
      params({ tab: null });
      if (first) setOpen(first.uid);
      toast(tr("Some questions are not finished. They are marked."), "error");
      return;
    }
    if (isDirty && !(await save())) return;
    setBusy("publish");
    try {
      await api.post(docPath("Form", doc.id, "actions", "publish"), {});
      staleList(qc);
      await qc.invalidateQueries({ queryKey: key(doc.id) });
      params({ tab: "share" });
      toast(status === "Closed" ? tr("Reopened") : tr("Published. The link works now."));
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) refuse(e);
      else toast(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const close = async () => {
    const ok = await confirmDialog({ title: tr("Close this form?"), message: tr("People who open its link are told it is closed. You can reopen it any time."), confirmLabel: tr("Close it") });
    if (!ok) return;
    setBusy("close");
    try {
      await api.post(docPath("Form", doc.id, "actions", "close"), {});
      staleList(qc);
      await qc.invalidateQueries({ queryKey: key(doc.id) });
      toast(tr("Closed"));
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const duplicate = async () => {
    try {
      const made = await api.post<{ id: string }>(docPath("Form", doc.id, "actions", "duplicate"), {});
      staleList(qc);
      allowLeave();
      toast(tr("A copy was made"));
      navigate(`/b/${made.id}`);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const remove = async () => {
    const ok = await confirmDialog({ title: tr("Delete “{value}”?", { value: draft.fields.title || tr("this form") }), message: tr("The form and its questions are deleted. A form with responses cannot be deleted: close it instead."), confirmLabel: tr("Delete it"), danger: true });
    if (!ok) return;
    try {
      await api.del(docPath("Form", doc.id));
      staleList(qc);
      allowLeave();
      toast(tr("Deleted"));
      navigate("/");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  // Ctrl+S or Cmd+S saves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const f = draft.fields;
  const live = status === "Published";
  const url = f.slug && saved.fields.slug ? linkOf(saved.fields.slug) : "";
  const settingProblems = no ? Object.keys(no.fields).filter((k) => k !== "slug").length : 0;
  const usedElsewhere = (k: string) => [...(f.email_question === k ? ["it is the question that holds their email (Settings)"] : []), ...(f.field_map.some((m) => m.question === k) ? ["it fills a field of the record each response creates (Settings)"] : [])];
  const answerableCount = draft.rows.filter((r) => r.question_type !== "page_break" && r.question_type !== "statement").length;

  return (
    <div className="fm-page fm-builder">
      {dialog}
      <header className="fm-head">
        <div className="fm-head-top">
          <Link className="fm-back" to="/" aria-label={tr("All forms")}>
            <ArrowLeft size={16} aria-hidden="true" /> {tr("Forms")}
          </Link>
          <span className="spacer" />
          <SaveStatus state={busy === "save" ? "saving" : isDirty ? "draft" : "saved"} />
        </div>
        <div className="fm-head-main">
          <div className="fm-title-wrap">
            <input className="fm-title" aria-label={tr("Title of the form")} value={f.title} maxLength={200} placeholder={tr("Untitled form")} onChange={(e) => setFields({ title: e.target.value })} />
            {no?.fields.title && <p className="field-error">{isolate(no.fields.title)}</p>}
          </div>
          <div className="fm-actions">
            <Badge tone={STATUS_TONE[status]}>{isolate(STATUS_LABEL[status])}</Badge>
            <Button onClick={() => params({ preview: preview ? null : "1" })} aria-pressed={preview}>
              <Eye size={16} aria-hidden="true" />
              {tr("Preview")}
            </Button>
            {isDirty && (
              <Button variant={live ? "primary" : "default"} loading={busy === "save"} onClick={() => void save()}>
                {live ? tr("Save changes") : tr("Save")}
              </Button>
            )}
            {!live && (
              <Button variant="primary" loading={busy === "publish"} onClick={() => void publish()}>
                {status === "Closed" ? tr("Reopen") : tr("Publish")}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="icon-btn" aria-label={tr("More")}>
                  <Ellipsis size={18} aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {url && (
                  <DropdownMenuItem onSelect={() => void copy(url)}>
                    <Copy size={14} aria-hidden="true" /> {tr("Copy the link")}
                  </DropdownMenuItem>
                )}
                {url && live && (
                  <DropdownMenuItem asChild>
                    <a href={url} target="_blank" rel="noopener noreferrer">
                      <ExternalLink size={14} aria-hidden="true" /> {tr("Open it as a respondent")}
                    </a>
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem asChild>
                  <Link to={`/e/Form/${doc.id}`}>
                    <Lock size={14} aria-hidden="true" /> {tr("Open the full record")}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void duplicate()}>
                  <Copy size={14} aria-hidden="true" /> {tr("Make a copy")}
                </DropdownMenuItem>
                {live && (
                  <DropdownMenuItem onSelect={() => void close()}>
                    <Lock size={14} aria-hidden="true" /> {tr("Close the form")}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => void remove()}>
                  <Trash2 size={14} aria-hidden="true" /> {tr("Delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <div className="fm-tabs">
          <Tabs
            id="builder"
            value={tab}
            onChange={(t) => params({ tab: t === "questions" ? null : t })}
            tabs={[
              { id: "questions", label: <>{tr("Questions")}{answerableCount ? <span className="fm-count">{answerableCount}</span> : null}</> },
              { id: "settings", label: <>{tr("Settings")}{settingProblems ? <span className="tab-errors">{settingProblems}</span> : null}</> },
              { id: "share", label: tr("Share") },
            ]}
          />
          <Link className="fm-results-link" to={`/b/${doc.id}/results`}>
            <BarChart3 size={15} aria-hidden="true" /> {tr("Results")}
          </Link>
        </div>
      </header>

      {stale && (
        <Alert
          tone="warning"
          action={
            <Button
              onClick={() => {
                const d = draftOf(doc, draft.rows);
                setSaved(d);
                setDraft(d);
                setVersion(doc.version);
                setStale(false);
              }}
            >
              {tr("Load their version")}
            </Button>
          }
        >
          {tr("This form was changed somewhere else. Loading it replaces what you have changed here.")}
        </Alert>
      )}
      {live && !stale && isDirty && <Alert tone="info">{tr("This form is live. What you change here reaches the people who open it as soon as you save.")}</Alert>}
      {no && no.other.length > 0 && <Alert tone="error">{isolate(no.other.join(" "))}</Alert>}
      {tried && flagged > 0 && tab !== "questions" && (
        <Alert tone="warning" action={<Button onClick={() => params({ tab: null })}>{tr("Show them")}</Button>}>
          {flagged} {(flagged === 1 ? tr("question is not finished.") : tr("questions are not finished."))}
        </Alert>
      )}

      <div className="fm-body" data-preview={preview ? "" : undefined}>
        <div className="fm-main">
          <TabPanel id="builder" tab={tab}>
            {tab === "questions" && (
              <Questions
                rows={draft.rows}
                onChange={setRows}
                quiz={f.kind === "Quiz"}
                open={open}
                onOpen={setOpen}
                server={no?.cards ?? {}}
                showProblems={tried}
                usedElsewhere={usedElsewhere}
              />
            )}
            {tab === "settings" && <Settings fields={f} set={setFields} rows={draft.rows} formId={doc.id} errors={no?.fields ?? {}} />}
            {tab === "share" && (
              <Share
                fields={f}
                set={setFields}
                rows={draft.rows}
                status={status}
                savedSlug={saved.fields.slug}
                errors={no?.fields ?? {}}
                dirty={isDirty}
                publishing={busy === "publish"}
                onPublish={() => void publish()}
                onSettings={() => params({ tab: "settings" })}
              />
            )}
          </TabPanel>
        </div>
        {preview && <Preview draft={draft} onClose={() => params({ preview: null })} />}
      </div>
    </div>
  );
}

export function BuilderRoute() {
  const { id = "" } = useParams();
  const q = useQuery({ queryKey: key(id), queryFn: ({ signal }) => api.get<FormDoc>(docPath("Form", id), undefined, signal), staleTime: 0 });
  if (q.error) return <StatePanel kind={q.error instanceof ApiError && q.error.status === 403 ? "denied" : "failed"} error={q.error} onRetry={() => void q.refetch()} title={tr("Could not open this form")} />;
  if (!q.data) return <FormSkeleton />;
  return <BuilderPage key={id} doc={q.data} />;
}
