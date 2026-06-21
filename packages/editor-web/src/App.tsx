import { useEffect, useMemo, useReducer, useState } from "react";
import type { FormEvent } from "react";
import { EditorSession } from "@ludelier/editor-core";
import type { EditorSnapshot } from "@ludelier/editor-core";
import { validateStory } from "@ludelier/schema";
import { openRouterProvider } from "@ludelier/authoring";
import type { AgentRunResult } from "@ludelier/authoring";
import { PlayCanvas } from "./PlayCanvas";
import cafeStory from "../../../examples/cafe.story.json";

/** A counter that bumps on every session change (edit / undo / redo / chat) — drives re-render
 *  and signals the play preview to replay the updated story. */
function useSessionVersion(session: EditorSession): number {
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => session.subscribe(() => bump()), [session]);
  return version;
}

export function App(): JSX.Element {
  const session = useMemo(() => {
    const v = validateStory(cafeStory);
    if (!v.success) throw new Error(`example story invalid: ${JSON.stringify(v.issues)}`);
    return new EditorSession(v.data);
  }, []);
  const version = useSessionVersion(session);
  const snap = session.snapshot();

  return (
    <div className="app">
      <Toolbar session={session} snap={snap} />
      <div className="cols">
        <ChatPanel session={session} />
        <div className="center">
          <PlayCanvas session={session} version={version} />
          <StoryInspector snap={snap} />
        </div>
        <SidePanel session={session} snap={snap} />
      </div>
    </div>
  );
}

function Toolbar({ session, snap }: { session: EditorSession; snap: EditorSnapshot }): JSX.Element {
  const [newId, setNewId] = useState("");
  const [err, setErr] = useState<string | null>(null);

  function addNode(): void {
    const id = newId.trim();
    if (!id) return;
    const res = session.edit("create-node", { id });
    if (res.success) {
      setNewId("");
      setErr(null);
    } else {
      setErr(res.issues.map((i) => i.message).join("; "));
    }
  }

  return (
    <header className="toolbar">
      <div className="brand">
        Ludelier <span className="muted">· editor</span>
      </div>
      <span className={`badge ${snap.valid ? "ok" : "bad"}`}>{snap.valid ? "valid" : "invalid"}</span>
      {err && <span className="err">{err}</span>}
      <div className="spacer" />
      <button onClick={() => session.undo()} disabled={!snap.canUndo}>
        ↶ Undo
      </button>
      <button onClick={() => session.redo()} disabled={!snap.canRedo}>
        ↷ Redo
      </button>
      <input
        className="node-id"
        placeholder="new node id"
        value={newId}
        onChange={(e) => setNewId(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") addNode();
        }}
      />
      <button onClick={addNode} disabled={!newId.trim()}>
        ＋ Node
      </button>
    </header>
  );
}

function ChatPanel({ session }: { session: EditorSession }): JSX.Element {
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("openai/gpt-5-mini");
  const [prompt, setPrompt] = useState("Add a new secret ending and wire it in from an existing choice.");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AgentRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!apiKey.trim()) {
      setError("Paste an OpenRouter API key (BYOK).");
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const provider = openRouterProvider({
        apiKey: apiKey.trim(),
        model,
        appName: "Ludelier Editor",
        appUrl: location.origin,
      });
      const res = await session.chat(prompt, { provider, model, runId: `chat-${Date.now()}` });
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="panel chat">
      <h2>Agent chat</h2>
      <form onSubmit={onSubmit}>
        <input
          type="password"
          placeholder="OpenRouter API key (BYOK)"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        <input placeholder="model slug" value={model} onChange={(e) => setModel(e.target.value)} />
        <textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <button type="submit" disabled={running}>
          {running ? "Running…" : "Send"}
        </button>
      </form>
      {error && <p className="err">{error}</p>}
      {result && (
        <div className="run">
          <p>
            run <code>{result.runId.slice(0, 8)}</code> · {result.commands.length} edit(s) ·{" "}
            <span className={result.ok ? "ok" : "bad"}>{result.ok ? "clean" : "not clean"}</span> ·{" "}
            {result.completed ? "completed" : "incomplete"}
          </p>
          {(result.verification.unreachable.length > 0 || result.verification.deadEnds.length > 0) && (
            <p className="err">
              unreachable: [{result.verification.unreachable.join(", ")}] · dead ends: [
              {result.verification.deadEnds.join(", ")}]
            </p>
          )}
          <ul className="cmds">
            {result.commands.map((c) => (
              <li key={c.seq}>
                <code>{c.command}</code> {JSON.stringify(c.params)}
              </li>
            ))}
          </ul>
          <button onClick={() => session.revertRun(result.runId)}>Revert this run</button>
        </div>
      )}
    </section>
  );
}

function StoryInspector({ snap }: { snap: EditorSnapshot }): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);
  const unreachable = new Set(snap.graph.unreachable);
  const deadEnds = new Set(snap.graph.deadEnds);
  const node = snap.story.nodes.find((n) => n.id === selected) ?? null;

  return (
    <section className="panel inspector">
      <h2>Story</h2>
      <p className="muted">
        {snap.story.meta.title} · start: <code>{snap.story.meta.start}</code>
      </p>
      <ul className="nodes">
        {snap.story.nodes.map((n) => (
          <li
            key={n.id}
            className={n.id === selected ? "sel" : ""}
            onClick={() => setSelected(n.id)}
          >
            <code>{n.id}</code>
            {n.id === snap.story.meta.start && <span className="tag">start</span>}
            {unreachable.has(n.id) && <span className="tag bad">unreachable</span>}
            {deadEnds.has(n.id) && <span className="tag bad">dead end</span>}
            <span className="muted"> {n.body.length} stmt</span>
          </li>
        ))}
      </ul>
      {node && (
        <div className="node-detail">
          <h3>
            <code>{node.id}</code>
          </h3>
          <ol>
            {node.body.map((s, i) => (
              <li key={i}>
                <code>{s.op}</code> <span className="muted">{summarize(s)}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

function SidePanel({ session, snap }: { session: EditorSession; snap: EditorSnapshot }): JSX.Element {
  return (
    <section className="panel side">
      <h2>Graph health</h2>
      <dl className="health">
        <dt>valid</dt>
        <dd className={snap.valid ? "ok" : "bad"}>{String(snap.valid)}</dd>
        <dt>reachable</dt>
        <dd>{snap.graph.reachable.length}</dd>
        <dt>unreachable</dt>
        <dd className={snap.graph.unreachable.length ? "bad" : "ok"}>
          {snap.graph.unreachable.join(", ") || "none"}
        </dd>
        <dt>dead ends</dt>
        <dd className={snap.graph.deadEnds.length ? "bad" : "ok"}>
          {snap.graph.deadEnds.join(", ") || "none"}
        </dd>
      </dl>

      <h2>History</h2>
      {snap.records.length === 0 ? (
        <p className="muted">No edits yet.</p>
      ) : (
        <ol className="history">
          {snap.records.map((r) => (
            <li key={r.seq}>
              <code>{r.command}</code> <span className="muted">{r.runId.slice(0, 8)}</span>
            </li>
          ))}
        </ol>
      )}
      <button
        onClick={() => {
          void navigator.clipboard?.writeText(session.exportLog());
        }}
        disabled={snap.records.length === 0}
      >
        Copy edit log (JSONL)
      </button>
    </section>
  );
}

/** A short human summary of a statement for the inspector. */
function summarize(s: Record<string, unknown>): string {
  if (s.op === "say") return `${String(s.who)}: ${String(s.text)}`;
  if (s.op === "jump") return `→ ${String(s.goto)}`;
  if (s.op === "choice") return `${(s.options as unknown[] | undefined)?.length ?? 0} option(s)`;
  if (s.op === "scene") return `bg ${String(s.bg)}`;
  if (s.op === "show" || s.op === "hide") return String(s.asset ?? s.id ?? "");
  return "";
}
