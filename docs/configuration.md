# Configuration

Appwalk supports one explicit YAML configuration source. Pass it with `--config`; a file named `appwalk.config.yaml` in the working directory is not loaded automatically.

CLI values take precedence over values from YAML. The merged result is validated once, so invalid values are rejected regardless of whether they came from the command line or the config file. `provider` and `model` are mandatory after merging.

## Minimal config

```yaml
version: 1
url: https://your-app.example
provider: ${PROVIDER}
model: ${MODEL}
```

Run it explicitly:

```bash
export PROVIDER="your-provider"
export MODEL="your-model"
# For hosted providers, also set the provider-specific API key.
npx tsx src/cli/index.ts run --config ./appwalk.config.yaml
```

`output` is optional. When omitted, Appwalk writes executions below `./appwalk-output`.

## Complete example

```yaml
version: 1

url: https://your-app.example
output: ./appwalk-output
provider: ${PROVIDER}
model: ${MODEL}
maxSteps: 25
# Explore coverage.runs personas at once instead of one after another. Defaults to 1.
# maxConcurrentPersonas: 2
screenshots: true

scope: Explore the authenticated shopping and order history experience.
expect:
  - The cart shows the selected item before checkout.
  - A completed order appears in order history.

responses:
  maxVariants: 0
  maxFixtureBytes: 200000

auth:
  email: ${APP_USERNAME}
  password: ${APP_PASSWORD}
  # Use storageState instead of email/password for SSO, MFA, or CAPTCHA.
  # storageState: ./auth/storage-state.json

safety:
  allowDestructive: false
  blockMethods: [POST, DELETE, PUT, PATCH]
  # Optional JSON file with URL rules.
  # config: ./safety.json

coverage:
  runs:
    - name: Mobile baseline
      persona: mia
      maxSteps: 25
      scope: Explore the main mobile shopping journeys.
      expect:
        - Primary actions remain reachable at a phone viewport.
    - name: Returning customer
      persona: rosa
      maxSteps: 18
      scope: Explore retained account history and repeat actions.
```

## Fields

| YAML path                   | Type                 | Required                     | Meaning                                                                                                                               |
| --------------------------- | -------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                   | `1`                  | Yes                          | Config schema version.                                                                                                                |
| `url`                       | string               | Yes unless passed as CLI URL | Application URL.                                                                                                                      |
| `output`                    | string               | No                           | Output root. Defaults to `./appwalk-output`.                                                                                          |
| `provider`                  | enum                 | Yes                          | `openai`, `anthropic`, `gemini`, `grok`, or `ollama`.                                                                                 |
| `model`                     | string               | Yes                          | Model name understood by the selected provider.                                                                                       |
| `browser`                   | enum                 | No                           | `chromium`, `firefox`, or `webkit`. Defaults to `chromium`.                                                                           |
| `persona`                   | string               | No                           | Built-in persona for a single run. Use `coverage.runs` for multiple independent personas.                                             |
| `maxSteps`                  | positive integer     | No                           | Default action budget per run is 25.                                                                                                  |
| `maxConcurrentPersonas`     | positive integer     | No                           | How many `coverage.runs` personas explore at once. Defaults to `1` (sequential). See [Multi-person coverage](#multi-person-coverage). |
| `screenshots`               | boolean              | No                           | Include screenshots in provider turns where supported.                                                                                |
| `trace`                     | boolean              | No                           | Save a Playwright trace (`.zip`) for exploration and each replayed flow.                                                              |
| `scope`                     | string               | No                           | Global exploration objective.                                                                                                         |
| `expect`                    | string list          | No                           | Global expectations. Requires a global or run scope.                                                                                  |
| `responses.maxVariants`     | non-negative integer | No                           | Maximum derived response scenarios per confirmed flow.                                                                                |
| `responses.maxFixtureBytes` | non-negative integer | No                           | Maximum captured response body size.                                                                                                  |
| `auth.email`                | string               | No                           | Credential-login username/email.                                                                                                      |
| `auth.password`             | string               | No                           | Credential-login password. Prefer `${ENV_VAR}`.                                                                                       |
| `auth.storageState`         | string               | No                           | Path to Playwright storage state.                                                                                                     |
| `safety.allowDestructive`   | boolean              | No                           | If true, disables the default method block.                                                                                           |
| `safety.blockMethods`       | string list          | No                           | Methods blocked by the browser guard.                                                                                                 |
| `safety.config`             | string               | No                           | Path to URL-based safety rules JSON.                                                                                                  |
| `coverage.runs`             | run list             | No                           | Independent persona runs. Every run needs a `name`; `persona`, `maxSteps`, `scope`, and `expect` override global values for that run. |

## Environment variables

`${NAME}` is expanded in YAML string values. An unset variable is an error; secrets should not be committed to the config file.

```yaml
auth:
  email: ${APP_USERNAME}
  password: ${APP_PASSWORD}
```

## Multi-person coverage

Coverage runs execute sequentially by default; set `maxConcurrentPersonas` above 1 (or pass `--max-concurrent-personas`) to run that many at once instead. Each run gets a fresh browser session and its own LLM conversation regardless of concurrency; one persona's context is never sent to another. The output is aggregated into one execution report and one discovery bundle, while each run remains identifiable by its run ID and persona.

The action budget is per run. For three runs with `maxSteps` values of 18, 17, and 15, the total possible browser actions are 50. Provider requests still depend on how many decisions each run needs and how much context the selected provider resends or caches.

Running personas concurrently does not raise the account's real provider rate limit — that limit is tied to the API key/project, not to Appwalk's process or how many personas run at once. What concurrency buys instead is overlap: while one persona's browser is navigating or waiting for an element, another persona's LLM request can be in flight, so the same request/token budget gets used with fewer idle gaps. A shared rate-limit ledger (in-process) reserves budget before each provider request and blocks a concurrent request that would exceed it, so turning `maxConcurrentPersonas` up changes how much local CPU/memory (one Chromium instance per concurrent persona) you spend, not how much provider quota is available. Start low (2-3) and watch for rate-limit waits in `--verbose`/`--debug` output before going higher.

## Safety

The optional safety JSON file has this shape:

```json
{
  "allow": ["https://your-app.example/api/health"],
  "block": ["https://your-app.example/api/admin/**"]
}
```

URL `allow` rules take precedence over URL `block` rules and method blocking. The default method block remains active unless `allowDestructive` is set to `true`; setting `blockMethods` changes the method list but does not make other methods destructive automatically.

Keep the safety policy global to the execution. Do not loosen it in only one persona run unless that is an intentional, reviewed test setup.
