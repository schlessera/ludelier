import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import type { Layout, PanelImperativeHandle } from "react-resizable-panels";
import { EditorSession } from "@ludelier/editor-core";
import type { EditorSnapshot, AgentEvent, AgentRunResult } from "@ludelier/editor-core";
import { validateStory } from "@ludelier/schema";
import type { Issue, Story, StoryNode } from "@ludelier/schema";
import type { TaskManifestEntry } from "@ludelier/world";
import { openRouterProvider } from "@ludelier/authoring";
import type { AgentTool } from "@ludelier/authoring";
import { StoryMap } from "./storymap/StoryMap";
import { ScriptLens } from "./storymap/ScriptLens";
import { TaskForm } from "./forms/TaskForm";
import { HealthPanel } from "./health/HealthPanel";
import { PlayOverlay } from "./play/PlayOverlay";
import { newStoryScaffold, parseStoryJson, serializeStory, storyFileName } from "./story/files";
import { AssetPanel } from "./assets/AssetPanel";
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

/** Which inspector tab is showing: the selected node's script, the global edit forms,
 *  graph health, or the edit history. */
type InspectorTab = "node" | "edit" | "assets" | "health" | "history";

/** localStorage slot for the resizable column layout, so panel sizes survive reloads. */
const LAYOUT_STORE = "ludelier.editor.layout";

function loadLayout(): Layout | undefined {
  try {
    const raw = localStorage.getItem(LAYOUT_STORE);
    return raw ? (JSON.parse(raw) as Layout) : undefined;
  } catch {
    return undefined;
  }
}

function saveLayout(layout: Layout): void {
  try {
    localStorage.setItem(LAYOUT_STORE, JSON.stringify(layout));
  } catch {
    /* private-mode / quota — a non-persisted layout is a fine degradation */
  }
}

export function App(): JSX.Element {
  // The session is swappable at runtime (Open / New / Import log). `key` counts swaps: it
  // keys the PlayCanvas so a swap remounts the renderer and replays the new story (the
  // version counter alone doesn't bump on a swap).
  const [current, setCurrent] = useState(() => ({ session: makeInitialSession(), key: 0 }));
  const { session, key } = current;
  const currentSessionRef = useRef(session);
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

  // Which inspector tab is showing. Selecting a node jumps to "node" (below) so a click on
  // the graph immediately reveals that node's script.
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("node");
  const [playOpen, setPlayOpen] = useState(false);
  const [assetTool, setAssetTool] = useState<AgentTool | undefined>();
  const [assetEventVersion, bumpAssetEvent] = useReducer((n: number) => n + 1, 0);
  // A human asset transaction crosses provider and persistence awaits without taking the
  // EditorSession lock. Keep a synchronous app-level guard so Chat cannot acquire that lock
  // between media persistence and its subsequent Story registration.
  const assetGenerationActiveRef = useRef(false);
  const [assetGenerationActive, setAssetGenerationActive] = useState(false);
  const setHumanAssetGenerationActive = useCallback((active: boolean): void => {
    assetGenerationActiveRef.current = active;
    setAssetGenerationActive(active);
  }, []);
  const canStartAgentRun = useCallback((): boolean => !assetGenerationActiveRef.current, []);

  // Collapsible side docks (react-resizable-panels imperative handles). The panels stay
  // MOUNTED when collapsed — collapse is size→0, not unmount — so ChatPanel keeps its BYOK
  // key / in-flight run and the inspector keeps its state.
  const chatRef = useRef<PanelImperativeHandle>(null);
  const inspectorRef = useRef<PanelImperativeHandle>(null);
  const [chatOpen, setChatOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  // Read the persisted column layout once (localStorage) — a stable value so re-renders
  // don't hand the panel group a new object mid-session.
  const [initialLayout] = useState(loadLayout);

  function toggleDock(ref: React.RefObject<PanelImperativeHandle | null>): void {
    const p = ref.current;
    if (!p) return;
    if (p.isCollapsed()) p.expand();
    else p.collapse();
  }

  /** Select a node from the graph: reveal its script in the inspector (expanding the dock
   *  if the author had collapsed it) so a click always shows what was clicked. */
  function selectNode(id: string): void {
    setSelected(id);
    setInspectorTab("node");
    inspectorRef.current?.expand();
  }

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

  /**
   * Replace only the session captured by the initiating control. Async Open/Import work may
   * complete after New or another session replacement; neither a stale completion nor an active
   * agent/human asset transaction may mutate its detached session.
   */
  const openSession = useCallback((expected: EditorSession, next: EditorSession): boolean => {
    const live = currentSessionRef.current;
    if (live !== expected || live.busy || assetGenerationActiveRef.current) return false;
    currentSessionRef.current = next;
    setSelected(null);
    setAssetTool(undefined);
    setCurrent((previous) => {
      if (previous.session !== expected || previous.session.busy || assetGenerationActiveRef.current) {
        currentSessionRef.current = previous.session;
        return previous;
      }
      return { session: next, key: previous.key + 1 };
    });
    return true;
  }, []);

  return (
    <div className="app">
      <Toolbar
        session={session}
        snap={snap}
        onOpenSession={openSession}
        assetGenerationActive={assetGenerationActive}
        onPlay={() => setPlayOpen(true)}
      />
      <div className="workspace">
        <nav className="rail" aria-label="Panels">
          <button
            type="button"
            className={`rail-btn ${chatOpen ? "active" : ""}`}
            onClick={() => toggleDock(chatRef)}
            title="Toggle agent chat"
            aria-pressed={chatOpen}
          >
            💬
          </button>
          <button
            type="button"
            className={`rail-btn ${inspectorOpen ? "active" : ""}`}
            onClick={() => toggleDock(inspectorRef)}
            title="Toggle inspector"
            aria-pressed={inspectorOpen}
          >
            ☰
          </button>
          <div className="rail-spacer" />
          <button
            type="button"
            className="rail-btn play"
            onClick={() => setPlayOpen(true)}
            title="Play preview"
          >
            ▶
          </button>
        </nav>

        <Group
          orientation="horizontal"
          id="editor"
          className="panels"
          defaultLayout={initialLayout}
          onLayoutChanged={saveLayout}
        >
          <Panel
            id="chat"
            panelRef={chatRef}
            collapsible
            collapsedSize={0}
            minSize="16%"
            defaultSize="24%"
            onResize={(size) => setChatOpen(size.asPercentage > 0)}
          >
            {/* Deliberately NOT keyed on session swap — the BYOK key/model/prompt are
                session-independent and should survive Open / New. Collapse is size→0, not
                unmount, so an in-flight run survives a toggle too. */}
            <ChatPanel
              session={session}
              assetTool={assetTool}
              onAssetHostEvent={bumpAssetEvent}
              assetGenerationActive={assetGenerationActive}
              canStartAgentRun={canStartAgentRun}
            />
          </Panel>
          <Separator className="handle" />

          <Panel id="graph" minSize="30%">
            {/* Keyed by the swap counter: React Flow's fitView only fires on init, so without
                a remount an Open/New would keep the previous story's pan/zoom over a different
                graph. Within a session, edits deliberately do NOT refit — the viewport holds. */}
            <StoryMap
              key={`map-${key}`}
              snap={snap}
              selected={selected}
              onSelect={selectNode}
              onPlay={() => setPlayOpen(true)}
            />
          </Panel>
          <Separator className="handle" />

          <Panel
            id="inspector"
            panelRef={inspectorRef}
            collapsible
            collapsedSize={0}
            minSize="18%"
            defaultSize="26%"
            onResize={(size) => setInspectorOpen(size.asPercentage > 0)}
          >
            {/* Keyed on swap so a new story doesn't inherit form/error state from the old. */}
            <Inspector
              key={`inspector-${key}`}
              session={session}
              snap={snap}
              manifest={manifest}
              selectedNode={selectedNode}
              tab={inspectorTab}
              onTab={setInspectorTab}
              onOpenSession={openSession}
              assetHostEventVersion={assetEventVersion}
              onAgentToolChange={setAssetTool}
              onHumanGenerationChange={setHumanAssetGenerationActive}
              assetGenerationActive={assetGenerationActive}
            />
          </Panel>
        </Group>
      </div>

      {playOpen && (
        <PlayOverlay
          session={session}
          version={version}
          startNode={selected ?? undefined}
          playKey={key}
          onClose={() => setPlayOpen(false)}
        />
      )}
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
  assetGenerationActive,
  onPlay,
}: {
  session: EditorSession;
  snap: EditorSnapshot;
  onOpenSession: (expected: EditorSession, next: EditorSession) => boolean;
  assetGenerationActive: boolean;
  onPlay: () => void;
}): JSX.Element {
  const [newId, setNewId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const replacementDisabled = session.busy || assetGenerationActive;

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
    if (!onOpenSession(session, new EditorSession(res.story))) {
      setErr("open canceled — the current session changed or has a pending operation.");
      return;
    }
    setErr(null);
  }

  function newSession(): void {
    if (!onOpenSession(session, new EditorSession(newStoryScaffold()))) {
      setErr("new canceled — the current session changed or has a pending operation.");
      return;
    }
    setErr(null);
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
        onClick={newSession}
        disabled={replacementDisabled}
        title="Start a minimal new story"
      >
        New
      </button>
      <button type="button" onClick={() => fileRef.current?.click()} disabled={replacementDisabled}>
        Open…
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        hidden
        disabled={replacementDisabled}
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
      <button type="button" onClick={() => session.undo()} disabled={session.busy || !snap.canUndo}>
        ↶ Undo
      </button>
      <button type="button" onClick={() => session.redo()} disabled={session.busy || !snap.canRedo}>
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
      <span className="toolbar-sep" />
      <button type="button" className="play-cta" onClick={onPlay} title="Play the story in an overlay">
        ▶ Play
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
  if (e.kind === "host-tool") {
    return (
      <li className={e.success ? "ev-edit" : "ev-edit bad"}>
        {e.success ? "✏️" : "✕"} <code>{e.name}</code> <span className="muted">{e.effects.join(", ")}</span>
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

function ChatPanel({
  session,
  assetTool,
  onAssetHostEvent,
  assetGenerationActive,
  canStartAgentRun,
}: {
  session: EditorSession;
  assetTool: AgentTool | undefined;
  onAssetHostEvent: () => void;
  assetGenerationActive: boolean;
  canStartAgentRun: () => boolean;
}): JSX.Element {
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
    if (running || assetGenerationActive || !canStartAgentRun()) {
      setError("Wait for the current asset generation to finish.");
      return;
    }
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
        tools: assetTool === undefined ? undefined : [assetTool],
        // runAgent's default (500) would make the checkpoint prompt unreachable in
        // practice — 25 turns is long enough to build, short enough to stay supervised.
        checkpointEvery: 25,
        onEvent: (ev) => {
          if (ev.kind === "turn") setStep(ev.step + 1);
          else {
            if (ev.kind === "host-tool" && ev.name === "generate-asset") onAssetHostEvent();
            setEvents((prev) => [...prev, ev]);
          }
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
        <textarea
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={running || assetGenerationActive}
        />
        {running ? (
          <button type="button" className="danger" onClick={() => abortRef.current?.abort()}>
            ✕ Interrupt {step > 0 ? `(turn ${step})` : ""}
          </button>
        ) : (
          <button
            type="submit"
            disabled={assetGenerationActive}
            title={assetGenerationActive ? "Wait for asset generation to finish." : undefined}
          >
            Send
          </button>
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
    <div className="edit-tasks">
      <p className="muted tab-hint">
        Every manipulate task, as a form. Node-scoped statement edits also live inline in the Node tab.
      </p>
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
    </div>
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

/**
 * The right-hand inspector. A fixed set of tabs (Node / Edit / Health / History) share one
 * scroll-isolated body, so selecting a node or a long node's script only swaps the body's
 * contents — it never reflows the graph or the chat. Selecting a node in the graph jumps to
 * the Node tab (see `selectNode` in App).
 */
function Inspector({
  session,
  snap,
  manifest,
  selectedNode,
  tab,
  onTab,
  onOpenSession,
  assetHostEventVersion,
  onAgentToolChange,
  onHumanGenerationChange,
  assetGenerationActive,
}: {
  session: EditorSession;
  snap: EditorSnapshot;
  manifest: TaskManifestEntry[];
  selectedNode: StoryNode | null;
  tab: InspectorTab;
  onTab: (t: InspectorTab) => void;
  onOpenSession: (expected: EditorSession, next: EditorSession) => boolean;
  assetHostEventVersion: number;
  onAgentToolChange: (tool: AgentTool | undefined) => void;
  onHumanGenerationChange: (active: boolean) => void;
  assetGenerationActive: boolean;
}): JSX.Element {
  const unhealthy =
    !snap.valid ||
    snap.graph.unreachable.length > 0 ||
    snap.graph.deadEnds.length > 0 ||
    !snap.explore.endReachable ||
    snap.explore.stuck.length > 0 ||
    snap.explore.crashed;
  return (
    <section className="panel inspector">
      <div className="tabs" role="tablist" aria-label="Inspector">
        <TabButton id="node" tab={tab} onTab={onTab}>
          Node
          {selectedNode && <code className="tab-badge">{selectedNode.id}</code>}
        </TabButton>
        <TabButton id="edit" tab={tab} onTab={onTab}>
          Edit
        </TabButton>
        <TabButton id="assets" tab={tab} onTab={onTab}>
          Assets
        </TabButton>
        <TabButton id="health" tab={tab} onTab={onTab}>
          Health
          {unhealthy && <span className="tab-dot bad" aria-hidden />}
        </TabButton>
        <TabButton id="history" tab={tab} onTab={onTab}>
          History
          {snap.records.length > 0 && <span className="tab-count">{snap.records.length}</span>}
        </TabButton>
      </div>
      <div className="tab-body">
        <div
          role="tabpanel"
          id="inspector-panel-node"
          aria-labelledby="inspector-tab-node"
          hidden={tab !== "node"}
        >
          {tab === "node" && <ScriptLens node={selectedNode} session={session} manifest={manifest} />}
        </div>
        <div
          role="tabpanel"
          id="inspector-panel-edit"
          aria-labelledby="inspector-tab-edit"
          hidden={tab !== "edit"}
        >
          {tab === "edit" && <EditTasks session={session} snap={snap} manifest={manifest} />}
        </div>
        <div
          role="tabpanel"
          id="inspector-panel-assets"
          aria-labelledby="inspector-tab-assets"
          hidden={tab !== "assets"}
        >
          <AssetPanel
            session={session}
            story={snap.story}
            hostEventVersion={assetHostEventVersion}
            onAgentToolChange={onAgentToolChange}
            onHumanGenerationChange={onHumanGenerationChange}
          />
        </div>
        <div
          role="tabpanel"
          id="inspector-panel-health"
          aria-labelledby="inspector-tab-health"
          hidden={tab !== "health"}
        >
          {tab === "health" && <HealthPanel valid={snap.valid} graph={snap.graph} explore={snap.explore} />}
        </div>
        <div
          role="tabpanel"
          id="inspector-panel-history"
          aria-labelledby="inspector-tab-history"
          hidden={tab !== "history"}
        >
          {tab === "history" && (
            <HistoryPanel
              session={session}
              snap={snap}
              onOpenSession={onOpenSession}
              assetGenerationActive={assetGenerationActive}
            />
          )}
        </div>
      </div>
    </section>
  );
}

const inspectorTabs: readonly InspectorTab[] = ["node", "edit", "assets", "health", "history"];

function TabButton({
  id,
  tab,
  onTab,
  children,
}: {
  id: InspectorTab;
  tab: InspectorTab;
  onTab: (t: InspectorTab) => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      id={`inspector-tab-${id}`}
      role="tab"
      aria-controls={`inspector-panel-${id}`}
      aria-selected={tab === id}
      tabIndex={tab === id ? 0 : -1}
      className={`tab ${tab === id ? "active" : ""}`}
      onClick={() => onTab(id)}
      onKeyDown={(event) => {
        const index = inspectorTabs.indexOf(id);
        const next =
          event.key === "ArrowRight"
            ? inspectorTabs[(index + 1) % inspectorTabs.length]
            : event.key === "ArrowLeft"
              ? inspectorTabs[(index - 1 + inspectorTabs.length) % inspectorTabs.length]
              : event.key === "Home"
                ? inspectorTabs[0]
                : event.key === "End"
                  ? inspectorTabs[inspectorTabs.length - 1]
                  : undefined;
        if (next === undefined) return;
        event.preventDefault();
        onTab(next);
        document.getElementById(`inspector-tab-${next}`)?.focus();
      }}
    >
      {children}
    </button>
  );
}

function HistoryPanel({
  session,
  snap,
  onOpenSession,
  assetGenerationActive,
}: {
  session: EditorSession;
  snap: EditorSnapshot;
  onOpenSession: (expected: EditorSession, next: EditorSession) => boolean;
  assetGenerationActive: boolean;
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
    if (!onOpenSession(session, res.data)) {
      setLogErr("import canceled — the current session changed or has a pending operation.");
      return;
    }
    setLogErr(null);
  }

  return (
    <>
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
          disabled={session.busy || assetGenerationActive}
          title="Replay a .log.jsonl onto this session's base story"
        >
          Import log…
        </button>
        <input
          ref={logRef}
          type="file"
          accept=".jsonl,.log,.txt,application/jsonl"
          hidden
          disabled={session.busy || assetGenerationActive}
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
    </>
  );
}
