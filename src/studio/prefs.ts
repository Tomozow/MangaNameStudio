// Per-device preferences, kept in localStorage: they describe this headset and its
// user rather than a project (window layout, pen lift distance, hand smoothing, pen
// length and the real drawing surface).

const KEY = 'mns.prefs.v1';

/** Where a window rides instead of floating in space. */
export type Dock = 'left' | 'right' | 'belt';

export interface Prefs {
  /** Height above the paper (mm) at which a lifted pen stops drawing. */
  liftMm: number;
  /** One Euro smoothing of the hand-tracked pen position. */
  penFilter: boolean;
  /** Moved windows: [x, y, z, qx, qy, qz, qw, scale] in their parent's space, by window id. */
  windows: Record<string, number[]>;
  /** Windows riding on a wrist or the belt, by window id. */
  docks: Record<string, Dock>;
  /** Each window's size while docked, by `${id}@wrist` / `${id}@belt`. */
  dockScales: Record<string, number>;
  /** The belt point from the head in the body frame (+X right, -Z forward), once moved. */
  belt: number[] | null;
  /** Pen tip distance (m) past the thumb/index grip point (hand) or the ray origin (controller). */
  penReach: { hand: number; controller: number };
  /** The board laid on a real surface, or null while it floats as a window. */
  surface: Surface | null;
}

/** A real drawing surface measured with the pen (reference-space, i.e. world, coordinates). */
export interface Surface {
  /** Centre [x, y, z] and orientation [qx, qy, qz, qw]: +X along the top edge, +Z out of the surface. */
  pose: number[];
  /** Measured width and height (m). */
  size: number[];
  /** Hand tuning on top: [x mm, y mm, height mm, rotation deg, size %]. */
  adjust: number[];
}

export const PEN_REACH_DEFAULT = { hand: 0.028, controller: 0.085 } as const;

export const LIFT_RANGE = { min: 0, max: 10, step: 0.5 } as const;

const DOCKS: readonly string[] = ['left', 'right', 'belt'];

function record<T>(raw: unknown, ok: (v: unknown) => v is T): Record<string, T> {
  const out: Record<string, T> = {};
  if (raw == null || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) if (ok(v)) out[k] = v;
  return out;
}

const isPose = (v: unknown): v is number[] =>
  Array.isArray(v) && (v.length === 7 || v.length === 8) && v.every(Number.isFinite);
const isDock = (v: unknown): v is Dock => typeof v === 'string' && DOCKS.includes(v);
const isScale = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isNums = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every(Number.isFinite);

function reach(raw: unknown, key: 'hand' | 'controller'): number {
  const v = Number((raw as Record<string, unknown> | null)?.[key]);
  return Number.isFinite(v) && v > 0 && v < 0.3 ? v : PEN_REACH_DEFAULT[key];
}

function surface(raw: unknown): Surface | null {
  const s = raw as Partial<Record<keyof Surface, unknown>> | null;
  if (s == null || !isNums(s.pose, 7) || !isNums(s.size, 2) || !isNums(s.adjust, 5)) return null;
  return { pose: s.pose, size: s.size, adjust: s.adjust };
}

function load(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<keyof Prefs, unknown>>;
    const lift = Number(raw.liftMm);
    const belt = raw.belt;
    return {
      liftMm: Number.isFinite(lift) ? Math.min(LIFT_RANGE.max, Math.max(LIFT_RANGE.min, lift)) : 2.5,
      penFilter: typeof raw.penFilter === 'boolean' ? raw.penFilter : true,
      windows: record(raw.windows, isPose),
      docks: record(raw.docks, isDock),
      dockScales: record(raw.dockScales, isScale),
      belt: isNums(belt, 3) ? belt : null,
      penReach: { hand: reach(raw.penReach, 'hand'), controller: reach(raw.penReach, 'controller') },
      surface: surface(raw.surface),
    };
  } catch {
    return { liftMm: 2.5, penFilter: true, windows: {}, docks: {}, dockScales: {}, belt: null, penReach: { ...PEN_REACH_DEFAULT }, surface: null };
  }
}

export const prefs: Prefs = load();

export function savePrefs(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Private mode or full storage: the setting still applies for this session.
  }
}
