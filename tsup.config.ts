import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  sourcemap: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  // jq-wasm ships a .wasm file loaded relative to its own package at runtime;
  // don't bundle it away, just bundle our own source.
  noExternal: [],
});
