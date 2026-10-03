// Per-device preferences, kept in localStorage: they describe this headset and its
// user rather than a project (window layout, pen lift distance, hand smoothing).

const KEY = 'mns.prefs.v1';

export interface Prefs {
  /** Height above the paper (mm) at which a lifted pen stops drawing. */
  liftMm: number;
  /** One Euro smoothing of the hand-tracked pen position. */
  penFilter: boolean;
  /** Moved windows: [x, y, z, qx, qy, qz, qw] in their parent's space, by window id. */
  windows: Record<string, number[]>;
}

export const LIFT_RANGE = { min: 0, max: 10, step: 0.5 } as const;

const DEFAULTS: Prefs = { liftMm: 2.5, penFilter: true, windows: {} };

function load(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>;
    const lift = Number(raw.liftMm);
    return {
      liftMm: Number.isFinite(lift) ? Math.min(LIFT_RANGE.max, Math.max(LIFT_RANGE.min, lift)) : DEFAULTS.liftMm,
      penFilter: typeof raw.penFilter === 'boolean' ? raw.penFilter : DEFAULTS.penFilter,
      windows: raw.windows != null && typeof raw.windows === 'object' ? raw.windows : {},
    };
  } catch {
    return { ...DEFAULTS, windows: {} };
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
