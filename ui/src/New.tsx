// A new form: the title, and something to start from: nothing, or one of the workspace's templates (FormTemplate
// records, which anyone building forms may read and an agent may use). It is made as a draft and opens in the builder.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useNavigate, Link } from "react-router";
import { api, docPath, errorMessage, t as tr, isolate } from "@ferrum/client";
import { Alert, Button, Field, FormSkeleton, StatePanel, useShellTitle } from "@ferrum/kit";
import { can, useEntityMeta } from "@ferrum/records";
import type { FormDoc } from "./formdoc";

/** A template as the list of them gives it. */
export interface TemplateRow {
  id: string;
  template_name: string;
  kind: "Form" | "Survey" | "Quiz";
  description?: string | null;
}

const BLANK = "blank";

export function New() {
  useShellTitle(tr("New form"));
  const navigate = useNavigate();
  const qc = useQueryClient();
  const meta = useEntityMeta("Form");
  const templates = useQuery({
    queryKey: ["forms", "templates"],
    queryFn: ({ signal }) => api.get<{ rows: TemplateRow[] }>("/api/v1/FormTemplate", { fields: "template_name,kind,description", sort: "template_name asc", limit: 200 }, signal).then((r) => r.rows),
  });
  const [picked, setPicked] = useState(BLANK);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const template = templates.data?.find((t) => t.id === picked) ?? null;

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const made = template
        ? await api.post<{ id: string }>(docPath("FormTemplate", template.id, "actions", "use_template"), { title: title.trim() || undefined })
        : await api.post<FormDoc>("/api/v1/Form", { title: title.trim() || tr("Untitled form"), kind: "Form" });
      void qc.invalidateQueries({ queryKey: ["forms", "list"] });
      navigate(`/b/${made.id}`, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  if (meta.isPending) return <FormSkeleton />;
  if (meta.data && !can(meta.data.permissions, "create")) {
    return (
      <StatePanel kind="denied" title={tr("You cannot make forms here")} action={<Link to="/">{tr("Back to Forms")}</Link>}>
        {tr("Building forms needs the Forms User role. Ask an administrator of this workspace.")}
      </StatePanel>
    );
  }

  return (
    <form className="fm-page fm-new" onSubmit={(e) => void create(e)}>
      <p className="crumbs">
        <Link to="/">{tr("Forms")}</Link>
      </p>
      <h1 className="page-title">{tr("New form")}</h1>
      {error && <Alert tone="error">{isolate(error)}</Alert>}
      <Field label={tr("Title")} htmlFor="new-title" hint={tr("This is the title people see at the top of the form. You can change it in the builder.")}>
        <input id="new-title" className="input" autoFocus maxLength={200} placeholder={template ? template.template_name : tr("Untitled form")} value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <fieldset className="fm-templates">
        <legend className="field-label">{tr("Start from")}</legend>
        <div className="fm-template-grid">
          <label className="fm-template" data-picked={picked === BLANK ? "" : undefined}>
            <input type="radio" name="template" className="sr-only" checked={picked === BLANK} onChange={() => setPicked(BLANK)} />
            <strong>{tr("Blank form")}</strong>
            <span className="muted">{tr("Start from nothing.")}</span>
          </label>
          {templates.data?.map((t) => (
            <label key={t.id} className="fm-template" data-picked={picked === t.id ? "" : undefined}>
              <input type="radio" name="template" className="sr-only" checked={picked === t.id} onChange={() => setPicked(t.id)} />
              <strong>{isolate(t.template_name)}</strong>
              {t.description && <span className="muted">{isolate(t.description)}</span>}
              <span className="faint">{isolate(t.kind)}</span>
            </label>
          ))}
        </div>
        {templates.isPending && <p className="faint">{tr("Loading the templates…")}</p>}
        {templates.error && <p className="field-error">{tr("The templates could not be loaded: {message}", { message: errorMessage(templates.error) })}</p>}
      </fieldset>
      <div className="row">
        <Button type="submit" variant="primary" loading={busy}>
          {tr("Make the form")}
        </Button>
        <Link className="btn btn-default btn-md" to="/">
          {tr("Cancel")}
        </Link>
      </div>
    </form>
  );
}
