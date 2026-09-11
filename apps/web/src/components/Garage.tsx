import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  disposeVehicleModel,
  loadVehicleModel,
  vehicles,
  type VehicleChoice,
} from "../engine/vehicleModels.js";

export function Garage({
  choice,
  onApply,
  onClose,
}: {
  choice: VehicleChoice;
  onApply: (choice: VehicleChoice) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(choice);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    const host = preview.current;
    if (!host) return;
    let cancelled = false;
    let frame = 0;
    let object: THREE.Group | undefined;
    setReady(false);
    setError("");
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#172b35");
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(6, 3.2, -6);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    host.append(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false;
    controls.minDistance = 5;
    controls.maxDistance = 12;
    controls.autoRotate = true;
    let previousTime = performance.now();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x657369, 3));
    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(3, 6, -4);
    scene.add(light);
    const resize = new ResizeObserver(() => {
      const width = host.clientWidth,
        height = host.clientHeight;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    });
    resize.observe(host);
    void loadVehicleModel(draft)
      .then((model) => {
        if (cancelled) {
          disposeVehicleModel(model.root);
          return;
        }
        object = model.root;
        scene.add(object);
        setReady(true);
      })
      .catch(() => {
        if (!cancelled)
          setError(
            "Could not load this car. Your current vehicle is unchanged. Please retry.",
          );
      });
    const animate = () => {
      const now = performance.now();
      controls.update(Math.min((now - previousTime) / 1000, 0.1));
      previousTime = now;
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };
    animate();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      controls.dispose();
      if (object) disposeVehicleModel(object);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [draft]);
  return (
    <dialog
      ref={dialog}
      className="garage"
      aria-labelledby="garage-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="garage-heading">
        <div>
          <p className="eyebrow">StreetRove garage</p>
          <h2 id="garage-title">Choose your ride</h2>
        </div>
        <button disabled={busy} onClick={onClose} aria-label="Close garage">
          ×
        </button>
      </div>
      <div
        ref={preview}
        className="garage-preview"
        aria-label="Interactive vehicle preview"
      />
      <p className="garage-hint">
        Drag to look around. All cars share the same handling.
      </p>
      <div className="garage-cars" role="group" aria-label="Vehicle models">
        {vehicles.map((vehicle) => (
          <button
            key={vehicle.id}
            disabled={busy}
            aria-pressed={draft.id === vehicle.id}
            onClick={() => setDraft({ ...draft, id: vehicle.id })}
          >
            {vehicle.name}
          </button>
        ))}
      </div>
      <label className="garage-paint">
        Paint color{" "}
        <input
          type="color"
          value={draft.color}
          disabled={busy}
          onChange={(event) =>
            setDraft({ ...draft, color: event.target.value })
          }
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <div className="garage-heading">
        <small>
          CC0 models by{" "}
          <a
            href="https://kenney.nl/assets/car-kit"
            target="_blank"
            rel="noreferrer"
          >
            Kenney
          </a>
          . Saved on this device.
        </small>
        <button
          disabled={!ready || busy}
          onClick={() => {
            setBusy(true);
            void onApply(draft)
              .then(onClose)
              .catch(() => setError("Could not switch cars. Please try again."))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Loading…" : "Use this car"}
        </button>
      </div>
    </dialog>
  );
}
