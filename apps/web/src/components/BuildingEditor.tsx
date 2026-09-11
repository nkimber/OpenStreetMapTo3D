import { useEffect, useRef, useState } from "react";
import {
  footprintSignature,
  openingWidth,
  validateBuildingOpenings,
  type BuildingCustomization,
  type BuildingOpening,
  type WorldDefinition,
} from "@osm3d/contracts";
import { api } from "../api.js";
import {
  automaticPath,
  emptyCustomization,
  hasCustomization,
  nearestWall,
  openingPosition,
  openingOnBuilding,
  exteriorWalls,
  routeBlocked,
  routeMeetsRoad,
  toLocal,
  toMap,
} from "../engine/buildingEdits.js";
import { buildingAppearance } from "../engine/buildingVisual.js";
import { customizedPlan } from "../engine/buildingEditVisuals.js";
import type { EditPointer, WorldEngine } from "../engine/WorldEngine.js";

type Tool =
  | "select"
  | "front-door"
  | "garage"
  | "window"
  | "route"
  | "fence"
  | "gate"
  | "garden";
interface Props {
  definition: WorldDefinition;
  engine: WorldEngine;
  onDefinitionChange: (value: WorldDefinition) => void;
  onDirtyChange: (dirty: boolean) => void;
}

export function BuildingEditor({
  definition,
  engine,
  onDefinitionChange,
  onDirtyChange,
}: Props) {
  const buildings = definition.features.filter(
    (feature) => feature.kind === "building",
  );
  const [sourceId, setSourceId] = useState(buildings[0]?.sourceId ?? "");
  const feature = buildings.find((item) => item.sourceId === sourceId);
  const saved = definition.buildingCustomizations?.find(
    (item) => item.sourceId === sourceId,
  );
  const [draft, setDraft] = useState<BuildingCustomization>(
    () =>
      saved ??
      (feature
        ? emptyCustomization(feature)
        : {
            sourceId: "",
            footprint: "",
            revision: 0,
            openings: [],
            appearance: {},
            boundaries: [],
          }),
  );
  const [tool, setTool] = useState<Tool>("select");
  const [selectedId, setSelectedId] = useState<string>();
  const [cars, setCars] = useState<1 | 2 | 3>(1);
  const [history, setHistory] = useState<BuildingCustomization[]>([]);
  const [future, setFuture] = useState<BuildingCustomization[]>([]);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [highlight, setHighlight] = useState(true);
  const baseline = useRef(JSON.stringify(draft));
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const definitionRef = useRef(definition);
  definitionRef.current = definition;
  const dragStart = useRef<BuildingCustomization | undefined>(undefined);
  const activeBoundary = useRef<string | undefined>(undefined);
  const selected = draft.openings.find((item) => item.id === selectedId);
  const boundary = draft.boundaries.find((item) => item.id === selectedId);
  const dirty = JSON.stringify(draft) !== baseline.current;
  const stale = Boolean(
    draft.footprint &&
    feature &&
    draft.footprint !== footprintSignature(feature.geometry),
  );
  const context = engine.getEditContext();
  const planBuilding = context.plan.buildings.find(
    (item) => item.sourceId === sourceId,
  );
  const unavailable = !planBuilding;
  useEffect(() => {
    onDirtyChange(dirty || saving);
    return () => onDirtyChange(false);
  }, [dirty, saving, onDirtyChange]);

  function change(next: BuildingCustomization, record = true) {
    if (record) {
      setHistory((items) => [
        ...items.slice(-49),
        structuredClone(draftRef.current),
      ]);
      setFuture([]);
    }
    draftRef.current = next;
    setDraft(next);
  }
  function switchBuilding(id: string) {
    if (id === sourceId) return;
    if (dirty) {
      setMessage(
        "Save or discard this building's changes before selecting another building.",
      );
      return;
    }
    const nextFeature = buildings.find((item) => item.sourceId === id);
    if (!nextFeature) return;
    const next =
      definition.buildingCustomizations?.find((item) => item.sourceId === id) ??
      emptyCustomization(nextFeature);
    setSourceId(id);
    setDraft(next);
    draftRef.current = next;
    baseline.current = JSON.stringify(next);
    setHistory([]);
    setFuture([]);
    setSelectedId(undefined);
    setTool("select");
    setMessage("");
    activeBoundary.current = undefined;
    engine.focusBuilding(id);
  }
  useEffect(() => {
    if (sourceId) engine.focusBuilding(sourceId);
    return () => {
      engine.setEditPointerHandler(undefined);
      engine.setCustomizationPreview(
        definitionRef.current.buildingCustomizations ?? [],
        false,
      );
    };
  }, [engine]);
  useEffect(() => {
    const values = [
      ...(definition.buildingCustomizations ?? []).filter(
        (item) => item.sourceId !== sourceId,
      ),
      draft,
    ];
    engine.setCustomizationPreview(values, highlight);
  }, [draft, definition.buildingCustomizations, engine, sourceId, highlight]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  function connect(opening: BuildingOpening): BuildingOpening {
    try {
      return {
        ...opening,
        path: automaticPath(
          opening,
          sourceId,
          definition,
          context.plan,
          opening.roadId,
        ),
      };
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not create a route.",
      );
      return { ...opening, path: [] };
    }
  }
  function place(
    point: { x: number; z: number },
    kind: BuildingOpening["kind"],
    existing?: BuildingOpening,
    record = true,
  ) {
    if (!feature || !planBuilding || stale) return;
    const wall = nearestWall(feature, point, definition);
    if (!wall) return;
    const opening: BuildingOpening = existing
      ? { ...existing, wall: wall.wall, fraction: wall.fraction }
      : {
          id: crypto.randomUUID(),
          kind,
          wall: wall.wall,
          fraction: wall.fraction,
          cars,
          width: kind === "window" ? 1.25 : 1,
          sill: 1,
          path: [],
        };
    const margin = (openingWidth(opening) / 2 + 0.12) / wall.length;
    if (margin > 0.5) {
      setMessage(
        "That wall is too narrow. Choose a wider wall or a smaller garage.",
      );
      return;
    }
    opening.fraction = Math.max(margin, Math.min(1 - margin, opening.fraction));
    setMessage("");
    const next = {
      ...draftRef.current,
      footprint: footprintSignature(feature.geometry),
      openings: existing
        ? draftRef.current.openings.map((item) =>
            item.id === opening.id ? opening : item,
          )
        : [...draftRef.current.openings, opening],
    };
    // During dragging, move the apron without replacing the user's route bends.
    if (existing) {
      if (opening.path.length)
        opening.path = [
          toMap(openingPosition(opening, definition), definition),
          ...opening.path.slice(1),
        ];
    } else if (kind !== "window")
      next.openings[next.openings.length - 1] = connect(opening);
    change(next, record);
    setSelectedId(opening.id);
  }
  const handler = (event: EditPointer) => {
    if (saving) return;
    if (event.phase === "end") {
      if (
        dragStart.current &&
        JSON.stringify(dragStart.current) !== JSON.stringify(draftRef.current)
      ) {
        const beforeDrag = dragStart.current;
        setHistory((items) => [...items.slice(-49), beforeDrag]);
        setFuture([]);
      }
      dragStart.current = undefined;
      return;
    }
    if (event.phase === "click" && (event.openingId || event.boundaryId)) {
      if (event.sourceId !== sourceId) {
        switchBuilding(event.sourceId ?? "");
        return;
      }
      setSelectedId(event.openingId ?? event.boundaryId);
      const opening = draftRef.current.openings.find(
        (item) => item.id === event.openingId,
      );
      if (opening) setCars(opening.cars);
      setTool("select");
      dragStart.current = structuredClone(draftRef.current);
      return;
    }
    if (event.phase === "move") {
      if (stale || !dragStart.current) return;
      const current = draftRef.current;
      if (event.openingId) {
        const opening = current.openings.find(
          (item) => item.id === event.openingId,
        );
        if (!opening) return;
        if (event.routeIndex !== undefined)
          change(
            {
              ...current,
              openings: current.openings.map((item) =>
                item.id === opening.id
                  ? {
                      ...item,
                      path: item.path.map((p, i) =>
                        i === event.routeIndex
                          ? toMap(event.point, definition)
                          : p,
                      ),
                    }
                  : item,
              ),
            },
            false,
          );
        else place(event.point, opening.kind, opening, false);
      } else if (event.boundaryId)
        change(
          {
            ...current,
            boundaries: current.boundaries.map((item) =>
              item.id === event.boundaryId
                ? {
                    ...item,
                    points: item.points.map((p, i) =>
                      i === event.boundaryIndex
                        ? toMap(event.point, definition)
                        : p,
                    ),
                  }
                : item,
            ),
          },
          false,
        );
      return;
    }
    if (stale) {
      setMessage(
        "This building's footprint changed. Reset its placements or reload before editing.",
      );
      return;
    }
    if (tool === "front-door" || tool === "garage" || tool === "window") {
      if (event.sourceId !== sourceId) {
        setMessage(
          "Click a wall of the selected building, or choose a wall below.",
        );
        return;
      }
      place(event.point, tool);
      setTool("select");
    } else if (tool === "route" && selected) {
      updateOpening({
        ...selected,
        path: [...selected.path, toMap(event.point, definition)],
      });
    } else if (tool === "fence" || tool === "gate" || tool === "garden") {
      const point = toMap(event.point, definition);
      const current = draftRef.current;
      const active = current.boundaries.find(
        (item) => item.id === activeBoundary.current,
      );
      if (!active) {
        const id = crypto.randomUUID();
        activeBoundary.current = id;
        setSelectedId(id);
        change({
          ...current,
          boundaries: [
            ...current.boundaries,
            { id, kind: tool, points: [point, point] },
          ],
        });
        setMessage(
          "Click the next boundary point, then Finish drawing. Yellow handles can be dragged.",
        );
      } else
        change({
          ...current,
          boundaries: current.boundaries.map((item) =>
            item.id === active.id
              ? {
                  ...item,
                  points:
                    item.points[0]![0] === item.points[1]![0] &&
                    item.points[0]![1] === item.points[1]![1]
                      ? [item.points[0]!, point]
                      : [...item.points, point],
                }
              : item,
          ),
        });
    } else if (event.sourceId) switchBuilding(event.sourceId);
  };
  useEffect(() => {
    engine.setEditPointerHandler(handler);
  });

  function updateOpening(opening: BuildingOpening) {
    if (!feature) return;
    if (opening.path.length)
      opening = {
        ...opening,
        path: [
          toMap(openingPosition(opening, definition), definition),
          ...opening.path.slice(1),
        ],
      };
    const next = {
      ...draftRef.current,
      openings: draftRef.current.openings.map((item) =>
        item.id === opening.id ? opening : item,
      ),
    };
    const invalid = validateBuildingOpenings(feature.geometry, next);
    if (invalid) {
      setMessage(invalid);
      return;
    }
    setMessage("");
    change(next);
  }
  function validate(): string | undefined {
    if (!feature || !planBuilding) return "Select a visible building.";
    if (stale)
      return "The footprint changed. Reset placements and place the openings again.";
    const invalid = validateBuildingOpenings(feature.geometry, draft);
    if (invalid) return invalid;
    for (const opening of draft.openings) {
      const part = context.plan.buildings.find(
        (building) =>
          building.sourceId === sourceId &&
          openingOnBuilding(opening, building, definition),
      );
      if (!part) return "An opening is no longer attached to a visible wall.";
      const eaves = buildingAppearance(customizedPlan(part, draft)).eaves;
      const top =
        opening.kind === "window"
          ? opening.sill + 1.3
          : opening.kind === "garage"
            ? 2.3
            : 2.1;
      if (top > eaves - 0.1)
        return "An opening is too tall for the wall below the roof.";
      if (opening.path.length === 1)
        return "Finish the route with at least one point beyond the entrance, or remove the route.";
      if (
        opening.path.length >= 2 &&
        !routeMeetsRoad(
          toLocal(opening.path.at(-1)!, definition),
          context.plan,
          opening.roadId,
        )
      )
        return "The route must end at the selected road or a sidewalk/path. Move its last yellow handle onto the road, or regenerate it.";
      if (
        opening.path.length >= 2 &&
        routeBlocked(
          [
            openingPosition(opening, definition),
            ...opening.path.slice(1).map((p) => toLocal(p, definition)),
          ],
          context.plan.buildings,
          opening.kind === "garage" ? openingWidth(opening) : 1.2,
          sourceId,
        )
      )
        return "A driveway or path crosses a building. Move its yellow route handles or regenerate it.";
    }
    if (
      draft.boundaries.some((item) =>
        item.points.every(
          (p) => p[0] === item.points[0]![0] && p[1] === item.points[0]![1],
        ),
      )
    )
      return "A boundary needs two different points.";
    return undefined;
  }
  async function save() {
    const error = validate();
    if (error) {
      setMessage(error);
      return;
    }
    setSaving(true);
    setTool("select");
    try {
      const value = await api.saveBuildingCustomization(
        definition.world.id,
        draft,
      );
      baseline.current = JSON.stringify(value);
      setDraft(value);
      draftRef.current = value;
      onDefinitionChange({
        ...definition,
        buildingCustomizations: [
          ...(definition.buildingCustomizations ?? []).filter(
            (item) => item.sourceId !== sourceId,
          ),
          value,
        ],
      });
      setMessage(
        "Saved. These customizations will appear whenever this building is loaded again.",
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Save failed; your edits remain here.",
      );
    } finally {
      setSaving(false);
    }
  }
  function discard() {
    if (!feature) return;
    const value = saved ?? emptyCustomization(feature);
    setDraft(value);
    draftRef.current = value;
    baseline.current = JSON.stringify(value);
    setHistory([]);
    setFuture([]);
    setSelectedId(undefined);
    setTool("select");
    setMessage("Unsaved changes discarded.");
  }

  if (!feature)
    return (
      <aside className="inspector glass-panel">
        This world has no buildings to edit.
      </aside>
    );
  return (
    <aside
      className="inspector glass-panel building-editor"
      aria-label="Building editor"
    >
      <h2>Edit building</h2>
      <div className="editor-savebar">
        <div className="editor-actions">
          <button
            disabled={!dirty || saving || stale || unavailable}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save building"}
          </button>
          <button disabled={!dirty || saving} onClick={discard}>
            Discard changes
          </button>
        </div>
        <p className="editor-status" role="status">
          {message ||
            (dirty
              ? "Unsaved preview — save to keep these changes."
              : "Saved edits apply across worlds in this installation.")}
        </p>
      </div>
      <label>
        Building
        <select
          aria-label="Building to edit"
          value={sourceId}
          onChange={(event) => switchBuilding(event.target.value)}
          disabled={saving}
        >
          {buildings.map((item) => (
            <option key={item.sourceId} value={item.sourceId}>
              {hasCustomization(
                definition.buildingCustomizations?.find(
                  (v) => v.sourceId === item.sourceId,
                ),
              )
                ? "★ "
                : ""}
              {item.tags.name ?? item.tags["addr:housenumber"] ?? item.sourceId}
            </option>
          ))}
        </select>
      </label>
      <button onClick={() => engine.focusBuilding(sourceId)}>
        Focus building
      </button>
      <label className="editor-checkbox">
        <input
          type="checkbox"
          checked={highlight}
          onChange={(event) => setHighlight(event.target.checked)}
        />
        Highlight customized buildings
      </label>
      <p className="garage-hint">
        Click to place. Drag yellow handles to move doors, route points or
        boundaries. Scroll to zoom; drag the scene to orbit.
      </p>
      {unavailable && (
        <p role="alert">
          This building is hidden. Show it in Inspect before editing.
        </p>
      )}
      {stale && (
        <p role="alert">
          The OSM footprint has changed. Saved placements are paused. Reset
          placements below, then place doors on the new walls.
        </p>
      )}
      <fieldset disabled={saving || unavailable || stale}>
        <legend>Doors and windows</legend>
        <label>
          Garage width
          <select
            aria-label="Garage width"
            value={selected?.kind === "garage" ? selected.cars : cars}
            onChange={(event) => {
              const count = Number(event.target.value) as 1 | 2 | 3;
              setCars(count);
              if (selected?.kind === "garage")
                updateOpening({ ...selected, cars: count });
            }}
          >
            {[1, 2, 3].map((count) => (
              <option key={count} value={count}>
                {count} {count === 1 ? "car" : "cars"} ·{" "}
                {(count * 2.7).toFixed(1)} m
              </option>
            ))}
          </select>
        </label>
        <div className="editor-actions">
          {(["front-door", "garage", "window"] as const).map((kind) => (
            <button
              key={kind}
              aria-pressed={tool === kind}
              onClick={() => {
                setTool(kind);
                setMessage(
                  "Click a wall of the selected building, or choose a wall below.",
                );
              }}
            >
              {kind === "front-door"
                ? "Place front door"
                : kind === "garage"
                  ? "Place garage door"
                  : "Place window"}
            </button>
          ))}
        </div>
        {(tool === "front-door" || tool === "garage" || tool === "window") && (
          <label>
            Or place at wall centre
            <select
              aria-label="Place on wall"
              value=""
              onChange={(event) => {
                const wall = exteriorWalls(feature)[Number(event.target.value)];
                if (!wall) return;
                const a = toLocal(wall[0], definition),
                  b = toLocal(wall[1], definition);
                place({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }, tool);
                setTool("select");
              }}
            >
              <option value="">Choose a wall…</option>
              {exteriorWalls(feature).map((wall, index) => {
                const a = toLocal(wall[0], definition),
                  b = toLocal(wall[1], definition);
                return (
                  <option key={index} value={index}>
                    Wall {index + 1} ·{" "}
                    {Math.hypot(b.x - a.x, b.z - a.z).toFixed(1)} m
                  </option>
                );
              })}
            </select>
          </label>
        )}
        <label>
          Placed item
          <select
            aria-label="Placed item"
            value={selectedId ?? ""}
            onChange={(event) => {
              setSelectedId(event.target.value);
              const opening = draft.openings.find(
                (item) => item.id === event.target.value,
              );
              if (opening) setCars(opening.cars);
            }}
          >
            <option value="">Select an item…</option>
            {draft.openings.map((item, index) => (
              <option value={item.id} key={item.id}>
                {index + 1}. {item.kind}
                {item.kind === "garage" ? ` (${item.cars} cars)` : ""}
              </option>
            ))}
            {draft.boundaries.map((item, index) => (
              <option value={item.id} key={item.id}>
                Boundary {index + 1}: {item.kind}
              </option>
            ))}
          </select>
        </label>
        {selected && (
          <>
            <label>
              Position along wall
              <input
                aria-label="Position along wall"
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={selected.fraction}
                onChange={(event) =>
                  updateOpening({
                    ...selected,
                    fraction: Number(event.target.value),
                  })
                }
              />
            </label>
            {selected.kind !== "garage" && (
              <label>
                Opening width (m)
                <input
                  aria-label="Opening width"
                  type="number"
                  min="0.5"
                  max="4"
                  step="0.1"
                  value={selected.width}
                  onChange={(event) =>
                    updateOpening({
                      ...selected,
                      width: Math.max(
                        0.5,
                        Math.min(4, Number(event.target.value)),
                      ),
                    })
                  }
                />
              </label>
            )}
            {selected.kind === "window" && (
              <label>
                Window sill height (m)
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  value={selected.sill}
                  onChange={(event) =>
                    updateOpening({
                      ...selected,
                      sill: Math.max(0, Number(event.target.value)),
                    })
                  }
                />
              </label>
            )}
            {selected.kind !== "window" && (
              <>
                <label>
                  Connect to road
                  <select
                    aria-label="Connect to road"
                    value={selected.roadId ?? ""}
                    onChange={(event) =>
                      updateOpening({
                        ...selected,
                        roadId: event.target.value || undefined,
                      })
                    }
                  >
                    <option value="">Nearest accessible road</option>
                    {[
                      ...new Map(
                        context.plan.roads
                          .filter((road) => !road.bridge && !road.tunnel)
                          .map((road) => [road.sourceId, road]),
                      ).values(),
                    ].map((road) => (
                      <option key={road.sourceId} value={road.sourceId}>
                        {road.name ?? road.sourceId}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="editor-actions">
                  <button
                    onClick={() => {
                      setMessage("");
                      change({
                        ...draft,
                        openings: draft.openings.map((item) =>
                          item.id === selected.id ? connect(selected) : item,
                        ),
                      });
                    }}
                  >
                    Generate {selected.kind === "garage" ? "driveway" : "path"}
                  </button>
                  <button
                    onClick={() => {
                      updateOpening({
                        ...selected,
                        path: [
                          toMap(
                            openingPosition(selected, definition),
                            definition,
                          ),
                        ],
                      });
                      setTool("route");
                      setMessage(
                        "Click ground points towards the road, then Finish drawing. Drag yellow points to refine the route.",
                      );
                    }}
                  >
                    Draw route
                  </button>
                  <button
                    disabled={selected.path.length < 2}
                    onClick={() => {
                      const path = [...selected.path];
                      const a = path[path.length - 2]!,
                        b = path[path.length - 1]!;
                      path.splice(path.length - 1, 0, [
                        (a[0] + b[0]) / 2,
                        (a[1] + b[1]) / 2,
                      ]);
                      updateOpening({ ...selected, path });
                    }}
                  >
                    Add bend
                  </button>
                  <button
                    disabled={!selected.path.length}
                    onClick={() => updateOpening({ ...selected, path: [] })}
                  >
                    Remove route
                  </button>
                </div>
                <small>
                  {selected.path.length > 1
                    ? `${selected.path.length - 1} route points · drag yellow handles`
                    : "No route attached"}
                </small>
                {selected.path.length > 2 && (
                  <button
                    onClick={() =>
                      updateOpening({
                        ...selected,
                        path: selected.path.filter(
                          (_, i) => i !== selected.path.length - 2,
                        ),
                      })
                    }
                  >
                    Remove last bend
                  </button>
                )}
              </>
            )}
          </>
        )}
        {(selected || boundary) && (
          <button
            onClick={() => {
              change({
                ...draft,
                openings: draft.openings.filter(
                  (item) => item.id !== selectedId,
                ),
                boundaries: draft.boundaries.filter(
                  (item) => item.id !== selectedId,
                ),
              });
              setSelectedId(undefined);
            }}
          >
            Delete selected item
          </button>
        )}
        {boundary && (
          <button
            disabled={boundary.points.length < 3}
            onClick={() => {
              change({
                ...draft,
                boundaries: draft.boundaries.map((item) =>
                  item.id === boundary.id
                    ? { ...item, points: [...item.points, item.points[0]!] }
                    : item,
                ),
              });
              setTool("select");
              activeBoundary.current = undefined;
            }}
          >
            Close boundary
          </button>
        )}
      </fieldset>
      <fieldset disabled={saving || unavailable || stale}>
        <legend>Appearance</legend>
        <label>
          Roof shape
          <select
            aria-label="Roof shape"
            value={draft.appearance.roof ?? ""}
            onChange={(event) =>
              change({
                ...draft,
                appearance: {
                  ...draft.appearance,
                  roof: (event.target.value ||
                    undefined) as BuildingCustomization["appearance"]["roof"],
                },
              })
            }
          >
            <option value="">From map / estimated</option>
            <option value="gabled">Gabled</option>
            <option value="hipped">Hipped</option>
            <option value="flat">Flat</option>
          </select>
        </label>
        <label>
          Wall finish
          <select
            value={draft.appearance.material ?? ""}
            onChange={(event) =>
              change({
                ...draft,
                appearance: {
                  ...draft.appearance,
                  material: (event.target.value ||
                    undefined) as BuildingCustomization["appearance"]["material"],
                },
              })
            }
          >
            <option value="">From map / estimated</option>
            <option value="brick">Brick</option>
            <option value="siding">Siding</option>
            <option value="stucco">Stucco</option>
          </select>
        </label>
        <label>
          Wall color
          <input
            aria-label="Wall color"
            type="color"
            value={
              draft.appearance.wallColor ??
              (planBuilding
                ? buildingAppearance(planBuilding).wallColor
                : "#c0c0c0")
            }
            onChange={(event) =>
              change({
                ...draft,
                appearance: {
                  ...draft.appearance,
                  wallColor: event.target.value,
                },
              })
            }
          />
        </label>
        <label>
          Roof color
          <input
            aria-label="Roof color"
            type="color"
            value={
              draft.appearance.roofColor ??
              (planBuilding
                ? buildingAppearance(planBuilding).roofColor
                : "#555555")
            }
            onChange={(event) =>
              change({
                ...draft,
                appearance: {
                  ...draft.appearance,
                  roofColor: event.target.value,
                },
              })
            }
          />
        </label>
      </fieldset>
      <fieldset disabled={saving || unavailable || stale}>
        <legend>Fences and garden boundaries</legend>
        <div className="editor-actions">
          {(["fence", "gate", "garden"] as const).map((kind) => (
            <button
              key={kind}
              aria-pressed={tool === kind}
              onClick={() => {
                setTool(kind);
                activeBoundary.current = undefined;
                setMessage(
                  "Click ground points to draw the boundary, then Finish drawing.",
                );
              }}
            >
              Draw {kind}
            </button>
          ))}
        </div>
      </fieldset>
      {tool !== "select" && (
        <button
          onClick={() => {
            setTool("select");
            activeBoundary.current = undefined;
          }}
        >
          Finish drawing / cancel placement
        </button>
      )}
      <div className="editor-actions">
        <button
          disabled={!history.length || saving}
          onClick={() => {
            const value = history.at(-1)!;
            setFuture((items) => [...items, draft]);
            setHistory((items) => items.slice(0, -1));
            setDraft({ ...value, revision: draft.revision });
          }}
        >
          Undo edit
        </button>
        <button
          disabled={!future.length || saving}
          onClick={() => {
            const value = future.at(-1)!;
            setHistory((items) => [...items, draft]);
            setFuture((items) => items.slice(0, -1));
            setDraft({ ...value, revision: draft.revision });
          }}
        >
          Redo edit
        </button>
      </div>
      <button
        disabled={saving}
        onClick={() => {
          change(emptyCustomization(feature, draft.revision));
          setTool("select");
          setSelectedId(undefined);
          setMessage(
            "Placements and appearance reset in preview. Save building to apply this reset across future worlds.",
          );
        }}
      >
        Reset building customizations
      </button>
      <button
        disabled={saving}
        onClick={() =>
          void api
            .getWorldDefinition(definition.world.id)
            .then((next) => {
              const value =
                next.buildingCustomizations?.find(
                  (item) => item.sourceId === sourceId,
                ) ?? emptyCustomization(feature);
              onDefinitionChange(next);
              baseline.current = JSON.stringify(value);
              setDraft(value);
              setHistory([]);
              setFuture([]);
              setMessage("Loaded the latest saved changes.");
            })
            .catch((error: unknown) =>
              setMessage(
                error instanceof Error ? error.message : "Reload failed.",
              ),
            )
        }
      >
        Discard and reload saved changes
      </button>
    </aside>
  );
}
