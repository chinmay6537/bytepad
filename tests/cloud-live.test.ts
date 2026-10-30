// Runs every cloud language's template against the real Wandbox service.
// Skipped by default to be polite to a free service: run with `npm run test:cloud`.
import { describe, expect, it } from 'vitest';
import { fetchWandboxCompilers, runOnWandbox, selectCompilers } from '../src/core/cloud';
import { LANGUAGES } from '../src/core/languages';
import { createProject } from '../src/core/project';

describe.skipIf(!process.env.LIVE)('Wandbox templates', () => {
  for (const language of LANGUAGES.filter((l) => l.wandbox)) {
    it(language.label, { timeout: 120_000, retry: 1 }, async () => {
      const compilers = selectCompilers(await fetchWandboxCompilers(), language);
      expect(compilers.length, 'no compiler available').toBeGreaterThan(0);
      const project = { ...createProject(language.id), stdin: 'Ada\n' };
      const result = await runOnWandbox(project, compilers[0].name, AbortSignal.timeout(100_000));
      expect(result.compileFailed, result.compileOutput).toBe(false);
      expect(result.exitCode, result.stderr + result.compileOutput).toBe(0);
      expect(result.stdout + result.stderr).toMatch(/Ada|Zig|Grace/);
    });
  }
});
