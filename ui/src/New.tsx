// A new form: the title, and something to start from. It is made as a draft and opens in the builder.

import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useNavigate, Link } from "react-router";
import { api, errorMessage, t as tr, isolate } from "@ferrum/client";
import { Alert, Button, EmptyState, Field, PageLoading, useShellTitle } from "@ferrum/kit";
import { can, useEntityMeta } from "@ferrum/records";
import { rowToDoc } from "./rows";
import type { FormDoc } from "./formdoc";
import { TEMPLATES } from "./templates";

export function New() {
  useShellTitle(tr("New form"));
  const navigate = useNavigate();
  const qc = useQueryClient();
  const meta = useEntityMeta("Form");
  const [picked, setPicked] = useState(TEMPLATES[0].id);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const template = TEMPLATES.find((t) => t.id === picked) ?? TEMPLATES[0];

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const made = await api.post<FormDoc>("/api/v1/Form", {
        title: title.trim() || (template.id === "blank" ? tr("Untitled form") : template.name),
        kind: template.kind,
        questions: template.rows().map(rowToDoc),
        ...template.settings,
      });
      void qc.invalidateQueries({ queryKey: ["forms", "list"] });
      navigate(`/b/${made.id}`, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  if (meta.isPending) return <PageLoading />;
  if (meta.data && !can(meta.data.permissions, "create")) {
    return (
      <EmptyState title={tr("You cannot make forms here")} icon="doc">
        <p className="muted">{tr("Building forms needs the Forms User role. Ask an administrator of this workspace.")}</p>
        <Link to="/">{tr("Back to Forms")}</Link>
      </EmptyState>
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
        <input id="new-title" className="input" autoFocus maxLength={200} placeholder={template.id === "blank" ? tr("Untitled form") : template.name} value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <fieldset className="fm-templates">
        <legend className="field-label">{tr("Start from")}</legend>
        <div className="fm-template-grid">
          {TEMPLATES.map((t) => (
            <label key={t.id} className="fm-template" data-picked={picked === t.id ? "" : undefined}>
              <input type="radio" name="template" className="sr-only" checked={picked === t.id} onChange={() => setPicked(t.id)} />
              <strong>{isolate(t.name)}</strong>
              <span className="muted">{isolate(t.hint)}</span>
              <span className="faint">{t.id === "blank" ? t.kind : tr("{kind} · {length} questions", { kind: t.kind, length: t.rows().length })}</span>
            </label>
          ))}
        </div>
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
