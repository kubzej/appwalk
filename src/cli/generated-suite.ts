import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GENERATED_CREDENTIALS_FILE, generateSpecBundle, type CodegenOptions, type FlowEntries } from "../codegen/spec.js";

export interface GeneratedSuiteOutput {
  specPath: string;
  fixtureHelperPath?: string;
  credentialsPath?: string;
}

export function writeGeneratedSuite(
  directory: string,
  flows: FlowEntries[],
  options: CodegenOptions,
): GeneratedSuiteOutput {
  const bundle = generateSpecBundle(flows, options);
  const specPath = join(directory, "discovered.spec.ts");
  writeFileSync(specPath, bundle.spec);

  for (const artifact of bundle.artifacts) {
    const artifactPath = join(directory, artifact.relativePath);
    mkdirSync(dirname(artifactPath), { recursive: true });
    if (artifact.relativePath === GENERATED_CREDENTIALS_FILE) {
      writeFileSync(artifactPath, artifact.content, { mode: 0o600 });
      chmodSync(artifactPath, 0o600);
    } else {
      writeFileSync(artifactPath, artifact.content);
    }
  }

  return {
    specPath,
    fixtureHelperPath: bundle.artifacts.some((artifact) => artifact.relativePath === "fixtures.ts")
      ? join(directory, "fixtures.ts")
      : undefined,
    credentialsPath: bundle.artifacts.some((artifact) => artifact.relativePath === GENERATED_CREDENTIALS_FILE)
      ? join(directory, GENERATED_CREDENTIALS_FILE)
      : undefined,
  };
}
