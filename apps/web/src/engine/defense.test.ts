import * as THREE from "three";
import type { BuildingPlan } from "@osm3d/worldgen";
import { describe, expect, it } from "vitest";
import { CombatEffects } from "./combat.js";
import {
  DefenseSession,
  buildRoadGraph,
  chooseSpawnNodes,
  chooseTargetBuilding,
  nearestNode,
  pathToGoal,
  routesToGoal,
} from "./defense.js";
import { RobotKit, ROBOT_HEIGHT, createRobot, poseWalk } from "./robot.js";

const road = (points: [number, number][]) => ({
  tunnel: false,
  points: points.map(([x, z]) => ({ x, y: 0, z })),
});

// A plus-shaped street grid: four arms meeting at the origin.
const roads = [
  road([
    [-400, 0],
    [-200, 0],
    [0, 0],
  ]),
  road([
    [0, 0],
    [200, 0],
    [400, 0],
  ]),
  road([
    [0, -400],
    [0, 0.8],
  ]),
  road([
    [0, 0],
    [0, 400],
  ]),
];

describe("robot routing", () => {
  it("joins roads that meet at a junction into one graph", () => {
    const graph = buildRoadGraph(roads);
    const center = nearestNode(graph, 0, 0);
    expect(graph.edges[center]!.length).toBe(4);
  });

  it("walks the shortest road route to the goal", () => {
    const graph = buildRoadGraph(roads);
    const goal = nearestNode(graph, 0, 0);
    const routes = routesToGoal(graph, goal);
    const start = nearestNode(graph, -400, 0);
    const path = pathToGoal(start, routes.next).map((id) => graph.nodes[id]!);
    expect(path.at(-1)!.distanceTo(new THREE.Vector3())).toBeLessThan(1);
    expect(routes.distance[start]).toBeCloseTo(400, 0);
  });

  it("spawns robots at road ends spread around the map edge", () => {
    const graph = buildRoadGraph(roads);
    const goal = nearestNode(graph, 0, 0);
    const spawns = chooseSpawnNodes(
      graph,
      routesToGoal(graph, goal),
      { centerX: 0, centerZ: 0, halfWidth: 420, halfDepth: 420 },
      new THREE.Vector3(),
    );
    const ends = spawns
      .slice(0, 4)
      .map((id) => graph.nodes[id]!)
      .map((node) => `${Math.round(node.x)},${Math.round(node.z)}`)
      .sort();
    expect(ends).toEqual(["-400,0", "0,-400", "0,400", "400,0"]);
  });

  it("defends the building nearest the middle of the map", () => {
    const house = (x: number, id: string) =>
      ({
        sourceId: id,
        baseHeight: 0,
        height: 8,
        rings: [
          [
            { x, z: 0 },
            { x: x + 10, z: 0 },
            { x: x + 10, z: 10 },
            { x, z: 10 },
          ],
        ],
      }) as BuildingPlan;
    const target = chooseTargetBuilding(
      [house(200, "far"), house(-5, "middle")],
      0,
      0,
    );
    expect(target?.building.sourceId).toBe("middle");
  });
});

describe("giant robot", () => {
  it("stands about 100 feet tall with a merged, low draw-call mesh", () => {
    const kit = new RobotKit();
    const robot = createRobot(kit);
    poseWalk(robot, 0, 1);
    robot.root.updateMatrixWorld(true);
    const size = new THREE.Box3()
      .setFromObject(robot.root)
      .getSize(new THREE.Vector3());
    expect(size.y).toBeGreaterThan(ROBOT_HEIGHT - 2);
    expect(size.y).toBeLessThan(ROBOT_HEIGHT + 8);
    let meshes = 0;
    robot.root.traverse((object) => {
      if (object instanceof THREE.Mesh) meshes += 1;
    });
    expect(meshes).toBeLessThan(70);
    kit.dispose();
  });

  it("swings its legs in opposition while walking", () => {
    const robot = createRobot(new RobotKit());
    poseWalk(robot, Math.PI / 2, 1);
    const [left, right] = robot.legs;
    expect(left!.pivot.rotation.x).toBeGreaterThan(0.3);
    expect(right!.pivot.rotation.x).toBeLessThan(-0.3);
  });
});

describe("defense session", () => {
  // Minimal DOM stand-ins for the screen-edge arrows.
  const element = () => ({
    className: "",
    hidden: true,
    style: { setProperty() {}, left: "", top: "" },
    dataset: {},
    remove() {},
    appendChild() {},
  });
  globalThis.document ??= {
    createElement: element,
  } as unknown as Document;

  const setup = () => {
    const scene = new THREE.Scene();
    const combat = new CombatEffects(scene, () => 0);
    const destroyed: string[] = [];
    const session = DefenseSession.create({
      scene,
      combat,
      roads: roads.map((item) => ({ ...item }) as never),
      buildings: [
        {
          sourceId: "home",
          baseHeight: 0,
          height: 8,
          rings: [
            [
              { x: 5, z: 5 },
              { x: 15, z: 5 },
              { x: 15, z: 15 },
              { x: 5, z: 15 },
            ],
          ],
        } as BuildingPlan,
      ],
      groundHeight: () => 0,
      bounds: { centerX: 0, centerZ: 0, halfWidth: 420, halfDepth: 420 },
      helicopter: () => undefined,
      onHelicopterHit() {},
      onHelicopterDestroyed() {},
      destroyBuilding: (id) => destroyed.push(id),
      overlayParent: element() as unknown as HTMLElement,
    });
    if (typeof session === "string") throw new Error(session);
    return { session, destroyed };
  };
  const run = (session: DefenseSession, seconds: number) => {
    for (let t = 0; t < seconds; t += 1 / 60) session.update(1 / 60);
  };
  it("counts down, then marches robots along the roads toward the house", () => {
    const { session } = setup();
    expect(session.stats().phase).toBe("countdown");
    run(session, 7);
    const stats = session.stats();
    expect(stats.phase).toBe("wave");
    expect(stats.robots).toHaveLength(1);
    const start = stats.robots[0]!.distanceToHouse;
    run(session, 3);
    const later = session.stats().robots[0]!.distanceToHouse;
    expect(start - later).toBeGreaterThan(12);
  });

  it("topples a destroyed robot, flashes it for five seconds, then removes it", () => {
    const { session } = setup();
    run(session, 7);
    const robot = (
      session as unknown as { robots: { rig: RobotRigLike; state: string }[] }
    ).robots[0]!;
    const aim = () =>
      robot.rig.root.position.clone().add(new THREE.Vector3(0, 20, 0));
    for (let shot = 0; shot < 10; shot += 1) {
      expect(session.rocketHit(aim())).toBe(true);
      run(session, 0.1);
    }
    expect(robot.state).toBe("falling");
    expect(session.rocketHit(aim())).toBe(false);
    run(session, 2.5);
    expect(robot.state).toBe("down");
    expect(Math.abs(robot.rig.root.rotation.x)).toBeCloseTo(Math.PI / 2, 1);
    run(session, 5.1);
    expect(robot.state).toBe("sinking");
    run(session, 1.5);
    // Only the wave's second robot, spawned meanwhile, is left.
    expect(robot.state).toBe("gone");
    expect(session.stats().robots.map((item) => item.id)).toEqual([2]);
    expect(session.stats().destroyed).toBe(1);
  });

  it("wins after clearing every wave and loses if the house falls", () => {
    const { session } = setup();
    const internals = session as unknown as {
      robots: { rig: RobotRigLike; health: number }[];
    };
    for (let guard = 0; guard < 200 && session.active; guard += 1) {
      run(session, 1);
      for (const robot of internals.robots)
        for (let shot = 0; shot < 40 && robot.health > 0; shot += 1) {
          // Head shots, aimed through the robot's current facing.
          const head = new THREE.Vector3(0, 28.4, -3.6).applyAxisAngle(
            new THREE.Vector3(0, 1, 0),
            robot.rig.root.rotation.y,
          );
          session.rocketHit(robot.rig.root.position.clone().add(head));
        }
    }
    expect(session.stats().phase).toBe("won");
    expect(session.stats().headshots).toBeGreaterThan(0);

    const second = setup();
    run(second.session, 400);
    expect(second.session.stats().phase).toBe("lost");
    expect(second.destroyed).toEqual(["home"]);
  });
});

type RobotRigLike = { root: THREE.Group };
