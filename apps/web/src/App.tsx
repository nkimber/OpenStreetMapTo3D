import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import type {
  GenerationSettings,
  GeocodeResult,
  ImportJob,
  SnapshotPreview,
  Wgs84Position,
  WorldDefinition,
  WorldSummary,
} from "@osm3d/contracts";
import { api } from "./api.js";
import { MapPreview } from "./components/MapPreview.js";
import { boundsFromCenter, formatArea } from "./geo.js";

const WorldWorkspace = lazy(async () => {
  const module = await import("./components/WorldWorkspace.js");
  return { default: module.WorldWorkspace };
});

const sampleCenter: Wgs84Position = {
  longitude: -75.1672,
  latitude: 39.9515,
  height: 0,
};
const defaultSettings: GenerationSettings = {
  buildingLevelHeight: 3,
  defaultBuildingHeight: 8,
  includeMinorPaths: true,
  buildingCollisions: true,
  seed: 1,
  visualStyle: "clean",
};

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export function App() {
  const [ready, setReady] = useState<boolean>();
  const [center, setCenter] = useState<Wgs84Position>(sampleCenter);
  const [sizeMeters, setSizeMeters] = useState(1_000);
  const [provider, setProvider] = useState<"fixture" | "overpass">("fixture");
  const [query, setQuery] = useState("");
  const [coordinateLatitude, setCoordinateLatitude] = useState(
    String(sampleCenter.latitude),
  );
  const [coordinateLongitude, setCoordinateLongitude] = useState(
    String(sampleCenter.longitude),
  );
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [importJob, setImportJob] = useState<ImportJob>();
  const [preview, setPreview] = useState<SnapshotPreview>();
  const [worldName, setWorldName] = useState("My neighborhood");
  const [settings, setSettings] = useState(defaultSettings);
  const [recentWorlds, setRecentWorlds] = useState<WorldSummary[]>([]);
  const [definition, setDefinition] = useState<WorldDefinition>();
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string>();
  const bounds = useMemo(
    () => boundsFromCenter(center, sizeMeters),
    [center, sizeMeters],
  );

  const refreshWorlds = async () => {
    try {
      setRecentWorlds(await api.listWorlds());
    } catch {
      setRecentWorlds([]);
    }
  };

  useEffect(() => {
    void api.ready().then(setReady);
    void refreshWorlds();
  }, []);

  const search = async (event: FormEvent) => {
    event.preventDefault();
    setSearching(true);
    setError(undefined);
    try {
      const found = await api.geocode(query);
      setResults(found);
      if (found.length === 0) setError("No matching places were found.");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Location search failed.",
      );
    } finally {
      setSearching(false);
    }
  };

  const selectResult = (result: GeocodeResult) => {
    const next = {
      longitude: result.longitude,
      latitude: result.latitude,
      height: 0,
    };
    setCenter(next);
    setCoordinateLatitude(String(next.latitude));
    setCoordinateLongitude(String(next.longitude));
    setWorldName(result.displayName.split(",")[0] || "My neighborhood");
    setProvider("overpass");
    setResults([]);
    setImportJob(undefined);
    setPreview(undefined);
  };

  const useCoordinates = (event: FormEvent) => {
    event.preventDefault();
    const latitude = Number(coordinateLatitude);
    const longitude = Number(coordinateLongitude);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      setError("Latitude must be between -90 and 90.");
      return;
    }
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      setError("Longitude must be between -180 and 180.");
      return;
    }
    setError(undefined);
    setCenter({ latitude, longitude, height: 0 });
    setProvider("overpass");
    setWorldName("Coordinate neighborhood");
    setImportJob(undefined);
    setPreview(undefined);
  };

  const importArea = async () => {
    setError(undefined);
    setImportJob(undefined);
    try {
      let job = await api.createImport({ provider, bounds, queryVersion: 1 });
      setImportJob(job);
      while (!["complete", "failed", "cancelled"].includes(job.status)) {
        await sleep(450);
        job = await api.getImport(job.id);
        setImportJob(job);
      }
      if (job.status === "failed")
        throw new Error(job.errorMessage ?? "The map import failed.");
      if (job.snapshotId)
        setPreview(await api.getSnapshotPreview(job.snapshotId));
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "The map import failed.",
      );
    }
  };

  const generateWorld = async () => {
    if (!importJob?.snapshotId) return;
    setGenerating(true);
    setError(undefined);
    try {
      const world = await api.createWorld({
        name: worldName,
        snapshotId: importJob.snapshotId,
        bounds,
        anchor: center,
        settings,
      });
      const loaded = await api.getWorldDefinition(world.id);
      setDefinition(loaded);
      await refreshWorlds();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The world could not be generated.",
      );
    } finally {
      setGenerating(false);
    }
  };

  const openWorld = async (world: WorldSummary) => {
    setError(undefined);
    try {
      setDefinition(await api.getWorldDefinition(world.id));
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The world could not be opened.",
      );
    }
  };

  if (definition) {
    return (
      <Suspense
        fallback={
          <main className="engine-loading">Preparing the 3D engine…</main>
        }
      >
        <WorldWorkspace
          definition={definition}
          onDefinitionChange={setDefinition}
          onExit={() => setDefinition(undefined)}
        />
      </Suspense>
    );
  }

  return (
    <main className="app-shell">
      <section className="setup-panel">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div>
            <p className="eyebrow">Open geospatial playground</p>
            <h1>
              OpenStreetMap<span>To3D</span>
            </h1>
          </div>
        </div>

        <div className={`service-status ${ready === false ? "offline" : ""}`}>
          <span />
          {ready === undefined
            ? "Checking local services…"
            : ready
              ? "Docker services ready"
              : "Local API is unavailable"}
        </div>

        <section className="workflow-section">
          <div className="section-number">1</div>
          <div className="section-content">
            <p className="eyebrow">Choose a place</p>
            <h2>Where should we build?</h2>
            <form className="search-form" onSubmit={search}>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="City, address, or intersection"
                aria-label="Location search"
              />
              <button disabled={searching || query.trim().length < 2}>
                {searching ? "Searching…" : "Search"}
              </button>
            </form>
            <p className="provider-note">
              Search is submitted explicitly to the configured geocoder;
              autocomplete is not used.
            </p>
            {results.length > 0 && (
              <ul className="search-results">
                {results.map((result) => (
                  <li key={`${result.longitude}:${result.latitude}`}>
                    <button onClick={() => selectResult(result)}>
                      {result.displayName}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="separator">
              <span>or</span>
            </div>
            <form className="coordinate-form" onSubmit={useCoordinates}>
              <label>
                Latitude
                <input
                  aria-label="Latitude"
                  inputMode="decimal"
                  value={coordinateLatitude}
                  onChange={(event) =>
                    setCoordinateLatitude(event.target.value)
                  }
                />
              </label>
              <label>
                Longitude
                <input
                  aria-label="Longitude"
                  inputMode="decimal"
                  value={coordinateLongitude}
                  onChange={(event) =>
                    setCoordinateLongitude(event.target.value)
                  }
                />
              </label>
              <button>Use coordinates</button>
            </form>
            <div className="separator">
              <span>or</span>
            </div>
            <button
              className="sample-button"
              onClick={() => {
                setCenter(sampleCenter);
                setProvider("fixture");
                setWorldName("Open Data sample neighborhood");
                setImportJob(undefined);
                setPreview(undefined);
                setCoordinateLatitude(String(sampleCenter.latitude));
                setCoordinateLongitude(String(sampleCenter.longitude));
              }}
            >
              <span className="sample-icon">⌂</span>
              <span>
                <strong>Use the offline sample</strong>
                <small>No network map request required</small>
              </span>
              <span>→</span>
            </button>
          </div>
        </section>

        <section className="workflow-section">
          <div className="section-number">2</div>
          <div className="section-content">
            <p className="eyebrow">Set the boundary</p>
            <div className="range-heading">
              <h2>World size</h2>
              <strong>{formatArea(sizeMeters)}</strong>
            </div>
            <input
              className="range-control"
              type="range"
              min="400"
              max="2000"
              step="100"
              value={sizeMeters}
              onChange={(event) => {
                setSizeMeters(Number(event.target.value));
                setImportJob(undefined);
                setPreview(undefined);
              }}
              aria-label="World width and height in metres"
            />
            <div className="range-labels">
              <span>400 m</span>
              <span>
                {sizeMeters} × {sizeMeters} m
              </span>
              <span>2 km</span>
            </div>
            <label className="field-label">
              Data source
              <select
                value={provider}
                onChange={(event) => {
                  setProvider(event.target.value as "fixture" | "overpass");
                  setImportJob(undefined);
                  setPreview(undefined);
                }}
              >
                <option value="fixture">Offline sample data</option>
                <option value="overpass">
                  Live OpenStreetMap via Overpass
                </option>
              </select>
            </label>
            <button
              className="primary-action"
              onClick={importArea}
              disabled={
                ready !== true ||
                importJob?.status === "running" ||
                importJob?.status === "queued"
              }
            >
              {importJob && !["complete", "failed"].includes(importJob.status)
                ? "Importing map data…"
                : "Import neighborhood data"}
              <span>→</span>
            </button>
            {importJob && (
              <div className="progress-card" aria-live="polite">
                <div>
                  <strong>{importJob.stage.replaceAll("-", " ")}</strong>
                  <span>{importJob.progress}%</span>
                </div>
                <progress max="100" value={importJob.progress} />
                {importJob.status === "complete" && (
                  <small>
                    {importJob.featureCount} geographic features ready
                  </small>
                )}
              </div>
            )}
            {preview && (
              <div
                className="coverage-card"
                aria-label="Imported source coverage"
              >
                <div>
                  <strong>{preview.stats.roads}</strong>
                  <span>roads</span>
                </div>
                <div>
                  <strong>{preview.stats.buildings}</strong>
                  <span>buildings</span>
                </div>
                <div>
                  <strong>{preview.stats.estimatedBuildingHeights}</strong>
                  <span>estimated heights</span>
                </div>
                <div>
                  <strong>{preview.diagnostics.length}</strong>
                  <span>diagnostics</span>
                </div>
                {preview.elevation && (
                  <>
                    <div>
                      <strong>{preview.elevation.provider}</strong>
                      <span>elevation source</span>
                    </div>
                    <div>
                      <strong>
                        {(
                          preview.elevation.maxHeight -
                          preview.elevation.minHeight
                        ).toFixed(1)}{" "}
                        m
                      </strong>
                      <span>terrain relief</span>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </section>

        {importJob?.status === "complete" && (
          <section className="workflow-section final-step">
            <div className="section-number">3</div>
            <div className="section-content">
              <p className="eyebrow">Generate</p>
              <h2>Create the 3D world</h2>
              <label className="field-label">
                World name
                <input
                  value={worldName}
                  onChange={(event) => setWorldName(event.target.value)}
                />
              </label>
              <label className="field-label">
                Visual style
                <select
                  value={settings.visualStyle}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      visualStyle: event.target
                        .value as GenerationSettings["visualStyle"],
                    })
                  }
                >
                  <option value="clean">Clean daylight</option>
                  <option value="colorful">Colorful blocks</option>
                  <option value="night">Night drive</option>
                </select>
              </label>
              <details className="advanced-settings">
                <summary>Advanced generation settings</summary>
                <label className="field-label">
                  Fallback building height (metres)
                  <input
                    type="number"
                    min="2"
                    max="100"
                    step="1"
                    value={settings.defaultBuildingHeight}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        defaultBuildingHeight: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label className="field-label">
                  Deterministic seed
                  <input
                    type="number"
                    step="1"
                    value={settings.seed}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        seed: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={settings.includeMinorPaths}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        includeMinorPaths: event.target.checked,
                      })
                    }
                  />{" "}
                  Include minor paths
                </label>
                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={settings.buildingCollisions}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        buildingCollisions: event.target.checked,
                      })
                    }
                  />{" "}
                  Building collisions
                </label>
              </details>
              <button
                className="primary-action generate"
                onClick={generateWorld}
                disabled={generating || !worldName.trim()}
              >
                {generating ? "Building world…" : "Generate and explore"}
                <span>✦</span>
              </button>
            </div>
          </section>
        )}

        {error && (
          <p className="error-message setup-error" role="alert">
            {error}
          </p>
        )}

        {recentWorlds.length > 0 && (
          <section className="recent-worlds">
            <p className="eyebrow">Recent worlds</p>
            {recentWorlds.slice(0, 4).map((world) => (
              <button key={world.id} onClick={() => void openWorld(world)}>
                <span>{world.name}</span>
                <small>{new Date(world.updatedAt).toLocaleDateString()}</small>
              </button>
            ))}
          </section>
        )}
      </section>

      <section className="map-stage">
        <MapPreview
          center={center}
          bounds={bounds}
          features={preview?.features ?? []}
          onCenterChange={(next) => {
            setCenter(next);
            setCoordinateLatitude(next.latitude.toFixed(6));
            setCoordinateLongitude(next.longitude.toFixed(6));
            setImportJob(undefined);
            setPreview(undefined);
          }}
        />
        <div className="map-overlay top-left">
          <p className="eyebrow">Selection center</p>
          <strong>
            {center.latitude.toFixed(5)}, {center.longitude.toFixed(5)}
          </strong>
          <span>Pan the map to move the generation area</span>
          {preview && (
            <span>
              {preview.stats.roads} roads · {preview.stats.buildings} buildings
              imported
            </span>
          )}
        </div>
        <div className="map-overlay bottom-right legend">
          <span>
            <i className="selection-swatch" /> Selected world
          </span>
          <span>
            <i className="center-dot" /> Map center
          </span>
        </div>
      </section>
    </main>
  );
}
