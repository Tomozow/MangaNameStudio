import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { StudioSystem } from './studio/studio-system.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  // StudioSystem registers DioramaSystem itself once the project has loaded.
  world.registerSystem(StudioSystem);
});
