// The shapes that cross module boundaries. Everything a city knows about
// itself lives here, and both the worker and the page build against it.

/** A transport mode as OpenStreetMap tags it on a `route` relation. */
export type Mode = 'subway' | 'light_rail' | 'tram' | 'monorail' | 'train';

export interface BBox {
  south: number;
  north: number;
  west: number;
  east: number;
}

/** A partial box is what the tests pass when they want no clipping at all. */
export type MaybeBBox = Partial<BBox>;

export interface Place {
  name: string;
  short: string;
  lat: number;
  lon: number;
  bbox: BBox;
}

/** A line as it appears on a station: enough to draw a chip for it. */
export interface StationLine {
  label: string;
  colour: string | null;
  name: string;
  mode: string | undefined;
}

export interface Station {
  id: string;
  name: string;
  lat: number;
  lon: number;
  lines: StationLine[];
}

/**
 * Geometry is a flat Int32Array of round(degrees * 1e6), interleaved
 * [lat, lon, lat, lon, …]. Render-only: nothing routes off it.
 */
export type PackedShape = Int32Array;

export interface Line {
  id: string;
  ref: string;
  name: string;
  colour: string | null;
  mode: string | undefined;
  stops: string[];
  shapes: PackedShape[];
}

export interface Edge {
  to: string;
  cost: number;
  line: string;
  ref?: string;
  colour?: string | null;
  mode?: string;
  walk?: boolean;
  metres?: number;
}

export interface Graph {
  adj: Record<string, Edge[]>;
  links: [string, string][];
  transferPenalty: number;
}

export interface CityStats {
  stations: number;
  routes: number;
  lines: number;
}

export interface City {
  id: string;
  /** Bumped when the stored record shape changes; see `migrateCity`. */
  format: number;
  name: string;
  bbox: MaybeBBox;
  modes: string[];
  savedAt: number;
  stations: Station[];
  lines: Line[];
  graph: Graph;
  stats: CityStats;
}

/** A run of consecutive edges on one line, which is how people describe a trip. */
export interface Leg {
  line: string;
  walk: boolean;
  metres?: number;
  ref?: string;
  colour?: string | null;
  mode?: string;
  stations: Station[];
  seconds: number;
}

export interface RouteResult {
  legs: Leg[];
  seconds: number;
  changes: number;
  from: Station | undefined;
  to: Station | null;
}

/* ---------------- Overpass ---------------- */

export interface OverpassPoint {
  lat: number;
  lon: number;
}

export interface OverpassMember {
  type: 'node' | 'way' | 'relation';
  ref: number;
  role?: string;
  lat?: number;
  lon?: number;
  geometry?: OverpassPoint[];
}

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  members?: OverpassMember[];
  geometry?: OverpassPoint[];
}

export interface OverpassResponse {
  elements: OverpassElement[];
}

/* ---------------- worker protocol ---------------- */

export interface BuildJob {
  type?: 'build';
  id: string;
  name: string;
  bbox: BBox;
  modes: string[];
}

export interface MigrateJob {
  type: 'migrate';
  id: string;
}

export type WorkerJob = BuildJob | MigrateJob;

export type StepName = 'geo' | 'query' | 'build' | 'save';
export type StepState = 'active' | 'done' | null;

export type WorkerMessage =
  | { type: 'ready' }
  | { type: 'step'; name: StepName; state: StepState }
  | { type: 'progress'; text: string }
  | { type: 'done'; id: string; stats?: CityStats; changed?: boolean }
  | { type: 'error'; message: string };
