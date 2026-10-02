// Dev-only end-to-end checks driven through the real studio objects (F9).
// Results go to the console as "[selftest] PASS/FAIL ..." lines.
import { RASTER_H, RASTER_W } from './doc.js';
import * as ops from './page-ops.js';
import * as storage from './storage.js';
import type { StudioSystem } from './studio-system.js';

function alphaAt(canvas: HTMLCanvasElement, x: number, y: number, r = 3): number {
  const ctx = canvas.getContext('2d')!;
  const data = ctx.getImageData(Math.round(x - r), Math.round(y - r), r * 2 + 1, r * 2 + 1).data;
  let max = 0;
  for (let i = 3; i < data.length; i += 4) max = Math.max(max, data[i]!);
  return max;
}

export async function runSelfTest(studio: StudioSystem): Promise<void> {
  const results: string[] = [];
  const check = (name: string, ok: boolean, detail = '') => {
    results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
    console.log(`[selftest] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  };
  // Run on a throwaway project so the user's work is never touched.
  const s = studio as unknown as {
    newProject(n: number): Promise<void>;
    openProject(id: string): Promise<void>;
    deleteProject(id: string): Promise<void>;
  };
  const previous = studio.project.id;
  await s.newProject(6);
  const board = studio.board;
  const tools = studio.tools;
  const project = studio.project;
  project.name = 'selftest';
  try {
    while (project.order.length < 4) ops.appendPage(studio);
    ops.goToPage(studio, project.order[0]!);
    board.single = false;
    board.resetZoom();
    studio.refreshBoard();
    const r = board.slotRect(1);
    const page = board.slots[1]!.page!;
    check('spread shows page 1 alone on the left', page.id === project.order[0] && board.slots[0]!.page == null);
    const toBoard = (rx: number, ry: number) => ({ x: r.x0 + rx / 4000, y: r.y1 - ry / 4000 });
    const stroke = (pts: Array<[number, number]>, pressure = 1) => {
      tools.down(9001, toBoard(...pts[0]!), pressure);
      for (const p of pts.slice(1)) tools.move(9001, toBoard(...p), pressure);
      tools.up(9001);
    };
    // Pen
    studio.setTool('pen');
    project.tools.stabilizer = 0;
    const line: Array<[number, number]> = [];
    for (let i = 0; i <= 20; i++) line.push([300 + i * 15, 600]);
    stroke(line);
    check('pen bakes ink onto the page', alphaAt(page.ink, 450, 600) > 200, `alpha=${alphaAt(page.ink, 450, 600)}`);
    check('pen bakes the stroke tail', alphaAt(page.ink, 598, 600) > 200, `alpha=${alphaAt(page.ink, 598, 600)}`);
    studio.undo();
    check('undo removes the stroke', alphaAt(page.ink, 450, 600) === 0);
    studio.redo();
    check('redo restores the stroke', alphaAt(page.ink, 450, 600) > 200);
    // Eraser
    studio.setTool('eraser');
    stroke([[450, 560], [450, 600], [450, 640]]);
    check('eraser clears page ink', alphaAt(page.ink, 450, 600, 1) === 0, `alpha=${alphaAt(page.ink, 450, 600, 1)}`);
    check('eraser keeps far ink', alphaAt(page.ink, 330, 600) > 200);
    // Frame tool snaps to the inner frame
    studio.setTool('frame');
    stroke([[200, 230], [700, 600], [1030, 760]]);
    check('frame tool draws a snapped border', alphaAt(page.ink, 188, 400, 2) > 200, `alpha=${alphaAt(page.ink, 188, 400, 2)}`);
    // Selection move
    studio.setTool('pen');
    stroke([[600, 1200], [640, 1200], [680, 1200]]);
    studio.setTool('select');
    tools.down(9002, toBoard(560, 1150), 1);
    tools.move(9002, toBoard(720, 1250), 1);
    tools.up(9002);
    check('marquee cuts ink into a floating clip', tools.selection.active && alphaAt(page.ink, 640, 1200) === 0);
    tools.down(9003, toBoard(640, 1200), 1);
    tools.move(9003, toBoard(640, 1400), 1);
    tools.up(9003);
    tools.selection.commit();
    check('moved clip bakes at the new place', alphaAt(page.ink, 640, 1400) > 150 && alphaAt(page.ink, 640, 1200) === 0, `new=${alphaAt(page.ink, 640, 1400)}`);
    studio.undo();
    check('undo restores the original clip place', alphaAt(page.ink, 640, 1200) > 150 && alphaAt(page.ink, 640, 1400) === 0);
    // Text
    studio.setTool('text');
    const before = page.texts.length;
    tools.pendingText = 'セリフ テスト';
    tools.down(9004, toBoard(900, 400), 1);
    tools.up(9004);
    check('text tool places pending dialogue', page.texts.length === before + 1 && page.texts[page.texts.length - 1]?.content === 'セリフ テスト');
    studio.undo();
    check('undo removes the text', page.texts.length === before);
    // Page ops
    const n = project.order.length;
    ops.appendPage(studio);
    check('append page', project.order.length === n + 1);
    studio.undo();
    check('undo append', project.order.length === n);
    ops.goToPage(studio, project.order[1]!);
    const moved = project.currentPage!;
    ops.removeCurrent(studio, 'stock');
    check('page to stock', project.stock.some((s) => s.kind === 'page' && s.id === moved) && !project.order.includes(moved));
    ops.restorePage(studio, moved, 'stock');
    check('page back from stock', project.order.includes(moved));
    ops.goToPage(studio, project.order[0]!);
    ops.turnSpread(studio, 1);
    check('turn spread goes to page 2', project.currentPage === project.order[1]);
    const ids = board.slots.map((s) => s.page?.id);
    check('spread 1 = [3][2]', ids[0] === project.order[1] && ids[1] === project.order[2], JSON.stringify(ids.map((id) => project.order.indexOf(id ?? '') + 1)));
    // Untouched cut is not an undo step
    ops.goToPage(studio, project.order[0]!);
    studio.setTool('pen');
    stroke([[300, 900], [400, 900]]);
    studio.setTool('select');
    tools.down(9010, toBoard(250, 850), 1);
    tools.move(9010, toBoard(450, 950), 1);
    tools.up(9010);
    tools.selection.commit();
    check('untouched cut leaves the ink', alphaAt(page.ink, 350, 900) > 200);
    studio.undo();
    check('untouched cut is not on the undo stack', alphaAt(page.ink, 350, 900) === 0);
    // Moved clip survives a spread/single toggle (P0 regression)
    studio.redo();
    tools.down(9011, toBoard(250, 850), 1);
    tools.move(9011, toBoard(450, 950), 1);
    tools.up(9011);
    check('second cut floats', tools.selection.active, `hit=${tools.selection.hitTest(toBoard(350, 900).x, toBoard(350, 900).y)} clip=${JSON.stringify((({ canvas, cx, cy }) => ({ w: canvas.width, h: canvas.height, cx, cy }))((tools.selection as unknown as { clip: { canvas: HTMLCanvasElement; cx: number; cy: number } }).clip))} p=${JSON.stringify(toBoard(350, 900))}`);
    tools.down(9012, toBoard(350, 900), 1);
    tools.move(9012, toBoard(350, 1000), 1);
    tools.up(9012);
    studio.textInput.commit();
    tools.settle();
    board.single = true;
    studio.refreshBoard();
    check('clip baked before single view', alphaAt(page.ink, 350, 1000) > 150 && alphaAt(page.ink, 350, 900) === 0, `new=${alphaAt(page.ink, 350, 1000)} old=${alphaAt(page.ink, 350, 900)} active=${tools.selection.active}`);
    board.single = false;
    studio.refreshBoard();
    studio.undo();
    check('undo after toggle restores ink', alphaAt(page.ink, 350, 900) > 200 && alphaAt(page.ink, 350, 1000) === 0);
    // Clip carried to the next spread
    tools.down(9013, toBoard(250, 850), 1);
    tools.move(9013, toBoard(450, 950), 1);
    tools.up(9013);
    ops.turnSpread(studio, 1);
    tools.selection.commit();
    const p2 = project.page(project.order[1]!)!;
    const rr = board.slotRect(0);
    const r1 = { x0: -rr.x1, y1: rr.y1 }; // page 1 sat in the left slot of spread 0
    void r1;
    check('carried clip leaves page 1 empty', alphaAt(page.ink, 350, 900) === 0);
    const anyInk = alphaAt(p2.ink, 350 - 1200 - 48, 900) + alphaAt(project.page(project.order[2]!)!.ink, 350, 900);
    check('carried clip bakes onto the new spread', anyInk > 150, `alpha=${anyInk}`);
    studio.undo();
    check('undo restores carried cut', alphaAt(page.ink, 350, 900) > 200);
    // Persistence
    await (studio as unknown as { autosave: { flush(): Promise<void> } }).autosave.flush();
    const saved = await storage.loadDoc(project.id);
    check('autosave writes the document', saved != null && saved.order.length === project.order.length);
    // Composite export size
    const comp = project.page(project.order[0]!)!.composite(true);
    check('composite page is full raster', comp.width === RASTER_W && comp.height === RASTER_H);
    comp.width = 0;
  } catch (error) {
    check('selftest crashed', false, String((error as Error).stack ?? error));
  }
  await s.openProject(previous).catch(() => undefined);
  await s.deleteProject(project.id).catch(() => undefined);
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`[selftest] DONE ${results.length - failed}/${results.length} passed`);
  studio.toast(`セルフテスト ${results.length - failed}/${results.length} 合格`);
}
