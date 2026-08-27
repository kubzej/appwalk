# Getting started

This guide takes a new user from a checkout of Appwalk to a generated Playwright test.

## 1. Install

```bash
git clone <repository-url>
cd appwalk
npm install
npx playwright install chromium
```

Appwalk currently runs from the repository with `tsx`:

```bash
npx tsx src/cli/index.ts <command> ...
```

## 2. Choose a provider

Set only the credential required by the provider you use. Hosted providers use different variable names; Ollama does not need a key:

```bash
# Set the key matching PROVIDER when using a hosted provider:
# OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, or XAI_API_KEY
```

Then provide both provider and model on the command line or in an explicitly passed config file. There is no implicit provider or model selection.

## 3. Run a first exploration

```bash
PROVIDER="your-provider"  # openai, anthropic, gemini, grok, or ollama
MODEL="your-model"
npx tsx src/cli/index.ts run https://your-app.example \
  --provider "$PROVIDER" \
  --model "$MODEL" \
  --persona mia \
  --max-steps 25
```

The action budget is per persona run. A run can discover several flows, but a flow is only generated after it passes replay verification. The default safety policy blocks state-changing HTTP methods.

If the application is public, omit `--email` and `--password`. If it has authentication, choose one of these approaches:

```bash
# Credential login, when the application has a normal username/password flow.
npx tsx src/cli/index.ts run https://your-app.example \
  --email "$APP_USERNAME" \
  --password "$APP_PASSWORD" \
  --provider "$PROVIDER" --model "$MODEL" --persona mia

# Reuse a browser storage state captured separately.
npx tsx src/cli/index.ts run https://your-app.example \
  --storage-state ./auth/storage-state.json \
  --provider "$PROVIDER" --model "$MODEL" --persona mia
```

Use `--storage-state` for SSO, MFA, CAPTCHA, or login flows that cannot be completed by a simple credential form.

## 4. Read the result

The CLI prints the execution directory, for example:

```text
appwalk-output/
  2026-08-27T09-42-18-291Z-8e2c4d91/
```

Open `report.html` first. It is the human-facing result. The same directory contains machine-readable JSON, raw evidence, the discovery manifest, and, when applicable, `discovered.spec.ts`.

## 5. Run generated tests

Generated tests use `@playwright/test` and are independent tests, one per confirmed flow. Run one generated spec with:

```bash
npx playwright test ./appwalk-output/<execution-id>/discovered.spec.ts
```

The generated file may include captured response fixtures and captured flow storage state. Treat it as source code: review it, place it in the appropriate test project, and decide how its credentials and environment should be supplied in CI.

## 6. Use a focused exploration

When you know the area you want to inspect, add a scope:

```bash
npx tsx src/cli/index.ts run https://your-app.example \
  --provider "$PROVIDER" --model "$MODEL" \
  --persona mia --max-steps 25 \
  --scope "Explore account settings and changing the notification preference" \
  --expect "The saved notification preference is visible after returning to the settings page"
```

An expectation describes a user-visible condition inside the scope. `--expect` requires `--scope`, and the flag can be repeated.

## First-run checklist

| Check | Why it matters |
| --- | --- |
| Use a disposable or staging target | Exploration can navigate widely, and `--allow-destructive` can permit mutations. |
| Set the provider and model explicitly | They are required configuration, not hidden defaults. |
| Start with 15-25 steps | This keeps the first run understandable and controls provider usage. |
| Leave destructive actions blocked initially | The default policy prevents common state changes. |
| Read `report.html` before generated code | A generated test is an output of confirmed evidence, not a guarantee that every discovered flow was stable. |
