import { AssetType, defineAssets } from '@iwsdk/core';
import createDioramaPreview from './scene-assets/diorama.scene-asset.js';
import createPenPreview from './scene-assets/pen.scene-asset.js';
import createStudioFloor from './scene-assets/studio-floor.scene-asset.js';

const publicAssetUrl = (filePath: string): string =>
  `${import.meta.env.BASE_URL}${filePath.replace(/^\/+/u, '')}`;

export default defineAssets({
  'tool-palette': {
    url: publicAssetUrl('ui/tools.uikitml'),
    type: AssetType.UIKitML,
    name: 'Tool Palette',
  },
  manager: {
    url: publicAssetUrl('ui/manager.uikitml'),
    type: AssetType.UIKitML,
    name: 'Page / Stock / Reference / File Manager',
  },
  'diorama-palette': {
    url: publicAssetUrl('ui/diorama.uikitml'),
    type: AssetType.UIKitML,
    name: 'Diorama Palette',
  },
  'wrist-menu': {
    url: publicAssetUrl('ui/wrist.uikitml'),
    type: AssetType.UIKitML,
    name: 'Wrist Quick Menu',
  },
  'diorama-preview': createDioramaPreview(),
  'studio-floor': createStudioFloor(),
  'stylus-pen': createPenPreview(),
});
