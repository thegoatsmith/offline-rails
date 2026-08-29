// The whole of the app's shared state. It is small on purpose: a loaded city,
// the two ends of a trip, the trip itself, and whether the browser thinks it is
// online. Everything else is local to a component.

import { route as findRoute } from './graph.ts';
import type { City, RouteResult, Station } from './types.ts';

export const app = $state({
  city: null as City | null,
  from: null as Station | null,
  to: null as Station | null,
  trip: null as RouteResult | null,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
});

/** Recomputed whenever either end changes; null until both are chosen. */
export function plan(): void {
  if (!app.city || !app.from || !app.to) {
    app.trip = null;
    return;
  }
  app.trip = findRoute(app.city, app.from.id, app.to.id);
}

export function setSlot(which: 'from' | 'to', station: Station | null): void {
  app[which] = station;
  plan();
}

export function clearTrip(): void {
  app.from = null;
  app.to = null;
  app.trip = null;
}

export const mins = (s: number): string => (s < 60 ? '<1 min' : Math.round(s / 60) + ' min');

export const when = (ts: number): string => {
  const days = Math.floor((Date.now() - ts) / 864e5);
  return days === 0 ? 'today' : days === 1 ? 'yesterday' : days + ' days ago';
};
