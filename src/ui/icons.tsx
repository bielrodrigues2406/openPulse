import type { SVGProps } from 'react';

/** 20px stroke icons drawn for this app; currentColor so they follow text colour. */
const base = (p: SVGProps<SVGSVGElement>) => ({
  width: 20, height: 20, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, ...p,
});

export const IconPulse = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M2 10.5h3.2l1.6-4 2.6 9 2.4-11 1.9 6h4.3" /></svg>
);
export const IconWeek = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="3" y="4" width="14" height="13" rx="2" /><path d="M3 8h14M7 2.5v3M13 2.5v3M6.5 11.5h2M11.5 11.5h2M6.5 14h2" /></svg>
);
export const IconHistory = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M3.5 10a6.5 6.5 0 1 0 1.9-4.6M3.5 3.5v3h3" /><path d="M10 6.5V10l2.5 1.6" /></svg>
);
export const IconTrend = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M3 16.5h14" /><path d="M4 13l4-4 3 2.5 5-6" /><path d="M13 5.5h3v3" /></svg>
);
export const IconSunrise = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M5 14a5 5 0 0 1 10 0M2.5 14h15M10 3.5v3M4.2 7.2l1.6 1.6M15.8 7.2l-1.6 1.6M6 17h8" /></svg>
);
export const IconLibrary = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M3 5h3v11H3zM8 5h3v11H8z" /><path d="M13.2 5.6l2.9-.8 2.4 10.6-2.9.8z" /></svg>
);
export const IconUser = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="10" cy="7" r="3.2" /><path d="M3.8 17c.9-3 3.4-4.6 6.2-4.6s5.3 1.6 6.2 4.6" /></svg>
);
export const IconFlag = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M5 17V3.5M5 4h9l-2 3.2 2 3.3H5" /></svg>
);
export const IconExpand = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M3.5 8V3.5H8M12 3.5h4.5V8M16.5 12v4.5H12M8 16.5H3.5V12" /></svg>
);
export const IconBattery = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base({ width: 16, height: 16, ...p })}><rect x="2.5" y="6" width="13" height="8" rx="1.5" /><path d="M17.5 8.5v3" /></svg>
);
