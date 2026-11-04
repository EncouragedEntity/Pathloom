import RBush from 'rbush';
import type { Element } from './types';
import { boundsIntersect, elementBounds, hitElement, type Bounds, type Point } from './geometry';
import { compareIndex } from './index-key';

interface Item { minX: number; minY: number; maxX: number; maxY: number; id: string }

/** Element store + rbush spatial index + z-order. `rev` bumps on every mutation. */
export class Scene {
  private map = new Map<string, Element>();
  private tree = new RBush<Item>();
  private items = new Map<string, Item>();
  private vers = new Map<string, number>();
  private sorted: Element[] | null = null;
  private rank = new Map<string, number>();
  rev = 0;

  load(elements: Element[]) {
    this.map.clear(); this.items.clear(); this.vers.clear(); this.tree.clear();
    const items: Item[] = [];
    for (const el of elements) {
      this.map.set(el.id, el);
      const it = { ...elementBounds(el), id: el.id };
      this.items.set(el.id, it);
      items.push(it);
      this.vers.set(el.id, 1);
    }
    this.tree.load(items);
    this.sorted = null; this.rev++;
  }

  get size() { return this.map.size; }
  get(id: string) { return this.map.get(id); }
  has(id: string) { return this.map.has(id); }
  version(id: string) { return this.vers.get(id) ?? 0; }

  set(el: Element) {
    const old = this.items.get(el.id);
    if (old) this.tree.remove(old);
    const it = { ...elementBounds(el), id: el.id };
    this.items.set(el.id, it);
    this.tree.insert(it);
    const prev = this.map.get(el.id);
    if (!prev || prev.index !== el.index) this.sorted = null;
    else if (this.sorted) this.sorted[this.rank.get(el.id)!] = el;
    this.map.set(el.id, el);
    this.vers.set(el.id, (this.vers.get(el.id) ?? 0) + 1);
    this.rev++;
  }

  remove(id: string) {
    const it = this.items.get(id);
    if (it) this.tree.remove(it);
    this.items.delete(id); this.map.delete(id); this.vers.delete(id);
    this.sorted = null; this.rev++;
  }

  /** All elements in z-order (bottom first). */
  all(): Element[] {
    if (!this.sorted) {
      this.sorted = [...this.map.values()].sort(compareIndex);
      this.rank.clear();
      this.sorted.forEach((e, i) => this.rank.set(e.id, i));
    }
    return this.sorted;
  }

  /** Elements whose bounds intersect `b`, in z-order. */
  query(b: Bounds): Element[] {
    this.all();
    const hits = this.tree.search(b);
    const out: Element[] = [];
    for (const h of hits) { const e = this.map.get(h.id); if (e) out.push(e); }
    return out.sort((a, c) => this.rank.get(a.id)! - this.rank.get(c.id)!);
  }

  /** Topmost element under `p` (world), tolerance in world units. */
  hit(p: Point, tol: number, filter?: (e: Element) => boolean, solid = false): Element | null {
    const cand = this.query({ minX: p[0] - tol, minY: p[1] - tol, maxX: p[0] + tol, maxY: p[1] + tol });
    for (let i = cand.length - 1; i >= 0; i--) {
      const e = cand[i];
      if (filter && !filter(e)) continue;
      if (hitElement(e, p, tol, solid)) return e;
    }
    return null;
  }

  intersecting(b: Bounds): Element[] {
    return this.query(b).filter((e) => boundsIntersect(elementBounds(e), b));
  }
}
