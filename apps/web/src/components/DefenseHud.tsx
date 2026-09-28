import type { DefenseStats } from "../engine/defense.js";

function Meter({
  label,
  value,
  max,
  tone,
}: {
  label: string;
  value: number;
  max: number;
  tone: "house" | "helicopter" | "robot";
}) {
  const fraction = Math.max(0, Math.min(1, value / max));
  return (
    <div className={`defense-meter ${tone}`}>
      <span>{label}</span>
      <div>
        <i style={{ width: `${fraction * 100}%` }} />
      </div>
      <strong>{Math.round(value)}</strong>
    </div>
  );
}

/** Wave status and health for the robot attack, plus the end-of-game board. */
export function DefenseHud({
  defense,
  onRestart,
  onClose,
}: {
  defense: DefenseStats;
  onRestart: () => void;
  onClose: () => void;
}) {
  const finished = defense.phase === "won" || defense.phase === "lost";
  const living = defense.robots.filter(
    (robot) => robot.state === "walking" || robot.state === "attacking",
  );
  return (
    <>
      <section className="defense-hud glass-panel" aria-live="polite">
        <header>
          <strong>
            Wave {defense.wave} of {defense.waves}
          </strong>
          <span>
            {defense.phase === "countdown"
              ? `${defense.message ?? "Incoming"} · ${defense.countdown}`
              : defense.phase === "wave"
                ? `${living.length} robot${living.length === 1 ? "" : "s"} approaching`
                : defense.message}
          </span>
        </header>
        <Meter
          label="House"
          value={defense.houseHealth}
          max={defense.houseMaxHealth}
          tone="house"
        />
        <Meter
          label="Helicopter"
          value={defense.helicopterHealth}
          max={defense.helicopterMaxHealth}
          tone="helicopter"
        />
        {living.length > 0 && (
          <ol className="defense-robots">
            {living.map((robot) => (
              <li key={robot.id}>
                <Meter
                  label={
                    robot.state === "attacking"
                      ? "Attacking!"
                      : `${robot.distanceToHouse} m out`
                  }
                  value={robot.health}
                  max={robot.maxHealth}
                  tone="robot"
                />
              </li>
            ))}
          </ol>
        )}
        <small>
          F fires · head shots do double damage · {defense.destroyed} destroyed
        </small>
      </section>
      {finished && (
        <section
          className={`defense-result glass-panel ${defense.phase}`}
          aria-label="Attack result"
        >
          <small>{defense.phase === "won" ? "Victory" : "Defeat"}</small>
          <h2>{defense.message}</h2>
          <dl>
            <div>
              <dt>Robots destroyed</dt>
              <dd>{defense.destroyed}</dd>
            </div>
            <div>
              <dt>Head shots</dt>
              <dd>{defense.headshots}</dd>
            </div>
            <div>
              <dt>House</dt>
              <dd>{defense.houseHealth}%</dd>
            </div>
            <div>
              <dt>Score</dt>
              <dd>{defense.score.toLocaleString()}</dd>
            </div>
          </dl>
          <footer>
            <button type="button" onClick={onRestart}>
              Play again
            </button>
            <button type="button" onClick={onClose}>
              Close
            </button>
          </footer>
        </section>
      )}
    </>
  );
}
