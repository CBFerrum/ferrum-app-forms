// Forms: every form the person can build, with what it has gathered, and the things to do with
// one without opening it (see its results, copy its link, close it, copy it).

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart3, Copy, Ellipsis, ExternalLink, Globe, Link2, Lock, Plus, Search, Trash2 } from "lucide-react";
import { useCallback, useMemo } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api, ApiError, docPath, errorMessage, relativeTime, t, isolate } from "@ferrum/client";
import { Badge, Button, confirmDialog, EmptyState, ErrorState, toast, useLiveEntity, useShellTitle } from "@ferrum/kit";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@ferrum/kit/primitives";
import { can, useEntityMeta } from "@ferrum/records";
import { STATUS_LABEL, STATUS_TONE, type Status } from "./formdoc";
import { copy, linkOf } from "./Share";

interface FormRow {
  id: string;
  title?: string | null;
  kind?: string | null;
  status?: Status | null;
  slug?: string | null;
  access?: string | null;
  updated_at?: string | null;
  closes_at?: string | null;
  response_limit?: number | null;
}

interface Overview {
  form: string;
  responses: number | null;
  views: number;
  completion_rate: string | null;
  last_response_at: string | null;
}

const FILTERS: [string, string][] = [
  ["", "All"],
  ["Draft", "Drafts"],
  ["Published", "Open"],
  ["Closed", "Closed"],
];

export function Home() {
  useShellTitle(t("Forms"));
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  const q = sp.get("q") ?? "";
  const status = sp.get("status") ?? "";
  const meta = useEntityMeta("Form").data;

  const forms = useQuery({
    queryKey: ["forms", "list"],
    queryFn: ({ signal }) => api.get<{ rows: FormRow[] }>("/api/v1/Form", { fields: "title,kind,status,slug,access,updated_at,closes_at,response_limit", sort: "updated_at desc", limit: 500 }, signal).then((r) => r.rows),
  });
  // The counts are a bonus: a form is listed even when they cannot be read.
  const overview = useQuery({
    queryKey: ["forms", "overview"],
    queryFn: ({ signal }) => api.get<{ rows: Overview[] }>("/api/reports/forms_overview", undefined, signal).then((r) => new Map(r.rows.map((o) => [o.form, o]))),
    retry: false,
  });
  const refresh = useCallback(() => void qc.invalidateQueries({ queryKey: ["forms"] }), [qc]);
  useLiveEntity("Form", refresh);
  useLiveEntity("FormResponse", useCallback(() => void qc.invalidateQueries({ queryKey: ["forms", "overview"] }), [qc]));

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (forms.data ?? []).filter((f) => (!status || f.status === status) && (!needle || [f.title, f.slug, f.kind].some((v) => v?.toLowerCase().includes(needle))));
  }, [forms.data, q, status]);

  const set = (p: Record<string, string>) =>
    setSp(
      (cur) => {
        const next = new URLSearchParams(cur);
        for (const [k, v] of Object.entries(p)) v ? next.set(k, v) : next.delete(k);
        return next;
      },
      { replace: true },
    );

  const act = async (f: FormRow, action: "publish" | "close" | "duplicate") => {
    try {
      const r = await api.post<{ id?: string }>(docPath("Form", f.id, "actions", action), {});
      refresh();
      if (action === "duplicate" && r.id) navigate(`/b/${r.id}`);
      else toast(action === "close" ? t("Closed") : t("Published"));
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const remove = async (f: FormRow) => {
    const ok = await confirmDialog({ title: t("Delete “{value}”?", { value: f.title ?? "this form" }), message: t("A form with responses cannot be deleted: close it instead."), confirmLabel: t("Delete it"), danger: true });
    if (!ok) return;
    try {
      await api.del(docPath("Form", f.id));
      refresh();
      toast(t("Deleted"));
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const canCreate = can(meta?.permissions, "create");
  const denied = forms.error instanceof ApiError && forms.error.status === 403;

  return (
    <div className="fm-page">
      <header className="page-head">
        <div>
          <h1 className="page-title">{t("Forms")}</h1>
          <p className="page-sub" aria-live="polite">
            {forms.data ? `${forms.data.length} ${forms.data.length === 1 ? "form" : "forms"}` : " "}
          </p>
        </div>
        <div className="page-actions">
          {canCreate && (
            <Link className="btn btn-primary btn-md" to="/new">
              <Plus size={16} aria-hidden="true" />
              {t("New form")}
            </Link>
          )}
        </div>
      </header>

      {denied ? (
        <EmptyState title={t("Forms are built by people with the Forms User role")} icon="doc">
          <p className="muted">{t("If someone sent you a link to a form, open that link to answer it. To build forms, ask an administrator of this workspace for the role.")}</p>
        </EmptyState>
      ) : forms.error ? (
        <ErrorState error={forms.error} onRetry={() => void forms.refetch()} />
      ) : !forms.data ? (
        <div className="fm-list" aria-busy="true" aria-label={t("Loading the forms")}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="fm-form fm-skeleton">
              <span className="skeleton" style={{ width: "40%", height: 16 }} />
              <span className="skeleton" style={{ width: "25%" }} />
            </div>
          ))}
        </div>
      ) : (
        <>
          {forms.data.length > 0 && (
            <div className="fm-tools">
              <div className="fm-search">
                <Search size={15} aria-hidden="true" />
                <input type="search" aria-label={t("Find a form")} placeholder={t("Find a form…")} value={q} onChange={(e) => set({ q: e.target.value })} />
              </div>
              <div className="chips" role="group" aria-label={t("Show")}>
                {FILTERS.map(([v, label]) => (
                  <button key={v} type="button" className="chip" aria-pressed={status === v} onClick={() => set({ status: v })}>
                    {isolate(label)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {!forms.data.length ? (
            <EmptyState title={t("No forms yet")} icon="doc">
              <p className="muted">{t("Build a form, a survey or a quiz, publish it, and share its link.")}</p>
              {canCreate && (
                <Link className="btn btn-primary btn-md" to="/new">
                  <Plus size={16} aria-hidden="true" />
                  {t("Make your first form")}
                </Link>
              )}
            </EmptyState>
          ) : !shown.length ? (
            <EmptyState title={t("No form matches")} icon="search">
              <Button onClick={() => set({ q: "", status: "" })}>{t("Show every form")}</Button>
            </EmptyState>
          ) : (
            <ul className="fm-list">
              {shown.map((f) => {
                const o = overview.data?.get(f.id);
                const live = f.status === "Published";
                return (
                  <li key={f.id} className="fm-form">
                    <div className="fm-form-main">
                      <Link className="fm-form-title" to={`/b/${f.id}`}>
                        {f.title || t("Untitled form")}
                      </Link>
                      <p className="fm-form-meta faint">
                        <span>{isolate(f.kind ?? "")}</span>
                        <span className="fm-dot" aria-hidden="true" />
                        <span title={f.access === "Internal" ? t("Only people signed in to this workspace") : t("Anyone with the link")}>
                          {f.access === "Internal" ? <Lock size={12} aria-hidden="true" /> : <Globe size={12} aria-hidden="true" />} {f.access === "Internal" ? t("Workspace") : t("Public")}
                        </span>
                        {f.updated_at && (
                          <>
                            <span className="fm-dot" aria-hidden="true" />
                            <span>{t("Edited")} {isolate(relativeTime(f.updated_at))}</span>
                          </>
                        )}
                      </p>
                    </div>
                    <Badge tone={STATUS_TONE[f.status ?? "Draft"]}>{isolate(STATUS_LABEL[f.status ?? "Draft"])}</Badge>
                    <Link className="fm-stat" to={`/b/${f.id}/results`} title={t("See the results")}>
                      <strong>{o?.responses ?? "–"}</strong>
                      <span className="faint">{o?.responses === 1 ? t("response") : t("responses")}</span>
                    </Link>
                    <p className="fm-stat">
                      <strong>{o?.completion_rate != null ? `${Number(o.completion_rate)}%` : "–"}</strong>
                      <span className="faint">{t("completed")}</span>
                    </p>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button type="button" className="icon-btn" aria-label={t("More for {value}", { value: f.title ?? "this form" })}>
                          <Ellipsis size={16} aria-hidden="true" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild>
                          <Link to={`/b/${f.id}`}>{t("Edit")}</Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem asChild>
                          <Link to={`/b/${f.id}/results`}>
                            <BarChart3 size={14} aria-hidden="true" /> {t("Results")}
                          </Link>
                        </DropdownMenuItem>
                        {f.slug && (
                          <DropdownMenuItem onSelect={() => void copy(linkOf(f.slug as string))}>
                            <Link2 size={14} aria-hidden="true" /> {t("Copy the link")}
                          </DropdownMenuItem>
                        )}
                        {f.slug && live && (
                          <DropdownMenuItem asChild>
                            <a href={linkOf(f.slug)} target="_blank" rel="noopener noreferrer">
                              <ExternalLink size={14} aria-hidden="true" /> {t("Open it")}
                            </a>
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onSelect={() => void act(f, "duplicate")}>
                          <Copy size={14} aria-hidden="true" /> {t("Make a copy")}
                        </DropdownMenuItem>
                        {live ? (
                          <DropdownMenuItem onSelect={() => void act(f, "close")}>
                            <Lock size={14} aria-hidden="true" /> {t("Close it")}
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem onSelect={() => void act(f, "publish")}>{f.status === "Closed" ? t("Reopen it") : t("Publish it")}</DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onSelect={() => void remove(f)}>
                          <Trash2 size={14} aria-hidden="true" /> {t("Delete")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
