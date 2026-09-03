import type {
  ExecutionReport,
  ReportFlow,
  ReportResponseVariantAudit,
  ReportRun,
  ReportRuntimeError,
  ReportSafety,
  ReportStep,
  ReportStopReason,
} from "./contract.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function cleanDiagnostic(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\uFFFD\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

function isTechnicalDiagnostic(value: string): boolean {
  return /(?:locator\.|timeout|call log:|waiting for locator|replay failed|\berror\b|\bHTTP \d{3}\b)/i.test(value);
}

function renderScenarioReason(reason: string): string {
  const cleaned = cleanDiagnostic(reason);
  return isTechnicalDiagnostic(cleaned)
    ? `<pre class="r-code-block r-scenario-code"><code>${escapeHtml(cleaned)}</code></pre>`
    : `<p class="r-scenario-reason">${escapeHtml(cleaned)}</p>`;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || 'Unknown';
  return new Intl.DateTimeFormat('en', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatDuration(startedAt: string, completedAt: string): string {
  const duration =
    new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(duration) || duration < 0) return 'Duration unavailable';
  if (duration < 1000) return '<1s';
  if (duration < 60000) return `${Math.round(duration / 1000)}s`;
  return `${Math.floor(duration / 60000)}m ${Math.round((duration % 60000) / 1000)}s`;
}

function flowStatus(flow: ReportFlow): { label: string; tone: string } {
  if (!flow.replayConfirmed) return { label: 'Needs review', tone: 'warning' };
  if (flow.finding?.status === 'confirmed') return { label: 'Potential bug', tone: 'danger' };
  if (flow.finding?.status === 'inconclusive') return { label: 'Needs review', tone: 'warning' };
  return { label: 'Confirmed', tone: 'good' };
}

function panelId(
  runIndex: number,
  flowIndex?: number,
): string {
  return flowIndex === undefined
    ? `panel-persona-${runIndex}`
    : `panel-flow-${runIndex}-${flowIndex}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function personaName(run: ReportRun): string | undefined {
  return run.persona ? capitalize(run.persona) : undefined;
}

function callout(tone: string, children: string): string {
  return `<div class="r-callout r-callout-${tone}">${children}</div>`;
}

function badge(label: string, tone: string): string {
  return `<span class="r-badge r-badge-${tone}">${escapeHtml(label)}</span>`;
}

function similarFlowLabel(id: string): string {
  const match = /-flow-(\d+)$/.exec(id);
  return match ? `Similar to Flow ${match[1]}` : 'Similar baseline flow';
}

function renderIndex(report: ExecutionReport): string {
  const personas = report.runs
    .map((run, runIndex) => {
      const renderFlowLink = (flow: ReportFlow, flowIndex: number, variant = false): string => {
        const status = flowStatus(flow);
        const similar = !variant && flow.similarTo
          ? `<span class="r-flow-secondary">${escapeHtml(similarFlowLabel(flow.similarTo))}</span>`
          : '';
        return `<a class="r-link r-link-flow${variant ? ' r-link-variant' : ''}" href="#${panelId(runIndex, flowIndex)}" data-target="${panelId(runIndex, flowIndex)}"><span class="r-link-title">${variant ? '<span class="r-variant-label">Variant</span>' : ''}<span>${escapeHtml(flow.title)}</span>${similar}</span>${badge(status.label, status.tone)}</a>`;
      };
      const variantsByParent = new Map<string, Array<{ flow: ReportFlow; index: number }>>();
      run.flows.forEach((flow, flowIndex) => {
        if (!flow.parentFlowId) return;
        const variants = variantsByParent.get(flow.parentFlowId) ?? [];
        variants.push({ flow, index: flowIndex });
        variantsByParent.set(flow.parentFlowId, variants);
      });
      const renderedFlowIndexes = new Set<number>();
      const flows = run.flows.map((flow, flowIndex) => {
        if (flow.origin === 'derived' || renderedFlowIndexes.has(flowIndex)) return '';
        renderedFlowIndexes.add(flowIndex);
        const variants = variantsByParent.get(flow.id) ?? [];
        variants.forEach((variant) => renderedFlowIndexes.add(variant.index));
        return `${renderFlowLink(flow, flowIndex)}${variants.length ? `<div class="r-index-variants"><span class="r-variant-group-label">Variants</span>${variants.map((variant) => renderFlowLink(variant.flow, variant.index, true)).join('')}</div>` : ''}`;
      }).join('') + run.flows.map((flow, flowIndex) =>
        flow.origin === 'derived' && !renderedFlowIndexes.has(flowIndex)
          ? renderFlowLink(flow, flowIndex, true)
          : '',
      ).join('');
      const name = personaName(run);
      const primary = name
        ? `${escapeHtml(name)}${run.personaIntent ? `, ${escapeHtml(run.personaIntent)}` : ''}`
        : escapeHtml(run.name);
      const secondary = name
        ? `<span class="r-persona-secondary">${escapeHtml(run.name)}</span>`
        : '';
      return `<div class="r-index-group">
      <a class="r-link r-link-persona" href="#${panelId(runIndex)}" data-target="${panelId(runIndex)}"><span class="r-link-title"><span class="r-persona-primary">${primary}</span>${secondary}</span></a>
      <div class="r-index-flows">${flows}</div>
    </div>`;
    })
    .join('');
  return `<nav class="r-index r-card">
    <a class="r-link r-link-overview" href="#panel-overview" data-target="panel-overview"><span class="r-link-title">Overview</span></a>
    <div class="r-index-personas">${personas}</div>
  </nav>`;
}

function renderStepsCard(steps: ReportStep[]): string {
  const body = steps.length
    ? `<div class="r-steps">${steps
        .map((step) => {
          const target = step.target
            ? ` <span class="r-code">${escapeHtml(step.target)}</span>`
            : '';
          const value =
            step.value !== undefined
              ? ` <span class="r-muted">${escapeHtml(step.value)}</span>`
              : '';
          const error = step.error
            ? `<div class="r-step-error"><p class="r-label">${escapeHtml(step.errorLabel ?? 'Action failed')}</p><pre class="r-code-block"><code>${escapeHtml(cleanDiagnostic(step.error))}</code></pre></div>`
            : '';
          const safety = step.safetyBlocked
            ? `<div class="r-tone-warning">Safety policy blocked ${step.safetyBlocked} request${step.safetyBlocked === 1 ? '' : 's'}; the request was not sent.</div>`
            : '';
          return `<div class="r-step"><span class="r-muted">${String(step.number).padStart(2, '0')}</span><div><span class="r-step-action">${escapeHtml(step.action)}</span>${target}${value}${error}${safety}</div></div>`;
        })
        .join('')}</div>`
    : `<p class="r-muted">No action evidence recorded.</p>`;
  return `<div class="r-card"><p class="r-label">Steps</p>${body}</div>`;
}

function renderResponseScenariosCard(
  audit: ReportResponseVariantAudit,
): string {
  if (!audit.enabled) {
    return `<div class="r-card"><p class="r-label">Response scenarios</p><p class="r-muted">Variant exploration was not enabled. The flow uses baseline response fixtures only.</p></div>`;
  }
  const plannerStatus = audit.planningStatus === 'completed'
    ? `Returned ${audit.plannerCandidates} proposal${audit.plannerCandidates === 1 ? '' : 's'}`
    : audit.planningStatus === 'failed'
      ? 'Failed'
      : audit.planningStatus === 'incomplete'
        ? 'Incomplete'
        : 'Not run';
  const variantSummary = [
    `${audit.proposed} accepted`,
    ...(audit.plannerRejected > 0 ? [`${audit.plannerRejected} rejected`] : []),
    `${audit.confirmed} replay confirmed`,
    `${audit.skipped.length} skipped`,
  ].join(' · ');
  const summary = `<div class="r-meta-list r-response-meta">
    <div class="r-meta-row"><strong class="r-meta-label">Fixtures:</strong><span class="r-meta-value">${audit.fixturesFound} captured</span></div>
    <div class="r-meta-row"><strong class="r-meta-label">Variants:</strong><span class="r-meta-value">${variantSummary}</span></div>
    <div class="r-meta-row"><strong class="r-meta-label">Planner:</strong><span class="r-meta-value">${escapeHtml(plannerStatus)}</span></div>
  </div>`;
  const fixtures = audit.fixtures.length
    ? `<div class="r-response-section"><p class="r-label">Captured fixtures</p><div class="r-fixtures">${audit.fixtures.map((fixture) => `<div class="r-row"><span class="r-code">${escapeHtml(fixture.method)}</span><code class="r-code r-fixture-url">${escapeHtml(fixture.url)}</code><span class="r-muted">${fixture.bytes.toLocaleString()} B</span></div>`).join('')}</div></div>`
    : `<div class="r-response-section"><p class="r-label">Captured fixtures</p><p class="r-muted">No replayable JSON responses were captured.</p></div>`;
  const confirmed = audit.confirmedScenarios.length
    ? `<div class="r-response-section"><p class="r-label">Replay-confirmed variants</p><div class="r-scenario-list">${audit.confirmedScenarios.map((name) => `<p><strong>${escapeHtml(name)}</strong></p>`).join('')}</div></div>`
    : `<div class="r-response-section"><p class="r-label">Replay-confirmed variants</p><p class="r-muted">No response variant was confirmed by replay.</p></div>`;
  const skipped = audit.skipped.length
    ? `<div class="r-response-section"><p class="r-label">Skipped variants</p><div class="r-scenario-list">${audit.skipped.map((item) => `<div class="r-scenario"><p><strong>${escapeHtml(item.name)}</strong></p>${renderScenarioReason(item.reason)}</div>`).join('')}</div></div>`
    : '';
  const planner = audit.planningStatus === 'failed'
    ? `<p class="r-response-note r-tone-danger">Variant planning failed${audit.plannerReason ? `: ${escapeHtml(cleanDiagnostic(audit.plannerReason))}` : '.'}</p>`
    : audit.planningStatus === 'incomplete'
      ? `<p class="r-response-note r-tone-danger">Variant planning was incomplete${audit.plannerReason ? `: ${escapeHtml(cleanDiagnostic(audit.plannerReason))}` : '.'}</p>`
    : audit.plannerReason && audit.plannerRejected === 0
      ? `<p class="r-response-note r-muted">${escapeHtml(cleanDiagnostic(audit.plannerReason))}</p>`
      : '';
  const rejected = audit.plannerRejected > 0
    ? `<div class="r-response-section"><p class="r-label">Rejected proposals</p><p><strong>${audit.plannerRejected} planner proposal${audit.plannerRejected === 1 ? '' : 's'}</strong> rejected by Appwalk validation.</p>${audit.plannerRejectionReasons.length ? `<p class="r-scenario-reason">Reason: ${escapeHtml(audit.plannerRejectionReasons.map(cleanDiagnostic).join('; '))}</p>` : ''}</div>`
    : '';
  return `<div class="r-card">
    <p class="r-label">Response scenarios</p>
    ${summary}
    ${planner}
    ${rejected}
    ${fixtures}
    ${confirmed}
    ${skipped}
  </div>`;
}

function renderFlowRuntimeIssues(errors: ReportRuntimeError[]): string {
  if (errors.length === 0) return '';
  const rows = errors.slice(0, 8).map((error) => {
    const phase = capitalize(error.phase);
    const request = [error.method, error.url].filter(Boolean).join(' ');
    const count = error.occurrences > 1 ? ` (${error.occurrences} occurrences)` : '';
    return `<div class="r-runtime-item">
      <p class="r-runtime-message"><strong>${escapeHtml(error.message)}</strong>${escapeHtml(count)}</p>
      <p class="r-runtime-line"><strong>Phase:</strong> ${escapeHtml(phase)}</p>
      ${request ? `<p class="r-runtime-line"><strong>Request:</strong> <code>${escapeHtml(request)}</code></p>` : ''}
      <p class="r-muted">Observed during replay; this event is not linked to a recorded action.</p>
    </div>`;
  }).join('');
  const more = errors.length > 8
    ? `<p class="r-muted">${errors.length - 8} more application error${errors.length - 8 === 1 ? '' : 's'} recorded for this flow.</p>`
    : '';
  return callout('warning', `<p class="r-callout-title">APPLICATION ERROR OBSERVED</p>${rows}${more}`);
}

function renderReplayFailure(failure: ReportFlow['replayFailure']): string {
  if (!failure) return '';
  const diagnostic = failure.error ? cleanDiagnostic(failure.error) : '';
  const causeLabels: Record<NonNullable<ReportFlow['replayFailure']>['cause'] & string, string> = {
    action: 'The recorded action could not be completed.',
    authentication: 'The replay session was not authenticated when the flow expected an application page.',
    loading: 'The application was still loading when the recorded action was replayed.',
    request: 'A request failed while the replay was restoring the flow state.',
    safety: 'The safety policy blocked a request needed by the flow.',
    expectation: 'The replay did not reproduce the recorded expectation.',
    verification: 'The replay reached a different final state than the recorded flow.',
  };
  const cause = failure.cause ? `<p class="r-failure-cause"><strong>Likely cause:</strong> ${causeLabels[failure.cause]}</p>` : '';
  const step = failure.step !== undefined
    ? `<p class="r-failure-line"><strong>Step:</strong> <code>${failure.step}</code>${failure.action ? ` <span class="r-muted">(${escapeHtml(failure.action)})</span>` : ''}</p>`
    : '';
  const technicalError = diagnostic
    ? `<pre class="r-code-block"><code>${escapeHtml(diagnostic)}</code></pre>`
    : '';
  return callout('warning', `<p class="r-callout-title">REPLAY NOT CONFIRMED</p><p class="r-failure-description">${escapeHtml(failure.reason)}</p>${cause}<p class="r-failure-line"><strong>Last URL:</strong> <code>${escapeHtml(failure.lastUrl)}</code></p>${step}${technicalError}<details><summary>Last captured page state</summary><pre class="r-code-block"><code>${escapeHtml(failure.lastSnapshot || '(empty)')}</code></pre></details>`);
}

function renderSafetyCard(safety: ReportSafety): string {
  if (safety.blockedRequests === 0) return '';
  const methods = Object.entries(safety.byMethod)
    .map(([method, count]) => `${method} ${count}`)
    .join(', ');
  const samples = safety.samples.slice(0, 3).map((sample) => `${sample.method} ${sample.url}`).join(', ');
  const related = safety.safetyRelatedRuntimeErrors > 0
    ? `<p class="r-muted">${safety.safetyRelatedRuntimeErrors} browser runtime issue${safety.safetyRelatedRuntimeErrors === 1 ? '' : 's'} were caused by these blocked requests and are excluded from potential bug review.</p>`
    : '';
  return callout('warning', `<p class="r-label">Safety limited coverage</p><p>${safety.blockedRequests} destructive request${safety.blockedRequests === 1 ? '' : 's'} blocked during this persona.</p><p class="r-muted">Exploration: ${safety.explorationBlocked}; replay: ${safety.replayBlocked}${methods ? `; methods: ${escapeHtml(methods)}` : ''}.</p>${related}${samples ? `<p class="r-muted">Examples: ${escapeHtml(samples)}</p>` : ''}`);
}

function renderStopReason(stopReason: ReportStopReason): string {
  if (stopReason === 'completed') return '';
  const message = stopReason === 'budget_exhausted'
    ? 'The action budget was reached before the next flow was completed.'
    : stopReason === 'agent_stopped'
      ? 'Exploration ended before the next flow was completed.'
      : stopReason === 'no_progress'
        ? 'Exploration stopped after repeated attempts made no progress.'
        : 'The persona did not complete its exploration.';
  return callout('warning', `<p class="r-label">Exploration incomplete</p><p>${message}</p>`);
}

function renderPersonaContext(run: ReportRun): string {
  const scope = run.scope
    ? `<div class="r-run-context-row"><strong>Scope:</strong><span>${escapeHtml(run.scope)}</span></div>`
    : '';
  const expectations = run.expectations.length
    ? `<div class="r-run-context-row"><strong>Expectations:</strong><ol class="r-expectations">${run.expectations.map((expectation) => `<li>${escapeHtml(expectation)}</li>`).join('')}</ol></div>`
    : '';
  return `<div class="r-run-context">
    <div class="r-run-context-row"><strong>Max steps:</strong><code>${run.maxSteps}</code></div>
    ${scope}
    ${expectations}
  </div>`;
}

function renderOverviewPanel(report: ExecutionReport): string {
  const caveats =
    report.runs.filter((run) => run.error).length +
    report.runs.filter((run) => run.exhausted).length;
  const intentBody =
    report.intent.scope || report.intent.expectations.length
      ? `${report.intent.scope ? `<p class="r-label">Scope</p><p>${escapeHtml(report.intent.scope)}</p>` : ''}
      ${report.intent.expectations.length ? `<p class="r-label">Expectations</p><ol class="r-expectations">${report.intent.expectations.map((expectation) => `<li>${escapeHtml(expectation)}</li>`).join('')}</ol>` : ''}`
      : '';
  const artifacts = Object.entries(report.artifacts)
    .map(
      ([key, path]) => `<a href="${escapeHtml(path)}">${escapeHtml(key)}</a>`,
    )
    .join('');
  const evidenceIssues = report.issues.filter((issue) => issue.source === 'evidence');
  const evidenceWarning = evidenceIssues.length
    ? callout('warning', `<p><strong>Evidence is incomplete.</strong> ${evidenceIssues.length} malformed record${evidenceIssues.length === 1 ? '' : 's'} skipped while reading evidence.</p><p class="r-muted">${evidenceIssues.map((issue) => `Line ${issue.line}: ${escapeHtml(issue.message)}`).join('<br>')}</p>`)
    : '';
  return `<section id="panel-overview" class="r-panel">
    <div class="r-panel-head"><p class="r-label">Report</p><h1 class="r-h1">Execution overview</h1></div>
    <div class="r-card">
      <div class="r-meta-list">
        <div class="r-meta-row"><strong class="r-meta-label">URL:</strong><span class="r-meta-value"><a href="${escapeHtml(report.url)}">${escapeHtml(report.url)}</a></span></div>
        <div class="r-meta-row"><strong class="r-meta-label">Command:</strong><span class="r-meta-value">${escapeHtml(report.command)}</span></div>
        <div class="r-meta-row"><strong class="r-meta-label">Execution:</strong><span class="r-meta-value">${escapeHtml(report.executionId)}</span></div>
        <div class="r-meta-row"><strong class="r-meta-label">Completed:</strong><span class="r-meta-value">${escapeHtml(formatTimestamp(report.completedAt))}</span></div>
        <div class="r-meta-row"><strong class="r-meta-label">Duration:</strong><span class="r-meta-value">${escapeHtml(formatDuration(report.startedAt, report.completedAt))}</span></div>
        <div class="r-meta-row"><strong class="r-meta-label">Exit code:</strong><span class="r-meta-value">${report.exitCode}</span></div>
      </div>
      ${report.summary.coverageIncomplete ? callout('warning', `<p><strong>Coverage incomplete.</strong> At least one persona exhausted its action budget, encountered a runtime issue, or was limited by safety policy.</p>`) : ''}
      ${caveats && !report.summary.coverageIncomplete ? callout('warning', `<p>${caveats} persona${caveats === 1 ? '' : 's'} needed attention during this execution.</p>`) : ''}
      ${evidenceWarning}
      <div class="r-stat-grid">
        <div><p class="r-label">Personas</p><p class="r-stat">${report.summary.runs}</p></div>
        <div><p class="r-label">Flows found</p><p class="r-stat">${report.summary.flowsFound}</p></div>
        <div><p class="r-label">Baseline replay confirmed</p><p class="r-stat">${report.summary.replayConfirmed}</p></div>
        <div><p class="r-label">Generated tests</p><p class="r-stat">${report.summary.generatedTests}</p></div>
        <div><p class="r-label">Potential bugs</p><p class="r-stat">${report.summary.confirmedFindings}</p></div>
        <div><p class="r-label">Needs review</p><p class="r-stat">${report.summary.inconclusiveFindings}</p></div>
        <div><p class="r-label">Runtime issues</p><p class="r-stat">${report.summary.runtimeErrors}</p></div>
        <div><p class="r-label">Safety blocks</p><p class="r-stat">${report.summary.safetyBlockedRequests}</p></div>
      </div>
    </div>
    ${intentBody ? `<div class="r-card">${intentBody}</div>` : ''}
    <div class="r-card"><p class="r-label">Execution artifacts</p><nav class="r-artifacts">${artifacts}</nav></div>
  </section>`;
}

function renderPersonaPanel(run: ReportRun, runIndex: number): string {
  const name = personaName(run);
  const intentLabel = run.personaIntent
    ? `${capitalize(run.personaIntent)} persona`
    : 'Persona';
  const meta = `<div class="r-persona-stat-grid">
    <div><p class="r-label">Flows found</p><p class="r-stat">${run.flowsFound}</p></div>
    <div><p class="r-label">Baseline replay confirmed</p><p class="r-stat">${run.replayConfirmed}</p></div>
    <div><p class="r-label">Generated tests</p><p class="r-stat">${run.generatedTests}</p></div>
  </div>`;
  const head = name
    ? `<p class="r-label">${escapeHtml(intentLabel)}</p><h1 class="r-h1">${escapeHtml(name)}</h1><p class="r-muted">${escapeHtml(run.name)}</p>`
    : `<p class="r-label">Run</p><h1 class="r-h1">${escapeHtml(run.name)}</h1>`;
  return `<section id="${panelId(runIndex)}" class="r-panel" hidden>
    <div class="r-panel-head">${head}</div>
    ${renderPersonaContext(run)}
    <div class="r-card">
      ${meta}
      ${run.error ? callout('danger', `<p>Persona failed: ${escapeHtml(run.error)}</p>`) : ''}
      ${renderStopReason(run.stopReason)}
      ${renderSafetyCard(run.safety)}
    </div>
  </section>`;
}

function renderFlowPanel(
  flow: ReportFlow,
  run: ReportRun,
  runIndex: number,
  flowIndex: number,
  audit: ReportResponseVariantAudit | undefined,
): string {
  const status = flowStatus(flow);
  const finding = flow.finding
    ? callout(
        flow.finding.status === 'confirmed' ? 'danger' : 'warning',
        `<p class="r-label">${flow.finding.status === 'confirmed' ? 'Potential bug' : 'Potential bug · review'}</p><p>${escapeHtml(flow.finding.summary)}</p>${flow.finding.failure ? `<p class="r-muted">${escapeHtml(flow.finding.failure)}</p>` : ''}`,
      )
    : '';
  const name = personaName(run);
  const relationship = flow.origin === 'derived'
    ? '<p class="r-label">Response variant</p>'
    : flow.similarTo
      ? '<p class="r-muted r-flow-note">A similar baseline flow was also discovered in this persona.</p>'
      : '';
  const crumb = name
    ? `<a class="r-crumb-link" href="#${panelId(runIndex)}" data-target="${panelId(runIndex)}">${escapeHtml(name)}</a><span class="r-crumb-sep">/</span><span>${escapeHtml(run.name)}</span><span class="r-crumb-sep">/</span><span>${flow.origin === 'derived' ? 'response variant' : 'discovered flow'}</span>`
    : `<a class="r-crumb-link" href="#${panelId(runIndex)}" data-target="${panelId(runIndex)}">${escapeHtml(run.name)}</a><span class="r-crumb-sep">/</span><span>${flow.origin === 'derived' ? 'response variant' : 'discovered flow'}</span>`;
  return `<section id="${panelId(runIndex, flowIndex)}" class="r-panel" hidden>
    <div class="r-panel-head"><p class="r-crumb">${crumb}</p>${relationship}<h1 class="r-h1">${escapeHtml(flow.title)}</h1></div>
    <div class="r-card">
      <p class="r-flow-status r-tone-${status.tone}">${escapeHtml(status.label)}</p>
      <div class="r-flow-checks">
        <div class="r-flow-check"><p class="r-label">Discovery</p><p class="r-flow-check-value${flow.discoveryVerified ? ' r-tone-good' : ''}">${flow.discoveryVerified ? 'Verified' : 'Not verified'}</p></div>
        <div class="r-flow-check"><p class="r-label">Replay</p><p class="r-flow-check-value${flow.replayConfirmed ? ' r-tone-good' : ''}">${flow.replayConfirmed ? 'Confirmed' : 'Not confirmed'}</p></div>
      </div>
      <p>${escapeHtml(flow.summary)}</p>
    </div>
    ${finding}
    ${renderReplayFailure(flow.replayFailure)}
    ${renderFlowRuntimeIssues(flow.runtimeIssues)}
    ${renderStepsCard(flow.steps)}
    ${audit ? renderResponseScenariosCard(audit) : ''}
  </section>`;
}

export function renderHtmlReport(report: ExecutionReport): string {
  const index = renderIndex(report);
  const overview = renderOverviewPanel(report);
  const panels = report.runs
    .map((run, runIndex) => {
      const auditsByFlowIndex = new Map(
        run.responseVariants.map((audit) => [audit.flowIndex, audit]),
      );
      const variantsByParent = new Map<string, Array<{ flow: ReportFlow; index: number }>>();
      run.flows.forEach((flow, flowIndex) => {
        if (!flow.parentFlowId) return;
        const variants = variantsByParent.get(flow.parentFlowId) ?? [];
        variants.push({ flow, index: flowIndex });
        variantsByParent.set(flow.parentFlowId, variants);
      });
      const renderedFlowIndexes = new Set<number>();
      const flowPanels = run.flows.map((flow, flowIndex) => {
        if (flow.origin === 'derived' || renderedFlowIndexes.has(flowIndex)) return '';
        renderedFlowIndexes.add(flowIndex);
        const variants = variantsByParent.get(flow.id) ?? [];
        variants.forEach((variant) => renderedFlowIndexes.add(variant.index));
        return renderFlowPanel(flow, run, runIndex, flowIndex, auditsByFlowIndex.get(flowIndex)) +
          variants.map((variant) => renderFlowPanel(variant.flow, run, runIndex, variant.index, undefined)).join('');
      }).join('') + run.flows.map((flow, flowIndex) =>
        flow.origin === 'derived' && !renderedFlowIndexes.has(flowIndex)
          ? renderFlowPanel(flow, run, runIndex, flowIndex, undefined)
          : '',
      ).join('');
      return renderPersonaPanel(run, runIndex) + flowPanels;
    })
    .join('');
  const styles = [
    ':root { color-scheme: light; --brand: #4338ca; --brand-tint: #eef0fd; --brand-ink: #312e81; }',
    '* { box-sizing: border-box; }',
    'body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; font-size: 14px; color: #1c2529; background: #f4f5f6; line-height: 1.55; }',
    '.r-app { width: min(1280px, calc(100% - 64px)); margin: 0 auto; padding: 36px 0 96px; }',
    'h1, p, ol { margin: 0; }',
    'a { color: var(--brand); text-decoration: none; }',
    'a:hover { text-decoration: underline; }',
    '.r-h1 { font-size: 26px; font-weight: 700; }',
    '.r-label { color: #6b7680; font-size: 11px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; }',
    '.r-stat { font-size: 20px; font-weight: 700; margin-top: 4px; }',
    '.r-tone-good { color: #157347; }',
    '.r-tone-warning { color: #8a6a00; }',
    '.r-tone-danger { color: #b42318; }',
    '.r-muted { color: #6b7680; }',
    '.r-card { background: #fff; border-radius: 12px; padding: 20px 22px; }',
    '.r-callout { border-radius: 10px; padding: 12px 14px; margin-top: 14px; color: #33424c; }',
    '.r-callout-good { background: #eaf6ee; }',
    '.r-callout-warning { background: #fdf6df; }',
    '.r-callout-danger { background: #fbeae8; }',
    '.r-masthead { display: flex; align-items: baseline; justify-content: space-between; gap: 24px; padding-bottom: 24px; }',
    '.r-brand { display: flex; align-items: baseline; gap: 8px; }',
    '.r-brand-mark { color: var(--brand); font-size: 11px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }',
    '.r-brand-sub { color: #6b7680; font-size: 11px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; }',
    '.r-badge { display: inline-flex; align-items: center; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 650; letter-spacing: .02em; white-space: nowrap; }',
    '.r-badge-good { background: #e3f5ea; color: #157347; }',
    '.r-badge-warning { background: #fdf3d9; color: #8a6a00; }',
    '.r-badge-danger { background: #fbe4e1; color: #b42318; }',
    '.r-masthead-url { display: block; margin-top: 4px; font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }',
    '.r-workspace { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 28px; align-items: start; }',
    '.r-index { position: sticky; top: 24px; padding: 10px; max-height: calc(100vh - 48px); overflow-y: auto; }',
    '.r-link { display: grid; grid-template-columns: 1fr auto; align-items: start; gap: 10px; padding: 7px 10px; border-radius: 7px; color: #5b6670; }',
    '.r-link-title { min-width: 0; display: flex; flex-direction: column; }',
    '.r-persona-secondary { margin-top: 2px; color: #6b7680; font-weight: 400; }',
    '.r-flow-secondary { margin-top: 2px; color: #89939b; font-size: 11px; font-weight: 500; }',
    '.r-link:hover { background: #f6f7f7; text-decoration: none; }',
    '.r-link.r-active { background: var(--brand-tint); color: var(--brand-ink); font-weight: 600; }',
    '.r-link-overview { font-weight: 600; margin-bottom: 8px; }',
    '.r-link-persona { font-weight: 600; margin-top: 14px; }',
    '.r-index-group:first-child .r-link-persona { margin-top: 0; }',
    '.r-index-flows { display: flex; flex-direction: column; gap: 2px; margin: 4px 0 0 22px; padding-left: 10px; }',
    '.r-index-variants { display: flex; flex-direction: column; gap: 2px; margin: 2px 0 6px 18px; padding-left: 14px; }',
    '.r-variant-group-label, .r-variant-label { color: #7a858d; font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }',
    '.r-variant-group-label { padding: 4px 10px 2px; }',
    '.r-link-variant { padding-top: 5px; padding-bottom: 5px; font-size: 13px; }',
    '.r-panel { display: none; }',
    '.r-panel:not([hidden]) { display: flex; flex-direction: column; gap: 18px; }',
    '.r-panel-head p.r-label, .r-panel-head p.r-crumb { margin-bottom: 6px; }',
    '.r-panel-head h1 + p { margin-top: 4px; }',
    '.r-crumb { font-size: 11px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; color: #6b7680; }',
    '.r-crumb-link { color: var(--brand); font-weight: 800; }',
    '.r-crumb-sep { margin: 0 6px; color: #b7bcc1; }',
    '.r-card-top { display: flex; align-items: baseline; gap: 12px; }',
    '.r-card-top p { color: #33424c; }',
    '.r-flow-status { font-size: 16px; font-weight: 700; }',
    '.r-flow-checks { display: grid; grid-template-columns: repeat(2, minmax(150px, 220px)); gap: 28px; margin-top: 18px; }',
    '.r-flow-check { display: flex; flex-direction: column; gap: 2px; }',
    '.r-flow-check .r-label, .r-flow-check-value { margin: 0; }',
    '.r-flow-check-value { color: #6b7680; font-weight: 700; }',
    '.r-callout-title { color: #6b7680; font-size: 16px; font-weight: 700; letter-spacing: .04em; }',
    '.r-failure-description { margin-top: 8px; }',
    '.r-failure-cause { margin-top: 10px; }',
    '.r-failure-line { overflow-wrap: anywhere; }',
    '.r-failure-line code { color: #33424c; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }',
    '.r-code-block { max-height: 280px; margin: 8px 0 0; padding: 12px 14px; overflow: auto; background: #f3f5f6; border-radius: 7px; white-space: pre-wrap; overflow-wrap: anywhere; color: #33424c; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.5; }',
    '.r-code-block code { font: inherit; }',
    '.r-callout details { margin-top: 14px; }',
    '.r-callout summary { color: #33424c; cursor: pointer; font-weight: 600; }',
    '.r-runtime-item + .r-runtime-item { margin-top: 16px; }',
    '.r-runtime-message { margin-top: 8px; }',
    '.r-runtime-line { margin-top: 4px; }',
    '.r-runtime-line code { color: #33424c; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; overflow-wrap: anywhere; }',
    '.r-card > * + * { margin-top: 12px; }',
    '.r-response-meta { margin-top: 14px; }',
    '.r-response-section { margin-top: 20px; }',
    '.r-response-section > .r-label { margin-bottom: 8px; }',
    '.r-response-note { margin-top: 14px; }',
    '.r-scenario-list { display: grid; gap: 10px; }',
    '.r-scenario-reason { margin-top: 3px; color: #6b7680; overflow-wrap: anywhere; }',
    '.r-meta-list { display: grid; gap: 7px; margin-top: 16px; }',
    '.r-meta-row { display: grid; grid-template-columns: 112px minmax(0, 1fr); gap: 12px; align-items: baseline; }',
    '.r-meta-label { color: #33424c; font-weight: 700; }',
    '.r-meta-value { color: #6b7680; overflow-wrap: anywhere; }',
    '.r-run-context { display: grid; gap: 10px; color: #33424c; }',
    '.r-run-context-row { display: grid; grid-template-columns: 112px minmax(0, 1fr); gap: 12px; align-items: baseline; }',
    '.r-run-context-row strong { font-weight: 700; }',
    '.r-run-context-row code { color: #33424c; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }',
    '.r-run-context .r-expectations { margin: 0; }',
    '.r-expectations { padding-left: 20px; }',
    '.r-expectations li + li { margin-top: 6px; }',
    '.r-stat-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 18px; margin-top: 18px; }',
    '.r-stat-grid > div { background: #f3f5f6; border-radius: 10px; padding: 16px 14px; min-height: 104px; }',
    '.r-stat-grid .r-stat { text-align: center; margin-top: 14px; }',
    '.r-persona-stat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; margin-top: 18px; }',
    '.r-persona-stat-grid > div { background: #f3f5f6; border-radius: 10px; padding: 16px 14px; min-height: 104px; }',
    '.r-persona-stat-grid .r-stat { text-align: center; margin-top: 14px; }',
    '.r-steps { display: grid; gap: 10px; }',
    '.r-step { display: grid; grid-template-columns: 22px 1fr; gap: 10px; }',
    '.r-step-action { font-weight: 600; }',
    '.r-code, .r-step-error code { color: #33424c; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }',
    '.r-step-error { margin-top: 10px; }',
    '.r-step-error .r-code-block { max-height: 240px; }',
    '.r-fixtures { display: grid; gap: 6px; }',
    '.r-row { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; gap: 10px; align-items: baseline; }',
    '.r-fixture-url { overflow-wrap: anywhere; }',
    '.r-audit-group { margin-top: 14px; }',
    '.r-audit-group p:not(.r-label) { margin-top: 4px; }',
    '.r-artifacts { display: flex; flex-wrap: wrap; gap: 10px 22px; font-size: 12px; margin-top: 8px; }',
    '[hidden] { display: none !important; }',
  ].join(' ');
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Appwalk report ',
    escapeHtml(report.url),
    '</title><style>',
    styles,
    '</style></head><body>',
    '<div class="r-app">',
    '<header class="r-masthead"><div><p class="r-brand"><span class="r-brand-mark">Appwalk</span><span class="r-brand-sub">Execution report</span></p></div></header>',
    '<div class="r-workspace">',
    index,
    '<div class="r-detail">',
    overview,
    panels,
    '</div>',
    '</div>',
    '</div>',
    '<script>',
    'const links=[...document.querySelectorAll("[data-target]")];const panels=[...document.querySelectorAll(".r-panel")];',
    'function activate(id){const target=document.getElementById(id)?id:"panel-overview";panels.forEach((panel)=>{panel.hidden=panel.id!==target;});links.forEach((link)=>{link.classList.toggle("r-active",link.dataset.target===target);});}',
    'links.forEach((link)=>{link.addEventListener("click",(event)=>{event.preventDefault();activate(link.dataset.target);history.replaceState(null,"","#"+link.dataset.target);});});',
    'activate(location.hash?location.hash.slice(1):"panel-overview");',
    '</script>',
    '</body></html>',
  ].join('');
}
