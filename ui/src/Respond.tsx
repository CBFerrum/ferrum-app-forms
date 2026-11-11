// The page a form's link opens, for anyone: /forms/f/{workspace}/{form}, with no sign-in and no bar.
// It opens the form from the public endpoints; a form for the workspace's own people answers
// there only to a signed-in person, so when the public door says "not found" it tries that one
// (the cookie goes with it) before saying so. Closed, full, not open yet, missing and "sign in"
// are pages of their own, in the owner's words where they wrote some.

import { useQuery } from "@tanstack/react-query";
import { CalendarClock, Lock, SearchX } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef } from "react";
import { useParams, useSearchParams } from "react-router";
import { api, ApiError, bootstrap, shell, t as tr, isolate } from "@ferrum/client";
import { Button, FormSkeleton, placed } from "@ferrum/kit";
import { accentVars } from "./accent";
import { Notice, QuizResultView } from "./Done";
import type { Opened, QuizResult, Receipt } from "./model";
import { Frame, Runner } from "./Runner";
import { APP_BASE, closedState, formPath, loginPath, Refreshed, resultPath, siteBase } from "./site";

/** Sooner than this after the page opened, the server keeps a response as spam (its default;
 *  src/response.rs): a person never gets there that fast, and a quick tap on a one-question
 *  form waits a moment rather than being lost. */
const MIN_FILL_MS = 3200;

type Loaded =
  | { kind: "form"; opened: Opened; internal: boolean }
  | { kind: "closed"; message: string }
  | { kind: "missing" }
  | { kind: "signin" }
  | { kind: "forbidden" };

/** Public first; then, for a form only the workspace's people answer, the signed-in door. */
async function open(tenant: string, slug: string, query: Record<string, string>, signal?: AbortSignal): Promise<Loaded> {
  const name = encodeURIComponent(slug);
  try {
    return { kind: "form", opened: await api.get<Opened>(`${siteBase(tenant)}/f/${name}`, query, signal), internal: false };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    if (e.status === 409) return { kind: "closed", message: e.message };
    if (e.status !== 404) throw e;
  }
  try {
    return { kind: "form", opened: await api.get<Opened>(`${APP_BASE}/f/${name}`, query, signal), internal: true };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    if (e.status === 409) return { kind: "closed", message: e.message };
    if (e.status === 401) return { kind: "signin" };
    if (e.status === 403) return { kind: "forbidden" };
    if (e.status === 404) return { kind: "missing" };
    throw e;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The page's own skin: the form's colour when it has one, the workspace's otherwise. */
function Plain({ children, accent }: { children: ReactNode; accent?: string | null }) {
  return <Frame accent={accentVars(accent) as CSSProperties | undefined}>{children}</Frame>;
}

function Loading() {
  return (
    <Plain>
      <FormSkeleton />
    </Plain>
  );
}

function Missing({ workspace }: { workspace?: string }) {
  return (
    <Plain>
      <Notice icon={<SearchX size={26} />} title={tr("This form is not available")}>
        <p>{placed(tr("The link may be wrong, or the form is not published. Ask the person who sent it to you{p1} for a new link."), { p1: workspace ? tr(" at {workspace}", { workspace }) : "" })}</p>
      </Notice>
    </Plain>
  );
}

export function RespondPage() {
  const { tenant = "", slug = "" } = useParams();
  const [params] = useSearchParams();
  const query = useMemo(() => Object.fromEntries(params) as Record<string, string>, [params]);
  const keep = useMemo(() => ({ tenant, slug }), [tenant, slug]);
  const boot = bootstrap();
  const workspace = boot?.workspace.name;
  const zone = boot?.locale.timezone ?? "UTC";
  useEffect(() => shell().ready(), []);

  // The form is opened once: every opening counts as a view, and the session in it lasts a day.
  const q = useQuery({
    queryKey: ["respond", tenant, slug],
    queryFn: ({ signal }) => open(tenant, slug, query, signal),
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const loaded = q.data;
  const opened = loaded?.kind === "form" ? loaded.opened : null;
  const internal = loaded?.kind === "form" && loaded.internal;
  const token = useRef("");
  const sessionAt = useRef(Date.now());
  useEffect(() => {
    token.current = opened?.token ?? "";
    sessionAt.current = Date.now();
  }, [opened?.token]);
  useEffect(() => {
    document.title = opened ? opened.form.title : loaded ? "Form" : tr("Opening the form…");
  }, [opened, loaded]);

  if (q.error) {
    return (
      <Plain>
        <Notice icon={<SearchX size={26} />} title={tr("We could not open this form")} actions={<Button onClick={() => void q.refetch()}>{tr("Try again")}</Button>}>
          <p>{q.error instanceof ApiError && q.error.status !== 0 ? q.error.message : tr("Check your connection and try again.")}</p>
        </Notice>
      </Plain>
    );
  }
  if (!loaded) return <Loading />;
  if (loaded.kind === "missing") return <Missing workspace={workspace} />;
  if (loaded.kind === "signin") {
    return (
      <Plain>
        <Notice
          icon={<Lock size={26} />}
          title={tr("Sign in to open this form")}
          actions={
            <a className="btn btn-primary btn-md" href={loginPath(window.location.pathname + window.location.search)}>
              {tr("Sign in")}
            </a>
          }
        >
          <p>{placed(tr("This form is not public. If it is for people in {p1}, sign in to answer it."), { p1: workspace ?? tr("this workspace") })}</p>
        </Notice>
      </Plain>
    );
  }
  if (loaded.kind === "forbidden") {
    return (
      <Plain>
        <Notice icon={<Lock size={26} />} title={tr("This form is not for you")}>
          <p>{placed(tr("It is for people who work in {p1}. Your account is not one of them."), { p1: workspace ?? tr("this workspace") })}</p>
        </Notice>
      </Plain>
    );
  }
  if (loaded.kind === "closed") {
    const c = closedState(loaded.message);
    return (
      <Plain>
        <Notice icon={c.opensAt ? <CalendarClock size={26} /> : <Lock size={26} />} title={c.title}>
          {c.body && <p>{isolate(c.body)}</p>}
        </Notice>
      </Plain>
    );
  }

  const { form } = loaded.opened;
  const base = internal ? APP_BASE : siteBase(tenant);
  const send = async (answers: Record<string, unknown>, honeypot: string): Promise<Receipt> => {
    // Not before a person could have filled it in.
    const wait = sessionAt.current + MIN_FILL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await api.post<Receipt>(`${base}/f/${encodeURIComponent(slug)}/responses`, { token: token.current, answers, honeypot }, { idempotencyKey: token.current });
    } catch (e) {
      if (e instanceof ApiError && e.status === 422 && e.fields.some((f) => f.field === "token")) {
        // The page was open too long, or its session was not understood: a fresh one, same answers.
        await q.refetch();
        throw new Refreshed();
      }
      throw e;
    }
  };

  return <Runner form={form} prefill={loaded.opened.prefill} zone={zone} workspace={workspace} send={send} keep={keep} resultLink={(t) => resultPath(tenant, slug, t)} />;
}

// ───────────────────────────── a quiz result, kept as a link ─────────────────────────────

interface Result {
  form: { title: string; slug: string };
  number?: string | null;
  result: QuizResult;
}

async function openResult(tenant: string, token: string, signal?: AbortSignal): Promise<Result | null> {
  const t = encodeURIComponent(token);
  for (const base of [siteBase(tenant), APP_BASE]) {
    try {
      return await api.get<Result>(`${base}/results/${t}`, undefined, signal);
    } catch (e) {
      if (!(e instanceof ApiError) || ![404, 401, 403].includes(e.status)) throw e;
    }
  }
  return null;
}

/** /forms/f/{workspace}/{form}/result/{token}: the result a respondent was sent, for 30 days. */
export function ResultPage() {
  const { tenant = "", slug = "", token = "" } = useParams();
  useEffect(() => shell().ready(), []);
  const q = useQuery({ queryKey: ["result", tenant, token], queryFn: ({ signal }) => openResult(tenant, token, signal), staleTime: Infinity, retry: false, refetchOnWindowFocus: false });
  useEffect(() => {
    document.title = q.data ? tr("Your result · {title}", { title: q.data.form.title }) : tr("Your result");
  }, [q.data]);
  if (q.error) {
    return (
      <Plain>
        <Notice icon={<SearchX size={26} />} title={tr("We could not open this result")} actions={<Button onClick={() => void q.refetch()}>{tr("Try again")}</Button>}>
          <p>{tr("Check your connection and try again.")}</p>
        </Notice>
      </Plain>
    );
  }
  if (q.isPending) return <Loading />;
  if (!q.data) {
    return (
      <Plain>
        <Notice icon={<SearchX size={26} />} title={tr("This result is no longer here")}>
          <p>{tr("Result links work for 30 days after the quiz was sent.")}</p>
          <p>
            <a href={formPath(tenant, slug)}>{tr("Open the form")}</a>
          </p>
        </Notice>
      </Plain>
    );
  }
  return (
    <Plain>
      <div className="fr-form">
        <header className="fr-head">
          <h1 className="fr-title">{isolate(q.data.form.title)}</h1>
          <p className="fr-desc">{tr("Your result")}{q.data.number ? `, ${q.data.number}` : ""}</p>
        </header>
        <QuizResultView result={q.data.result} />
      </div>
    </Plain>
  );
}
