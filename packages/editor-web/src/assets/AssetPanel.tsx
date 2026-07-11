import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { AgentTool } from "@ludelier/authoring";
import type { EditorSession } from "@ludelier/editor-core";
import type { Story } from "@ludelier/schema";
import {
  createDefaultAssetHost,
  type AssetGenerationHost,
  type AssetGenerationInput,
  type AssetHostOutcome,
  type PreviewAssetOutcome,
} from "./model";

interface AssetPanelProps {
  readonly session: EditorSession;
  readonly story: Story;
  readonly hostEventVersion: number;
  readonly onAgentToolChange: (tool: AgentTool | undefined) => void;
  /** App-scoped guard prevents Chat from taking the session lock during this human transaction. */
  readonly onHumanGenerationChange?: (active: boolean) => void;
  /** Injectable only for hermetic component tests. Production uses the same browser host as chat. */
  readonly host?: AssetGenerationHost;
}

const imageRoles = ["background", "sprite"] as const;
const audioRoles = ["music", "sfx", "voice"] as const;

/**
 * Inspector half of asset parity. It invokes the same `AssetGenerationHost.generate` method that
 * the optional agent tool invokes; Story registration is deliberately a separate last step.
 */
export function AssetPanel({
  session,
  story,
  hostEventVersion,
  onAgentToolChange,
  onHumanGenerationChange,
  host,
}: AssetPanelProps): JSX.Element {
  const hostRef = useRef<AssetGenerationHost | null>(null);
  if (hostRef.current === null) hostRef.current = host ?? createDefaultAssetHost();
  const assetHost = hostRef.current;

  const [provider, setProvider] = useState<"openai" | "openrouter">("openai");
  const [model, setModel] = useState("gpt-image-2");
  const [kind, setKind] = useState<"image" | "audio">("image");
  const [role, setRole] = useState<"background" | "sprite" | "music" | "sfx" | "voice">("background");
  const [prompt, setPrompt] = useState("");
  const [assetId, setAssetId] = useState("generated_asset");
  const [destination, setDestination] = useState("generated/generated_asset.png");
  const [apiKey, setApiKey] = useState("");
  const [approved, setApproved] = useState(false);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<AssetHostOutcome | null>(null);
  const [registrationError, setRegistrationError] = useState<string | null>(null);
  const [presentation, setPresentation] = useState<{
    readonly kind: "image" | "audio";
    readonly storyId: string;
    readonly destination: string;
  } | null>(null);
  const [agentActivity, setAgentActivity] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const currentInput = useRef<AssetGenerationInput | null>(null);
  const outcomeRef = useRef<AssetHostOutcome | null>(null);
  const input: AssetGenerationInput = {
    storyId: story.meta.id,
    provider,
    model,
    kind,
    role,
    prompt,
    assetId,
    destination,
    apiKey,
    approved,
  };
  currentInput.current = input;

  useEffect(
    () => () => {
      abortRef.current?.abort();
      onHumanGenerationChange?.(false);
      assetHost.dispose();
    },
    [assetHost, onHumanGenerationChange],
  );

  useEffect(() => {
    if (hostEventVersion > 0) setAgentActivity(true);
  }, [hostEventVersion]);

  const replaceOutcome = useCallback(
    (next: AssetHostOutcome | null): void => {
      if (outcomeRef.current !== null) assetHost.release(outcomeRef.current);
      outcomeRef.current = next;
      setOutcome(next);
    },
    [assetHost],
  );

  const retainAgentPreview = useCallback(
    (next: PreviewAssetOutcome, submitted: AssetGenerationInput): void => {
      setRegistrationError(null);
      setPresentation({
        kind: submitted.kind,
        storyId: submitted.storyId,
        destination: submitted.destination,
      });
      replaceOutcome(next);
    },
    [replaceOutcome],
  );

  const agentTool = useMemo(() => {
    if (!approved || !apiKey.trim()) return undefined;
    return createGenerateAssetTool(assetHost, () => currentInput.current, retainAgentPreview);
  }, [apiKey, approved, assetHost, retainAgentPreview]);

  useEffect(() => {
    onAgentToolChange(agentTool);
    return () => onAgentToolChange(undefined);
  }, [agentTool, onAgentToolChange]);

  function updateKind(next: "image" | "audio"): void {
    setKind(next);
    setRole(next === "image" ? "background" : "music");
    setModel(next === "image" ? "gpt-image-2" : "gpt-4o-mini-tts");
    setDestination((value) => value.replace(/\.(png|mp3)$/, next === "image" ? ".png" : ".mp3"));
  }

  async function generate(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (running || session.busy) return;
    setRegistrationError(null);
    replaceOutcome(null);
    setPresentation(null);
    if (story.assets.some((asset) => asset.id === input.assetId)) {
      replaceOutcome({
        success: false,
        error: {
          code: "duplicate-asset",
          message: "A Story asset already uses this id.",
          mayHaveCharged: false,
        },
      });
      return;
    }

    const submitted = input;
    const controller = new AbortController();
    abortRef.current = controller;
    onHumanGenerationChange?.(true);
    setRunning(true);
    try {
      const next = await assetHost.generate(submitted, controller.signal);
      if (next.success) {
        setPresentation({
          kind: submitted.kind,
          storyId: submitted.storyId,
          destination: submitted.destination,
        });
      }
      if (next.success && next.mode === "persisted") {
        const registration = session.edit("register-asset", {
          id: next.asset.assetId,
          src: next.asset.publicUrl,
          kind: next.asset.kind,
          generated: true,
        });
        if (!registration.success) {
          setRegistrationError(
            "The media was saved, but its Story asset id is no longer valid. Choose another id.",
          );
        }
      }
      replaceOutcome(next);
    } finally {
      onHumanGenerationChange?.(false);
      setRunning(false);
      abortRef.current = null;
    }
  }

  const controlsDisabled = running || session.busy;
  const canGenerate = approved && !!apiKey.trim() && !controlsDisabled;
  const roles = kind === "image" ? imageRoles : audioRoles;
  const outcomeId =
    outcome !== null && outcome.success
      ? outcome.mode === "persisted"
        ? outcome.asset.assetId
        : outcome.assetId
      : "";

  return (
    <section className="assets-panel" data-testid="asset-panel">
      <h2>Assets</h2>
      <p className="muted tab-hint">
        Generate media with an in-memory BYOK key, or inspect registered Story assets.
      </p>

      <ul className="assets-list" aria-label="Story assets">
        {story.assets.length === 0 ? (
          <li className="muted">No declared assets.</li>
        ) : (
          story.assets.map((asset) => (
            <li key={asset.id}>
              <code>{asset.id}</code> <span className="muted">{asset.kind}</span>
              <span className="asset-src">{asset.src}</span>
            </li>
          ))
        )}
      </ul>

      <form className="asset-form" onSubmit={(event) => void generate(event)}>
        <label className="field">
          <span className="field-label">Provider</span>
          <select
            aria-label="Asset provider"
            value={provider}
            disabled={controlsDisabled}
            onChange={(event) => setProvider(event.target.value as "openai" | "openrouter")}
          >
            <option value="openai">OpenAI</option>
            <option value="openrouter">OpenRouter</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Model</span>
          <input
            aria-label="Asset model"
            value={model}
            disabled={controlsDisabled}
            onChange={(event) => setModel(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Kind</span>
          <select
            aria-label="Asset kind"
            value={kind}
            disabled={controlsDisabled}
            onChange={(event) => updateKind(event.target.value as "image" | "audio")}
          >
            <option value="image">Image</option>
            <option value="audio">Audio</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Role</span>
          <select
            aria-label="Asset role"
            value={role}
            disabled={controlsDisabled}
            onChange={(event) => setRole(event.target.value as (typeof roles)[number])}
          >
            {roles.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Prompt</span>
          <textarea
            aria-label="Asset prompt"
            rows={3}
            value={prompt}
            disabled={controlsDisabled}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Asset id</span>
          <input
            aria-label="Asset id"
            value={assetId}
            disabled={controlsDisabled}
            onChange={(event) => setAssetId(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Relative destination</span>
          <input
            aria-label="Asset destination"
            value={destination}
            disabled={controlsDisabled}
            onChange={(event) => setDestination(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Provider API key</span>
          <input
            aria-label="Asset API key"
            type="password"
            autoComplete="off"
            value={apiKey}
            disabled={controlsDisabled}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
        <label className="remember asset-approval">
          <input
            aria-label="Enable paid asset generation"
            type="checkbox"
            checked={approved}
            disabled={controlsDisabled}
            onChange={(event) => setApproved(event.target.checked)}
          />
          Enable paid generation for this in-memory key
        </label>
        <p className="muted hint">
          The key is never saved.{" "}
          {assetHost.mode === "dev"
            ? "Development saves to the configured public assets root."
            : "Static builds can preview and download only; they cannot write this source tree."}
        </p>
        {running ? (
          <button type="button" className="danger" onClick={() => abortRef.current?.abort()}>
            Abort generation
          </button>
        ) : (
          <button
            type="submit"
            disabled={!canGenerate}
            title={!canGenerate ? "Approval and an API key are required." : undefined}
          >
            {assetHost.mode === "dev" ? "Generate & save" : "Generate preview"}
          </button>
        )}
      </form>

      {outcome !== null && !outcome.success && (
        <p className="err" role="status">
          {outcome.error.message}
          {outcome.error.mayHaveCharged ? " The provider may have received the request." : ""}
        </p>
      )}
      {registrationError && <p className="err">{registrationError}</p>}
      {agentActivity && (
        <p className="muted hint">Agent asset activity finished; Story assets above are current.</p>
      )}

      {outcome !== null && outcome.success && presentation !== null && (
        <div className="asset-result">
          {presentation.kind === "image" ? (
            <img className="asset-preview" src={outcome.previewUrl} alt={`Preview of ${outcomeId}`} />
          ) : (
            // biome-ignore lint/a11y/useMediaCaption: Generated audio previews may be nonverbal and have no transcript.
            <audio controls src={outcome.previewUrl} aria-label={`Preview of ${outcomeId}`} />
          )}
          {outcome.mode === "persisted" ? (
            <p className={registrationError === null ? "ok" : "warn"} role="status">
              Saved <code>{outcome.asset.publicUrl}</code>
              {registrationError === null
                ? ` and registered the generated ${outcome.asset.kind} asset.`
                : " but did not change the Story."}
            </p>
          ) : (
            <>
              <p className="warn" role="status">
                Preview ready. Download both files and place the media at{" "}
                <code>{`/assets/${presentation.storyId}/${presentation.destination}`}</code>.
              </p>
              <div className="asset-actions">
                <button type="button" onClick={() => outcome.download()}>
                  Download preview
                </button>
                <button
                  type="button"
                  onClick={() =>
                    downloadStoryDelta({
                      id: outcome.assetId,
                      src: `/assets/${presentation.storyId}/${presentation.destination}`,
                      kind: presentation.kind,
                      generated: true,
                    })
                  }
                >
                  Download Story delta
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The agent can only generate the exact in-memory inspector draft, never a prompt in tool
 * arguments. Static hosts retain preview ownership in the panel for a later human gesture.
 */
export function createGenerateAssetTool(
  host: AssetGenerationHost,
  getInput: () => AssetGenerationInput | null,
  onPreview?: (preview: PreviewAssetOutcome, input: AssetGenerationInput) => void,
): AgentTool {
  const persists = host.mode === "dev";
  return {
    definition: {
      name: "generate-asset",
      description: persists
        ? "Generate the currently approved asset inspector draft and register its saved metadata. Takes no arguments."
        : "Generate the currently approved asset inspector draft as a preview for a human to download. Takes no arguments.",
      parameters: { type: "object", additionalProperties: false },
    },
    effects: persists ? ["paid-network", "filesystem", "story-write"] : ["paid-network"],
    async handler(context) {
      if (!isEmptyObject(context.call.arguments))
        return failedTool("arguments", "generate-asset accepts no arguments.");
      const input = getInput();
      if (input === null || !input.approved || !input.apiKey.trim() || (host.mode === "dev" && !host.ready)) {
        return failedTool(
          "approval",
          "Asset generation requires an approved in-memory key and an available host.",
        );
      }
      if (context.log.currentStory().assets.some((asset) => asset.id === input.assetId)) {
        return failedTool("asset", "A Story asset already uses this id.");
      }

      const generated = await host.generate(input, context.signal);
      if (!generated.success) return failedTool("asset", generated.error.message);
      let previewRetained = false;
      try {
        if (generated.mode === "preview") {
          if (onPreview === undefined)
            return failedTool("host", "Asset preview presentation is unavailable in this host.");
          onPreview(generated, input);
          previewRetained = true;
          return {
            success: true,
            data: {
              assetId: generated.assetId,
              kind: input.kind,
              mode: "preview",
            },
          };
        }

        const registered = context.log.apply(
          "register-asset",
          {
            id: generated.asset.assetId,
            src: generated.asset.publicUrl,
            kind: generated.asset.kind,
            generated: true,
          },
          { runId: context.runId },
        );
        if (!registered.success) return registered;
        return {
          success: true,
          data: {
            assetId: generated.asset.assetId,
            kind: generated.asset.kind,
            src: generated.asset.publicUrl,
          },
        };
      } finally {
        if (!previewRetained) host.release(generated);
      }
    },
  };
}

function failedTool(
  path: string,
  message: string,
): { success: false; issues: { path: string; message: string }[] } {
  return { success: false, issues: [{ path, message }] };
}

function isEmptyObject(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0
  );
}

function downloadStoryDelta(asset: {
  id: string;
  src: string;
  kind: "image" | "audio";
  generated: boolean;
}): void {
  const blob = new Blob([JSON.stringify({ assets: [asset] }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${asset.id}-story-delta.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
