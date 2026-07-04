import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { FormEvent } from "react";
import { EditorSession } from "@ludelier/editor-core";
import type { EditorSnapshot, AgentEvent, AgentRunResult } from "@ludelier/editor-core";
import { validateStory } from "@ludelier/schema";
import type { Issue, Story } from "@ludelier/schema";
import type { TaskManifestEntry } from "@ludelier/world";
import { openRouterProvider } from "@ludelier/authoring";
import { PlayCanvas } from "./PlayCanvas";
import { StoryMap } from "./storymap/StoryMap";
import { ScriptLens } from "./storymap/ScriptLens";
import { TaskForm } from "./forms/TaskForm";
import { newStoryScaffold, parseStoryJson, serializeStory, storyFileName } from "./story/files";
import cafeStory from "../../../examples/cafe.story.json";

/** A counter that bumps on every session change (edit / undo / redo / chat) — drives re-render
 *  and signals the play preview to replay the updated story. */
function useSessionVersion(session: EditorSession): number {
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => session.subscribe(() => bump()), [session]);
  return version;
}

function makeInitialSession(): EditorSession {
  const v = validateStory(cafeStory);
  if (!v.success) throw new Error(`example story invalid: ${JSON.stringify(v.issues)}`);
  return new EditorSession(v.data);
}

export function App(): JSX.Element {
  // The session is swappable at runtime (Open / New / Import log). `key` counts swaps: it
  // keys the PlayCanvas so a swap remounts the renderer and replays the new story (the
  // version counter alone doesn't bump on a swap).
  const [current, setCurrent] = useState(() => ({ session: makeInitialSession(), key: 0 }));
  const { session, key } = current;
  const version = useSessionVersion(session);
  // Snapshot recomputes validateStory + graph analysis, so memoize it on the session-change
  // counter — selection clicks re-render App but don't re-run that work.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the deliberate recompute signal — snapshot() reads mutable session state a counter must invalidate
  const snap = useMemo(() => session.snapshot(), [session, version]);
  // The task manifest (name/description/JSON Schema) drives every human edit form — the
  // same list the agent's toolset is derived from (parity). Stable per session.
  const manifest = useMemo(() => session.describe(), [session]);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedNode = snap.story.nodes.find((n) => n.id === selected) ?? null;

  // A selected node can vanish when the agent deletes it — drop the stale selection so the
  // lens, preview, and map agree (and a later node reusing the id isn't silently re-selected).
  useEffect(() => {
    if (selected !== null && !snap.story.nodes.some((n) => n.id === selected)) setSelected(null);
  }, [snap, selected]);

  // e2e readiness flag (mirrors the runtime-web player): flips once the shell has rendered,
  // so Playwright waits on a concrete signal instead of a timeout.
  useEffect(() => {
    document.documentElement.dataset.ready = "1";
  }, []);

  /** Swap in a freshly opened/imported/new session; the old one (and its history) is dropped. */
  function openSession(next: EditorSession): void {
    setSelected(null);
    setCurrent((prev) => ({ session: next, key: prev.key + 1 }));
  }

  return (
    <div className="app">
      <Toolbar session={session} snap={snap} onOpenSession={openSession} />
      <div className="cols">
        <ChatPanel session={session} />
        <div className="center">
          {/* Keyed by the swap counter (namespaced — same-key siblings would collide and
              duplicate): a swapped-in session must remount the renderer and must not inherit
              form state or error text that referred to the previous story (ChatPanel is
              deliberately not keyed — the BYOK key/model/prompt are session-independent). */}
          <PlayCanvas
            key={`play-${key}`}
            session={session}
            version={version}
            startNode={selected ?? undefined}
          />
          {/* Keyed too: React Flow's fitView only fires on init, so without a remount an
              Open/New would keep the previous story's pan/zoom over a different graph.
              Within a session, edits deliberately do NOT refit — the viewport holds, and
              the Controls' fit-view button re-frames on demand. */}
          <StoryMap key={`map-${key}`} snap={snap} selected={selected} onSelect={setSelected} />
          <ScriptLens key={`lens-${key}`} node={selectedNode} session={session} manifest={manifest} />
        </div>
        <SidePanel
          key={`side-${key}`}
          session={session}
          snap={snap}
          manifest={manifest}
          onOpenSession={openSession}
        />
      </div>
    </div>
  );
}

/** Render a handful of issues as one compact line (file-open / import errors). */
function formatIssues(issues: Issue[], max = 3): string {
  const shown = issues.slice(0, max).map((i) => `${i.path}: ${i.message}`);
  const more = issues.length - shown.length;
  return shown.join("; ") + (more > 0 ? ` (+${more} more)` : "");
}

/** Trigger a browser download of `text` as `filename` (Blob + temporary anchor). */
function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function Toolbar({
  session,
  snap,
  onOpenSession,
}: {
  session: EditorSession;
  snap: EditorSnapshot;
  onOpenSession: (next: EditorSession) => void;
}): JSX.Element {
  const [newId, setNewId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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

  /** Open a `.story.json`: parse + validate; an invalid file reports issues and keeps the
   *  current session untouched (the always-valid invariant extends to what we open). */
  async function openFile(file: File): Promise<void> {
    const res = parseStoryJson(await file.text());
    if (!res.success) {
      setErr(`open failed — ${formatIssues(res.issues)}`);
      return;
    }
    setErr(null);
    onOpenSession(new EditorSession(res.story));
  }

  return (
    <header className="toolbar">
      <div className="brand">
        Ludelier <span className="muted">· editor</span>
      </div>
      <span className={`badge ${snap.valid ? "ok" : "bad"}`} data-testid="validity-badge">
        {snap.valid ? "valid" : "invalid"}
      </span>
      <span className="muted story-title" data-testid="story-title">
        {snap.story.meta.title}
      </span>
      {err && <span className="err">{err}</span>}
      <div className="spacer" />
      <button
        type="button"
        onClick={() => onOpenSession(new EditorSession(newStoryScaffold()))}
        disabled={session.busy}
        title="Start a minimal new story"
      >
        New
      </button>
      <button type="button" onClick={() => fileRef.current?.click()} disabled={session.busy}>
        Open…
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void openFile(file);
          e.target.value = ""; // allow re-opening the same file after a fix
        }}
      />
      <button
        type="button"
        onClick={() => downloadText(storyFileName(snap.story), serializeStory(snap.story))}
        title="Download the current story as JSON"
      >
        Save
      </button>
      <span className="toolbar-sep" />
      <button type="button" onClick={() => session.undo()} disabled={!snap.canUndo}>
        ↶ Undo
      </button>
      <button type="button" onClick={() => session.redo()} disabled={!snap.canRedo}>
        ↷ Redo
      </button>
      <input
        className="node-id"
        data-testid="new-node-id"
        placeholder="new node id"
        value={newId}
        onChange={(e) => setNewId(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") addNode();
        }}
      />
      <button type="button" onClick={addNode} disabled={!newId.trim()}>
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
    if (!e.clean) return <li className="ev-verify bad">⚠ {e.problems.join("; ")}</li>;
    return (
      <li className="ev-verify ok">
        ✓ verified clean
        {e.warnings && e.warnings.length > 0 && <span className="muted"> · ⚠ {e.warnings.join("; ")}</span>}
      </li>
    );
  }
  return <li className="ev-stop muted">■ {e.reason}</li>;
}

/** localStorage slot for the opt-in remembered BYOK key. Plain text by necessity (there is
 *  no client-side secret to encrypt with) — hence opt-in, labelled, and easy to clear. */
const KEY_STORE = "ludelier.byok.openrouter";

function ChatPanel({ session }: { session: EditorSession }): JSX.Element {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(KEY_STORE) ?? "");
  const [remember, setRemember] = useState(() => localStorage.getItem(KEY_STORE) !== null);
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: `events` is the scroll trigger — the effect reads only the ref, but must run per appended event
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
        // runAgent's default (500) would make the checkpoint prompt unreachable in
        // practice — 25 turns is long enough to build, short enough to stay supervised.
        checkpointEvery: 25,
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
      // A run can end while a checkpoint prompt is showing (Interrupt races it) — clear it.
      setCheckpointStep(null);
      checkpointResolve.current = null;
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
          onChange={(e) => {
            setApiKey(e.target.value);
            if (remember) localStorage.setItem(KEY_STORE, e.target.value);
          }}
        />
        <label className="remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => {
              setRemember(e.target.checked);
              if (e.target.checked) localStorage.setItem(KEY_STORE, apiKey);
              else localStorage.removeItem(KEY_STORE);
            }}
          />
          Remember key on this device (stored unencrypted in this browser)
        </label>
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
          <button type="button" onClick={() => answerCheckpoint(true)}>
            Continue
          </button>
          <button type="button" className="danger" onClick={() => answerCheckpoint(false)}>
            Stop
          </button>
        </div>
      )}

      {(running || events.length > 0) && (
        <ul className="feed" ref={feedRef}>
          {events.map((ev, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the feed is append-only within a run (and reset per run) — indices are stable identities here
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
            <button type="button" onClick={() => session.revertRun(result.runId)}>
              Revert this run
            </button>
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
  const node = typeof p.nodeId === "string" ? `${p.nodeId} · ` : "";
  const stmt = p.statement as { op?: string } | undefined;
  if (stmt?.op) return `${node}${stmt.op}`;
  if (typeof p.statementId === "string") return `${node}${p.statementId}`;
  if (typeof p.id === "string") return p.id;
  if (typeof p.nodeId === "string") return String(p.nodeId);
  return JSON.stringify(p).slice(0, 60);
}

/** Context prefill for the side panel's task forms — currently just set-meta's live values. */
function taskPrefill(name: string, story: Story): unknown {
  if (name === "set-meta") {
    return { title: story.meta.title, start: story.meta.start, seed: story.meta.seed };
  }
  return undefined;
}

/**
 * The generic manipulate-task forms, derived entirely from the manifest — a manipulate
 * task registered in the world shows up here with a working form, zero editor code.
 * The script lens adds the context-aware entry points for the statement ops; this list
 * is the exhaustive fallback (set-meta, add-character, register-asset, nodes, rewire…).
 */
function EditTasks({
  session,
  snap,
  manifest,
}: {
  session: EditorSession;
  snap: EditorSnapshot;
  manifest: TaskManifestEntry[];
}): JSX.Element {
  const tasks = manifest.filter((t) => t.kind === "manipulate");
  // Re-key prefilled forms on their prefill so an outside edit (agent, undo) refreshes them.
  const metaKey = `${snap.story.meta.title}·${snap.story.meta.start}·${snap.story.meta.seed}`;
  return (
    <details className="edit-tasks">
      <summary>
        <h2>Edit ({tasks.length} tasks)</h2>
      </summary>
      {tasks.map((t) => (
        <details key={t.name} className="edit-task">
          <summary>
            <code>{t.name}</code>
          </summary>
          <p className="muted task-desc">{t.description}</p>
          <TaskForm
            key={t.name === "set-meta" ? metaKey : t.name}
            session={session}
            name={t.name}
            schema={t.schema}
            prefill={taskPrefill(t.name, snap.story)}
          />
        </details>
      ))}
    </details>
  );
}

/**
 * The edit log grouped into consecutive runs, with a Revert button on the run that can
 * actually be reverted: `revertRun` is defined only for a contiguous TAIL of the history
 * (KTD-11), so exactly one group — the last — is actionable; earlier runs show why not.
 */
function RunHistory({ session, snap }: { session: EditorSession; snap: EditorSnapshot }): JSX.Element {
  const [err, setErr] = useState<string | null>(null);
  const runs: { runId: string; commands: string[] }[] = [];
  for (const r of snap.records) {
    const last = runs[runs.length - 1];
    if (last && last.runId === r.runId) last.commands.push(r.command);
    else runs.push({ runId: r.runId, commands: [r.command] });
  }
  const tail = runs[runs.length - 1];

  function revert(runId: string): void {
    const res = session.revertRun(runId);
    setErr(res.success ? null : res.issues.map((i) => i.message).join("; "));
  }

  return (
    <>
      <ol className="history">
        {runs.map((run, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: run groups are re-derived per snapshot and only ever truncated from the tail — positional identity is stable
          <li key={`${i}-${run.runId}`} className="run-group">
            <div className="run-head">
              <span className="muted">
                {run.runId.slice(0, 12)} · {run.commands.length} edit(s)
              </span>
              {run === tail && (
                <button
                  type="button"
                  className="danger small"
                  onClick={() => revert(run.runId)}
                  disabled={session.busy}
                  title="Drop this run's edits (only the most recent run can be reverted)"
                >
                  Revert
                </button>
              )}
            </div>
            <ul className="run-cmds">
              {run.commands.map((c, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: commands within a run are append-only and re-derived per snapshot
                <li key={j}>
                  <code>{c}</code>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      {err && <p className="err">{err}</p>}
    </>
  );
}

function SidePanel({
  session,
  snap,
  manifest,
  onOpenSession,
}: {
  session: EditorSession;
  snap: EditorSnapshot;
  manifest: TaskManifestEntry[];
  onOpenSession: (next: EditorSession) => void;
}): JSX.Element {
  const [logErr, setLogErr] = useState<string | null>(null);
  const logRef = useRef<HTMLInputElement>(null);

  /** Replay an exported `.log.jsonl` onto the current session's base story. The pairing
   *  matters: open the base `.story.json` first, then import the log recorded over it. */
  async function importLogFile(file: File): Promise<void> {
    const res = EditorSession.fromLog(session.baseStory, await file.text());
    if (!res.success) {
      setLogErr(`import failed — ${formatIssues(res.issues)}`);
      return;
    }
    setLogErr(null);
    onOpenSession(res.data);
  }

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

      <EditTasks session={session} snap={snap} manifest={manifest} />

      <h2>History</h2>
      {snap.records.length === 0 ? (
        <p className="muted">No edits yet.</p>
      ) : (
        <RunHistory session={session} snap={snap} />
      )}
      <div className="log-actions">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(session.exportLog());
          }}
          disabled={snap.records.length === 0}
        >
          Copy edit log (JSONL)
        </button>
        <button
          type="button"
          onClick={() => logRef.current?.click()}
          disabled={session.busy}
          title="Replay a .log.jsonl onto this session's base story"
        >
          Import log…
        </button>
        <input
          ref={logRef}
          type="file"
          accept=".jsonl,.log,.txt,application/jsonl"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importLogFile(file);
            e.target.value = "";
          }}
        />
      </div>
      {logErr && <p className="err">{logErr}</p>}
      <p className="muted hint">
        Import replays a log onto the current base story — open the matching .story.json first.
      </p>
    </section>
  );
}
