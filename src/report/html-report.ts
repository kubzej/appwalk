import type {
  ExecutionReport,
  ReportFlow,
  ReportResponseVariantAudit,
  ReportRun,
  ReportRuntimeError,
  ReportStep,
} from './contract.js';

/**
 * Renders report.html — an investigation board (persona case files -> flow evidence -> findings)
 * over the same `ExecutionReport` data that drives report.json.
 */

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
    .replace(/\ufffd\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

/** A Playwright error carries the human-readable reason on its first line, then a "Call log:"
 * trace (locator resolution, retry attempts, the full outerHTML of the element) meant for a
 * terminal or evidence.jsonl, not this report. Keep only the sentence a reader can act on. */
function summarizeReason(value: string): string {
  const cleaned = cleanDiagnostic(value);
  const [firstLine] = cleaned.split(/\n\s*Call log:/i);
  return (firstLine ?? cleaned).trim();
}

function actionLabel(name: string): string {
  const labels: Record<string, string> = {
    navigate: 'Navigate',
    click: 'Click',
    doubleClick: 'Double click',
    fill: 'Fill',
    select: 'Select',
    pressKey: 'Press key',
    check: 'Check',
    uncheck: 'Uncheck',
    hover: 'Hover',
    dragAndDrop: 'Drag and drop',
    goBack: 'Go back',
    goForward: 'Go forward',
    reload: 'Reload',
    openInNewTab: 'Open new tab',
    reopenBrowser: 'Reopen browser',
    scroll: 'Scroll',
    setViewportSize: 'Set viewport',
    waitFor: 'Wait for element',
    uploadFile: 'Upload file',
    download: 'Download',
    handleDialog: 'Handle dialog',
    verifyExpectation: 'Verify expectation',
    clearCookie: 'Clear cookie',
    simulateFailure: 'Simulate failure',
    simulateLatency: 'Simulate latency',
    burst: 'Repeat action',
  };
  return labels[name] ?? name;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return escapeHtml(iso);
  return escapeHtml(
    date
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, 'Z'),
  );
}

function formatDuration(startedAt: string, completedAt: string): string {
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'unavailable';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function outcomeStamp(report: ExecutionReport): { tone: string; label: string } {
  const { summary } = report;
  if (summary.errors > 0) return { tone: 'critical', label: 'failed — an execution error stopped one or more runs' };
  if (summary.confirmedFindings > 0)
    return {
      tone: 'warning',
      label: `${summary.confirmedFindings} finding${summary.confirmedFindings === 1 ? '' : 's'} confirmed`,
    };
  if (summary.inconclusiveFindings > 0 || summary.coverageIncomplete || summary.replayConfirmed === 0) {
    return { tone: 'warning', label: 'inconclusive — coverage incomplete or nothing replay-confirmed' };
  }
  return { tone: 'success', label: 'passed — every confirmed flow verified cleanly' };
}

function flowStatusChip(flow: ReportFlow): { tone: string; label: string } {
  if (flow.finding?.status === 'confirmed') return { tone: 'critical', label: 'finding confirmed' };
  if (flow.finding?.status === 'inconclusive') return { tone: 'warning', label: 'finding inconclusive' };
  if (flow.replayConfirmed) return { tone: 'success', label: 'replay confirmed' };
  if (flow.replayFailure) return { tone: 'warning', label: 'not confirmed' };
  return { tone: 'muted', label: flow.discoveryVerified ? 'discovered' : 'unverified' };
}

/** `flow.id` for a discovered flow is always `<runId>-flow-<n>`; pull the ordinal back out to
 * label a similar-shaped flow ("similar to Flow N") without threading a lookup table around. */
function flowOrdinal(flowId: string): string | undefined {
  return flowId.match(/-flow-(\d+)$/)?.[1];
}

/** One shared way to place two or more related facts side by side, everywhere in this report. */
function metaRow(items: string[]): string {
  return `<div class="meta-row">${items.map((item) => `<span>${item}</span>`).join('')}</div>`;
}

function renderStep(step: ReportStep): string {
  const parts = [`<span class="verb">${escapeHtml(actionLabel(step.action))}</span>`];
  if (step.target) parts.push(`<span class="target mono">${escapeHtml(step.target)}</span>`);
  if (step.value !== undefined) parts.push(`<span class="target mono">= ${escapeHtml(step.value)}</span>`);
  const errorNote = step.error
    ? `<div class="step-error">${escapeHtml(step.errorLabel ?? 'Action failed')}: ${escapeHtml(summarizeReason(step.error))}</div>`
    : '';
  const safetyNote = step.safetyBlocked
    ? `<div class="step-note">Safety policy blocked ${step.safetyBlocked} request${step.safetyBlocked === 1 ? '' : 's'}</div>`
    : '';
  return `<li class="step"><span class="idx mono">${step.number}</span><span>${parts.join(' ')}${errorNote}${safetyNote}</span></li>`;
}

const RUNTIME_KIND_LABEL: Record<ReportRuntimeError['kind'], string> = {
  console_error: 'Console error',
  page_error: 'Page error',
  request_failed: 'Request failed',
  http_error: 'HTTP error',
  page_crash: 'Page crash',
};

/** Renders the actual error content (message, and method/url/status when it's a request), not
 * just the category label — a bare "console error ×2" with no message is not diagnosable. */
function renderRuntimeIssue(issue: ReportRuntimeError): string {
  const label = RUNTIME_KIND_LABEL[issue.kind] ?? issue.kind.replace(/_/g, ' ');
  const count = issue.occurrences > 1 ? ` ×${issue.occurrences}` : '';
  const request =
    issue.method || issue.url
      ? `<span class="mono">${escapeHtml([issue.method, issue.status !== undefined ? String(issue.status) : undefined, issue.url].filter(Boolean).join(' '))}</span> `
      : '';
  // For http_error, `message` is always the fixed template "HTTP <status> response" — the status
  // is already in the request span above, so repeating it here would just say the same thing twice.
  const message = issue.kind === 'http_error' ? '' : escapeHtml(summarizeReason(issue.message));
  return `<div class="runtime-issue"><strong>${escapeHtml(label)}${count}</strong> ${request}${message}</div>`;
}

const VARIANT_STATUS_LABEL: Record<ReportResponseVariantAudit['planningStatus'], string> = {
  not_enabled: 'response variants disabled',
  not_run: 'no baseline response captured to plan from',
  completed: 'planning completed',
  incomplete: 'planning stopped early',
  failed: 'planning failed',
};

/** Response-scenario planning is a whole extra pipeline (capture a real JSON response, propose a
 * patch, replay it, confirm it changed the UI) — worth surfacing even when it produced nothing,
 * since "0 confirmed, 3 rejected" explains why a flow has no variants instead of leaving it silent. */
function renderVariantAudit(audit: ReportResponseVariantAudit): string {
  if (!audit.enabled) return '';
  const statusLabel = VARIANT_STATUS_LABEL[audit.planningStatus];
  const counts = metaRow([
    `${audit.fixturesFound} fixture${audit.fixturesFound === 1 ? '' : 's'} captured`,
    `${audit.proposed} proposed`,
    `${audit.confirmed} confirmed`,
    `${audit.plannerRejected} rejected`,
  ]);
  const rejectionReasons =
    audit.plannerRejectionReasons.length > 0
      ? `<div class="runtime-issue">Rejected: ${audit.plannerRejectionReasons.map((reason) => escapeHtml(reason)).join('; ')}</div>`
      : '';
  const skipped =
    audit.skipped.length > 0
      ? audit.skipped
          .map(
            (entry) =>
              `<div class="runtime-issue"><strong>${escapeHtml(entry.name)}</strong> skipped — ${escapeHtml(summarizeReason(entry.reason))}</div>`,
          )
          .join('')
      : '';
  const plannerNote = audit.plannerReason ? `<div class="runtime-issue">${escapeHtml(audit.plannerReason)}</div>` : '';
  const tone = audit.planningStatus === 'failed' ? 'warning' : 'muted';
  return `<div class="note ${tone}"><span class="eyebrow">Response scenarios · ${escapeHtml(statusLabel)}</span>${counts}${rejectionReasons}${skipped}${plannerNote}</div>`;
}

function renderFlow(flow: ReportFlow, children: ReportFlow[] = [], audit?: ReportResponseVariantAudit): string {
  const chip = flowStatusChip(flow);
  const originTag = flow.origin === 'derived' ? `<span class="chip muted">derived scenario</span>` : '';
  const similarOrdinal = flow.similarTo ? flowOrdinal(flow.similarTo) : undefined;
  const similarTag = similarOrdinal ? `<span class="chip muted">similar to Flow ${similarOrdinal}</span>` : '';
  const summary =
    flow.summary && flow.summary !== 'No flow summary provided.'
      ? `<p class="flow-summary">${escapeHtml(flow.summary)}</p>`
      : '';
  const steps =
    flow.steps.length > 0
      ? `<ol class="steps">${flow.steps.map(renderStep).join('')}</ol>`
      : `<p class="empty">No recorded steps.</p>`;
  const failure = flow.replayFailure
    ? `<div class="note warning"><span class="eyebrow">Replay</span><span>${escapeHtml(summarizeReason(flow.replayFailure.reason))}</span></div>`
    : '';
  const finding = flow.finding?.failure
    ? `<div class="note critical"><span class="eyebrow">Finding</span><span>${escapeHtml(summarizeReason(flow.finding.failure))}</span></div>`
    : '';
  const runtimeNotes =
    flow.runtimeIssues.length > 0
      ? `<div class="note warning"><span class="eyebrow">Runtime</span>${flow.runtimeIssues.map(renderRuntimeIssue).join('')}</div>`
      : '';
  const variantAudit = audit ? renderVariantAudit(audit) : '';
  const variants =
    children.length > 0
      ? `<div class="variants"><span class="eyebrow">Response scenarios confirmed (${children.length})</span>${children.map((child) => renderFlow(child)).join('')}</div>`
      : '';
  return `<div class="flow">
    <div class="flow-head"><h3>${escapeHtml(flow.title)}</h3><span class="chip-group">${originTag}${similarTag}<span class="chip ${chip.tone}">${escapeHtml(chip.label)}</span></span></div>
    ${summary}
    ${steps}
    ${failure}${finding}${runtimeNotes}${variantAudit}${variants}
  </div>`;
}

function renderBrief(run: ReportRun): string {
  const scope = run.scope ? `<div class="scope"><span class="eyebrow">Scope</span>${escapeHtml(run.scope)}</div>` : '';
  const expectations =
    run.expectations.length > 0
      ? `<div class="expect"><span class="eyebrow">Expectations</span><ol>${run.expectations.map((expectation) => `<li>${escapeHtml(expectation)}</li>`).join('')}</ol></div>`
      : '';
  return `<div class="brief">
    <h2>${escapeHtml(run.persona ?? run.name)}${run.personaIntent ? `<span class="intent ${run.personaIntent}">${run.personaIntent}</span>` : ''}</h2>
    ${scope}${expectations}
  </div>`;
}

function renderCase(run: ReportRun, index: number, active: boolean): string {
  // Counts only baseline flows — derived response scenarios are nested under their baseline in
  // the detail view, so they shouldn't inflate the top-level "N flows" count here either.
  const baselineFlows = run.flows.filter((flow) => flow.origin !== 'derived');
  const confirmed = baselineFlows.filter((flow) => flow.replayConfirmed).length;
  const metaItems = [`${baselineFlows.length} flow${baselineFlows.length === 1 ? '' : 's'}`, `${confirmed} confirmed`];
  if (run.error) metaItems.push(`<span class="text-critical">failed</span>`);
  return `<button class="case" aria-current="${active}" data-case="run-${index}">
    <div class="case-top"><span class="case-name">${escapeHtml(run.persona ?? run.name)}</span>${run.personaIntent ? `<span class="intent ${run.personaIntent}">${run.personaIntent}</span>` : ''}</div>
    ${metaRow(metaItems).replace('class="meta-row"', 'class="meta-row case-meta"')}
  </button>`;
}

function renderRunDetail(run: ReportRun, index: number, active: boolean): string {
  const errorNote = run.error
    ? `<div class="note critical"><span class="eyebrow">Run error</span><span>${escapeHtml(run.error)}</span></div>`
    : '';
  // Derived flows are confirmed response scenarios of a baseline flow, not independent flows —
  // nest them under that baseline instead of listing them as flat, unrelated top-level cards.
  const baselineFlows = run.flows.filter((flow) => flow.origin !== 'derived');
  const derivedByParent = new Map<string, ReportFlow[]>();
  for (const flow of run.flows) {
    if (flow.origin !== 'derived' || !flow.parentFlowId) continue;
    const siblings = derivedByParent.get(flow.parentFlowId) ?? [];
    siblings.push(flow);
    derivedByParent.set(flow.parentFlowId, siblings);
  }
  const flows =
    baselineFlows.length > 0
      ? baselineFlows
          .map((flow) => {
            const audit = run.responseVariants.find((candidate) =>
              flow.id.endsWith(`-flow-${candidate.flowIndex + 1}`),
            );
            return renderFlow(flow, derivedByParent.get(flow.id) ?? [], audit);
          })
          .join('')
      : `<p class="empty">No flows discovered in this run.</p>`;
  return `<section class="persona-detail" id="run-${index}"${active ? '' : ' hidden'}>
    ${renderBrief(run)}
    ${errorNote}
    ${flows}
  </section>`;
}

export function renderHtmlReport(report: ExecutionReport): string {
  const stamp = outcomeStamp(report);
  const cases = report.runs.map((run, index) => renderCase(run, index, index === 0)).join('');
  const details = report.runs.map((run, index) => renderRunDetail(run, index, index === 0)).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(report.url)} — execution report</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,450;0,9..144,560;0,9..144,650;1,9..144,500&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
${REPORT_CSS}
</style>
</head>
<body>
<div class="page">
  <div class="run-head">
    <div>
      <div class="eyebrow">Execution</div>
      <h1>${escapeHtml(report.url)}</h1>
      ${metaRow([
        `<span class="chip muted">${escapeHtml(report.command)}</span>`,
        `<span class="mono">${formatDate(report.startedAt)}</span>`,
        `duration <span class="mono">${escapeHtml(formatDuration(report.startedAt, report.completedAt))}</span>`,
      ])}
      <div class="execution-id">execution <span class="mono">${escapeHtml(report.executionId)}</span></div>
    </div>
    <div class="stamp ${stamp.tone}"><span class="dot"></span>${escapeHtml(stamp.label)}</div>
  </div>

  <div class="stats">
    <div class="stat"><div class="n mono">${report.summary.runs}</div><div class="l">personas run</div></div>
    <div class="stat"><div class="n mono">${report.summary.flowsFound}</div><div class="l">flows discovered</div></div>
    <div class="stat"><div class="n mono">${report.summary.replayConfirmed}</div><div class="l">replay-confirmed</div></div>
    <div class="stat"><div class="n mono">${report.summary.confirmedFindings}</div><div class="l">findings confirmed</div></div>
    <div class="stat"><div class="n mono">${report.summary.inconclusiveFindings}</div><div class="l">needs review</div></div>
  </div>

  <div class="board">
    <nav class="case-list" role="tablist" aria-label="Personas">${cases}</nav>
    <div class="detail">${details}</div>
  </div>

  <footer class="page-foot">
    <span>report.html</span>
    <span>generated by appwalk</span>
  </footer>
</div>

<script>
  document.querySelectorAll('.case').forEach(function(btn){
    btn.addEventListener('click', function(){
      document.querySelectorAll('.case').forEach(function(b){ b.setAttribute('aria-current','false'); });
      btn.setAttribute('aria-current','true');
      document.querySelectorAll('.persona-detail').forEach(function(p){ p.hidden = true; });
      document.getElementById(btn.dataset.case).hidden = false;
    });
  });
</script>
</body>
</html>`;
}

const REPORT_CSS = `
  :root{
    --bg:#EEF1F2; --surface:#FFFFFF; --surface-2:#E3E9EA; --border:#D3DADC;
    --text:#141A1F; --muted:#5B6B72; --faint:#8B979B;
    --accent:#2E6E73; --accent-soft:#DCEAEA; --accent-ink:#123236;
    --success:#3F7D52; --success-soft:#E1EEE4;
    --warning:#B8791E; --warning-soft:#F5E7D2;
    --critical:#A83E2C; --critical-soft:#F3E0DA;
  }
  @media (prefers-color-scheme: dark){
    :root:not([data-theme="light"]){
      --bg:#0E1518; --surface:#16212A; --surface-2:#1C2932; --border:#2A3A44;
      --text:#E7ECEC; --muted:#8CA0A8; --faint:#5E7178;
      --accent:#63BDC3; --accent-soft:#1B3236; --accent-ink:#CFEFF1;
      --success:#74CE8C; --success-soft:#1C3323;
      --warning:#E3AD55; --warning-soft:#392C15;
      --critical:#E58067; --critical-soft:#3A2019;
    }
  }
  :root[data-theme="dark"]{
    --bg:#0E1518; --surface:#16212A; --surface-2:#1C2932; --border:#2A3A44;
    --text:#E7ECEC; --muted:#8CA0A8; --faint:#5E7178;
    --accent:#63BDC3; --accent-soft:#1B3236; --accent-ink:#CFEFF1;
    --success:#74CE8C; --success-soft:#1C3323;
    --warning:#E3AD55; --warning-soft:#392C15;
    --critical:#E58067; --critical-soft:#3A2019;
  }
  *{box-sizing:border-box;}
  body{ margin:0; background:var(--bg); color:var(--text); font-family:"IBM Plex Sans",system-ui,sans-serif; font-size:15px; line-height:1.55; }
  h1,h2,h3,.display{ font-family:"Fraunces","IBM Plex Sans",serif; text-wrap:balance; }
  .mono{ font-family:"IBM Plex Mono",ui-monospace,monospace; font-variant-numeric:tabular-nums; }
  .eyebrow{ display:block; text-transform:uppercase; letter-spacing:.08em; font-size:11.5px; font-weight:600; color:var(--muted); margin-bottom:4px; }
  .text-critical{ color:var(--critical); font-weight:600; }
  .meta-row{ display:flex; align-items:center; gap:8px; color:var(--muted); font-size:13px; flex-wrap:wrap; }
  .meta-row span:not(:first-child)::before{ content:"·"; margin-right:8px; color:var(--faint); }
  .meta-row .mono{ color:var(--text); }
  .execution-id{ margin-top:6px; color:var(--faint); font-size:12px; }
  .execution-id .mono{ color:var(--muted); }
  .page{ max-width:1180px; margin:0 auto; padding:36px 28px 64px; }
  .run-head{ display:flex; justify-content:space-between; align-items:flex-end; gap:24px; padding-bottom:20px; border-bottom:1px solid var(--border); margin-bottom:24px; }
  .run-head h1{ font-size:26px; font-weight:650; margin:6px 0 10px; word-break:break-word; }
  .stamp{ display:inline-flex; align-items:center; gap:7px; padding:7px 14px; border-radius:3px; font-size:13px; font-weight:600; white-space:nowrap; border:1px solid transparent; }
  .stamp.success{ background:var(--success-soft); color:var(--success); border-color:color-mix(in srgb, var(--success) 35%, transparent); }
  .stamp.warning{ background:var(--warning-soft); color:var(--warning); border-color:color-mix(in srgb, var(--warning) 35%, transparent); }
  .stamp.critical{ background:var(--critical-soft); color:var(--critical); border-color:color-mix(in srgb, var(--critical) 35%, transparent); }
  .stamp .dot{ width:7px; height:7px; border-radius:50%; background:currentColor; }
  .stats{ display:grid; grid-template-columns:repeat(5,1fr); gap:1px; background:var(--border); border:1px solid var(--border); border-radius:6px; overflow:hidden; margin-bottom:32px; }
  .stat{ background:var(--surface); padding:18px 20px; }
  .stat .n{ font-family:"Fraunces",serif; font-size:34px; font-weight:560; line-height:1; }
  .stat .l{ margin-top:6px; color:var(--muted); font-size:12.5px; }
  .board{ display:grid; grid-template-columns:250px 1fr; gap:28px; align-items:start; }
  .case-list{ display:flex; flex-direction:column; gap:8px; position:sticky; top:24px; }
  .case{ text-align:left; width:100%; cursor:pointer; border:1px solid var(--border); background:var(--surface); border-radius:6px; padding:13px 14px; display:flex; flex-direction:column; gap:6px; font:inherit; color:inherit; }
  .case[aria-current="true"]{ border-color:var(--accent); background:var(--accent-soft); }
  .case-top{ display:flex; justify-content:space-between; align-items:baseline; gap:8px; }
  .case-name{ font-family:"Fraunces",serif; font-weight:650; font-size:17px; }
  .intent{ font-size:10.5px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; padding:2px 7px; border-radius:99px; white-space:nowrap; }
  .intent.journey{ background:var(--accent-soft); color:var(--accent-ink); }
  .intent.challenge{ background:var(--warning-soft); color:var(--warning); }
  .case-meta{ font-size:12.5px; }
  .detail{ display:flex; flex-direction:column; gap:22px; min-width:0; }
  .persona-detail{ display:flex; flex-direction:column; gap:16px; }
  .persona-detail[hidden]{ display:none; }
  .brief{ background:var(--surface); border:1px solid var(--border); border-radius:6px; padding:18px 20px; }
  .brief h2{ font-size:19px; margin:0 0 10px; display:flex; align-items:baseline; gap:10px; }
  .brief h2 .intent{ font-family:"IBM Plex Sans",sans-serif; }
  .brief .scope, .brief .expect{ font-size:14px; }
  .brief .expect{ margin-top:12px; font-size:13.5px; color:var(--muted); }
  .brief .expect ol{ margin:0; padding-left:18px; color:var(--text); }
  .flow{ background:var(--surface); border:1px solid var(--border); border-radius:6px; overflow:hidden; }
  .flow-head{ display:flex; justify-content:space-between; align-items:center; gap:12px; padding:14px 18px; border-bottom:1px solid var(--border); }
  .flow-head h3{ font-size:16.5px; margin:0; }
  .flow-summary{ margin:12px 18px; color:var(--muted); font-size:13.5px; }
  .chip-group{ display:flex; gap:6px; }
  .chip{ font-size:11.5px; font-weight:600; padding:3px 10px; border-radius:99px; white-space:nowrap; }
  .chip.success{ background:var(--success-soft); color:var(--success); }
  .chip.warning{ background:var(--warning-soft); color:var(--warning); }
  .chip.critical{ background:var(--critical-soft); color:var(--critical); }
  .chip.muted{ background:var(--surface-2); color:var(--muted); }
  .steps{ list-style:none; margin:0; padding:6px 0; }
  .step{ display:grid; grid-template-columns:30px 1fr; gap:12px; padding:8px 18px; align-items:baseline; }
  .step + .step{ border-top:1px dashed var(--border); }
  .step .idx{ color:var(--faint); text-align:right; font-size:13px; }
  .step .verb{ font-weight:600; }
  .step .target{ color:var(--muted); margin-left:4px; }
  .step-error{ color:var(--critical); font-size:12.5px; margin-top:2px; }
  .step-note{ color:var(--warning); font-size:12.5px; margin-top:2px; }
  .note{ margin:0 18px 12px; padding:9px 12px; border-radius:5px; font-size:13px; }
  .note.warning{ background:var(--warning-soft); color:var(--warning); }
  .note.critical{ background:var(--critical-soft); color:var(--critical); }
  .note.muted{ background:var(--surface-2); color:var(--muted); }
  .note.muted .mono{ color:var(--text); }
  .variants{ margin:0 18px 12px; padding-top:8px; border-top:1px dashed var(--border); }
  .variants > .eyebrow{ margin-bottom:8px; }
  .variants .flow{ margin-bottom:10px; }
  .variants .flow:last-child{ margin-bottom:0; }
  .note .eyebrow{ color:inherit; opacity:.85; margin-bottom:2px; }
  .runtime-issue{ margin-top:4px; }
  .runtime-issue:first-of-type{ margin-top:0; }
  .empty{ padding:14px 18px; color:var(--muted); font-size:13.5px; }
  footer.page-foot{ margin-top:40px; padding-top:16px; border-top:1px solid var(--border); color:var(--faint); font-size:12px; display:flex; justify-content:space-between; gap:12px; }
  @media (max-width:760px){
    .board{ grid-template-columns:1fr; }
    .case-list{ position:static; flex-direction:row; flex-wrap:wrap; }
    .case{ width:auto; flex:1 1 220px; }
    .stats{ grid-template-columns:repeat(2,1fr); }
  }
`;
