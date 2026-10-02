import type { UIKitMLAsset } from '@iwsdk/core';
import { studioBridge } from './studio-ctx.js';

type Cleanup = Array<() => void>;

/** Wire a UIKit element click; adds a haptic tick and registers teardown. */
export function bindButton(
  panel: UIKitMLAsset,
  id: string,
  onClick: () => void,
  cleanup: Cleanup,
): void {
  const el = panel.getElementById(id);
  if (el == null) {
    console.warn(`[MangaNameStudio] UI element #${id} missing`);
    return;
  }
  el.name = id;
  const handler = (): void => {
    studioBridge.studio?.haptic(0.15);
    try {
      onClick();
    } catch (error) {
      console.error(`[MangaNameStudio] #${id} failed`, error);
      studioBridge.studio?.toast('操作に失敗しました');
    }
  };
  el.addEventListener('click', handler);
  cleanup.push(() => el.removeEventListener('click', handler));
}

export function setText(panel: UIKitMLAsset, id: string, text: string): void {
  panel.getElementById(id)?.setProperties({ text } as never);
}

export function setChip(panel: UIKitMLAsset, id: string, active: boolean, inactive = 'secondary'): void {
  panel.getElementById(id)?.setProperties({ variant: active ? 'primary' : inactive } as never);
}

export function setVisible(panel: UIKitMLAsset, id: string, visible: boolean): void {
  panel.getElementById(id)?.setProperties({ display: visible ? 'flex' : 'none' } as never);
}

export function setProps(panel: UIKitMLAsset, id: string, props: Record<string, unknown>): void {
  panel.getElementById(id)?.setProperties(props as never);
}

/** UIKitML's TTF path only rasterises ASCII; swap in the pre-built Japanese MSDF atlas. */
export function applyJapaneseFont(panel: UIKitMLAsset, rootId: string): void {
  const url = `${import.meta.env.BASE_URL}fonts/mplus-msdf.json`;
  panel.getElementById(rootId)?.setProperties({ fontFamilies: { 'M PLUS 1p': { normal: url } } } as never);
}
