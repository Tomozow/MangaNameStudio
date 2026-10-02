import type { BoardView } from './board.js';
import type { GrabTarget } from './direct-grab.js';
import type { History } from './history.js';
import type { PageRt, Project } from './project.js';
import type { TextInput } from './text-input.js';
import type { WindowSpec } from './windows.js';

/** What tools and panels need from the running studio. */
export interface StudioCtx {
  readonly project: Project;
  readonly board: BoardView;
  readonly history: History;
  readonly textInput: TextInput;
  toast(message: string): void;
  haptic(strength?: number): void;
  /** Re-bind board slots after page order or current page changed. */
  refreshBoard(): void;
  /** Re-render the text layers of displayed pages (only `page`'s slot when given). */
  refreshTexts(page?: PageRt): void;
  markDirty(): void;
}

/** Surface other systems (diorama, references) use to reach the studio. */
export interface StudioApi extends StudioCtx {
  /** Float an image over the current page with the selection tool active. */
  pasteOnPage(canvas: HTMLCanvasElement, label: string): void;
  /** Called with the project whenever a project is opened or created. */
  onProjectOpened(listener: (project: Project) => void): () => void;
  /** Let either hand pick `target` up directly; returns its unregister function. */
  addGrabTarget(target: GrabTarget): () => void;
  /** Give a window a grab bar so it can be moved. */
  addWindow(spec: WindowSpec): void;
}

export const studioBridge: { studio: StudioApi | null; dioramaGrabbing: boolean } = {
  studio: null,
  dioramaGrabbing: false,
};
