import type { Issue } from "@ludelier/schema";

/**
 * Manifest-driven form model: turn a world task's params JSON Schema (from
 * `session.describe()`) into renderable form fields, and collect typed-in values back
 * into the params object `session.edit()` expects. This is the human half of parity —
 * a form derived here invokes the exact same manipulate task the agent calls, so a new
 * task registered in the world gets a usable edit form with zero editor code.
 *
 * Deliberately pragmatic: it interprets the JSON Schema subset the current manipulate
 * tasks actually emit (flat objects of string/number/boolean/enum props, one nested
 * object level, scalar `anyOf` unions, and `oneOf` unions discriminated on a const tag).
 * Anything else — arrays, exotic combinators — falls back to a raw-JSON textarea, so an
 * unanticipated schema is never a dead end, just a less comfortable field.
 *
 * Pure and DOM-free (golden rule 4): derivation, prefill, and collection are all
 * testable in Vitest without a browser; `TaskForm.tsx` is a thin renderer over this.
 */

// ── field model ──────────────────────────────────────────────────────────────

export interface UnionVariant {
  /** The discriminator's const value for this variant (e.g. `"say"`). */
  tag: string;
  /** The variant's own fields — the discriminator property is excluded (the select owns it). */
  fields: FormField[];
}

export type FormField =
  | { kind: "string"; name: string; required: boolean; pattern?: string }
  | { kind: "number"; name: string; required: boolean; integer: boolean }
  | { kind: "boolean"; name: string; required: boolean }
  | { kind: "enum"; name: string; required: boolean; options: string[]; initial?: string }
  /** A string|number|boolean union (the schema's VarValue) — one input, type-coerced on collect. */
  | { kind: "scalar"; name: string; required: boolean }
  | { kind: "object"; name: string; required: boolean; fields: FormField[] }
  | { kind: "union"; name: string; required: boolean; discriminator: string; variants: UnionVariant[] }
  /** Fallback: raw JSON textarea for anything the interpreter doesn't model. */
  | { kind: "json"; name: string; required: boolean };

/** Sentinel field name for the whole-params JSON fallback (the schema itself was opaque). */
export const RAW_PARAMS = "$params";

// ── value model (what the form component holds in state) ─────────────────────

/** Raw input text (string/number/enum/scalar/json), a checkbox, or a nested structure. */
export type FieldValue = string | boolean | FormValues | UnionValue;
export interface FormValues {
  [name: string]: FieldValue;
}
export interface UnionValue {
  tag: string;
  values: FormValues;
}

export type CollectResult = { success: true; params: unknown } | { success: false; issues: Issue[] };

// ── JSON Schema interpretation ────────────────────────────────────────────────

/** The (loose) shape of the JSON Schema nodes Zod 4's toJSONSchema emits. */
interface SchemaNode {
  type?: unknown;
  properties?: unknown;
  required?: unknown;
  enum?: unknown;
  const?: unknown;
  anyOf?: unknown;
  oneOf?: unknown;
  pattern?: unknown;
  default?: unknown;
}

function asNode(raw: unknown): SchemaNode | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as SchemaNode) : null;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** True when every branch is a bare primitive type — the VarValue `anyOf` shape. */
function isScalarUnion(anyOf: unknown): boolean {
  if (!Array.isArray(anyOf) || anyOf.length === 0) return false;
  return anyOf.every((b) => {
    const n = asNode(b);
    return (
      n !== null &&
      (n.type === "string" || n.type === "number" || n.type === "boolean" || n.type === "integer")
    );
  });
}

/**
 * Detect a discriminated union: every `oneOf` branch is an object schema sharing one
 * property whose schema is a distinct string `const`. Returns the field, or null when
 * the branches don't fit (caller falls back to raw JSON).
 */
function deriveUnion(name: string, oneOf: unknown, required: boolean): FormField | null {
  if (!Array.isArray(oneOf) || oneOf.length === 0) return null;
  const branches: { props: Record<string, unknown>; required: string[] }[] = [];
  for (const b of oneOf) {
    const n = asNode(b);
    const props = asNode(n?.properties);
    if (n?.type !== "object" || !props) return null;
    branches.push({
      props: props as Record<string, unknown>,
      required: isStringArray(n.required) ? n.required : [],
    });
  }
  // Candidate discriminators: const-string props of the first branch, in declaration order.
  const first = branches[0]!;
  outer: for (const key of Object.keys(first.props)) {
    const tags: string[] = [];
    for (const b of branches) {
      const c = asNode(b.props[key])?.const;
      if (typeof c !== "string" || tags.includes(c)) continue outer;
      tags.push(c);
    }
    const variants: UnionVariant[] = branches.map((b, i) => ({
      tag: tags[i]!,
      fields: Object.entries(b.props)
        .filter(([k]) => k !== key)
        .map(([k, prop]) => deriveField(k, prop, b.required.includes(k))),
    }));
    return { kind: "union", name, required, discriminator: key, variants };
  }
  return null;
}

function objectFields(node: SchemaNode): FormField[] {
  const props = asNode(node.properties) as Record<string, unknown>;
  const required = isStringArray(node.required) ? node.required : [];
  return Object.entries(props).map(([name, prop]) => deriveField(name, prop, required.includes(name)));
}

function deriveField(name: string, raw: unknown, required: boolean): FormField {
  const s = asNode(raw);
  if (!s) return { kind: "json", name, required };
  if (isStringArray(s.enum)) {
    const initial = typeof s.default === "string" ? s.default : undefined;
    return initial !== undefined
      ? { kind: "enum", name, required, options: s.enum, initial }
      : { kind: "enum", name, required, options: s.enum };
  }
  // A lone const renders as a single-option select — fixed, but visible and collected.
  if (typeof s.const === "string")
    return { kind: "enum", name, required, options: [s.const], initial: s.const };
  if (s.anyOf !== undefined) {
    return isScalarUnion(s.anyOf) ? { kind: "scalar", name, required } : { kind: "json", name, required };
  }
  if (s.oneOf !== undefined) return deriveUnion(name, s.oneOf, required) ?? { kind: "json", name, required };
  switch (s.type) {
    case "string":
      return typeof s.pattern === "string"
        ? { kind: "string", name, required, pattern: s.pattern }
        : { kind: "string", name, required };
    case "number":
      return { kind: "number", name, required, integer: false };
    case "integer":
      return { kind: "number", name, required, integer: true };
    case "boolean":
      return { kind: "boolean", name, required };
    case "object":
      return asNode(s.properties)
        ? { kind: "object", name, required, fields: objectFields(s) }
        : { kind: "json", name, required };
    default:
      return { kind: "json", name, required };
  }
}

/**
 * Derive the form fields for one task's params schema (a `describe()` manifest entry's
 * `schema`). A non-object root degrades to a single whole-params JSON field.
 */
export function deriveTaskFields(schema: unknown): FormField[] {
  const node = asNode(schema);
  if (node?.type === "object" && asNode(node.properties)) return objectFields(node);
  return [{ kind: "json", name: RAW_PARAMS, required: true }];
}

// ── values: empty / prefill ───────────────────────────────────────────────────

/**
 * Render a scalar (VarValue) as input text such that `coerceScalar` round-trips it:
 * strings that would coerce to something else (numeric-looking, `true`/`false`, empty)
 * are JSON-quoted so their string-ness survives the trip.
 */
function formatScalar(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  return coerceScalar(s) === s && s !== "" ? s : JSON.stringify(s);
}

const NUMERIC = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Interpret one input string as a VarValue: quoted → string, `true`/`false` → boolean,
 * numeric-looking → number, everything else → the string as typed.
 */
export function coerceScalar(raw: string): string | number | boolean {
  const t = raw.trim();
  if (t.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(t);
      if (typeof parsed === "string") return parsed;
    } catch {
      // fall through — treat as a plain string
    }
  }
  if (t === "true") return true;
  if (t === "false") return false;
  if (NUMERIC.test(t)) return Number(t);
  return raw;
}

function emptyValue(field: FormField): FieldValue {
  switch (field.kind) {
    case "boolean":
      return false;
    case "enum":
      return field.initial ?? (field.required ? (field.options[0] ?? "") : "");
    case "object":
      return emptyValues(field.fields);
    case "union": {
      const v = field.variants[0];
      return { tag: v?.tag ?? "", values: emptyValues(v?.fields ?? []) };
    }
    default:
      return "";
  }
}

export function emptyValues(fields: FormField[]): FormValues {
  const out: FormValues = {};
  for (const f of fields) out[f.name] = emptyValue(f);
  return out;
}

function prefillValue(field: FormField, v: unknown): FieldValue {
  if (v === undefined) return emptyValue(field);
  switch (field.kind) {
    case "string":
    case "enum":
      return typeof v === "string" ? v : String(v);
    case "number":
      return typeof v === "number" ? String(v) : emptyValue(field);
    case "boolean":
      return v === true;
    case "scalar":
      return formatScalar(v);
    case "object":
      return initialValues(field.fields, v);
    case "union": {
      const rec = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
      const tag = rec?.[field.discriminator];
      const variant = field.variants.find((x) => x.tag === tag);
      if (!variant) return emptyValue(field);
      return { tag: variant.tag, values: initialValues(variant.fields, v) };
    }
    case "json":
      return JSON.stringify(v, null, 2);
  }
}

/**
 * Build the form's initial value tree, optionally prefilled from an existing params
 * object (e.g. update-statement prefilled with the statement's current value).
 */
export function initialValues(fields: FormField[], prefill?: unknown): FormValues {
  if (prefill === undefined || typeof prefill !== "object" || prefill === null) return emptyValues(fields);
  const rec = prefill as Record<string, unknown>;
  const out: FormValues = {};
  for (const f of fields) out[f.name] = prefillValue(f, rec[f.name]);
  return out;
}

// ── collect: values → params ──────────────────────────────────────────────────

function str(v: FieldValue | undefined): string {
  return typeof v === "string" ? v : "";
}

/** True when every field of an (optional) object subtree is still untouched. */
function isAllEmpty(fields: FormField[], values: FormValues): boolean {
  return fields.every((f) => {
    const v = values[f.name];
    switch (f.kind) {
      case "boolean":
        return v !== true;
      case "object":
        return typeof v === "object" && v !== null && !("tag" in (v as object))
          ? isAllEmpty(f.fields, v as FormValues)
          : true;
      default:
        return str(v) === "";
    }
  });
}

function collectInto(
  fields: FormField[],
  values: FormValues,
  prefix: string,
): { value: Record<string, unknown>; issues: Issue[] } {
  const value: Record<string, unknown> = {};
  const issues: Issue[] = [];
  for (const field of fields) {
    const v = values[field.name];
    const path = prefix === "" ? field.name : `${prefix}.${field.name}`;
    switch (field.kind) {
      case "string":
      case "enum": {
        const raw = str(v);
        if (raw === "" && !field.required) break;
        value[field.name] = raw;
        break;
      }
      case "number": {
        const raw = str(v).trim();
        if (raw === "") {
          if (field.required) issues.push({ path, message: "required" });
          break;
        }
        const n = Number(raw);
        if (!Number.isFinite(n)) issues.push({ path, message: `"${raw}" is not a number` });
        else if (field.integer && !Number.isInteger(n)) issues.push({ path, message: "must be an integer" });
        else value[field.name] = n;
        break;
      }
      case "boolean": {
        value[field.name] = v === true;
        break;
      }
      case "scalar": {
        const raw = str(v);
        if (raw.trim() === "" && !field.required) break;
        value[field.name] = coerceScalar(raw);
        break;
      }
      case "object": {
        const sub = typeof v === "object" && v !== null && !("tag" in (v as object)) ? (v as FormValues) : {};
        if (!field.required && isAllEmpty(field.fields, sub)) break;
        const r = collectInto(field.fields, sub, path);
        issues.push(...r.issues);
        value[field.name] = r.value;
        break;
      }
      case "union": {
        const uv = typeof v === "object" && v !== null && "tag" in (v as object) ? (v as UnionValue) : null;
        const variant = field.variants.find((x) => x.tag === uv?.tag) ?? field.variants[0];
        if (!variant) {
          issues.push({ path, message: "union has no variants" });
          break;
        }
        const r = collectInto(variant.fields, uv?.values ?? {}, path);
        issues.push(...r.issues);
        value[field.name] = { [field.discriminator]: variant.tag, ...r.value };
        break;
      }
      case "json": {
        const raw = str(v).trim();
        if (raw === "") {
          if (field.required) issues.push({ path, message: "required" });
          break;
        }
        try {
          value[field.name] = JSON.parse(raw) as unknown;
        } catch (e) {
          issues.push({ path, message: `invalid JSON: ${(e as Error).message}` });
        }
        break;
      }
    }
  }
  return { value, issues };
}

/**
 * Collect the value tree back into the params object for `session.edit(name, params)`.
 * Only local input problems (unparseable number/JSON) fail here — everything semantic
 * (unknown ids, terminal-statement rule, cross-refs) is the world's job, and its issues
 * come back through the edit's `{success:false}` envelope for the same inline display.
 */
export function collectParams(fields: FormField[], values: FormValues): CollectResult {
  const only = fields[0];
  if (fields.length === 1 && only !== undefined && only.kind === "json" && only.name === RAW_PARAMS) {
    const raw = str(values[RAW_PARAMS]).trim();
    if (raw === "") return { success: true, params: {} };
    try {
      return { success: true, params: JSON.parse(raw) as unknown };
    } catch (e) {
      return {
        success: false,
        issues: [{ path: RAW_PARAMS, message: `invalid JSON: ${(e as Error).message}` }],
      };
    }
  }
  const { value, issues } = collectInto(fields, values, "");
  return issues.length > 0 ? { success: false, issues } : { success: true, params: value };
}
