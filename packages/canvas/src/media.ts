/** Per-asset HTMLImageElement cache for image elements. Status 'loading' and 'error' render as placeholders. */
export interface ImageEntry { img: HTMLImageElement | null; status: 'loading' | 'ready' | 'error' }

export class ImageCache {
  private map = new Map<string, ImageEntry>();
  private urls: string[] = [];

  /** `url` turns an asset path into something an <img> can load; `onChange` fires when an image finishes (repaint). */
  constructor(private url: (asset: string) => string, private onChange: () => void) {}

  get(asset: string): ImageEntry {
    let e = this.map.get(asset);
    if (e) return e;
    e = { img: null, status: 'loading' };
    this.map.set(asset, e);
    const entry = e, img = new Image();
    img.decoding = 'async';
    img.onload = () => { entry.img = img; entry.status = 'ready'; this.onChange(); };
    img.onerror = () => { entry.status = 'error'; this.onChange(); };
    img.src = this.url(asset);
    return e;
  }

  /** Register an already loaded image (just added by the user) so it paints without a second fetch. */
  prime(asset: string, img: HTMLImageElement, objectUrl?: string) {
    this.map.set(asset, { img, status: 'ready' });
    if (objectUrl) this.urls.push(objectUrl);
  }

  /** Forget everything (e.g. the host's URL scheme changed); failed images get retried. */
  clear() { this.map.clear(); }

  destroy() { this.map.clear(); for (const u of this.urls) URL.revokeObjectURL(u); this.urls = []; }
}

/** Decode a blob into an image to read its natural size. The object URL stays alive for `ImageCache.prime`. */
export function loadBlobImage(blob: Blob): Promise<{ img: HTMLImageElement; url: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob), img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Not a readable image')); };
    img.src = url;
  });
}
