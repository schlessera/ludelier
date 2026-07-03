import { describe, expect, it } from "vitest";
import { createWorld } from "@ludelier/world";
import {
  deriveTaskFields,
  initialValues,
  emptyValues,
  collectParams,
  coerceScalar,
  RAW_PARAMS,
  type FormField,
  type FormValues,
  type UnionValue,
} from "../src/forms/model";

// Derive against the REAL manifest — the whole point is that the human forms and the
// agent tools are generated from the same schemas, so the tests must track them too.
const manifest = createWorld().describe();

function schemaOf(name: string): unknown {
  const entry = manifest.find((t) => t.name === name);
  if (!entry) throw new Error(`no task "${name}" in manifest`);
  return entry.schema;
}

function field(fields: FormField[], name: string): FormField {
  const f = fields.find((x) => x.name === name);
  if (!f) throw new Error(`no field "${name}" in [${fields.map((x) => x.name).join(", ")}]`);
  return f;
}

function unionField(fields: FormField[], name: string): Extract<FormField, { kind: "union" }> {
  const f = field(fields, name);
  if (f.kind !== "union") throw new Error(`field "${name}" is ${f.kind}, not union`);
  return f;
}

function variantOf(u: Extract<FormField, { kind: "union" }>, tag: string): FormField[] {
  const v = u.variants.find((x) => x.tag === tag);
  if (!v) throw new Error(`no variant "${tag}"`);
  return v.fields;
}

describe("deriveTaskFields — real manifest schemas", () => {
  it("derives flat string fields with required flags (add-character)", () => {
    const fields = deriveTaskFields(schemaOf("add-character"));
    expect(fields.map((f) => f.name)).toEqual(["id", "name", "color"]);
    expect(field(fields, "id")).toMatchObject({ kind: "string", required: true });
    expect(field(fields, "name")).toMatchObject({ kind: "string", required: true });
    expect(field(fields, "color")).toMatchObject({ kind: "string", required: false });
  });

  it("derives number fields with the integer flag (set-meta seed, rewire-goto optionIndex)", () => {
    expect(field(deriveTaskFields(schemaOf("set-meta")), "seed")).toMatchObject({
      kind: "number",
      integer: true,
      required: false,
    });
    expect(field(deriveTaskFields(schemaOf("rewire-goto")), "optionIndex")).toMatchObject({
      kind: "number",
      integer: true,
      required: false,
    });
  });

  it("derives the statement union discriminated on op, with op excluded from variants", () => {
    const u = unionField(deriveTaskFields(schemaOf("add-statement")), "statement");
    expect(u.discriminator).toBe("op");
    const tags = u.variants.map((v) => v.tag);
    expect(tags).toContain("say");
    expect(tags).toContain("choice");
    expect(tags).toContain("end");
    expect(new Set(tags).size).toBe(tags.length); // distinct tags
    const say = variantOf(u, "say");
    expect(say.map((f) => f.name)).toEqual(["id", "who", "text"]); // no `op` — the select owns it
    expect(field(say, "who")).toMatchObject({ kind: "string", required: true });
    expect(field(say, "id")).toMatchObject({ required: false });
  });

  it("derives an enum with its default (show.at)", () => {
    const u = unionField(deriveTaskFields(schemaOf("update-statement")), "statement");
    expect(field(variantOf(u, "show"), "at")).toMatchObject({
      kind: "enum",
      options: ["left", "center", "right"],
      initial: "center",
    });
  });

  it("derives a nested object with an enum and a scalar (branch.cond)", () => {
    const u = unionField(deriveTaskFields(schemaOf("add-statement")), "statement");
    const cond = field(variantOf(u, "branch"), "cond");
    expect(cond.kind).toBe("object");
    if (cond.kind !== "object") return;
    expect(field(cond.fields, "cmp")).toMatchObject({
      kind: "enum",
      options: ["eq", "ne", "gt", "lt", "gte", "lte"],
    });
    expect(field(cond.fields, "value")).toMatchObject({ kind: "scalar", required: true });
  });

  it("falls back to raw JSON for arrays (choice.options) — unsupported is never a dead end", () => {
    const u = unionField(deriveTaskFields(schemaOf("add-statement")), "statement");
    expect(field(variantOf(u, "choice"), "options")).toMatchObject({ kind: "json", required: true });
  });

  it("falls back to a single whole-params JSON field for an opaque root schema", () => {
    expect(deriveTaskFields({ type: "array" })).toEqual([{ kind: "json", name: RAW_PARAMS, required: true }]);
    expect(deriveTaskFields(true)).toEqual([{ kind: "json", name: RAW_PARAMS, required: true }]);
  });

  it("gives every manipulate task a non-empty form (a future task gets one for free)", () => {
    for (const t of manifest.filter((x) => x.kind === "manipulate")) {
      expect(deriveTaskFields(t.schema).length, t.name).toBeGreaterThan(0);
    }
  });
});

describe("initialValues — prefill", () => {
  const updFields = deriveTaskFields(schemaOf("update-statement"));

  it("prefills update-statement from an existing say statement", () => {
    const v = initialValues(updFields, {
      nodeId: "start",
      statementId: "start#2",
      statement: { op: "say", who: "narrator", text: "Hello." },
    });
    expect(v.nodeId).toBe("start");
    expect(v.statementId).toBe("start#2");
    const stmt = v.statement as UnionValue;
    expect(stmt.tag).toBe("say");
    expect(stmt.values.who).toBe("narrator");
    expect(stmt.values.text).toBe("Hello.");
  });

  it("prefills a nested condition and round-trips it through collect", () => {
    const prefill = {
      nodeId: "sit",
      statementId: "sit#4",
      statement: { op: "branch", cond: { var: "trust", cmp: "gte", value: 2 }, goto: "warm" },
    };
    const v = initialValues(updFields, prefill);
    const collected = collectParams(updFields, v);
    expect(collected).toEqual({ success: true, params: prefill });
  });

  it("quotes ambiguous scalar strings so string-typed values survive the round-trip", () => {
    const prefill = {
      nodeId: "a",
      statementId: "a#0",
      statement: { op: "set", var: "code", value: "5" }, // the STRING "5", not the number
    };
    const v = initialValues(updFields, prefill);
    const stmt = v.statement as UnionValue;
    expect(stmt.values.value).toBe('"5"');
    expect(collectParams(updFields, v)).toEqual({ success: true, params: prefill });
  });

  it("falls back to empty values when the prefill is absent", () => {
    const fields = deriveTaskFields(schemaOf("add-character"));
    expect(initialValues(fields)).toEqual(emptyValues(fields));
  });
});

describe("collectParams", () => {
  it("collects strings and omits blank optionals (add-character without color)", () => {
    const fields = deriveTaskFields(schemaOf("add-character"));
    const values = { ...emptyValues(fields), id: "rin", name: "Rin" };
    expect(collectParams(fields, values)).toEqual({ success: true, params: { id: "rin", name: "Rin" } });
  });

  it("parses numbers, and reports non-numeric / non-integer input with a path", () => {
    const fields = deriveTaskFields(schemaOf("set-meta"));
    const ok = collectParams(fields, { ...emptyValues(fields), seed: "42" });
    expect(ok).toEqual({ success: true, params: { seed: 42 } });
    const bad = collectParams(fields, { ...emptyValues(fields), seed: "many" });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.issues[0]).toMatchObject({ path: "seed" });
    const frac = collectParams(fields, { ...emptyValues(fields), seed: "1.5" });
    expect(frac.success).toBe(false);
  });

  it("coerces scalar input: numbers, booleans, quoted strings, plain strings", () => {
    expect(coerceScalar("5")).toBe(5);
    expect(coerceScalar("-2.5")).toBe(-2.5);
    expect(coerceScalar("true")).toBe(true);
    expect(coerceScalar("false")).toBe(false);
    expect(coerceScalar('"5"')).toBe("5");
    expect(coerceScalar('"true"')).toBe("true");
    expect(coerceScalar("hello there")).toBe("hello there");
  });

  it("collects a union value with the discriminator included (add-statement say)", () => {
    const fields = deriveTaskFields(schemaOf("add-statement"));
    const values: FormValues = {
      ...emptyValues(fields),
      nodeId: "start",
      statement: { tag: "say", values: { id: "", who: "narrator", text: "Hi." } },
    };
    expect(collectParams(fields, values)).toEqual({
      success: true,
      params: { nodeId: "start", statement: { op: "say", who: "narrator", text: "Hi." } },
    });
  });

  it("parses a JSON-fallback field inside a union variant (choice options)", () => {
    const fields = deriveTaskFields(schemaOf("add-statement"));
    const options = [{ label: "Go", goto: "next" }];
    const values: FormValues = {
      ...emptyValues(fields),
      nodeId: "start",
      statement: { tag: "choice", values: { id: "", prompt: "Now?", options: JSON.stringify(options) } },
    };
    expect(collectParams(fields, values)).toEqual({
      success: true,
      params: { nodeId: "start", statement: { op: "choice", prompt: "Now?", options } },
    });
  });

  it("reports invalid JSON in a json field with its dotted path", () => {
    const fields = deriveTaskFields(schemaOf("add-statement"));
    const values: FormValues = {
      ...emptyValues(fields),
      nodeId: "start",
      statement: { tag: "choice", values: { id: "", prompt: "", options: "not json" } },
    };
    const res = collectParams(fields, values);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.issues[0]?.path).toBe("statement.options");
      expect(res.issues[0]?.message).toMatch(/invalid JSON/);
    }
  });

  it("whole-params fallback parses the textarea as the entire params object", () => {
    const fields = deriveTaskFields({ type: "array" });
    expect(collectParams(fields, { [RAW_PARAMS]: '{"id":"x"}' })).toEqual({
      success: true,
      params: { id: "x" },
    });
    const bad = collectParams(fields, { [RAW_PARAMS]: "{oops" });
    expect(bad.success).toBe(false);
  });
});
