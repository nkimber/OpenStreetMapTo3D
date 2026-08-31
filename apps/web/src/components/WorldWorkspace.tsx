import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Diagnostic,
  NormalizedFeature,
  WorldBuildProgress,
  WorldDefinition,
  WorldOverride,
} from "@osm3d/contracts";
import {
  estimateBuildingHeight,
  estimateRoadWidthWithSource,
} from "@osm3d/worldgen";
import { api } from "../api.js";
import {
  WorldEngine,
  type DriveInputPreferences,
  type EngineMode,
  type EngineSelection,
  type EngineStats,
} from "../engine/WorldEngine.js";

interface WorldWorkspaceProps {
  definition: WorldDefinition;
  onDefinitionChange: (definition: WorldDefinition) => void;
  onExit: () => void;
}

const emptyStats: EngineStats = {
  roads: 0,
  buildings: 0,
  features: 0,
  speedKph: 0,
  fps: 0,
  chunks: 0,
  triangles: 0,
  terrainTriangles: 0,
  terrainChunks: 0,
  elevationProvider: "pending",
  elevationRange: 0,
  vehicleElevation: 0,
  buildHash: "pending",
  buildDurationMs: 0,
  diagnosticCount: 0,
  longFrameCount: 0,
  recoveryCount: 0,
  lastRebuiltChunks: 0,
  inputSource: "keyboard",
};

function replaceOverride(
  current: WorldOverride[],
  override: WorldOverride,
): WorldOverride[] {
  return [
    ...current.filter(
      (item) =>
        !(
          item.targetId === override.targetId &&
          item.operation === override.operation
        ),
    ),
    override,
  ];
}

function cloneOverrides(overrides: WorldOverride[]): WorldOverride[] {
  return structuredClone(overrides);
}

export function WorldWorkspace({
  definition,
  onDefinitionChange,
  onExit,
}: WorldWorkspaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<WorldEngine | null>(null);
  const definitionRef = useRef(definition);
  definitionRef.current = definition;
  const initialBuildAbortRef = useRef<AbortController | undefined>(undefined);
  const updateAbortRef = useRef<AbortController | undefined>(undefined);
  const [mode, setMode] = useState<EngineMode>("inspect");
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const [selection, setSelection] = useState<EngineSelection>({});
  const [stats, setStats] = useState(emptyStats);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>(
    definition.diagnostics,
  );
  const [buildProgress, setBuildProgress] = useState<WorldBuildProgress>();
  const [engineReady, setEngineReady] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [undoStack, setUndoStack] = useState<WorldOverride[][]>([]);
  const [redoStack, setRedoStack] = useState<WorldOverride[][]>([]);
  const [inputPreferences, setInputPreferences] =
    useState<DriveInputPreferences>({
      gamepadEnabled: true,
      steeringSensitivity: 1,
    });
  const [error, setError] = useState<string>();
  const hasRoads = definition.features.some(
    (feature) => feature.kind === "road",
  );

  const selected = useMemo(
    () =>
      definition.features.find(
        (feature) => feature.sourceId === selection.sourceId,
      ),
    [definition.features, selection.sourceId],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    const controller = new AbortController();
    initialBuildAbortRef.current = controller;
    setEngineReady(false);
    setError(undefined);
    setBuildProgress(undefined);
    setUndoStack([]);
    setRedoStack([]);
    void WorldEngine.create(
      container,
      definition,
      {
        onSelect: setSelection,
        onStats: setStats,
        onBuildProgress: setBuildProgress,
        onDiagnostics: setDiagnostics,
      },
      controller.signal,
    )
      .then((engine) => {
        if (cancelled) engine.dispose();
        else {
          engineRef.current = engine;
          engine.setMode(modeRef.current);
          engine.setInputPreferences(inputPreferences);
          setEngineReady(true);
        }
      })
      .catch((reason: unknown) => {
        if (
          cancelled ||
          (reason instanceof DOMException && reason.name === "AbortError")
        )
          return;
        setError(
          reason instanceof Error
            ? reason.message
            : "The 3D engine could not start.",
        );
      });
    return () => {
      cancelled = true;
      controller.abort();
      updateAbortRef.current?.abort();
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, [definition.world.id]);

  useEffect(() => {
    engineRef.current?.setMode(mode);
  }, [mode]);

  useEffect(() => {
    engineRef.current?.setInputPreferences(inputPreferences);
  }, [inputPreferences]);

  useEffect(() => {
    if (!selected) {
      setEditValue("");
      return;
    }
    if (selected.kind === "building") {
      setEditValue(
        String(
          estimateBuildingHeight(
            selected,
            definition.world.settings,
            definition.overrides,
          ).height,
        ),
      );
    } else if (selected.kind === "road") {
      setEditValue(
        String(
          estimateRoadWidthWithSource(selected, definition.overrides).width,
        ),
      );
    } else setEditValue("");
  }, [selected, definition]);

  const persistOverrides = async (
    requested: WorldOverride[],
  ): Promise<boolean> => {
    setSaving(true);
    setRebuilding(true);
    setError(undefined);
    updateAbortRef.current?.abort();
    const controller = new AbortController();
    updateAbortRef.current = controller;
    try {
      const currentDefinition = definitionRef.current;
      const saved = await api.saveOverrides(
        currentDefinition.world.id,
        requested,
      );
      const nextDefinition = { ...currentDefinition, overrides: saved };
      onDefinitionChange(nextDefinition);
      try {
        await engineRef.current?.updateDefinition(
          nextDefinition,
          controller.signal,
        );
      } catch (reason) {
        if (reason instanceof DOMException && reason.name === "AbortError") {
          setError(
            "The edit was saved, but its preview rebuild was cancelled. Reopen the world to refresh it.",
          );
        } else {
          setError(
            `The edit was saved, but the preview could not rebuild: ${reason instanceof Error ? reason.message : "unknown error"}`,
          );
        }
      }
      return true;
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The edit could not be saved.",
      );
      return false;
    } finally {
      setSaving(false);
      setRebuilding(false);
    }
  };

  const saveOverride = async (override: WorldOverride) => {
    const previous = cloneOverrides(definitionRef.current.overrides);
    const next = replaceOverride(previous, override);
    const hidesSelection =
      override.operation === "set-visible" &&
      override.payload.visible === false;
    if (hidesSelection) setSelection({});
    if (!(await persistOverrides(next))) {
      if (hidesSelection) setSelection({ sourceId: override.targetId });
      return;
    }
    setUndoStack((stack) => [...stack.slice(-49), previous]);
    setRedoStack([]);
  };

  const undo = async () => {
    const previous = undoStack.at(-1);
    if (!previous || saving) return;
    const current = cloneOverrides(definitionRef.current.overrides);
    if (!(await persistOverrides(previous))) return;
    setUndoStack((stack) => stack.slice(0, -1));
    setRedoStack((stack) => [...stack.slice(-49), current]);
  };

  const redo = async () => {
    const next = redoStack.at(-1);
    if (!next || saving) return;
    const current = cloneOverrides(definitionRef.current.overrides);
    if (!(await persistOverrides(next))) return;
    setRedoStack((stack) => stack.slice(0, -1));
    setUndoStack((stack) => [...stack.slice(-49), current]);
  };

  const applyNumericEdit = () => {
    if (!selected) return;
    const value = Number(editValue);
    if (!Number.isFinite(value) || value <= 0) {
      setError("Enter a positive number.");
      return;
    }
    if (selected.kind === "building") {
      void saveOverride({
        targetId: selected.sourceId,
        operation: "set-height",
        payloadVersion: 1,
        payload: { height: value },
      });
    } else if (selected.kind === "road") {
      void saveOverride({
        targetId: selected.sourceId,
        operation: "set-width",
        payloadVersion: 1,
        payload: { width: value },
      });
    }
  };

  const provenance = selected
    ? selected.kind === "building"
      ? estimateBuildingHeight(
          selected,
          definition.world.settings,
          definition.overrides,
        ).source
      : selected.kind === "road"
        ? estimateRoadWidthWithSource(selected, definition.overrides).source
        : undefined
    : undefined;

  return (
    <main className="world-workspace">
      <div ref={containerRef} className="world-canvas" />
      <header className="world-topbar glass-panel">
        <button
          className="icon-button"
          onClick={onExit}
          aria-label="Return to world setup"
        >
          ←
        </button>
        <div>
          <p className="eyebrow">Generated world</p>
          <h1>{definition.world.name}</h1>
        </div>
        <div className="edit-history" role="group" aria-label="Edit history">
          <button
            onClick={() => void undo()}
            disabled={!undoStack.length || saving}
          >
            ↶ Undo
          </button>
          <button
            onClick={() => void redo()}
            disabled={!redoStack.length || saving}
          >
            Redo ↷
          </button>
        </div>
        <div className="mode-switch" role="group" aria-label="World mode">
          <button
            className={mode === "inspect" ? "active" : ""}
            onClick={() => setMode("inspect")}
          >
            Inspect
          </button>
          <button
            className={mode === "drive" ? "active" : ""}
            onClick={() => setMode("drive")}
            disabled={!hasRoads || !engineReady}
          >
            Drive
          </button>
        </div>
      </header>

      {!engineReady && !error && (
        <div className="engine-loading" role="status">
          <div className="engine-progress">
            <strong>Preparing the 3D world…</strong>
            <span>{buildProgress?.stage ?? "starting"}</span>
            <progress max="100" value={buildProgress?.progress ?? 0} />
            <button
              onClick={() => {
                initialBuildAbortRef.current?.abort();
                onExit();
              }}
            >
              Cancel generation
            </button>
          </div>
        </div>
      )}

      {rebuilding && (
        <div className="rebuild-status glass-panel" role="status">
          <span>Rebuilding affected chunks</span>
          <progress max="100" value={buildProgress?.progress ?? 0} />
        </div>
      )}

      <aside className="world-stats glass-panel" aria-label="World statistics">
        <span>
          <strong>{stats.buildings}</strong> buildings
        </span>
        <span>
          <strong>{stats.roads}</strong> roads
        </span>
        <span>
          <strong>{stats.chunks}</strong> chunks
        </span>
        {mode === "drive" && (
          <span className="speed">
            <strong>{stats.speedKph}</strong> km/h
          </span>
        )}
      </aside>

      <details className="telemetry-panel glass-panel">
        <summary>Build &amp; performance</summary>
        <dl>
          <div>
            <dt>Frame rate</dt>
            <dd>{stats.fps || "…"} fps</dd>
          </div>
          <div>
            <dt>Road triangles</dt>
            <dd>{stats.triangles.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Terrain triangles</dt>
            <dd>{stats.terrainTriangles.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Elevation source</dt>
            <dd>{stats.elevationProvider}</dd>
          </div>
          <div>
            <dt>Elevation range</dt>
            <dd>{stats.elevationRange.toFixed(1)} m</dd>
          </div>
          <div>
            <dt>Car elevation</dt>
            <dd>{stats.vehicleElevation.toFixed(1)} m</dd>
          </div>
          <div>
            <dt>Worker build</dt>
            <dd>{stats.buildDurationMs} ms</dd>
          </div>
          <div>
            <dt>Last rebuild</dt>
            <dd>{stats.lastRebuiltChunks} chunks</dd>
          </div>
          <div>
            <dt>Long frames</dt>
            <dd>{stats.longFrameCount}</dd>
          </div>
          <div>
            <dt>Recoveries</dt>
            <dd>{stats.recoveryCount}</dd>
          </div>
        </dl>
        <code title="Deterministic build hash">{stats.buildHash}</code>
        {diagnostics.length > 0 && (
          <details className="diagnostic-list">
            <summary>{diagnostics.length} generation diagnostics</summary>
            <ul>
              {diagnostics.slice(0, 20).map((diagnostic, index) => (
                <li key={`${diagnostic.code}:${diagnostic.sourceId}:${index}`}>
                  <strong>{diagnostic.code}</strong> {diagnostic.message}
                </li>
              ))}
            </ul>
          </details>
        )}
      </details>

      {mode === "drive" ? (
        <section className="drive-help glass-panel">
          <strong>Drive</strong>
          <span>
            WASD / arrows · Space handbrake · R safe reset · Shift+R spawn
          </span>
          <div className="drive-actions">
            <button onClick={() => engineRef.current?.resetVehicle()}>
              Reset car
            </button>
            <button onClick={() => engineRef.current?.resetVehicle(true)}>
              Return to spawn
            </button>
          </div>
          <details className="control-settings">
            <summary>Controls</summary>
            <label>
              <input
                type="checkbox"
                checked={inputPreferences.gamepadEnabled}
                onChange={(event) =>
                  setInputPreferences({
                    ...inputPreferences,
                    gamepadEnabled: event.target.checked,
                  })
                }
              />
              Standard gamepad enabled
            </label>
            <label>
              Steering sensitivity
              <input
                type="range"
                min="0.5"
                max="1.5"
                step="0.1"
                value={inputPreferences.steeringSensitivity}
                onChange={(event) =>
                  setInputPreferences({
                    ...inputPreferences,
                    steeringSensitivity: Number(event.target.value),
                  })
                }
              />
            </label>
            <small>Active input: {stats.inputSource}</small>
          </details>
        </section>
      ) : (
        <aside className="inspector glass-panel">
          <p className="eyebrow">Inspector</p>
          <label className="feature-picker">
            Select a feature
            <select
              aria-label="Select a feature"
              value={selection.sourceId ?? ""}
              onChange={(event) =>
                setSelection(
                  event.target.value ? { sourceId: event.target.value } : {},
                )
              }
            >
              <option value="">Click the world or choose here</option>
              {definition.features
                .filter(
                  (feature) =>
                    feature.kind === "road" || feature.kind === "building",
                )
                .map((feature) => (
                  <option key={feature.sourceId} value={feature.sourceId}>
                    {feature.kind}:{" "}
                    {feature.tags.name ??
                      feature.tags.building ??
                      feature.sourceId}
                  </option>
                ))}
            </select>
          </label>
          {!selected && (
            <p className="muted">
              Select a road or building in the scene to inspect its source data.
            </p>
          )}
          {selected && (
            <FeatureInspector
              feature={selected}
              provenance={provenance}
              selectedPoint={selection.point}
              editValue={editValue}
              onEditValue={setEditValue}
              onApply={applyNumericEdit}
              onHide={() =>
                void saveOverride({
                  targetId: selected.sourceId,
                  operation: "set-visible",
                  payloadVersion: 1,
                  payload: {
                    visible: definition.overrides.some(
                      (override) =>
                        override.targetId === selected.sourceId &&
                        override.operation === "set-visible" &&
                        override.payload.visible === false,
                    ),
                  },
                })
              }
              isHidden={definition.overrides.some(
                (override) =>
                  override.targetId === selected.sourceId &&
                  override.operation === "set-visible" &&
                  override.payload.visible === false,
              )}
              onSetSpawn={() => {
                if (!selection.point) return;
                void saveOverride({
                  targetId: selected.sourceId,
                  operation: "set-spawn",
                  payloadVersion: 1,
                  payload: {
                    placement: "exact",
                    x: selection.point.x,
                    z: selection.point.z,
                  },
                });
              }}
              saving={saving}
            />
          )}
        </aside>
      )}

      {error && (
        <p className="world-error error-message" role="alert">
          {error}
        </p>
      )}

      <div className="attribution glass-panel">
        {definition.attribution.map((attribution) => (
          <a
            key={`${attribution.url}:${attribution.text}`}
            href={attribution.url}
            target="_blank"
            rel="noreferrer"
          >
            {attribution.text}
          </a>
        ))}
      </div>
    </main>
  );
}

interface FeatureInspectorProps {
  feature: NormalizedFeature;
  provenance: string | undefined;
  selectedPoint: { x: number; z: number } | undefined;
  editValue: string;
  onEditValue: (value: string) => void;
  onApply: () => void;
  onHide: () => void;
  onSetSpawn: () => void;
  isHidden: boolean;
  saving: boolean;
}

function FeatureInspector({
  feature,
  provenance,
  selectedPoint,
  editValue,
  onEditValue,
  onApply,
  onHide,
  onSetSpawn,
  isHidden,
  saving,
}: FeatureInspectorProps) {
  const editable = feature.kind === "building" || feature.kind === "road";
  return (
    <div className="feature-inspector">
      <div className="feature-heading">
        <span className={`feature-kind ${feature.kind}`}>{feature.kind}</span>
        <h2>
          {feature.tags.name ?? feature.tags.building ?? "Unnamed feature"}
        </h2>
      </div>
      <code>{feature.sourceId}</code>
      {provenance && (
        <p className="provenance">
          Current value: <strong>{provenance}</strong>
        </p>
      )}
      {editable && (
        <label>
          {feature.kind === "building" ? "Height (metres)" : "Width (metres)"}
          <div className="inline-edit">
            <input
              aria-label={
                feature.kind === "building"
                  ? "Height (metres)"
                  : "Width (metres)"
              }
              type="number"
              min="0.5"
              step="0.5"
              value={editValue}
              onChange={(event) => onEditValue(event.target.value)}
            />
            <button onClick={onApply} disabled={saving}>
              {saving ? "Saving…" : "Apply"}
            </button>
          </div>
        </label>
      )}
      <dl className="tag-list">
        {Object.entries(feature.tags)
          .slice(0, 10)
          .map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
      {feature.kind === "road" && (
        <button
          className="secondary-button"
          onClick={onSetSpawn}
          disabled={saving || !selectedPoint}
        >
          Set spawn at clicked position
        </button>
      )}
      <button
        className="secondary-button danger"
        onClick={onHide}
        disabled={saving}
      >
        {isHidden ? "Show feature" : "Hide feature"}
      </button>
    </div>
  );
}
