import { Types, createComponent, defineComponents } from '@iwsdk/core';

/** A placed diorama piece (figure, prop or the director camera). */
export const DioramaItem = createComponent(
  'DioramaItem',
  {
    itemId: { type: Types.String, default: '' },
    kind: { type: Types.String, default: 'box' },
  },
  'Diorama piece that can be grabbed, posed and saved with the project',
);

export default defineComponents([DioramaItem]);
