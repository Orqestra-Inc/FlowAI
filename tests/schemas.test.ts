import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TOOLS } from '../server/tools/registry.js';

/**
 * Tool schemas are sent to whichever model provider LLM_MODEL names. Gemini's function-declaration
 * format rejects some JSON Schema keywords (the whole request fails with 400), so keep schemas to the
 * portable subset. `.positive()` in Zod becomes `exclusiveMinimum`, for example; use `.min(1)`.
 */
const UNPORTABLE = ['exclusiveMinimum', 'exclusiveMaximum', 'oneOf', 'allOf', 'not', 'if', 'then', 'else', 'const', '$ref', 'patternProperties'];

function keysDeep(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysDeep(v, out);
    }
  }
  return out;
}

describe('tool schemas are portable across model providers', () => {
  for (const tool of TOOLS) {
    it(tool.name, () => {
      const keys = keysDeep(z.toJSONSchema(tool.schema));
      expect(UNPORTABLE.filter((k) => keys.has(k))).toEqual([]);
    });
  }
});
