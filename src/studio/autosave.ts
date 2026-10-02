import type { Project } from './project.js';
import * as storage from './storage.js';

const DEBOUNCE_MS = 1200;

function toPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG encode failed'))), 'image/png'),
  );
}

export type SaveState = 'saved' | 'pending' | 'saving' | 'error';

/** Single save queue: one write in flight, the latest request coalesced behind it. */
export class Autosave {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  state: SaveState = 'saved';
  /** Set while an immersive session is running. */
  fast = false;
  lastError: 'quota' | 'io' | null = null;
  onState: (state: SaveState) => void = () => {};

  constructor(private readonly project: () => Project | null) {}

  schedule(): void {
    this.setState('pending');
    if (this.timer != null) clearTimeout(this.timer);
    // Quest may kill a hidden immersive page quickly: save sooner while in XR.
    this.timer = setTimeout(() => void this.flush(), this.fast ? 400 : DEBOUNCE_MS);
  }

  async flush(): Promise<void> {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.running != null) {
      this.again = true;
      return this.running;
    }
    this.running = this.write().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.flush();
      }
    });
    return this.running;
  }

  /** Resolve once nothing is pending or in flight (use before switching projects). */
  /** False when the last write failed (never spin forever on a quota error). */
  async idle(): Promise<boolean> {
    while (this.running != null || this.timer != null || this.again) {
      await this.flush();
      if (this.state === 'error') return false;
    }
    return this.state !== 'error';
  }

  /** Drop pending work without writing (the project is being deleted). */
  cancel(): void {
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = null;
    this.again = false;
    this.failures = 0;
    this.setState('saved');
  }

  private failures = 0;

  private async write(): Promise<void> {
    const project = this.project();
    if (project == null || project.deleted) return;
    this.setState('saving');
    try {
      const inks = new Map<string, Blob>();
      const versions = new Map<string, number>();
      const live = new Set([
        ...project.order,
        ...project.trash,
        ...project.stock.filter((s) => s.kind === 'page').map((s) => s.id),
      ]);
      const orphaned: string[] = [];
      for (const page of project.pages.values()) {
        if (!live.has(page.id)) {
          // Undone pages stay in memory for redo but leave storage.
          if (page.savedVersion !== -1) orphaned.push(page.id);
          continue;
        }
        if (page.inkVersion === page.savedVersion) continue;
        versions.set(page.id, page.inkVersion);
        inks.set(page.id, await toPng(page.ink));
      }
      const clips = new Map<string, Blob>();
      const referenced = new Set(project.stock.filter((s) => s.kind === 'clip').map((s) => s.id));
      for (const id of referenced) {
        const canvas = project.clips.get(id);
        if (canvas != null && !project.savedClips.has(id)) clips.set(id, await toPng(canvas));
      }
      const removedCount = project.removedClips.length;
      const removedClips = [...project.removedClips];
      for (const id of project.savedClips) if (!referenced.has(id)) removedClips.push(id);
      const removedInks = [...project.removedInks];
      const json = project.toJson();
      for (const id of Object.keys(json.texts)) if (!live.has(id)) delete json.texts[id];
      await storage.saveProject(json, inks, clips, [...removedInks, ...orphaned], removedClips);
      for (const id of orphaned) {
        const page = project.pages.get(id);
        if (page != null) page.savedVersion = -1;
      }
      for (const [id, version] of versions) {
        const page = project.pages.get(id);
        if (page != null) page.savedVersion = version;
      }
      for (const id of clips.keys()) project.savedClips.add(id);
      for (const id of removedClips) project.savedClips.delete(id);
      project.removedInks.splice(0, removedInks.length);
      project.removedClips.splice(0, removedCount);
      storage.rememberProject(project.id);
      this.setState(this.timer != null ? 'pending' : 'saved');
      this.failures = 0;
    } catch (error) {
      console.error('[MangaNameStudio] autosave failed', error);
      this.failures++;
      this.lastError = (error as Error)?.name === 'QuotaExceededError' ? 'quota' : 'io';
      this.setState('error');
      // Retry with backoff; nothing is marked saved, so the next write re-sends everything dirty.
      if (this.timer == null && !project.deleted) {
        const delay = Math.min(60_000, 2000 * 2 ** Math.min(5, this.failures));
        this.timer = setTimeout(() => void this.flush(), delay);
      }
    }
  }

  private setState(state: SaveState): void {
    if (this.state === state) return;
    this.state = state;
    this.onState(state);
  }

  dispose(): void {
    if (this.timer != null) clearTimeout(this.timer);
  }
}
