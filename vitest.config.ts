import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Mirrors tsup's `loader: { '.md': 'text' }` so a markdown import
  // resolves the same way under test as it does in the bundle.
  plugins: [
    {
      name: 'markdown-as-text',
      transform(_code, id) {
        if (!id.endsWith('.md')) return null;
        return { code: `export default ${JSON.stringify(readFileSync(id, 'utf8'))};`, map: null };
      },
    },
  ],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
