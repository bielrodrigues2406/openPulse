import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative asset paths: the same build runs from a web server and from the desktop app's app:// scheme.
  base: './',
  plugins: [react()],
  test: { include: ['tests/**/*.test.ts'] },
});
