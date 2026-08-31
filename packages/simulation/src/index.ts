export interface VehicleConfig {
  chassisHalfExtents: [number, number, number];
  chassisMass: number;
  wheelRadius: number;
  wheelWidth: number;
  suspensionRestLength: number;
  suspensionStiffness: number;
  suspensionCompression: number;
  suspensionRelaxation: number;
  maxSuspensionForce: number;
  engineForce: number;
  brakeForce: number;
  handbrakeForce: number;
  maxSteeringAngle: number;
  steeringResponse: number;
  frictionSlip: number;
}

export const defaultVehicleConfig: VehicleConfig = {
  chassisHalfExtents: [0.95, 0.45, 2.05],
  chassisMass: 1_200,
  wheelRadius: 0.36,
  wheelWidth: 0.24,
  suspensionRestLength: 0.34,
  suspensionStiffness: 28,
  suspensionCompression: 4.4,
  suspensionRelaxation: 2.3,
  maxSuspensionForce: 100_000,
  engineForce: 2_300,
  brakeForce: 110,
  handbrakeForce: 180,
  maxSteeringAngle: 0.48,
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
