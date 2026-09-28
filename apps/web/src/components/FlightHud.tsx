import { useEffect, useState } from "react";
import type { FlightStats } from "../engine/WorldEngine.js";

const statusText: Record<FlightStats["form"], string> = {
  rising: "Transforming…",
  landing: "Folding back into a car…",
  flying: "Airborne",
};

const controls: Array<[string[], string]> = [
  [["W", "S"], "Forward / back"],
  [["A", "D"], "Turn left / right"],
  [["Space", "E"], "Climb"],
  [["Shift", "Q"], "Descend"],
  [["T"], "Land, then transform"],
  [["H"], "Hide these controls"],
];

/** Replaces the mini map while flying: flight readouts plus the key legend. */
export function FlightHud({ flight }: { flight: FlightStats }) {
  const [controlsOpen, setControlsOpen] = useState(true);
  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if (
        event.code === "KeyH" &&
        !(
          event.target instanceof Element &&
          event.target.closest("input, select, textarea")
        )
      )
        setControlsOpen((open) => !open);
    };
    window.addEventListener("keydown", toggle);
    return () => window.removeEventListener("keydown", toggle);
  }, []);

  return (
    <aside className="flight-hud glass-panel" aria-label="Helicopter">
      <div className="flight-hud-readouts">
        <span>
          <strong>{flight.altitudeMeters}</strong>
          <small>m altitude</small>
        </span>
        <span>
          <strong>{flight.airspeedKph}</strong>
          <small>km/h</small>
        </span>
        <span>
          <strong>{flight.headingDegrees}°</strong>
          <small>heading</small>
        </span>
      </div>
      <small className="flight-hud-status">
        {flight.form === "flying" && flight.grounded
          ? "Landed · press T to drive"
          : statusText[flight.form]}
      </small>
      <details
        open={controlsOpen}
        onToggle={(event) => setControlsOpen(event.currentTarget.open)}
      >
        <summary>Controls</summary>
        <dl>
          {controls.map(([keys, action]) => (
            <div key={action} style={{ display: "contents" }}>
              <dt>
                {keys.map((key, index) => (
                  <span key={key}>
                    {index > 0 && " / "}
                    <kbd>{key}</kbd>
                  </span>
                ))}
              </dt>
              <dd>{action}</dd>
            </div>
          ))}
        </dl>
      </details>
    </aside>
  );
}
