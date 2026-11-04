type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
let ctx: Ctx | undefined;
const cache = new Map<string, number>();

/** Text width in px for a CSS font string. Falls back to a rough estimate without a canvas (tests/SSR). */
export function measureText(text: string, font: string): number {
  const key = font + '|' + text;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (ctx === undefined) {
    try {
      ctx = (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas')).getContext('2d') as Ctx;
    } catch { ctx = null; }
  }
  let w: number;
  if (ctx) { ctx.font = font; w = ctx.measureText(text).width; }
  else w = text.length * parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? '14') * 0.55;
  if (cache.size > 20000) cache.clear();
  cache.set(key, w);
  return w;
}

export const clearMeasureCache = () => cache.clear();
