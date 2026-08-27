import type { ExpectationResult, LoopResult } from "../agent/loop.js";
import type { EvidenceEntry } from "../evidence/log.js";
import type { ResponseVariant } from "../response/variants.js";

export interface DescribeOptions {
  url: string;
  scope?: string;
  expectations?: ExpectationResult[];
}

function describeAction(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "navigate":
      return `Navigated to \`${input.url}\``;
    case "click":
      return `Clicked \`${input.locator}\``;
    case "fill":
      return `Filled \`${input.locator}\` with "${input.value}"`;
    case "select":
      return `Selected "${input.value}" in \`${input.locator}\``;
    case "pressKey":
      return `Pressed ${input.key} on \`${input.locator}\``;
    case "check":
      return `Checked \`${input.locator}\``;
    case "uncheck":
      return `Unchecked \`${input.locator}\``;
    case "hover":
      return `Hovered over \`${input.locator}\``;
    case "goBack":
      return "Navigated back";
    case "scroll":
      return input.locator ? `Scrolled \`${input.locator}\` into view` : "Scrolled to the bottom of the page";
    case "uploadFile":
      return `Uploaded file(s) to \`${input.locator}\``;
    case "handleDialog":
      return `Armed the next dialog to ${input.behavior as string}`;
    case "waitFor":
      return `Waited for \`${input.locator}\` to be visible`;
    default:
      return `${name}(${JSON.stringify(input)})`;
  }
}

function describeFlow(
  entries: EvidenceEntry[],
  flowNumber: string,
  discoveryVerified: boolean,
  finalText: string,
  replayConfirmed = discoveryVerified,
  origin?: "discovered" | "derived",
  sourceName?: string,
  variantReason?: string,
  variant?: ResponseVariant,
): string {
  const successfulSteps = entries.filter((entry) => entry.toolCall && !entry.error && entry.toolCall.name !== "flowComplete");
  const stepsList = successfulSteps
    .map((entry, i) => `${i + 1}. ${describeAction(entry.toolCall!.name, entry.toolCall!.input)}`)
    .join("\n");

  return `## Flow ${flowNumber}

- **Discovery verified:** ${discoveryVerified}
- **Replay confirmed:** ${replayConfirmed}
- **Origin:** ${origin ?? "discovered"}${sourceName ? ` (from ${sourceName})` : ""}
${origin === "derived" ? `- **Response source:** ${variant?.sourceUrl ?? "none"}
- **Response patches:** ${variant?.patches.map((patch) => "`" + patch.path + "` = " + JSON.stringify(patch.value)).join(", ") ?? "none"}
` : ""}
- **Steps:** ${successfulSteps.length} actions

${finalText}${variantReason ? `\n\nResponse variant: ${variantReason}` : ""}

${stepsList}
`;
}

export interface BatchDescriptionRun {
  id: string;
  name: string;
  persona?: string;
  scope?: string;
  entries: EvidenceEntry[];
  discovery?: LoopResult;
  replayConfirmedIds?: number[];
  findings?: Array<{
    flowIndex: number;
    status: "confirmed" | "inconclusive";
    summary: string;
    failure?: string;
  }>;
  derivedFlows?: Array<{
    name: string;
    entries: EvidenceEntry[];
    sourceName: string;
    reason?: string;
    variant?: ResponseVariant;
  }>;
  error?: string;
}

export function generateBatchDescription(entries: EvidenceEntry[], runs: BatchDescriptionRun[], url: string): string {
  const totalFlows = runs.reduce((total, run) => total + (run.discovery?.flows.length ?? 0) + (run.derivedFlows?.length ?? 0), 0);
  const totalFindings = runs.reduce((total, run) => total + (run.findings?.length ?? 0), 0);
  const totalSteps = entries.filter((entry) => entry.toolCall && !entry.error).length;
  const runSections = runs.map((run) => {
    const flowSections = (run.discovery?.flows ?? [])
      .map((flow, index) => describeFlow(
        run.entries.filter((entry) => entry.flowIndex === index),
        `${run.name} / Flow ${index + 1}`,
        flow.verified,
        flow.finalText,
        run.replayConfirmedIds?.includes(index + 1) ?? false,
      ))
      .join("\n");
    const derivedSections = (run.derivedFlows ?? [])
      .map((flow, index) => describeFlow(
        flow.entries,
        `${run.name} / Derived ${index + 1}`,
        true,
        flow.name,
        true,
        "derived",
        flow.sourceName,
        flow.reason,
        flow.variant,
      ))
      .join("\n");
    const expectations = describeExpectations(run.discovery?.expectationResults);
    const findings = describeFindings(run.findings, run.name);
    return `## Run: ${run.name}

- **Run ID:** ${run.id}
${run.persona ? `- **Persona:** ${run.persona}\n` : ""}
${run.scope ? `- **Scope:** ${run.scope}\n` : ""}
${run.discovery ? `- **Flows found:** ${run.discovery.flows.length}\n- **Ran out of budget mid-flow:** ${run.discovery.exhausted}\n` : `- **Status:** failed\n- **Error:** ${run.error ?? "unknown error"}\n`}

${expectations}${findings}${flowSections}${derivedSections ? `\n${derivedSections}` : ""}`;
  }).join("\n");

  return `# Discovered flows

## Info

- **URL:** ${url}
- **Runs:** ${runs.length}
- **Flows found:** ${totalFlows}
- **Application findings:** ${totalFindings}
- **Total steps:** ${totalSteps} actions

${runSections}`;
}

function describeFindings(
  findings: BatchDescriptionRun["findings"],
  runName: string,
): string {
  if (!findings?.length) return "";
  const rows = findings.map((finding, index) => `### Finding ${index + 1}

- **Status:** ${finding.status}
- **Flow:** ${runName} / Flow ${finding.flowIndex + 1}

${finding.summary}${finding.failure ? `\n\nReplay detail: ${finding.failure}` : ""}
`).join("\n");
  return `## Application findings\n\n${rows}`;
}

function describeExpectations(expectations: ExpectationResult[] | undefined): string {
  if (!expectations?.length) return "";
  const rows = expectations.map((expectation) => {
    const evidence = expectation.observations.length
      ? expectation.observations.map((observation) => `flow ${observation.flowIndex + 1}, step ${observation.historyIndex + 1}`).join("; ")
      : "none";
    return `- **${expectation.status}:** ${expectation.text}\n  Evidence: ${evidence}`;
  });
  return `## Expectations\n\n${rows.join("\n")}\n`;
}

/** A short, human-readable summary of every flow discovered in one session — hard facts, the agent's own narrative per flow, then the literal step-by-step record from the evidence log (ground truth — not a paraphrase). */
export function generateDescription(
  entries: EvidenceEntry[],
  discovery: LoopResult,
  options: DescribeOptions,
): string {
  const flowSections = discovery.flows
    .map((flow, i) =>
      describeFlow(
        entries.filter((e) => e.flowIndex === i),
        String(i + 1),
        flow.verified,
        flow.finalText,
      ),
    )
    .join("\n");

  return `# Discovered flows

## Info

- **URL:** ${options.url}
${options.scope ? `- **Scope:** ${options.scope}\n` : ""}- **Flows found:** ${discovery.flows.length}
- **Total steps:** ${entries.filter((e) => e.toolCall && !e.error).length} actions
- **Ran out of budget mid-flow:** ${discovery.exhausted}

${describeExpectations(options.expectations)}
${flowSections}`;
}
