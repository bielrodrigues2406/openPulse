import { useEffect, useRef } from 'react';

export interface Frame {
  readonly ctx: CanvasRenderingContext2D;
  readonly width: number; // CSS px
  readonly height: number;
  readonly color: (token: string) => string;
}

/**
 * Sizes the canvas to its box at device pixel ratio and draws. live = every animation frame
 * (streaming data); otherwise only on resize and when `version` changes.
 */
export function useCanvasLoop(draw: (frame: Frame) => void, opts: { live?: boolean; version?: unknown } = {}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const redrawRef = useRef<() => void>(() => {});
  const live = opts.live ?? true;

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let width = 0;
    let height = 0;
    const styles = getComputedStyle(canvas);
    const color = (token: string) => (token.startsWith('--') ? styles.getPropertyValue(token).trim() : token);
    const paint = () => {
      if (width <= 0 || height <= 0) return;
      ctx.clearRect(0, 0, width, height);
      drawRef.current({ ctx, width, height, color });
    };
    redrawRef.current = paint;

    const resize = new ResizeObserver(([entry]) => {
      if (!entry) return;
      width = entry.contentRect.width;
      height = entry.contentRect.height;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      paint();
    });
    resize.observe(canvas);

    let raf = 0;
    if (live) {
      const loop = () => {
        paint();
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }
    return () => {
      cancelAnimationFrame(raf);
      resize.disconnect();
    };
  }, [live]);

  useEffect(() => {
    if (!live) redrawRef.current();
  }, [live, opts.version]);

  return ref;
}
