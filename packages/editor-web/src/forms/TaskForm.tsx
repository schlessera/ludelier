import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { Issue } from "@ludelier/schema";
import type { EditorSession } from "@ludelier/editor-core";
import {
  deriveTaskFields,
  initialValues,
  emptyValues,
  collectParams,
  RAW_PARAMS,
  type FormField,
  type FormValues,
  type FieldValue,
  type UnionValue,
} from "./model";

/**
 * A generic edit form for any manipulate task, rendered from the task's manifest schema
 * (see `model.ts`). Submitting routes through `session.edit()` — the same always-valid
 * chokepoint the agent uses — and any `{success:false}` issues (local parse problems or
 * the world's semantic/validation errors) render inline as path + message.
 */
export function TaskForm({
  session,
  name,
  schema,
  prefill,
  submitLabel,
  onDone,
}: {
  session: EditorSession;
  name: string;
  schema: unknown;
  /** Optional params object to seed the fields from (e.g. the statement being updated). */
  prefill?: unknown;
  submitLabel?: string;
  /** Called after a successful edit (close the form / clear context). */
  onDone?: () => void;
}): JSX.Element {
  const fields = useMemo(() => deriveTaskFields(schema), [schema]);
  const [values, setValues] = useState<FormValues>(() => initialValues(fields, prefill));
  const [issues, setIssues] = useState<Issue[]>([]);

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    const collected = collectParams(fields, values);
    if (!collected.success) {
      setIssues(collected.issues);
      return;
    }
    const res = session.edit(name, collected.params);
    if (!res.success) {
      setIssues(res.issues);
      return;
    }
    setIssues([]);
    setValues(initialValues(fields, prefill));
    onDone?.();
  }

  return (
    <form className="task-form" onSubmit={onSubmit}>
      <FieldList fields={fields} values={values} onChange={setValues} />
      {issues.length > 0 && (
        <ul className="form-issues">
          {issues.map((i, k) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: issues are replaced wholesale on every submit — index identity is stable for the list's lifetime
            <li key={`${k}-${i.path}`} className="err">
              <code>{i.path}</code> {i.message}
            </li>
          ))}
        </ul>
      )}
      <div className="form-actions">
        <button type="submit" disabled={session.busy}>
          {submitLabel ?? "Apply"}
        </button>
      </div>
    </form>
  );
}

function FieldList({
  fields,
  values,
  onChange,
}: {
  fields: FormField[];
  values: FormValues;
  onChange: (v: FormValues) => void;
}): JSX.Element {
  return (
    <>
      {fields.map((f) => (
        <FieldInput
          key={f.name}
          field={f}
          value={values[f.name]}
          onChange={(fv) => onChange({ ...values, [f.name]: fv })}
        />
      ))}
    </>
  );
}

function text(v: FieldValue | undefined): string {
  return typeof v === "string" ? v : "";
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: FieldValue | undefined;
  onChange: (v: FieldValue) => void;
}): JSX.Element {
  const label = (
    <span className="field-label">
      {field.name === RAW_PARAMS ? "params (JSON)" : field.name}
      {!field.required && <span className="muted"> · optional</span>}
    </span>
  );
  switch (field.kind) {
    case "string":
    case "scalar":
      return (
        <label className="field">
          {label}
          <input value={text(value)} onChange={(e) => onChange(e.target.value)} />
        </label>
      );
    case "number":
      return (
        <label className="field">
          {label}
          <input inputMode="numeric" value={text(value)} onChange={(e) => onChange(e.target.value)} />
        </label>
      );
    case "boolean":
      return (
        <label className="field check">
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          {label}
        </label>
      );
    case "enum":
      return (
        <label className="field">
          {label}
          <select value={text(value)} onChange={(e) => onChange(e.target.value)}>
            {!field.required && <option value="">—</option>}
            {field.options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
      );
    case "json":
      return (
        <label className="field">
          {field.name === RAW_PARAMS ? (
            <span className="field-label">params (JSON)</span>
          ) : (
            <>
              {label}
              <span className="muted"> · JSON</span>
            </>
          )}
          <textarea
            rows={4}
            value={text(value)}
            onChange={(e) => onChange(e.target.value)}
            spellCheck={false}
          />
        </label>
      );
    case "object": {
      const sub =
        typeof value === "object" && value !== null && !("tag" in (value as object))
          ? (value as FormValues)
          : {};
      return (
        <fieldset className="field group">
          <legend>{field.name}</legend>
          <FieldList fields={field.fields} values={sub} onChange={onChange} />
        </fieldset>
      );
    }
    case "union": {
      const uv =
        typeof value === "object" && value !== null && "tag" in (value as object)
          ? (value as UnionValue)
          : { tag: field.variants[0]?.tag ?? "", values: {} };
      const variant = field.variants.find((x) => x.tag === uv.tag) ?? field.variants[0];
      return (
        <fieldset className="field group">
          <legend>{field.name}</legend>
          <label className="field">
            <span className="field-label">{field.discriminator}</span>
            <select
              value={uv.tag}
              onChange={(e) => {
                const next = field.variants.find((x) => x.tag === e.target.value);
                // Switching variant resets its fields — stale values from another op would
                // silently leak into params otherwise.
                if (next) onChange({ tag: next.tag, values: emptyValues(next.fields) });
              }}
            >
              {field.variants.map((x) => (
                <option key={x.tag} value={x.tag}>
                  {x.tag}
                </option>
              ))}
            </select>
          </label>
          {variant && (
            <FieldList
              fields={variant.fields}
              values={uv.values}
              onChange={(vals) => onChange({ tag: uv.tag, values: vals })}
            />
          )}
        </fieldset>
      );
    }
  }
}
