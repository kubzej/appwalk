import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, devices, type Browser } from 'playwright';
import {
  attachCrashDetection,
  attachPopupDetection,
  attachWebSocketCapture,
  createTraceSession,
  deviceContextOptions,
  startTracing,
  stopTracing,
  writeDiscoveryArtifacts,
  type ExplorationBatch,
} from '../../src/cli/orchestrate.js';
import { createBrowserLifecycle } from '../../src/cli/browser-lifecycle.js';
import type { Persona } from '../../src/agent/personas.js';
import { executeToolCall, type TabRegistryHandle } from '../../src/agent/tools.js';
import { EvidenceRecorder } from '../../src/evidence/recorder.js';
import { Logger } from '../../src/logging/logger.js';
import { Redactor } from '../../src/security/redaction.js';
import type { CliArgs } from '../../src/cli/args.js';

const WEBSOCKET_ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** A minimal, dependency-free WebSocket echo server (text frames only) — no test/runtime
 * dependency on the `ws` package, which this project doesn't actually depend on directly. Encodes
 * the handshake per RFC 6455 and decodes just enough of the (always-masked, client-to-server)
 * frame format to read one text message and echo it back unmasked. Also serves a plain page over
 * the same origin/port — Chromium's Private Network Access checks block a WebSocket to 127.0.0.1
 * from an untrusted origin like about:blank, so the test page needs to actually be served from here. */
async function startEchoWebSocketServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<h1>ok</h1>');
  });
  // Once a socket is upgraded, the http.Server hands off ownership and no longer tracks it —
  // server.closeAllConnections()/server.close() never touch it, which otherwise leaves the process
  // with an open handle and the test runner hanging forever waiting for it to exit.
  const upgradedSockets = new Set<import('node:stream').Duplex>();
  server.on('upgrade', (req, socket) => {
    upgradedSockets.add(socket);
    socket.on('close', () => upgradedSockets.delete(socket));
    const key = req.headers['sec-websocket-key'] as string;
    const accept = createHash('sha1')
      .update(key + WEBSOCKET_ACCEPT_GUID)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    // The browser closing the socket after the round-trip is a normal close, not a real error —
    // an unhandled 'error' event would otherwise crash the whole test process.
    socket.on('error', () => undefined);
    socket.on('data', (buffer: Buffer) => {
      const opcode = buffer[0]! & 0x0f;
      if (opcode !== 0x1) return; // ignore close (0x8)/ping/pong frames — only text frames carry the test message
      const payloadLength = buffer[1]! & 0x7f;
      const maskStart = 2; // only exercised with short (<126-byte) test payloads, so no extended-length handling needed
      const mask = buffer.subarray(maskStart, maskStart + 4);
      const encoded = buffer.subarray(maskStart + 4, maskStart + 4 + payloadLength);
      const decoded = Buffer.alloc(payloadLength);
      for (let i = 0; i < payloadLength; i++) decoded[i] = encoded[i]! ^ mask[i % 4]!;
      const message = decoded.toString('utf-8');
      const reply = Buffer.from(`echo:${message}`, 'utf-8');
      const header = reply.length < 126 ? Buffer.from([0x81, reply.length]) : null;
      if (!header) throw new Error('test echo server only supports short payloads');
      socket.write(Buffer.concat([header, reply]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        for (const socket of upgradedSockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

function spyLogger(): { logger: Logger; verboseMessages: string[] } {
  const logger = new Logger('quiet');
  const verboseMessages: string[] = [];
  logger.verbose = (message: string) => {
    verboseMessages.push(message);
  };
  logger.debug = () => {};
  return { logger, verboseMessages };
}

test('discovery manifest does not persist captured flow state', () => {
  const directory = mkdtempSync(join(tmpdir(), 'appwalk-discovery-state-'));
  const state = JSON.stringify({
    cookies: [{ name: 'session', value: 'secret-token', domain: 'example.test', path: '/' }],
    origins: [],
  });
  const args = {
    url: 'https://example.test',
    maxSteps: 25,
    expectations: [],
    output: directory,
  } as unknown as CliArgs;

  try {
    const manifestPath = writeDiscoveryArtifacts({
      executionId: 'execution-1',
      args,
      evidencePath: join(directory, 'evidence.jsonl'),
      allEntries: [],
      evidenceIssues: [],
      redactor: new Redactor(['secret-token']),
      confirmedFlows: [
        {
          name: 'Account flow',
          title: 'Account flow',
          entries: [],
          startUrl: 'https://example.test/account',
          startStorageState: state,
          origin: 'discovered',
          sourceFlowIndex: 0,
        },
      ],
      runs: [
        {
          runId: 'run-1',
          runName: 'baseline',
          args,
          evidencePath: join(directory, 'evidence.jsonl'),
          allEntries: [],
          confirmedFlows: [],
          replayConfirmedIds: [1],
          findings: [],
          responseVariantAudits: [],
          safety: {
            blockedRequests: 0,
            explorationBlocked: 0,
            replayBlocked: 0,
            byMethod: {},
            samples: [],
            safetyRelatedRuntimeErrors: 0,
          },
          runtimeErrors: [],
          replayFailures: {},
          discovery: {
            history: [],
            flows: [
              {
                startIndex: 0,
                endIndex: 0,
                finalText: 'Account flow',
                title: 'Account flow',
                verified: true,
                startUrl: 'https://example.test/account',
                startStorageState: state,
              },
            ],
            exhausted: false,
            stopReason: 'completed',
            expectationResults: [],
          },
        },
      ],
    } as unknown as ExplorationBatch);

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { flows: Array<Record<string, unknown>> };
    assert.equal('startStorageState' in manifest.flows[0]!, false);
    assert.equal('startStorageStatePath' in manifest.flows[0]!, false);
    assert.doesNotMatch(readFileSync(manifestPath, 'utf8'), /secret-token/);
    assert.equal(existsSync(join(directory, 'storage-state')), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function routedPage(browser: import('playwright').Browser) {
  const context = await browser.newContext();
  await context.route('https://app.test/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>ok</h1>' });
  });
  const page = await context.newPage();
  await page.goto('https://app.test/');
  return page;
}

test('attachPopupDetection logs a tab the page opens itself via window.open', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await routedPage(browser);
    const { logger, verboseMessages } = spyLogger();
    attachPopupDetection(page, logger);

    await Promise.all([
      page.waitForEvent('popup'),
      page.evaluate(() => {
        window.open('https://app.test/oauth-consent', '_blank');
      }),
    ]);

    assert.equal(verboseMessages.length, 1);
    assert.match(verboseMessages[0]!, /new tab/i);
    assert.match(verboseMessages[0]!, /oauth-consent/);
  } finally {
    await browser.close();
  }
});

test('attachPopupDetection is idempotent — attaching twice does not double-log one popup', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await routedPage(browser);
    const { logger, verboseMessages } = spyLogger();

    // Simulates switchTab revisiting a page already instrumented on an earlier activePage switch.
    attachPopupDetection(page, logger);
    attachPopupDetection(page, logger);

    await Promise.all([
      page.waitForEvent('popup'),
      page.evaluate(() => {
        window.open('https://app.test/receipt', '_blank');
      }),
    ]);

    assert.equal(verboseMessages.length, 1);
  } finally {
    await browser.close();
  }
});

test('a popup the page opens itself is reachable via switchTab, not just logged', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route('https://app.test/**', async (route) => {
      const url = route.request().url();
      const body = url.includes('oauth-consent') ? '<h1>consent screen</h1>' : '<h1>ok</h1>';
      await route.fulfill({ status: 200, contentType: 'text/html', body });
    });
    const page = await context.newPage();
    await page.goto('https://app.test/');
    const { logger } = spyLogger();
    const tabRegistryHandle: TabRegistryHandle = { tabs: new Map([['tab-0', page]]) };
    attachPopupDetection(page, logger, tabRegistryHandle);

    await Promise.all([
      page.waitForEvent('popup'),
      page.evaluate(() => {
        window.open('https://app.test/oauth-consent', '_blank');
      }),
    ]);

    // Phase 1 (logging) already proved the event is observed; this proves it's actually usable —
    // the tab registry the agent's next switchTab call reads now contains the popup.
    assert.equal(tabRegistryHandle.tabs.size, 2);
    assert.ok(
      tabRegistryHandle.tabs.has('tab-1'),
      'the popup should get the next sequential tab id, same scheme as openTab',
    );

    const result = await executeToolCall(
      page,
      { id: '1', name: 'switchTab', input: { tabId: 'tab-1' } },
      tabRegistryHandle.tabs,
    );
    assert.match(result.snapshot, /consent screen/);
    assert.equal(result.activePage?.url(), 'https://app.test/oauth-consent');
  } finally {
    await browser.close();
  }
});

test('attachPopupDetection with a tab registry handle does not double-register one popup when attached twice', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await routedPage(browser);
    const { logger } = spyLogger();
    const tabRegistryHandle: TabRegistryHandle = { tabs: new Map([['tab-0', page]]) };

    // Simulates switchTab revisiting a page already instrumented on an earlier activePage switch.
    attachPopupDetection(page, logger, tabRegistryHandle);
    attachPopupDetection(page, logger, tabRegistryHandle);

    await Promise.all([
      page.waitForEvent('popup'),
      page.evaluate(() => {
        window.open('https://app.test/receipt', '_blank');
      }),
    ]);

    assert.equal(tabRegistryHandle.tabs.size, 2);
  } finally {
    await browser.close();
  }
});

test('attachPopupDetection does not fire for a page appwalk opens itself via context.newPage()', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const { logger, verboseMessages } = spyLogger();
    attachPopupDetection(page, logger);

    // openTab's own mechanism — a deliberate second page, not something the original page opened.
    await context.newPage();
    await page.waitForTimeout(50);

    assert.equal(verboseMessages.length, 0);
  } finally {
    await browser.close();
  }
});

function personaWithDevice(devicePreset?: string): Persona {
  return { name: 'Test persona', goal: '', intent: 'journey', verificationMode: 'completion', devicePreset };
}

test('deviceContextOptions returns nothing for a persona without a device preset', () => {
  assert.deepEqual(deviceContextOptions(undefined), {});
  assert.deepEqual(deviceContextOptions(personaWithDevice(undefined)), {});
});

test("deviceContextOptions returns the named device's fields, minus defaultBrowserType", () => {
  const options = deviceContextOptions(personaWithDevice('iPhone 17'));
  const { defaultBrowserType: _defaultBrowserType, ...expected } = devices['iPhone 17']!;
  assert.deepEqual(options, expected);
  assert.ok(
    !('defaultBrowserType' in options),
    'defaultBrowserType is not a valid newContext() option and must be dropped',
  );
});

test('deviceContextOptions throws a clear error for an unknown device name', () => {
  assert.throws(() => deviceContextOptions(personaWithDevice('Nokia 3310')), /Unknown device preset "Nokia 3310"/);
});

test('a context built from deviceContextOptions actually behaves like the named phone', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(deviceContextOptions(personaWithDevice('iPhone 17')));
    const page = await context.newPage();
    // A real navigation, not setContent() — Chromium only wires up the touch-input feature
    // detection (`'ontouchstart' in window`) through an actual page load.
    await page.goto('data:text/html,<h1>ok</h1>');

    const userAgent = await page.evaluate(() => navigator.userAgent);
    const hasTouch = await page.evaluate(() => 'ontouchstart' in window);
    const viewport = page.viewportSize();

    assert.match(userAgent, /iPhone/);
    assert.equal(hasTouch, true);
    assert.deepEqual(viewport, devices['iPhone 17']!.viewport);

    // The browser engine actually running stays whatever was launched (chromium, by default) —
    // a device preset changes viewport/UA/touch, not which engine drives the browser.
    assert.equal(browser.browserType().name(), 'chromium');
  } finally {
    await browser.close();
  }
});

test('attachCrashDetection records a real renderer crash as its own runtime-error kind', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const recorder = new EvidenceRecorder(context);
    attachCrashDetection(page, recorder);

    // chrome://crash is a real Chromium debug URL that deliberately crashes the renderer — the
    // standard way to test crash handling without depending on the target application ever crashing.
    await Promise.all([page.waitForEvent('crash'), page.goto('chrome://crash').catch(() => undefined)]);

    assert.equal(recorder.runtimeErrors.length, 1);
    assert.equal(recorder.runtimeErrors[0]?.kind, 'page_crash');
  } finally {
    await browser.close();
  }
});

test('attachCrashDetection is idempotent — attaching twice does not double-record one crash', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const recorder = new EvidenceRecorder(context);
    attachCrashDetection(page, recorder);
    attachCrashDetection(page, recorder);

    await Promise.all([page.waitForEvent('crash'), page.goto('chrome://crash').catch(() => undefined)]);

    assert.equal(recorder.runtimeErrors.length, 1);
  } finally {
    await browser.close();
  }
});

test('attachWebSocketCapture records real sent and received frames, invisible to HTTP-only capture', async () => {
  const { port, close } = await startEchoWebSocketServer();

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const recorder = new EvidenceRecorder(context);
    attachWebSocketCapture(page, recorder);
    // Same origin/port as the WebSocket target — Chromium's Private Network Access checks block a
    // ws://127.0.0.1 connection from an untrusted origin like about:blank.
    await page.goto(`http://127.0.0.1:${port}/`);

    await page.evaluate(
      (p) =>
        new Promise<void>((resolve, reject) => {
          const socket = new WebSocket(`ws://127.0.0.1:${p}/`);
          socket.onopen = () => socket.send('hello');
          socket.onmessage = () => {
            socket.close();
            resolve();
          };
          socket.onerror = () => reject(new Error('WebSocket connection failed'));
        }),
      port,
    );
    await page.waitForTimeout(50);

    const sent = recorder.webSocketFrames.find((frame) => frame.direction === 'sent');
    const received = recorder.webSocketFrames.find((frame) => frame.direction === 'received');
    assert.ok(sent, 'expected a sent frame to be recorded');
    assert.equal(sent!.payload, 'hello');
    assert.ok(received, 'expected a received frame to be recorded');
    assert.equal(received!.payload, 'echo:hello');
    // Confirms this traffic really is invisible to the HTTP-only side of the same recorder — the
    // only network entry is the one real HTTP page load, nothing WS-shaped alongside it.
    assert.equal(recorder.network.length, 1);
  } finally {
    await browser.close();
    await close();
  }
});

test('attachWebSocketCapture is idempotent — attaching twice does not double-record one frame', async () => {
  const { port, close } = await startEchoWebSocketServer();

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const recorder = new EvidenceRecorder(context);
    attachWebSocketCapture(page, recorder);
    attachWebSocketCapture(page, recorder);
    await page.goto(`http://127.0.0.1:${port}/`);

    await page.evaluate(
      (p) =>
        new Promise<void>((resolve, reject) => {
          const socket = new WebSocket(`ws://127.0.0.1:${p}/`);
          socket.onopen = () => socket.send('ping');
          socket.onmessage = () => {
            socket.close();
            resolve();
          };
          socket.onerror = () => reject(new Error('WebSocket connection failed'));
        }),
      port,
    );
    await page.waitForTimeout(50);

    assert.equal(recorder.webSocketFrames.filter((frame) => frame.direction === 'sent').length, 1);
  } finally {
    await browser.close();
    await close();
  }
});

test('startTracing/stopTracing produce a real, viewable trace archive', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'appwalk-trace-'));
  const logger = new Logger('quiet');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await startTracing(context, logger);
    await page.goto('data:text/html,<h1>trace me</h1>');
    const tracePath = join(directory, 'trace.zip');
    await stopTracing(context, tracePath, logger);

    const stats = statSync(tracePath);
    assert.ok(stats.size > 0, 'the trace file must not be empty');
    // A Playwright trace is a real zip archive (openable with `npx playwright show-trace`) —
    // confirm it starts with the zip local-file-header magic bytes, not just that a file exists.
    const header = readFileSync(tracePath).subarray(0, 4);
    assert.equal(header.toString('hex'), '504b0304');
  } finally {
    await browser.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('stopTracing tolerates a context that closed mid-run instead of crashing the run', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'appwalk-trace-'));
  const logger = new Logger('quiet');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await startTracing(context, logger);
    // Simulates reopenBrowser closing the whole browser (and with it, the context that was
    // tracing) before the run gets a chance to call stopTracing on it.
    await context.close();

    await assert.doesNotReject(stopTracing(context, join(directory, 'trace.zip'), logger));
  } finally {
    await browser.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('trace session follows reopenBrowser into a second trace segment', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'appwalk-trace-reopen-'));
  const logger = new Logger('quiet');
  const browser = await chromium.launch({ headless: true });
  let reopenedBrowser: Browser | undefined;
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('data:text/html,<h1>before restart</h1>');
    const traceSession = await createTraceSession(context, join(directory, 'flow.zip'), logger);
    const browserLifecycle = createBrowserLifecycle({
      browserEngine: 'chromium',
      preparePage: async (preparedPage) => traceSession.switchTo(preparedPage),
    });
    const result = await executeToolCall(
      page,
      { id: 'reopen', name: 'reopenBrowser', input: {} },
      undefined,
      undefined,
      traceSession,
      browserLifecycle,
    );
    reopenedBrowser = result.activePage?.context().browser() ?? undefined;
    await traceSession.finish();

    for (const tracePath of [join(directory, 'flow.zip'), join(directory, 'flow-part-2.zip')]) {
      const stats = statSync(tracePath);
      assert.ok(stats.size > 0, `trace segment must not be empty: ${tracePath}`);
      assert.equal(readFileSync(tracePath).subarray(0, 4).toString('hex'), '504b0304');
    }
  } finally {
    await reopenedBrowser?.close();
    await browser.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
