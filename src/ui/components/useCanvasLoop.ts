import { useEffect, useRef } from 'react';

export interface Frame {
  readonly ctx: CanvasRenderingContext2D;
  readonly width: number; // CSS px
  readonly height: number;
  readonly color: (token: string) => string;
}

/** Sizes the canvas to its box at device pixel ratio and calls draw on every animation frame. */
export function useCanvasLoop(draw: (frame: Frame) => void) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let width = 0;
    let height = 0;
    const styles = getComputedStyle(canvas);
    const color = (token: string) => styles.getPropertyValue(token).trim();

    const resize = new ResizeObserver(([entry]) => {
      if (!entry) return;
      width = entry.contentRect.width;
      height = entry.contentRect.height;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    });
    resize.observe(canvas);

    let raf = 0;
    const loop = () => {
      if (width > 0 && height > 0) {
        ctx.clearRect(0, 0, width, height);
        drawRef.current({ ctx, width, height, color });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      resize.disconnect();
    };
  }, []);

  return ref;
}

export function niceRange(min: number, max: number, minSpan: number): [number, number] {
  const span = Math.max(max - min, minSpan);
  const mid = (min + max) / 2;
  return [mid - span * 0.6, mid + span * 0.6];
}
