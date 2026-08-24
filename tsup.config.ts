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
  // The agent-instructions block is authored as real markdown (so it can
  // be read and reviewed as the file it becomes) and inlined into the
  // bundle as a string — dist/ stays a single self-contained file.
  loader: {
    '.md': 'text',
  },
  // jq-wasm ships a .wasm file loaded relative to its own package at runtime;
  // don't bundle it away, just bundle our own source.
  noExternal: [],
});
