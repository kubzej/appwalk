# Appwalk

Appwalk is an AI-powered CLI for turning browser exploration into verified Playwright regression tests.

It lets a tester describe how an application should be explored, observes the real interface and network traffic, verifies discovered journeys by replaying them in a clean browser session, and generates executable Playwright tests from the flows that survived verification.

## Why Appwalk

Writing end-to-end coverage usually starts with a tester already knowing the exact journey and locator details. Appwalk starts one level earlier: it discovers meaningful user journeys in an application and preserves the evidence needed to decide whether a journey is stable enough to become regression coverage.

The generated test is not based on an LLM description alone. A flow must be locally verified during exploration and then confirmed by deterministic replay before it is generated. When enabled, captured same-origin JSON responses can also be replayed as fixtures so dynamic data does not make the generated test depend on a changing backend response.

## How it works

```mermaid
flowchart LR
    A[Target application] --> B[Browser exploration]
    P[Persona, scope, expectations] --> B
    B --> C[Evidence log]
    C --> D[Replay in clean session]
    D --> E{Confirmed?}
    E -->|No| F[Report as unconfirmed or inconclusive]
    E -->|Yes| G[Optional response scenarios]
    G --> H[Playwright test suite]
    D --> I[HTML and JSON report]
```

The core terms are deliberately simple:

| Term                | Meaning                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| Persona             | The behavior and risk lens used by the agent during exploration.                                                |
| Scope               | A natural-language area or objective that guides exploration.                                                   |
| Expectation         | A user-visible condition that should hold within the scope. Multiple expectations can be attached to one scope. |
| Flow                | One meaningful sequence of browser actions with a terminal outcome.                                             |
| Replay confirmation | Deterministic re-execution of a discovered flow in a clean session.                                             |
| Response scenario   | A derived flow made by patching an observed JSON response and checking the resulting UI behavior.               |

## Quick start

Requirements: Node.js 24 or newer, a Playwright browser installation, and an API key for the selected hosted provider.

```bash
git clone <repository-url>
cd appwalk
npm install
npx playwright install chromium  # add firefox/webkit here too if you plan to pass --browser

PROVIDER="your-provider"  # openai, anthropic, gemini, grok, or ollama
MODEL="your-model"
npx tsx src/cli/index.ts run https://your-app.example \
  --provider "$PROVIDER" \
  --model "$MODEL" \
  --persona mia \
  --max-steps 25
```

For a hosted provider, set its provider-specific credential first: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, or `XAI_API_KEY`. Ollama uses a local server and does not require an API key. See [Commands and options](docs/commands.md#provider-credentials) for the complete table.

`run` performs exploration, replay verification, report generation, and Playwright test generation in one execution. Every execution gets its own timestamped directory under `./appwalk-output`.

For a reusable setup, pass a configuration file explicitly:

```bash
npx tsx src/cli/index.ts run --config ./appwalk.config.yaml
```

Appwalk does not auto-discover a config file. `--config` is always required when YAML configuration should be used. See [Configuration](docs/configuration.md).

## Commands

| Command                    | Use it when                                                             | Produces                                                                     |
| -------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `run <url>`                | You want the complete pipeline.                                         | HTML/JSON report, evidence, discovery bundle, and tests for confirmed flows. |
| `explore <url>`            | You want discovery and reporting without generating a test suite.       | HTML/JSON report, evidence, and discovery bundle.                            |
| `generate <discovery-dir>` | You already have a discovery bundle and want to generate tests from it. | A Playwright spec for replay-confirmed flows.                                |

Examples:

```bash
# Explore only; no generated spec is written.
PROVIDER="your-provider"
MODEL="your-model"
npx tsx src/cli/index.ts explore https://your-app.example \
  --provider "$PROVIDER" --model "$MODEL" --persona mia --max-steps 25

# Generate all replay-confirmed flows from a previous execution.
npx tsx src/cli/index.ts generate ./appwalk-output/<execution-id>

# Generate only selected confirmed flow IDs.
npx tsx src/cli/index.ts generate ./appwalk-output/<execution-id> --flows 1,3
```

Use `run` for exploration plus generation, and run the generated spec with Playwright when you want to execute the resulting regression tests.

## What to read next

- [Getting started](docs/getting-started.md) - first run, authentication, and running generated tests.
- [Commands and options](docs/commands.md) - complete CLI reference.
- [Configuration](docs/configuration.md) - explicit YAML configuration and multi-person coverage.
- [Personas and exploration](docs/personas.md) - persona intent, scope, expectations, and response scenarios.
- [Reports and artifacts](docs/reports.md) - output layout, flow results, evidence, and CI behavior.
- [Troubleshooting](docs/troubleshooting.md) - common failures and how to interpret them.
- [Architecture](docs/architecture.md) - implementation boundaries for contributors.

## Safety defaults

Appwalk blocks `POST`, `DELETE`, `PUT`, and `PATCH` requests by default during application exploration and replay. This protects the target from unintended mutations, but it also means mutation-heavy journeys may stop or appear incomplete.

Use `--allow-destructive` only against a disposable environment when the side effect is intentional. A safety configuration can add URL-based `allow` and `block` rules; see [Configuration](docs/configuration.md#safety).

## Supported providers

| Provider  | Credential          | Notes                                            |
| --------- | ------------------- | ------------------------------------------------ |
| OpenAI    | `OPENAI_API_KEY`    | Hosted provider.                                 |
| Anthropic | `ANTHROPIC_API_KEY` | Hosted provider.                                 |
| Gemini    | `GEMINI_API_KEY`    | Hosted provider.                                 |
| Grok      | `XAI_API_KEY`       | Hosted provider.                                 |
| Ollama    | None                | Uses a local server at `http://localhost:11434`. |

The provider and model are mandatory. Appwalk intentionally does not choose a hidden model default.

## Development

```bash
npm install
npm run typecheck
npm test
```

The test suite is local and does not call an LLM or external application. Generated tests are intentionally separate from Appwalk's own tests; they live inside an execution directory and target the application you explored.

Changes should preserve the CLI/config contract, keep sensitive values out of logs and committed files, and add focused tests for behavioral changes. See [Architecture](docs/architecture.md) for the module boundaries and [Reports and artifacts](docs/reports.md) for the output contract.

## Project status

Appwalk is an actively developed prototype. The public contract is the CLI behavior, generated artifacts, and report schema; provider capabilities and generated test quality should be validated against the target application before adopting the output as production coverage.
