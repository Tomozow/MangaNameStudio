import { HISTORY_DEPTH } from './doc.js';

export interface HistoryEntry {
  label: string;
  undo(): void;
  redo(): void;
  /** Release pixel buffers held by the entry when it falls off the stack. */
  dispose?(): void;
  /** Approximate pixel memory held, for the byte budget. */
  bytes?: number;
}

/** Undo pixels are capped by memory as well as depth (Quest tabs get killed past ~1-2 GB). */
const BYTE_BUDGET = (typeof navigator !== "undefined" && /OculusBrowser/.test(navigator.userAgent) ? 96 : 192) * 1024 * 1024;

/** Session-only undo stack (not persisted, like MangaSketcher). */
export class History {
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];
  onChange: () => void = () => {};

  push(entry: HistoryEntry): void {
    this.past.push(entry);
    for (const e of this.future) e.dispose?.();
    this.future.length = 0;
    let bytes = 0;
    for (const e of this.past) bytes += e.bytes ?? 0;
    while (this.past.length > 1 && (this.past.length > HISTORY_DEPTH || bytes > BYTE_BUDGET)) {
      const old = this.past.shift()!;
      bytes -= old.bytes ?? 0;
      old.dispose?.();
    }
    this.onChange();
  }

  undo(): string | null {
    const entry = this.past.pop();
    if (entry == null) return null;
    entry.undo();
    this.future.push(entry);
    this.onChange();
    return entry.label;
  }

  redo(): string | null {
    const entry = this.future.pop();
    if (entry == null) return null;
    entry.redo();
    this.past.push(entry);
    this.onChange();
    return entry.label;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  clear(): void {
    for (const e of this.past) e.dispose?.();
    for (const e of this.future) e.dispose?.();
    this.past.length = 0;
    this.future.length = 0;
    this.onChange();
  }
}
