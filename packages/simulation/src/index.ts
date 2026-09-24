export interface VehicleConfig {
  chassisHalfExtents: [number, number, number];
  chassisCenterOfMassOffsetY: number;
  chassisMass: number;
  wheelRadius: number;
  wheelWidth: number;
  suspensionRestLength: number;
  suspensionStiffness: number;
  suspensionCompression: number;
  suspensionRelaxation: number;
  maxSuspensionForce: number;
  engineForce: number;
  maxForwardSpeedKph: number;
  maxReverseSpeedKph: number;
  brakeForce: number;
  handbrakeForce: number;
  maxSteeringAngle: number;
  highSpeedSteeringFactor: number;
  steeringResponse: number;
  frictionSlip: number;
}

export {
  generateRaceCourse,
  nearestRaceProgress,
  routeDistances,
  sampleRaceRoute,
} from "./raceCourse.js";
export type {
  GenerateRaceCourseOptions,
  RaceCourse,
  RacePoint,
  RaceRoad,
} from "./raceCourse.js";

export const defaultVehicleConfig: VehicleConfig = {
  chassisHalfExtents: [0.95, 0.45, 2.05],
  chassisCenterOfMassOffsetY: -0.16,
  chassisMass: 1_200,
  wheelRadius: 0.36,
  wheelWidth: 0.24,
  suspensionRestLength: 0.4,
  suspensionStiffness: 32,
  suspensionCompression: 5.2,
  suspensionRelaxation: 3,
  maxSuspensionForce: 100_000,
  engineForce: 2_300,
  maxForwardSpeedKph: 90,
  maxReverseSpeedKph: 32,
  brakeForce: 110,
  handbrakeForce: 180,
  maxSteeringAngle: 0.48,
  highSpeedSteeringFactor: 0.7,
  steeringResponse: 4.5,
  frictionSlip: 3.8,
};

export interface VehicleInput {
  throttle: number;
  brake: number;
  steering: number;
  handbrake: boolean;
}

export const neutralVehicleInput: VehicleInput = {
  throttle: 0,
  brake: 0,
  steering: 0,
  handbrake: false,
};

export function approach(
  current: number,
  target: number,
  maxDelta: number,
): number {
  if (current < target) return Math.min(current + maxDelta, target);
  if (current > target) return Math.max(current - maxDelta, target);
  return target;
}

export function smoothVehicleInput(
  current: VehicleInput,
  target: VehicleInput,
  deltaSeconds: number,
  steeringResponse = defaultVehicleConfig.steeringResponse,
): VehicleInput {
  return {
    throttle: approach(current.throttle, target.throttle, deltaSeconds * 3),
    brake: approach(current.brake, target.brake, deltaSeconds * 5),
    steering: approach(
      current.steering,
      target.steering,
      deltaSeconds * steeringResponse,
    ),
    handbrake: target.handbrake,
  };
}

export function speedLimitedEngineForce(
  throttle: number,
  speedKph: number,
  config: Pick<
    VehicleConfig,
    "engineForce" | "maxForwardSpeedKph" | "maxReverseSpeedKph"
  > = defaultVehicleConfig,
): number {
  const normalizedThrottle = Math.max(-1, Math.min(1, throttle));
  const speedLimit =
    normalizedThrottle >= 0
      ? config.maxForwardSpeedKph
      : config.maxReverseSpeedKph;
  const normalizedSpeed = Math.max(0, Math.abs(speedKph)) / speedLimit;
  const availableForce = Math.max(0, 1 - normalizedSpeed * normalizedSpeed);
  return -normalizedThrottle * config.engineForce * availableForce;
}

export function speedAdjustedSteeringAngle(
  steering: number,
  speedKph: number,
  config: Pick<
    VehicleConfig,
    "maxSteeringAngle" | "maxForwardSpeedKph" | "highSpeedSteeringFactor"
  > = defaultVehicleConfig,
): number {
  const highSpeedBlend = Math.max(
    0,
    Math.min(1, (Math.abs(speedKph) - 25) / (config.maxForwardSpeedKph - 25)),
  );
  const speedFactor = 1 - highSpeedBlend * (1 - config.highSpeedSteeringFactor);
  return (
    Math.max(-1, Math.min(1, steering)) * config.maxSteeringAngle * speedFactor
  );
}

export interface RacerAvoidanceSample {
  forwardX: number;
  forwardZ: number;
  offsetX: number;
  offsetZ: number;
}

/** Brakes a route-following racer before it can keep pushing another car. */
export function racerProximityBrake(sample: RacerAvoidanceSample): number {
  const distance = Math.hypot(sample.offsetX, sample.offsetZ);
  if (distance <= 2.2) return 1;
  const forwardLength = Math.hypot(sample.forwardX, sample.forwardZ);
  if (forwardLength < 0.001) return 0;
  const forwardX = sample.forwardX / forwardLength;
  const forwardZ = sample.forwardZ / forwardLength;
  const longitudinal = forwardX * sample.offsetX + forwardZ * sample.offsetZ;
  const lateral = Math.abs(
    forwardZ * sample.offsetX - forwardX * sample.offsetZ,
  );
  if (longitudinal <= 0 || longitudinal >= 11 || lateral > 2.15) return 0;
  if (longitudinal <= 4.8) return 1;
  return (11 - longitudinal) / (11 - 4.8);
}

export interface VehiclePoseSafetySample {
  uprightDot: number;
  height: number;
  insideWorld: boolean;
}

export function isVehiclePoseSafe(sample: VehiclePoseSafetySample): boolean {
  return (
    sample.uprightDot > 0.72 &&
    sample.insideWorld &&
    sample.height > 0.45 &&
    sample.height < 3.2
  );
}

export function shouldRecoverVehicle(
  unsafeSeconds: number,
  height: number,
  timeoutSeconds = 2.5,
): boolean {
  return unsafeSeconds >= timeoutSeconds || height < -8;
}

export interface StandardGamepadSnapshot {
  steeringAxis: number;
  throttle: number;
  reverse: number;
  handbrake: boolean;
}

export function standardGamepadInput(
  snapshot: StandardGamepadSnapshot,
  steeringSensitivity = 1,
): VehicleInput | undefined {
  const throttle = Math.max(0, Math.min(1, snapshot.throttle));
  const reverse = Math.max(0, Math.min(1, snapshot.reverse));
  const steering = Math.max(-1, Math.min(1, snapshot.steeringAxis));
  if (
    Math.max(throttle, reverse, Math.abs(steering)) < 0.08 &&
    !snapshot.handbrake
  )
    return undefined;
  return {
    throttle: throttle > reverse ? throttle : -reverse * 0.65,
    brake: 0,
    steering: -steering * Math.max(0.5, Math.min(1.5, steeringSensitivity)),
    handbrake: snapshot.handbrake,
  };
}
