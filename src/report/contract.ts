type ExecutionOutcome = 'passed' | 'findings' | 'inconclusive' | 'failed';

export const REPORT_EXIT_CODES = {
  passed: 0,
  findings: 1,
  failed: 2,
  inconclusive: 3,
} as const satisfies Record<ExecutionOutcome, number>;

export interface ReportFinding {
  id: string;
  runId: string;
  runName: string;
  flowIndex: number;
  status: 'confirmed' | 'inconclusive';
  summary: string;
  failure?: string;
}

export interface ReportStep {
  number: number;
  action: string;
  target?: string;
  value?: string;
  error?: string;
  errorLabel?: string;
  safetyBlocked?: number;
}

export interface ReportFlow {
  id: string;
  title: string;
  summary: string;
  origin: 'discovered' | 'derived';
  discoveryVerified: boolean;
  replayConfirmed: boolean;
  runtimeIssues: ReportRuntimeError[];
  steps: ReportStep[];
  replayFailure?: {
    reason: string;
    step?: number;
    action?: string;
    error?: string;
    lastUrl: string;
    lastSnapshot: string;
  };
  finding?: {
    status: 'confirmed' | 'inconclusive';
    summary: string;
    failure?: string;
  };
}

export interface ReportResponseVariantAudit {
  flowIndex: number;
  enabled: boolean;
  fixturesFound: number;
  fixtures: Array<{ method: string; url: string; bytes: number }>;
  planningStatus: 'not_enabled' | 'not_run' | 'completed' | 'incomplete' | 'failed';
  plannerCandidates: number;
  plannerRejected: number;
  plannerRejectionReasons: string[];
  plannerReason?: string;
  proposed: number;
  confirmed: number;
  confirmedScenarios: string[];
  skipped: Array<{ name: string; reason: string }>;
}

export interface ReportIssue {
  source: 'evidence';
  severity: 'warning';
  line: number;
  message: string;
}

export interface ReportRuntimeError {
  phase: 'exploration' | 'replay';
  kind: 'console_error' | 'page_error' | 'request_failed' | 'http_error';
  message: string;
  flowIndex?: number;
  method?: string;
  url?: string;
  status?: number;
  occurrences: number;
  safetyRelated?: boolean;
}

export interface ReportSafety {
  blockedRequests: number;
  explorationBlocked: number;
  replayBlocked: number;
  byMethod: Record<string, number>;
  samples: Array<{
    phase: 'exploration' | 'replay';
    method: string;
    url: string;
  }>;
  safetyRelatedRuntimeErrors: number;
}

export type ReportStopReason = 'completed' | 'agent_stopped' | 'budget_exhausted' | 'no_progress' | 'error';

export interface ReportRun {
  id: string;
  name: string;
  persona?: string;
  personaIntent?: 'journey' | 'challenge';
  flowsFound: number;
  replayConfirmed: number;
  generatedTests: number;
  exhausted: boolean;
  stopReason: ReportStopReason;
  safety: ReportSafety;
  runtimeErrors: ReportRuntimeError[];
  flows: ReportFlow[];
  findings: ReportFinding[];
  responseVariants: ReportResponseVariantAudit[];
  error?: string;
}

export interface ExecutionReport {
  schemaVersion: 1;
  executionId: string;
  command: 'explore' | 'run';
  url: string;
  startedAt: string;
  completedAt: string;
  exitCode: number;
  intent: {
    scope?: string;
    expectations: string[];
  };
  summary: {
    runs: number;
    flowsFound: number;
    replayConfirmed: number;
    generatedTests: number;
    confirmedFindings: number;
    inconclusiveFindings: number;
    errors: number;
    evidenceWarnings: number;
    coverageIncomplete: boolean;
    safetyBlockedRequests: number;
    runtimeErrors: number;
  };
  issues: ReportIssue[];
  runs: ReportRun[];
  findings: ReportFinding[];
  artifacts: {
    reportJson: string;
    reportHtml: string;
    discovery: string;
    evidence: string;
    testSuite?: string;
  };
}

export interface ExecutionReportInput {
  executionId: string;
  command: 'explore' | 'run';
  url: string;
  startedAt: string;
  completedAt: string;
  scope?: string;
  expectations: string[];
  generatedTests: number;
  artifacts: ExecutionReport['artifacts'];
  issues?: ReportIssue[];
  runs: Array<{
    id: string;
    name: string;
    persona?: string;
    personaIntent?: 'journey' | 'challenge';
    flowsFound: number;
    replayConfirmed: number;
    generatedTests: number;
    exhausted: boolean;
    stopReason: ReportStopReason;
    safety: ReportSafety;
    runtimeErrors: ReportRuntimeError[];
    flows: ReportFlow[];
    findings: Array<Omit<ReportFinding, 'id' | 'runId' | 'runName'>>;
    responseVariants: ReportResponseVariantAudit[];
    error?: string;
  }>;
}

export function buildExecutionReport(
  input: ExecutionReportInput,
): ExecutionReport {
  let nextFindingId = 1;
  const runs = input.runs.map((run): ReportRun => {
    const findings = run.findings.map((finding) => ({
      ...finding,
      id: `finding-${nextFindingId++}`,
      runId: run.id,
      runName: run.name,
    }));
    return {
      id: run.id,
      name: run.name,
      persona: run.persona,
      personaIntent: run.personaIntent,
      flowsFound: run.flowsFound,
      replayConfirmed: run.replayConfirmed,
      generatedTests: run.generatedTests,
      exhausted: run.exhausted,
      stopReason: run.stopReason,
      safety: run.safety,
      runtimeErrors: run.runtimeErrors,
      flows: run.flows,
      findings,
      responseVariants: run.responseVariants,
      error: run.error,
    };
  });
  const findings = runs.flatMap((run) => run.findings);
  const confirmedFindings = findings.filter(
    (finding) => finding.status === 'confirmed',
  ).length;
  const inconclusiveFindings = findings.filter(
    (finding) => finding.status === 'inconclusive',
  ).length;
  const errors = runs.filter((run) => Boolean(run.error)).length;
  const safetyBlockedRequests = runs.reduce((total, run) => total + run.safety.blockedRequests, 0);
  const runtimeErrors = runs.reduce((total, run) => total + run.runtimeErrors
    .filter((error) => !error.safetyRelated)
    .reduce((count, error) => count + error.occurrences, 0), 0);
  const coverageIncomplete = runs.some((run) => run.exhausted || Boolean(run.error) || run.safety.blockedRequests > 0 || run.runtimeErrors.some((error) => !error.safetyRelated));
  const flowsFound = runs.reduce((total, run) => total + run.flowsFound, 0);
  const replayConfirmed = runs.reduce(
    (total, run) => total + run.replayConfirmed,
    0,
  );
  const outcome: ExecutionOutcome =
    errors > 0
      ? 'failed'
      : (input.issues?.length ?? 0) > 0
        ? 'inconclusive'
      : confirmedFindings > 0
        ? 'findings'
        : inconclusiveFindings > 0 || replayConfirmed === 0 || coverageIncomplete
          ? 'inconclusive'
          : 'passed';

  return {
    schemaVersion: 1,
    executionId: input.executionId,
    command: input.command,
    url: input.url,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    exitCode: REPORT_EXIT_CODES[outcome],
    intent: { scope: input.scope, expectations: input.expectations },
    summary: {
      runs: runs.length,
      flowsFound,
      replayConfirmed,
      generatedTests: input.generatedTests,
      confirmedFindings,
      inconclusiveFindings,
      errors,
      evidenceWarnings: input.issues?.length ?? 0,
      coverageIncomplete,
      safetyBlockedRequests,
      runtimeErrors,
    },
    issues: input.issues ?? [],
    runs,
    findings,
    artifacts: input.artifacts,
  };
}
