import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { FormEvent } from "react";
import { EditorSession } from "@ludelier/editor-core";
import type { EditorSnapshot, AgentEvent, AgentRunResult } from "@ludelier/editor-core";
import { validateStory } from "@ludelier/schema";
import { openRouterProvider } from "@ludelier/authoring";
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

/** A streamed event rendered as one human-readable feed line. */
function FeedLine({ e }: { e: AgentEvent }): JSX.Element | null {
  if (e.kind === "turn") return null; // tracked as a counter, not shown per-line
  if (e.kind === "assistant") return <li className="ev-assistant">{e.text}</li>;
  if (e.kind === "query") {
    return (
      <li className="ev-query muted">
        🔍 <code>{e.task}</code>
      </li>
    );
  }
  if (e.kind === "edit") {
    return (
      <li className={e.success ? "ev-edit" : "ev-edit bad"}>
        {e.success ? "✏️" : "✕"} <code>{e.command}</code>{" "}
        <span className="muted">{summarizeParams(e.params)}</span>
        {!e.success && e.issues.length > 0 && <span className="err"> — {e.issues[0]?.message}</span>}
      </li>
    );
  }
  if (e.kind === "verify") {
    return e.clean ? (
      <li className="ev-verify ok">✓ verified clean</li>
    ) : (
      <li className="ev-verify bad">⚠ {e.problems.join("; ")}</li>
    );
  }
  return <li className="ev-stop muted">■ {e.reason}</li>;
}

function ChatPanel({ session }: { session: EditorSession }): JSX.Element {
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("openai/gpt-5-mini");
  const [prompt, setPrompt] = useState("Add a full branching discussion about careers.");
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [step, setStep] = useState(0);
  const [result, setResult] = useState<AgentRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkpointStep, setCheckpointStep] = useState<number | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const checkpointResolve = useRef<((cont: boolean) => void) | null>(null);
  const feedRef = useRef<HTMLUListElement>(null);

  // Keep the live feed scrolled to the newest event.
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [events]);

  function answerCheckpoint(cont: boolean): void {
    setCheckpointStep(null);
    checkpointResolve.current?.(cont);
    checkpointResolve.current = null;
  }

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!apiKey.trim()) {
      setError("Paste an OpenRouter API key (BYOK).");
      return;
    }
    const ac = new AbortController();
    abortRef.current = ac;
    setRunning(true);
    setError(null);
    setResult(null);
    setEvents([]);
    setStep(0);
    try {
      const provider = openRouterProvider({
        apiKey: apiKey.trim(),
        model,
        appName: "Ludelier Editor",
        appUrl: location.origin,
      });
      const res = await session.chat(prompt, {
        provider,
        model,
        runId: `chat-${Date.now()}`,
        signal: ac.signal,
        onEvent: (ev) => {
          if (ev.kind === "turn") setStep(ev.step + 1);
          else setEvents((prev) => [...prev, ev]);
        },
        onCheckpoint: (s) =>
          new Promise<boolean>((resolve) => {
            setCheckpointStep(s);
            checkpointResolve.current = resolve;
          }),
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
      abortRef.current = null;
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
        <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={running} />
        {running ? (
          <button type="button" className="danger" onClick={() => abortRef.current?.abort()}>
            ✕ Interrupt {step > 0 ? `(turn ${step})` : ""}
          </button>
        ) : (
          <button type="submit">Send</button>
        )}
      </form>

      {error && <p className="err">{error}</p>}

      {checkpointStep !== null && (
        <div className="checkpoint">
          <p>Ran {checkpointStep} turns. Keep going?</p>
          <button onClick={() => answerCheckpoint(true)}>Continue</button>
          <button className="danger" onClick={() => answerCheckpoint(false)}>
            Stop
          </button>
        </div>
      )}

      {(running || events.length > 0) && (
        <ul className="feed" ref={feedRef}>
          {events.map((ev, i) => (
            <FeedLine key={i} e={ev} />
          ))}
          {running && <li className="ev-live muted">… working (turn {step})</li>}
        </ul>
      )}

      {result && (
        <div className="run">
          <p>
            {result.commands.length} edit(s) ·{" "}
            <span className={result.ok ? "ok" : "bad"}>{result.ok ? "clean" : "not clean"}</span> ·{" "}
            {result.stopReason}
          </p>
          {(result.verification.unreachable.length > 0 || result.verification.deadEnds.length > 0) && (
            <p className="err">
              unreachable: [{result.verification.unreachable.join(", ")}] · dead ends: [
              {result.verification.deadEnds.join(", ")}]
            </p>
          )}
          {result.commands.length > 0 && (
            <button onClick={() => session.revertRun(result.runId)}>Revert this run</button>
          )}
        </div>
      )}
    </section>
  );
}

/** Compact one-line summary of an edit command's params for the live feed. */
function summarizeParams(params: unknown): string {
  if (!params || typeof params !== "object") return "";
  const p = params as Record<string, unknown>;
  if (typeof p.id === "string") return p.id;
  if (typeof p.nodeId === "string") return String(p.nodeId);
  return JSON.stringify(p).slice(0, 60);
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
