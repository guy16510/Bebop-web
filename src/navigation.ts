import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { NormalizedBoundingBox, ObjectDetection } from './perception.js';
import type { DroneSnapshot, PilotingCommand } from './types.js';
import { ZERO_COMMAND } from './types.js';

export type SemanticBehavior = 'obstacle' | 'landmark' | 'landing-pad' | 'ignore';
export type RangeSectorName = 'frontLeft' | 'front' | 'frontRight' | 'left' | 'right' | 'rear' | 'down';

export interface SemanticObjectDefinition {
  id: string;
  name: string;
  labels: string[];
  markerIds: number[];
  behavior: SemanticBehavior;
  clearanceMeters: number;
  notes: string;
}

export interface LandingPadDefinition {
  id: string;
  name: string;
  markerId: number;
  markerSizeMeters: number;
  mapPosition?: { x: number; y: number; z: number };
  gps?: { latitude: number; longitude: number; altitude?: number };
  approachAltitudeMeters: number;
  arrivalRadiusMeters: number;
}

export interface NavigationSettings {
  obstacleAvoidanceEnabled: boolean;
  requireMetricRange: boolean;
  rangeTimeoutMs: number;
  stopDistanceMeters: number;
  cautionDistanceMeters: number;
  avoidanceYawPercent: number;
  cruiseCommandPercent: number;
  landingCommandPercent: number;
  landingDescentPercent: number;
  landingAlignmentTolerance: number;
  finalLandAltitudeMeters: number;
  markerLossTimeoutMs: number;
  landingRollSign: 1 | -1;
  landingPitchSign: 1 | -1;
  landingCameraTiltDegrees: number;
}

export interface NavigationMapState {
  settings: NavigationSettings;
  objects: SemanticObjectDefinition[];
  landingPads: LandingPadDefinition[];
  revision: number;
  updatedAt: number;
  updatedBy: 'environment' | 'web' | 'api';
}

export interface RangeSectorReading {
  distanceMeters: number;
  confidence: number;
}

export interface RangeField {
  source: string;
  observedAt: number;
  receivedAt: number;
  sectors: Partial<Record<RangeSectorName, RangeSectorReading>>;
}

export interface SemanticObservation {
  trackId: string;
  semanticId: string | null;
  name: string;
  label: string;
  behavior: SemanticBehavior;
  confidence: number;
  bbox: NormalizedBoundingBox;
  clearanceMeters: number;
  markerId: number | null;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface GuidanceResult {
  command: PilotingCommand;
  arrived: boolean;
  blocked: boolean;
  reason: string | null;
  distanceMeters?: number;
  bearingRadians?: number;
}

export const DEFAULT_NAVIGATION_SETTINGS: NavigationSettings = {
  obstacleAvoidanceEnabled: true,
  requireMetricRange: true,
  rangeTimeoutMs: 750,
  stopDistanceMeters: 1.1,
  cautionDistanceMeters: 2.2,
  avoidanceYawPercent: 10,
  cruiseCommandPercent: 10,
  landingCommandPercent: 8,
  landingDescentPercent: 6,
  landingAlignmentTolerance: 0.08,
  finalLandAltitudeMeters: 0.55,
  markerLossTimeoutMs: 2_000,
  landingRollSign: 1,
  landingPitchSign: -1,
  landingCameraTiltDegrees: -80,
};

const DEFAULT_OBJECTS: SemanticObjectDefinition[] = [
  {
    id: 'people',
    name: 'Person',
    labels: ['person'],
    markerIds: [],
    behavior: 'obstacle',
    clearanceMeters: 2,
    notes: 'Never route toward a detected person.',
  },
  {
    id: 'landing-pads',
    name: 'Landing pad',
    labels: ['landing-pad'],
    markerIds: [],
    behavior: 'landing-pad',
    clearanceMeters: 0.3,
    notes: 'AprilTag-backed landing target.',
  },
];

function bounded(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback;
}

function cleanId(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const id = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return id || fallback;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toLowerCase()).filter(Boolean))].slice(0, 32);
}

function integers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is number => Number.isInteger(item) && item >= 0 && item <= 4096))]
    .slice(0, 64);
}

export function normalizeNavigationSettings(
  value: unknown,
  defaults: NavigationSettings = DEFAULT_NAVIGATION_SETTINGS,
): NavigationSettings {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const stopDistanceMeters = bounded(source.stopDistanceMeters, defaults.stopDistanceMeters, 0.25, 10);
  return {
    obstacleAvoidanceEnabled: typeof source.obstacleAvoidanceEnabled === 'boolean'
      ? source.obstacleAvoidanceEnabled
      : defaults.obstacleAvoidanceEnabled,
    requireMetricRange: typeof source.requireMetricRange === 'boolean'
      ? source.requireMetricRange
      : defaults.requireMetricRange,
    rangeTimeoutMs: bounded(source.rangeTimeoutMs, defaults.rangeTimeoutMs, 100, 5_000),
    stopDistanceMeters,
    cautionDistanceMeters: bounded(source.cautionDistanceMeters, defaults.cautionDistanceMeters, stopDistanceMeters + 0.1, 20),
    avoidanceYawPercent: bounded(source.avoidanceYawPercent, defaults.avoidanceYawPercent, 5, 20),
    cruiseCommandPercent: bounded(source.cruiseCommandPercent, defaults.cruiseCommandPercent, 5, 20),
    landingCommandPercent: bounded(source.landingCommandPercent, defaults.landingCommandPercent, 3, 15),
    landingDescentPercent: bounded(source.landingDescentPercent, defaults.landingDescentPercent, 3, 12),
    landingAlignmentTolerance: bounded(
      source.landingAlignmentTolerance,
      defaults.landingAlignmentTolerance,
      0.02,
      0.25,
    ),
    finalLandAltitudeMeters: bounded(source.finalLandAltitudeMeters, defaults.finalLandAltitudeMeters, 0.2, 1.5),
    markerLossTimeoutMs: bounded(source.markerLossTimeoutMs, defaults.markerLossTimeoutMs, 500, 10_000),
    landingRollSign: source.landingRollSign === -1 ? -1 : source.landingRollSign === 1 ? 1 : defaults.landingRollSign,
    landingPitchSign: source.landingPitchSign === -1 ? -1 : source.landingPitchSign === 1 ? 1 : defaults.landingPitchSign,
    landingCameraTiltDegrees: bounded(source.landingCameraTiltDegrees, defaults.landingCameraTiltDegrees, -100, 100),
  };
}

function normalizeObject(value: unknown, index: number): SemanticObjectDefinition | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const id = cleanId(source.id, `object-${index + 1}`);
  const behavior = ['obstacle', 'landmark', 'landing-pad', 'ignore'].includes(String(source.behavior))
    ? source.behavior as SemanticBehavior
    : 'landmark';
  return {
    id,
    name: typeof source.name === 'string' && source.name.trim() ? source.name.trim().slice(0, 128) : id,
    labels: strings(source.labels),
    markerIds: integers(source.markerIds),
    behavior,
    clearanceMeters: bounded(source.clearanceMeters, behavior === 'obstacle' ? 1.5 : 0.3, 0, 20),
    notes: typeof source.notes === 'string' ? source.notes.trim().slice(0, 500) : '',
  };
}

function normalizePad(value: unknown, index: number): LandingPadDefinition | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const markerId = Number(source.markerId);
  if (!Number.isInteger(markerId) || markerId < 0 || markerId > 4096) return null;
  const id = cleanId(source.id, `pad-${index + 1}`);
  const map = source.mapPosition && typeof source.mapPosition === 'object'
    ? source.mapPosition as Record<string, unknown>
    : null;
  const gps = source.gps && typeof source.gps === 'object'
    ? source.gps as Record<string, unknown>
    : null;
  const mapPosition = map
    && typeof map.x === 'number' && Number.isFinite(map.x)
    && typeof map.y === 'number' && Number.isFinite(map.y)
    && typeof map.z === 'number' && Number.isFinite(map.z)
    ? { x: map.x, y: map.y, z: map.z }
    : undefined;
  const gpsPosition = gps
    && typeof gps.latitude === 'number' && Number.isFinite(gps.latitude)
    && typeof gps.longitude === 'number' && Number.isFinite(gps.longitude)
    ? {
      latitude: Math.max(-90, Math.min(90, gps.latitude)),
      longitude: Math.max(-180, Math.min(180, gps.longitude)),
      ...(typeof gps.altitude === 'number' && Number.isFinite(gps.altitude) ? { altitude: gps.altitude } : {}),
    }
    : undefined;
  return {
    id,
    name: typeof source.name === 'string' && source.name.trim() ? source.name.trim().slice(0, 128) : id,
    markerId,
    markerSizeMeters: bounded(source.markerSizeMeters, 0.3, 0.05, 3),
    ...(mapPosition ? { mapPosition } : {}),
    ...(gpsPosition ? { gps: gpsPosition } : {}),
    approachAltitudeMeters: bounded(source.approachAltitudeMeters, 1.5, 0.5, 10),
    arrivalRadiusMeters: bounded(source.arrivalRadiusMeters, 1.5, 0.3, 10),
  };
}

export class NavigationMapManager {
  private state: NavigationMapState;

  constructor(
    private readonly storagePath?: string,
    private readonly now: () => number = Date.now,
    private readonly onChange?: (state: NavigationMapState) => void,
  ) {
    let persisted: any = {};
    if (storagePath) {
      try {
        persisted = JSON.parse(readFileSync(storagePath, 'utf8'));
      } catch {
        persisted = {};
      }
    }
    this.state = {
      settings: normalizeNavigationSettings(persisted.settings),
      objects: Array.isArray(persisted.objects)
        ? persisted.objects.map(normalizeObject).filter(Boolean) as SemanticObjectDefinition[]
        : structuredClone(DEFAULT_OBJECTS),
      landingPads: Array.isArray(persisted.landingPads)
        ? persisted.landingPads.map(normalizePad).filter(Boolean) as LandingPadDefinition[]
        : [],
      revision: 0,
      updatedAt: now(),
      updatedBy: 'environment',
    };
  }

  getState(): NavigationMapState {
    return structuredClone(this.state);
  }

  updateSettings(patch: Partial<NavigationSettings>, updatedBy: NavigationMapState['updatedBy'] = 'web'): NavigationMapState {
    this.state.settings = normalizeNavigationSettings({ ...this.state.settings, ...patch }, this.state.settings);
    return this.commit(updatedBy);
  }

  upsertObject(value: unknown, updatedBy: NavigationMapState['updatedBy'] = 'web'): NavigationMapState {
    const object = normalizeObject(value, this.state.objects.length);
    if (!object) throw new Error('Invalid semantic object definition');
    const index = this.state.objects.findIndex((item) => item.id === object.id);
    if (index >= 0) this.state.objects[index] = object;
    else this.state.objects.push(object);
    return this.commit(updatedBy);
  }

  deleteObject(id: string, updatedBy: NavigationMapState['updatedBy'] = 'web'): NavigationMapState {
    this.state.objects = this.state.objects.filter((item) => item.id !== id);
    return this.commit(updatedBy);
  }

  upsertLandingPad(value: unknown, updatedBy: NavigationMapState['updatedBy'] = 'web'): NavigationMapState {
    const pad = normalizePad(value, this.state.landingPads.length);
    if (!pad) throw new Error('Landing pad requires a valid id and AprilTag marker id');
    const index = this.state.landingPads.findIndex((item) => item.id === pad.id);
    if (index >= 0) this.state.landingPads[index] = pad;
    else this.state.landingPads.push(pad);
    return this.commit(updatedBy);
  }

  deleteLandingPad(id: string, updatedBy: NavigationMapState['updatedBy'] = 'web'): NavigationMapState {
    this.state.landingPads = this.state.landingPads.filter((item) => item.id !== id);
    return this.commit(updatedBy);
  }

  private commit(updatedBy: NavigationMapState['updatedBy']): NavigationMapState {
    this.state.revision += 1;
    this.state.updatedAt = this.now();
    this.state.updatedBy = updatedBy;
    if (this.storagePath) {
      mkdirSync(dirname(this.storagePath), { recursive: true });
      writeFileSync(this.storagePath, `${JSON.stringify({
        settings: this.state.settings,
        objects: this.state.objects,
        landingPads: this.state.landingPads,
      }, null, 2)}\n`, 'utf8');
    }
    const snapshot = this.getState();
    this.onChange?.(snapshot);
    return snapshot;
  }
}

export function markerIdFromDetection(detection: Pick<ObjectDetection, 'id' | 'label'>): number | null {
  if (detection.label !== 'landing-pad') return null;
  const match = /^apriltag-(\d+)$/.exec(detection.id);
  return match ? Number(match[1]) : null;
}

export function resolveSemanticObservations(
  detections: ObjectDetection[],
  definitions: SemanticObjectDefinition[],
): SemanticObservation[] {
  return detections.map((detection) => {
    const label = detection.label.toLowerCase();
    const markerId = markerIdFromDetection(detection);
    const definition = definitions.find((item) => (
      item.labels.includes(label) || (markerId !== null && item.markerIds.includes(markerId))
    ));
    return {
      trackId: detection.id,
      semanticId: definition?.id ?? null,
      name: definition?.name ?? detection.recognizedName ?? detection.label,
      label: detection.label,
      behavior: definition?.behavior ?? (label === 'person' ? 'obstacle' : 'landmark'),
      confidence: detection.confidence,
      bbox: detection.bbox,
      clearanceMeters: definition?.clearanceMeters ?? (label === 'person' ? 2 : 0.5),
      markerId,
      firstSeenAt: detection.firstSeenAt,
      lastSeenAt: detection.lastSeenAt,
    };
  });
}

export function rangeFieldFresh(field: RangeField | null, settings: NavigationSettings, now = Date.now()): boolean {
  return Boolean(
    field
    && field.observedAt <= now + 250
    && now - field.receivedAt <= settings.rangeTimeoutMs
    && now - field.observedAt <= settings.rangeTimeoutMs * 2,
  );
}

function sectorDistance(field: RangeField, names: RangeSectorName[]): number {
  const distances = names.map((name) => field.sectors[name]?.distanceMeters)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return distances.length > 0 ? Math.min(...distances) : Number.POSITIVE_INFINITY;
}

export function applyObstacleAvoidance(
  command: PilotingCommand,
  field: RangeField | null,
  settings: NavigationSettings,
  now = Date.now(),
): GuidanceResult {
  if (!command.active || !settings.obstacleAvoidanceEnabled) {
    return { command, arrived: false, blocked: false, reason: null };
  }
  if (!rangeFieldFresh(field, settings, now)) {
    return settings.requireMetricRange
      ? { command: ZERO_COMMAND, arrived: false, blocked: true, reason: 'Metric obstacle range is missing or stale' }
      : { command, arrived: false, blocked: false, reason: 'Metric range unavailable, avoidance not applied' };
  }

  const activeField = field as RangeField;
  const names: RangeSectorName[] = command.pitch > 0
    ? ['frontLeft', 'front', 'frontRight']
    : command.pitch < 0
      ? ['rear']
      : command.roll > 0
        ? ['frontRight', 'right']
        : command.roll < 0
          ? ['frontLeft', 'left']
          : [];
  if (names.length === 0) return { command, arrived: false, blocked: false, reason: null };

  const available = names.some((name) => {
    const value = activeField.sectors[name]?.distanceMeters;
    return typeof value === 'number' && Number.isFinite(value);
  });
  if (!available && settings.requireMetricRange) {
    return {
      command: ZERO_COMMAND,
      arrived: false,
      blocked: true,
      reason: `Metric range is missing for ${names.join(', ')}`,
    };
  }

  const distance = sectorDistance(activeField, names);
  if (distance <= settings.stopDistanceMeters) {
    if (command.pitch > 0) {
      const left = sectorDistance(activeField, ['frontLeft', 'left']);
      const right = sectorDistance(activeField, ['frontRight', 'right']);
      if (Math.max(left, right) > settings.cautionDistanceMeters) {
        return {
          command: {
            roll: 0,
            pitch: 0,
            yaw: right > left ? settings.avoidanceYawPercent : -settings.avoidanceYawPercent,
            gaz: 0,
            active: true,
          },
          arrived: false,
          blocked: true,
          reason: `Obstacle at ${distance.toFixed(2)} m, turning toward clearer side`,
          distanceMeters: distance,
        };
      }
    }
    return {
      command: ZERO_COMMAND,
      arrived: false,
      blocked: true,
      reason: `Obstacle inside ${settings.stopDistanceMeters.toFixed(2)} m stop distance`,
      distanceMeters: distance,
    };
  }

  if (distance < settings.cautionDistanceMeters) {
    const ratio = Math.max(
      0.25,
      Math.min(1, (distance - settings.stopDistanceMeters) / (settings.cautionDistanceMeters - settings.stopDistanceMeters)),
    );
    return {
      command: {
        roll: Math.round(command.roll * ratio),
        pitch: Math.round(command.pitch * ratio),
        yaw: Math.round(command.yaw * ratio),
        gaz: command.gaz,
        active: true,
      },
      arrived: false,
      blocked: false,
      reason: `Obstacle at ${distance.toFixed(2)} m, movement reduced`,
      distanceMeters: distance,
    };
  }
  return { command, arrived: false, blocked: false, reason: null, distanceMeters: distance };
}

function wrapRadians(value: number): number {
  let result = value;
  while (result > Math.PI) result -= Math.PI * 2;
  while (result < -Math.PI) result += Math.PI * 2;
  return result;
}

export function gpsOffsetMeters(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): { east: number; north: number; distance: number; bearing: number } {
  const latitudeRadians = ((from.latitude + to.latitude) / 2) * Math.PI / 180;
  const north = (to.latitude - from.latitude) * 111_132.92;
  const east = (to.longitude - from.longitude) * 111_412.84 * Math.cos(latitudeRadians);
  return { east, north, distance: Math.hypot(east, north), bearing: Math.atan2(east, north) };
}

export function gpsGuidance(
  snapshot: DroneSnapshot,
  target: LandingPadDefinition,
  settings: NavigationSettings,
): GuidanceResult {
  const telemetry = snapshot.telemetry;
  if (!target.gps) {
    return { command: ZERO_COMMAND, arrived: false, blocked: true, reason: 'Landing pad has no GPS position' };
  }
  if (typeof telemetry.latitude !== 'number' || typeof telemetry.longitude !== 'number' || telemetry.gpsFix !== true) {
    return { command: ZERO_COMMAND, arrived: false, blocked: true, reason: 'A current GPS fix is required for pad transfer' };
  }
  if (typeof telemetry.yaw !== 'number' || !Number.isFinite(telemetry.yaw)) {
    return { command: ZERO_COMMAND, arrived: false, blocked: true, reason: 'Heading telemetry is required for GPS guidance' };
  }

  const current = { latitude: telemetry.latitude, longitude: telemetry.longitude };
  const offset = gpsOffsetMeters(current, target.gps);
  if (offset.distance <= target.arrivalRadiusMeters) {
    return {
      command: ZERO_COMMAND,
      arrived: true,
      blocked: false,
      reason: `Inside ${target.arrivalRadiusMeters.toFixed(1)} m landing-pad approach radius`,
      distanceMeters: offset.distance,
      bearingRadians: offset.bearing,
    };
  }

  const yawError = wrapRadians(offset.bearing - telemetry.yaw);
  const strength = Math.max(5, Math.min(20, settings.cruiseCommandPercent));
  if (Math.abs(yawError) > 0.25) {
    return {
      command: { roll: 0, pitch: 0, yaw: yawError > 0 ? strength : -strength, gaz: 0, active: true },
      arrived: false,
      blocked: false,
      reason: `Turning toward landing pad, heading error ${(yawError * 180 / Math.PI).toFixed(0)} degrees`,
      distanceMeters: offset.distance,
      bearingRadians: offset.bearing,
    };
  }

  const speedScale = Math.max(0.35, Math.min(1, offset.distance / 5));
  return {
    command: { roll: 0, pitch: Math.round(strength * speedScale), yaw: 0, gaz: 0, active: true },
    arrived: false,
    blocked: false,
    reason: `Navigating to ${target.name}`,
    distanceMeters: offset.distance,
    bearingRadians: offset.bearing,
  };
}

export function landingPadDetection(detections: ObjectDetection[], markerId: number): ObjectDetection | null {
  return detections.find((item) => markerIdFromDetection(item) === markerId) ?? null;
}

export function landingGuidance(
  detection: ObjectDetection,
  altitudeMeters: number,
  settings: NavigationSettings,
): GuidanceResult {
  const errorX = detection.bbox.x + detection.bbox.width / 2 - 0.5;
  const errorY = detection.bbox.y + detection.bbox.height / 2 - 0.5;
  const aligned = Math.abs(errorX) <= settings.landingAlignmentTolerance
    && Math.abs(errorY) <= settings.landingAlignmentTolerance;

  if (aligned && altitudeMeters <= settings.finalLandAltitudeMeters) {
    return { command: ZERO_COMMAND, arrived: true, blocked: false, reason: 'Landing pad centered for final landing' };
  }
  if (aligned) {
    return {
      command: { roll: 0, pitch: 0, yaw: 0, gaz: -settings.landingDescentPercent, active: true },
      arrived: false,
      blocked: false,
      reason: 'Landing pad centered, descending',
    };
  }

  const roll = Math.abs(errorX) > settings.landingAlignmentTolerance
    ? Math.sign(errorX) * settings.landingCommandPercent * settings.landingRollSign
    : 0;
  const pitch = Math.abs(errorY) > settings.landingAlignmentTolerance
    ? Math.sign(errorY) * settings.landingCommandPercent * settings.landingPitchSign
    : 0;
  return {
    command: { roll, pitch, yaw: 0, gaz: 0, active: roll !== 0 || pitch !== 0 },
    arrived: false,
    blocked: false,
    reason: `Aligning over landing pad, image error ${errorX.toFixed(2)}, ${errorY.toFixed(2)}`,
  };
}
