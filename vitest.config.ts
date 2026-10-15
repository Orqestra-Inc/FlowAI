import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: '.',
  test: { include: ['tests/**/*.test.ts'], environment: 'node', env: { LANGCHAIN_CALLBACKS_BACKGROUND: 'false' } },
});
