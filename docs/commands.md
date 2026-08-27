# Commands and options

Appwalk exposes three commands. The command parser accepts the long forms shown below and the short aliases where noted.

## `run`

```text
appwalk run <url> [options]
```

Runs exploration, replay verification, optional response-scenario exploration, reporting, and test generation. Only replay-confirmed flows become tests.

## `explore`

```text
appwalk explore <url> [options]
```

Runs discovery, evidence collection, and replay verification. It writes the same report and discovery artifacts as `run`, but does not generate `discovered.spec.ts`.

## `generate`

```text
appwalk generate <discovery-dir> [--flows 1,3] [-o output] [auth options]
```

Reads `discovery.json` and `evidence.jsonl` from a previous execution. Without `--flows`, it selects only flows whose replay was confirmed. Explicitly selecting an unconfirmed flow is rejected.

If the discovery used login, generation needs either the captured flow storage state, `--storage-state`, or fresh `--email` and `--password` credentials. Generation itself does not call an LLM.

## Exploration intent

`--scope` focuses exploration on an area or objective. `--expect` adds one or more user-visible conditions within that scope and requires `--scope`. See [Personas and exploration](personas.md) and [Configuration](configuration.md) for details.

## Shared options

Requirements below are evaluated after command-line values and the explicitly passed YAML config are merged. A value can therefore be supplied in either place, and a CLI value overrides the config value. `generate` reads an existing discovery bundle and does not need a provider or model.

| Option | Applies to | Required when | Description |
| --- | --- | --- | --- |
| `-e, --email <value>` | `run`, `explore`, `generate` | Never; use with `--password` for credential login | Username or email for a normal credential login. |
| `-p, --password <value>` | `run`, `explore`, `generate` | Never; use with `--email` for credential login | Password for a normal credential login. Keep it in an environment variable. |
| `-o, --output <dir>` | All | Never | Output root. Defaults to `./appwalk-output`. |
| `-n, --max-steps <number>` | `run`, `explore` | Never | Maximum browser actions per persona run. Defaults to `25`; must be a positive integer. |
| `-m, --model <name>` | `run`, `explore` | Always for exploration | Provider model. Supply it via CLI or config. |
| `--provider <name>` | `run`, `explore` | Always for exploration | `anthropic`, `gemini`, `ollama`, `grok`, or `openai`. Supply it via CLI or config. |
| `--storage-state <path>` | All | Only when using a pre-authenticated session or generating without fresh credentials | Playwright storage state to preload or use for generated tests. |
| `--persona <name>` | `run`, `explore` | Never | Built-in exploration persona. See [Personas](personas.md). |
| `--scope <text>` | `run`, `explore` | Never | Natural-language area or objective for the exploration. It can be used independently to focus discovery. |
| `--expect <text>` | `run`, `explore` | Only with `--scope` | User-visible acceptance criterion. Repeatable. |
| `--screenshots` | `run`, `explore` | Never | Captures a screenshot after actions for providers/models with vision support. |
| `--config <path>` | `run`, `explore` | Only when using YAML configuration | Explicit YAML config. Config files are not auto-discovered. |
| `--flows <ids>` | `generate` | Never | Comma-separated flow IDs, for example `1,3`. Selected flows must be replay-confirmed. |
| `--response-variant-max <number>` | `run`, `explore` | Never | Enables up to this many LLM-proposed response scenarios per confirmed base flow. `0` disables them. |
| `--response-fixture-max-bytes <number>` | `run`, `explore` | Never | Skips captured JSON response bodies larger than this byte limit. |
| `--allow-destructive` | `run`, `explore` | Never | Disables the default method block. Use only on a disposable target. |
| `--block-methods <list>` | `run`, `explore` | Never | Replaces the default blocked method list with a comma-separated list. |
| `--safety-config <path>` | `run`, `explore` | Never | JSON URL allow/block rules. See [Configuration](configuration.md#safety). |

The application URL is positional for `run` and `explore`, unless it is provided as `url` in `--config`. For `generate`, the positional argument is the path to a previous discovery directory or `discovery.json` file.

## Output verbosity

These switches control console presentation, not the evidence captured in the output directory:

| Level | Intended reader | What appears |
| --- | --- | --- |
| `--quiet` | Automation or a user who needs only the result | Final results and errors. |
| default | End user/tester | Major lifecycle stages, completed flows, warnings, and artifact paths. |
| `--verbose` | Tester investigating a run | Detailed action progress, safety events, and scenario summaries. |
| `--debug` | Developer | Verbose output plus structured provider, browser, replay, and execution diagnostics. Sensitive values are redacted. |

`--verbose` and `--debug` are CLI-only operational controls. They are intentionally not part of the YAML coverage model.

## Provider credentials

| Provider | Environment variable | Local endpoint |
| --- | --- | --- |
| `openai` | `OPENAI_API_KEY` | Hosted API |
| `anthropic` | `ANTHROPIC_API_KEY` | Hosted API |
| `gemini` | `GEMINI_API_KEY` | Hosted API |
| `grok` | `XAI_API_KEY` | Hosted API |
| `ollama` | None | `http://localhost:11434` |

The selected hosted provider key must be present before the browser run starts. Ollama does not require a key, but the local service and selected model must be available.
