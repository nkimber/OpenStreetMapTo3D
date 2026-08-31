import { useEffect, useMemo, useRef, useState } from "react";
import type {
  NormalizedFeature,
  WorldDefinition,
  WorldOverride,
} from "@osm3d/contracts";
import { estimateBuildingHeight, estimateRoadWidth } from "@osm3d/worldgen";
import { api } from "../api.js";
import {
  WorldEngine,
  type EngineMode,
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
};

export function WorldWorkspace({
  definition,
  onDefinitionChange,
  onExit,
}: WorldWorkspaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<WorldEngine | null>(null);
  const [mode, setMode] = useState<EngineMode>("inspect");
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const [selectedId, setSelectedId] = useState<string>();
  const [stats, setStats] = useState(emptyStats);
  const [engineReady, setEngineReady] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const hasRoads = definition.features.some(
    (feature) => feature.kind === "road",
  );

  const selected = useMemo(
    () =>
      definition.features.find((feature) => feature.sourceId === selectedId),
    [definition.features, selectedId],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    setEngineReady(false);
    setError(undefined);
    void WorldEngine.create(container, definition, {
      onSelect: setSelectedId,
      onStats: setStats,
    })
      .then((engine) => {
        if (cancelled) engine.dispose();
        else {
          engineRef.current = engine;
          engine.setMode(modeRef.current);
          setEngineReady(true);
        }
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(
          reason instanceof Error
            ? reason.message
            : "The 3D engine could not start.",
        );
      });
    return () => {
      cancelled = true;
      setEngineReady(false);
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, [definition]);

  useEffect(() => {
    engineRef.current?.setMode(mode);
  }, [mode]);

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
      setEditValue(String(estimateRoadWidth(selected, definition.overrides)));
    } else setEditValue("");
  }, [selected, definition]);

  const saveOverride = async (override: WorldOverride) => {
    setSaving(true);
    setError(undefined);
    try {
      const next = definition.overrides.filter(
        (item) =>
          !(
            item.targetId === override.targetId &&
            item.operation === override.operation
          ),
      );
      next.push(override);
      const saved = await api.saveOverrides(definition.world.id, next);
      onDefinitionChange({ ...definition, overrides: saved });
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The edit could not be saved.",
      );
    } finally {
      setSaving(false);
    }
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
          Preparing the 3D world…
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
          <strong>{stats.features}</strong> features
        </span>
        {mode === "drive" && (
          <span className="speed">
            <strong>{stats.speedKph}</strong> km/h
          </span>
        )}
      </aside>

      {mode === "drive" ? (
        <section className="drive-help glass-panel">
          <strong>Drive</strong>
          <span>WASD / arrows · Space handbrake · R reset</span>
          <button onClick={() => engineRef.current?.resetVehicle()}>
            Reset car
          </button>
        </section>
      ) : (
        <aside className="inspector glass-panel">
          <p className="eyebrow">Inspector</p>
          {!selected && (
            <p className="muted">
              Select a road or building in the scene to inspect its source data.
            </p>
          )}
          {selected && (
            <FeatureInspector
              feature={selected}
              editValue={editValue}
              onEditValue={setEditValue}
              onApply={applyNumericEdit}
              onHide={() =>
                void saveOverride({
                  targetId: selected.sourceId,
                  operation: "set-visible",
                  payloadVersion: 1,
                  payload: { visible: false },
                })
              }
              onSetSpawn={() =>
                void saveOverride({
                  targetId: selected.sourceId,
                  operation: "set-spawn",
                  payloadVersion: 1,
                  payload: { placement: "road-start" },
                })
              }
              saving={saving}
            />
          )}
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
        </aside>
      )}

      <a
        className="attribution glass-panel"
        href={
          definition.attribution[0]?.url ??
          "https://www.openstreetmap.org/copyright"
        }
        target="_blank"
        rel="noreferrer"
      >
        {definition.attribution[0]?.text ?? "© OpenStreetMap contributors"}
      </a>
    </main>
  );
}

interface FeatureInspectorProps {
  feature: NormalizedFeature;
  editValue: string;
  onEditValue: (value: string) => void;
  onApply: () => void;
  onHide: () => void;
  onSetSpawn: () => void;
  saving: boolean;
}

function FeatureInspector({
  feature,
  editValue,
  onEditValue,
  onApply,
  onHide,
  onSetSpawn,
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
      {editable && (
        <label>
          {feature.kind === "building" ? "Height (metres)" : "Width (metres)"}
          <div className="inline-edit">
            <input
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
          disabled={saving}
        >
          Set car spawn on this road
        </button>
      )}
      <button
        className="secondary-button danger"
        onClick={onHide}
        disabled={saving}
      >
        Hide feature
      </button>
    </div>
  );
}
