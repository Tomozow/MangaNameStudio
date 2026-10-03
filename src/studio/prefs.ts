// Per-device preferences, kept in localStorage: they describe this headset and its
// user rather than a project (window layout, pen lift distance, hand smoothing).

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
}

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
      belt: Array.isArray(belt) && belt.length === 3 && belt.every(Number.isFinite) ? belt : null,
    };
  } catch {
    return { liftMm: 2.5, penFilter: true, windows: {}, docks: {}, dockScales: {}, belt: null };
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
