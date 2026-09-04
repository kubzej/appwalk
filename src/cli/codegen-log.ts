import type { Logger } from '../logging/logger.js';

interface CodegenFlowLike {
  origin?: 'discovered' | 'derived';
  responseFixtures?: unknown[];
}

function isBaselineOrigin(origin: 'discovered' | 'derived' | undefined): boolean {
  return origin !== 'derived';
}

export function logCodegenPlan(logger: Logger, mode: 'run' | 'generate', flows: CodegenFlowLike[]): void {
  logger.debug(
    'codegen.started',
    mode === 'generate' ? 'Generating tests from discovery' : 'Generating tests from confirmed flows',
    {
      mode,
      flows: flows.length,
      baselineFlows: flows.filter((flow) => isBaselineOrigin(flow.origin)).length,
      derivedFlows: flows.filter((flow) => !isBaselineOrigin(flow.origin)).length,
      baselineFixtures: flows.reduce((total, flow) => total + (flow.responseFixtures?.length ?? 0), 0),
    },
  );
  flows.forEach((flow, index) => {
    logger.debug('codegen.flow', 'Preparing generated flow', {
      mode,
      flowIndex: index + 1,
      origin: flow.origin ?? 'discovered',
      responseFixtures: flow.responseFixtures?.length ?? 0,
      responseMocking: (flow.responseFixtures?.length ?? 0) > 0,
    });
  });
}

export function logCodegenCompleted(logger: Logger, mode: 'run' | 'generate', flows: CodegenFlowLike[]): void {
  logger.debug('codegen.completed', 'Generated test suite', {
    mode,
    tests: flows.length,
    baselineTests: flows.filter((flow) => isBaselineOrigin(flow.origin)).length,
    derivedTests: flows.filter((flow) => !isBaselineOrigin(flow.origin)).length,
  });
}
