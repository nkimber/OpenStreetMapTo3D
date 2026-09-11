import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export const vehicles = [
  {
    id: "sedan",
    name: "Everyday sedan",
    length: 2.55,
    width: 1.5,
    paintColumn: 6,
  },
  {
    id: "hatchback-sports",
    name: "Sport hatchback",
    length: 2.85,
    width: 1.3,
    paintColumn: 3,
  },
  { id: "suv", name: "Trail SUV", length: 2.55, width: 1.5, paintColumn: 3 },
] as const;
export interface VehicleChoice {
  id: string;
  color: string;
}
export const defaultVehicleChoice: VehicleChoice = {
  id: "sedan",
  color: "#e87939",
};
export function parseVehicleChoice(value: string | null): VehicleChoice {
  try {
    const choice: unknown = JSON.parse(value ?? "null");
    if (
      choice &&
      typeof choice === "object" &&
      "id" in choice &&
      "color" in choice &&
      vehicles.some((vehicle) => vehicle.id === choice.id) &&
      typeof choice.color === "string" &&
      /^#[0-9a-f]{6}$/i.test(choice.color)
    )
      return { id: String(choice.id), color: choice.color };
  } catch {
    /* Invalid or obsolete preferences use the default. */
  }
  return { ...defaultVehicleChoice };
}
export const vehicleStorageKey = "streetrove.vehicle.v1";
export function savedVehicleChoice(): VehicleChoice {
  try {
    return parseVehicleChoice(localStorage.getItem(vehicleStorageKey));
  } catch {
    return { ...defaultVehicleChoice };
  }
}
export interface ModelVisual {
  root: THREE.Group;
  wheels: THREE.Object3D[];
  connections: THREE.Vector3[];
  brake: { value: number };
}

/** Each model has its own body-paint swatch in the shared palette. */
export async function loadVehicleModel(
  choice: VehicleChoice,
): Promise<ModelVisual> {
  const spec = vehicles.find((vehicle) => vehicle.id === choice.id);
  if (!spec || !/^#[0-9a-f]{6}$/i.test(choice.color))
    throw new Error("Invalid vehicle selection.");
  const gltf = await new GLTFLoader().loadAsync(
    `/models/vehicles/${spec.id}.glb`,
  );
  const root = new THREE.Group();
  const headlights = new THREE.SpotLight(0xffedc5, 45, 28, 0.55, 0.65, 2);
  headlights.position.set(0, -0.1, -1.8);
  headlights.target.position.set(0, -1, -16);
  root.add(headlights, headlights.target);
  const model = gltf.scene;
  model.scale.set(1.9 / spec.width, 1.2, 4.1 / spec.length);
  model.rotation.y = Math.PI; // Kenney faces +Z; our controller faces -Z.
  model.position.y = -0.95;
  root.add(model);
  root.updateMatrixWorld(true);
  const brake = { value: 0 };
  const paint = { value: new THREE.Color(choice.color) };
  const materials = new Set<THREE.MeshStandardMaterial>();
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = object.receiveShadow = true;
    const material = object.material as THREE.MeshStandardMaterial;
    materials.add(material);
  });
  for (const material of materials) {
    material.roughness = 0.48;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.vehiclePaint = paint;
      shader.uniforms.vehicleBrake = brake;
      shader.fragmentShader =
        "uniform vec3 vehiclePaint;\nuniform float vehicleBrake;\n" +
        shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <map_fragment>",
          `#include <map_fragment>
        if (floor(vMapUv.x * 8.0) == ${spec.paintColumn}.0 && vMapUv.y > 0.25 && vMapUv.y < 0.5)
          diffuseColor.rgb = vehiclePaint * (0.65 + 0.35 * diffuseColor.r);
      `,
        )
        .replace(
          "#include <emissivemap_fragment>",
          `#include <emissivemap_fragment>
        if (vMapUv.y > 0.75 && vMapUv.x < 0.25) totalEmissiveRadiance += vec3(0.8, 0.7, 0.4);
        if (vMapUv.y > 0.75 && vMapUv.x > 0.3 && vMapUv.x < 0.4)
          totalEmissiveRadiance += vec3(1.0, 0.02, 0.01) * (0.15 + vehicleBrake * 2.0);
      `,
        );
    };
    material.customProgramCacheKey = () =>
      `streetrove-vehicle-palette-v2-${spec.paintColumn}`;
  }
  const names = [
    "wheel-front-left",
    "wheel-front-right",
    "wheel-back-left",
    "wheel-back-right",
  ];
  const connections: THREE.Vector3[] = [];
  const wheels = names.map((name) => {
    const wheel = model.getObjectByName(name);
    if (!(wheel instanceof THREE.Mesh)) {
      disposeVehicleModel(root);
      throw new Error(`Vehicle is missing ${name}.`);
    }
    // Centre each mesh on its true axle, then keep steering separate from rolling.
    wheel.geometry.computeBoundingBox();
    const center = wheel.geometry.boundingBox!.getCenter(new THREE.Vector3());
    const axle = wheel.localToWorld(center.clone());
    const pivot = new THREE.Group();
    root.add(pivot);
    pivot.position.copy(axle);
    pivot.attach(wheel);
    wheel.geometry.translate(-center.x, -center.y, -center.z);
    wheel.position.set(0, 0, 0);
    wheel.scale.setScalar(1.2); // Circular 0.36 m tires, independent of body proportions.
    const connection = axle.clone();
    connection.y += 0.34;
    connections.push(connection);
    return pivot;
  });
  return { root, wheels, connections, brake };
}

export function disposeVehicleModel(root: THREE.Object3D): void {
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    for (const material of Array.isArray(object.material)
      ? object.material
      : [object.material])
      materials.add(material);
  });
  for (const material of materials) {
    for (const value of Object.values(material))
      if (value instanceof THREE.Texture) textures.add(value);
    material.dispose();
  }
  textures.forEach((texture) => {
    (texture.source.data as ImageBitmap | undefined)?.close?.();
    texture.dispose();
  });
}
