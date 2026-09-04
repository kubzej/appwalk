import assert from 'node:assert/strict';
import test from 'node:test';
import { createCoverageRuns, redactorForArgs } from '../../src/cli/orchestrate.js';
import type { CliArgs } from '../../src/cli/args.js';

function baseArgs(overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    command: 'explore',
    url: 'https://example.test',
    output: './appwalk-output',
    maxSteps: 25,
    maxConcurrentPersonas: 1,
    provider: 'openai',
    model: 'test-model',
    browserEngine: 'chromium',
    allowDestructive: false,
    blockMethods: [],
    screenshots: false,
    trace: false,
    expectations: [],
    cliSpecified: new Set<string>(),
    logLevel: 'quiet',
    ...overrides,
  };
}

test('a coverage run without its own auth fields inherits the global credentials', () => {
  const args = baseArgs({
    email: 'global@example.test',
    password: 'global-secret',
    coverageRuns: [{ name: 'Persona A' }],
  });
  const [runA] = createCoverageRuns(args);
  assert.equal(runA!.args.email, 'global@example.test');
  assert.equal(runA!.args.password, 'global-secret');
  assert.equal(runA!.args.storageStatePath, undefined);
});

test("a coverage run's own credentials fully replace the global auth, not merge with it", () => {
  const args = baseArgs({
    email: 'global@example.test',
    password: 'global-secret',
    storageStatePath: './global-state.json',
    coverageRuns: [
      { name: 'Persona A', email: 'persona-a@example.test', password: 'persona-a-secret' },
      { name: 'Persona B', storageState: './persona-b-state.json' },
      { name: 'Persona C' },
    ],
  });
  const [runA, runB, runC] = createCoverageRuns(args);

  // A declares its own credentials — the global storageState must not leak in and silently win
  // over them (navigateOrLogin prefers storageState when both are present).
  assert.equal(runA!.args.email, 'persona-a@example.test');
  assert.equal(runA!.args.password, 'persona-a-secret');
  assert.equal(runA!.args.storageStatePath, undefined);

  // B declares its own storageState — the global email/password must not linger either.
  assert.equal(runB!.args.storageStatePath, './persona-b-state.json');
  assert.equal(runB!.args.email, undefined);
  assert.equal(runB!.args.password, undefined);

  // C declares nothing — it still inherits the global auth unchanged.
  assert.equal(runC!.args.email, 'global@example.test');
  assert.equal(runC!.args.password, 'global-secret');
  assert.equal(runC!.args.storageStatePath, './global-state.json');
});

test("redactorForArgs redacts a coverage run's own secrets, not just the global ones", () => {
  const args = baseArgs({
    email: 'global@example.test',
    password: 'global-secret',
    coverageRuns: [{ name: 'Persona A', email: 'persona-a@example.test', password: 'persona-a-only-secret' }],
  });
  const redactor = redactorForArgs(args);
  const redacted = redactor.text('login attempt with persona-a-only-secret for persona-a@example.test');
  assert.doesNotMatch(redacted, /persona-a-only-secret/);
  assert.doesNotMatch(redacted, /persona-a@example\.test/);
});
