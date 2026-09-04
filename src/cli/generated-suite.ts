import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  GENERATED_CREDENTIALS_FILE,
  GENERATED_STORAGE_STATE_FILE,
  generateSpecBundle,
  type CodegenOptions,
  type FlowEntries,
} from '../codegen/spec.js';

export interface GeneratedSuiteOutput {
  specPath: string;
  fixtureHelperPath?: string;
  credentialsPath?: string;
  storageStatePath?: string;
}

function storageStateFileContent(path: string): string {
  try {
    return JSON.stringify(JSON.parse(readFileSync(path, 'utf8')), null, 2) + '\n';
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read storage state ${path}: ${detail}`);
  }
}

export function writeGeneratedSuite(
  directory: string,
  flows: FlowEntries[],
  options: CodegenOptions,
): GeneratedSuiteOutput {
  const storageStateContent = options.storageStatePath ? storageStateFileContent(options.storageStatePath) : undefined;
  const bundle = generateSpecBundle(
    flows,
    options.storageStatePath ? { ...options, storageStateArtifactPath: GENERATED_STORAGE_STATE_FILE } : options,
  );
  const specPath = join(directory, 'discovered.spec.ts');
  writeFileSync(specPath, bundle.spec);

  const artifacts =
    storageStateContent === undefined
      ? bundle.artifacts
      : [...bundle.artifacts, { relativePath: GENERATED_STORAGE_STATE_FILE, content: storageStateContent }];
  for (const artifact of artifacts) {
    const artifactPath = join(directory, artifact.relativePath);
    mkdirSync(dirname(artifactPath), { recursive: true });
    const isSensitiveArtifact =
      artifact.relativePath === GENERATED_CREDENTIALS_FILE || artifact.relativePath === GENERATED_STORAGE_STATE_FILE;
    if (isSensitiveArtifact) {
      writeFileSync(artifactPath, artifact.content, { mode: 0o600 });
      chmodSync(artifactPath, 0o600);
    } else {
      writeFileSync(artifactPath, artifact.content);
    }
  }

  return {
    specPath,
    fixtureHelperPath: artifacts.some((artifact) => artifact.relativePath === 'fixtures.ts')
      ? join(directory, 'fixtures.ts')
      : undefined,
    credentialsPath: artifacts.some((artifact) => artifact.relativePath === GENERATED_CREDENTIALS_FILE)
      ? join(directory, GENERATED_CREDENTIALS_FILE)
      : undefined,
    storageStatePath: storageStateContent === undefined ? undefined : join(directory, GENERATED_STORAGE_STATE_FILE),
  };
}
