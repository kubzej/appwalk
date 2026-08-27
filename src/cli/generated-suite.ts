import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateSpecBundle, type CodegenOptions, type FlowEntries } from "../codegen/spec.js";

export interface GeneratedSuiteOutput {
  specPath: string;
  fixtureHelperPath?: string;
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
    writeFileSync(artifactPath, artifact.content);
  }

  return {
    specPath,
    fixtureHelperPath: bundle.artifacts.some((artifact) => artifact.relativePath === "fixtures.ts")
      ? join(directory, "fixtures.ts")
      : undefined,
  };
}
