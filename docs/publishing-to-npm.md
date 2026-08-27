# Publishing Appwalk to npm

Goal: `npx appwalk explore <url> ...` works for anyone, without cloning the repo.

Appwalk is a CLI tool, not an importable library — every step below optimizes for that. Nothing here is done yet; this is the checklist to work through, in order, before running `npm publish`.

## 0. Current state (baseline)

- `package.json` has `"private": true` — blocks `npm publish` outright until removed.
- No `bin` field — nothing tells npm what command to install.
- No `main`/`exports` — nothing defines what a `require`/`import` of the package resolves to.
- No build step — `npm run cli` runs `tsx src/cli/index.ts` directly against TypeScript source; nothing compiles to `dist/`.
- No `LICENSE` file, no `license` field in `package.json`.
- No `README.md` — npmjs.com renders this as the package's page. Right now the package page would be blank.
- `tsconfig.json` already has `"outDir": "dist"` and `dist/` is already in `.gitignore` — the build target is half set up, just not wired to a script.
- `engines.node` is `">=24"` — worth reconsidering before a public release (see step 7).

## 1. Decide the distribution shape

Ship compiled JavaScript in `dist/`, not raw TypeScript. Two options exist; use the first:

- **Compile with `tsc`, ship `dist/`.** Standard practice, no runtime dependency on `tsx` for consumers, faster startup, smaller install. Recommended.
- **Ship `.ts` directly, require `tsx` as a dependency.** Works, but is non-standard, adds `tsx` to every consumer's install, and is slower to start. Only worth it if compiling turns out to be painful (it shouldn't — the codebase already has no `any`-laden escape hatches and `tsc --noEmit` passes clean).

Everything below assumes the `tsc` route.

## 2. Add a build script and produce `dist/`

```json
"scripts": {
  "build": "tsc -p tsconfig.build.json",
  "prepublishOnly": "npm run build && npm test"
}
```

`tsc --noEmit` (the existing `typecheck` script) intentionally emits nothing — don't repurpose it. Add a **separate** build config instead of changing the shared one, so the emitting config doesn't leak into normal type-checking flows or make CI's `noEmit` check accidentally emit files:

```json
// tsconfig.build.json
{
  "extends": "./tsconfig.json",
  "exclude": ["tests/**/*", "src/**/*.test.ts"]
}
```

Tests should never end up in the published package or in `dist/` — this `exclude` keeps them out at the source.

Run it and sanity-check the output:

```bash
npm run build
node dist/cli/index.js explore --help   # should print usage, not throw
```

Watch for two things specific to this codebase:
- Every relative import already uses explicit `.js` extensions (`from "../report/contract.js"`) — required by `moduleResolution: "NodeNext"` and already followed throughout `src/`, so this should compile without import-path surprises.
- `#!/usr/bin/env node` is already the first line of `src/cli/index.ts` — confirm it survives into `dist/cli/index.js` after compiling (`tsc` preserves it, but verify once).

## 3. Wire up `package.json` for a CLI package

```json
{
  "name": "appwalk",
  "version": "0.1.0",
  "private": false,
  "type": "module",
  "license": "MIT",
  "bin": {
    "appwalk": "./dist/cli/index.js"
  },
  "files": [
    "dist",
    "test-fixtures"
  ],
  "engines": {
    "node": ">=20"
  }
}
```

Notes on each field:
- **`private: false`** — removing the line entirely also works; `npm publish` only refuses when the key is present and `true`.
- **`bin`** — this is what makes `npx appwalk ...` and a global `npm i -g appwalk` resolve to a command. The key (`appwalk`) is the command name; make sure `dist/cli/index.js` is executable in the published tarball (npm sets the executable bit automatically from `bin` entries — no manual `chmod` needed).
- **`files`** — an *allowlist*, not a blocklist: only what's listed here (plus a few files npm always includes — `package.json`, `README.md`, `LICENSE`) ends up in the published tarball. Without it, npm falls back to `.gitignore`-based exclusion, which is looser than you want for a public package. `test-fixtures/` needs to ship because `uma`'s persona goal text references those paths at runtime (`test-fixtures/uma/wrong-type.txt` etc.) — anyone running that persona needs the files physically present after install.
- **`engines.node`** — `>=24` is very new (most CI runners and a lot of installed dev environments aren't there yet). Confirm what's actually load-bearing before publishing — if the code doesn't rely on a Node 24-only API, loosen this to whatever the real floor is (`>=20` is a safe assumption given `NodeNext`/ESM usage) so `npm install -g appwalk` doesn't fail for a large chunk of potential users on install.

## 4. Handle the Playwright browser download

`playwright` (the library) is a normal dependency; the actual browser binaries are a separate, large download (`npx playwright install chromium`) that doesn't happen automatically just from `npm install`.

Two ways to handle this — pick one and document it clearly, don't leave it implicit:

- **Postinstall script** (zero extra step for the user, but adds real time/bandwidth to every `npm install`, and can fail installs in sandboxed/offline CI environments):
  ```json
  "scripts": {
    "postinstall": "playwright install chromium"
  }
  ```
- **Explicit manual step**, documented in the README's Quick Start (no install-time surprise, but an easy step to forget):
  ```bash
  npx playwright install chromium
  ```

Given this is a CLI tool people run interactively (not a library embedded in someone else's build), a documented manual step is the safer default — it keeps `npm install -g appwalk` fast and avoids surprising anyone running it inside CI/Docker where a browser download mid-install can break the build.

## 5. Pick a license and add the file

No `LICENSE` file exists yet. MIT is the conventional default for a CLI tool like this (permissive, no obligations on downstream users) unless there's a specific reason to choose otherwise. Add:

```
LICENSE          (the actual license text)
```

and the matching `"license": "MIT"` field from step 3. npm's publish step will warn (not block) if these are missing or inconsistent — fix it before publishing, not after, since re-licensing a package that's already out is a real headache for anyone who already depends on it.

## 6. Write `README.md`

This is the single biggest content gap and the first thing anyone sees on the npm page. At minimum, cover, in this order:

1. **One-paragraph pitch** — what Appwalk does, in plain terms (a persona-driven AI agent explores your web app, verifies what it finds by replaying it deterministically, and generates a Playwright regression suite from what actually reproduced).
2. **Requirements** — Node version, an API key for one of the five supported providers (`ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `XAI_API_KEY` / `OPENAI_API_KEY`, or a local Ollama server — no key needed there), and the Playwright browser install step from §4.
3. **Quick start** — the shortest possible working command, e.g.:
   ```bash
   npx appwalk run https://your-app.example.com --provider anthropic --model claude-... 
   ```
4. **Cost/safety disclaimer** — explicit and upfront, not buried:
   - LLM API calls cost money; the user's own key, the user's own bill.
   - The agent will click through and submit real forms on whatever URL it's pointed at. Default safety settings block `POST`/`PUT`/`PATCH`/`DELETE` requests, but that's a floor, not a guarantee — recommend running against a staging/test environment, not production, unless the user has read `--allow-destructive`/`--block-methods`/`--safety-config` and made a deliberate choice.
5. **Full flag reference** — the CLI already generates this via `printUsage()`; either link to it (`appwalk --help`) or keep a copy in the README in sync with it manually (pick one — a copy that drifts out of sync is worse than a link).
6. **Config file format** (`--config`) — the YAML shape `config.ts` validates, with one worked example (`url`, provider, model, `coverage.runs`, `scope`/`expect`).
7. **Personas table** — name, one-line description, adversarial vs. workflow. There are 21 of these in `agent/personas.ts`; a table is much more scannable than prose here.
8. **Output layout** — what `report.html`/`report.json`/`discovery.json`/`evidence.jsonl`/`discovered.spec.ts` each are, since a fresh user will see five files land in `appwalk-output/<execution-id>/` and won't know which one to open first (answer: `report.html`).
9. **Contributing / license footer.**

## 7. Reduce `engines.node` if it's not actually required

Confirm nothing in `src/` genuinely needs a Node 24-only API (skim for anything from the last couple of Node major releases — new `util`/`fs` methods, etc.). If nothing does, drop the floor to whatever the real minimum is. A stricter-than-necessary `engines` field is a common, avoidable reason for `npm install -g appwalk` to just fail for someone with an otherwise-fine, slightly older Node.

## 8. Dry-run before the real publish

```bash
npm run build
npm pack --dry-run        # lists exactly what would ship — check test-fixtures/, dist/ are there, .env/tests/appwalk-output/ are NOT
npm pack                  # actually produces appwalk-0.1.0.tgz locally
cd /tmp && mkdir smoke-test && cd smoke-test
npm init -y
npm install /path/to/appwalk-0.1.0.tgz
npx appwalk --help    # confirm the bin actually resolves and runs from a real install, not from the source tree
```

This catches the two most common first-publish mistakes: a `files` list that's missing something the CLI needs at runtime (like `test-fixtures/`), and a `bin` path that's correct in the repo but wrong once files move into `dist/`.

## 9. Publish

```bash
npm login                 # once, if not already
npm version 0.1.0         # or patch/minor, tags a git commit too
npm publish               # add --access public if the package name is scoped (@you/appwalk)
```

`prepublishOnly` (from step 2) runs the build and test suite automatically as part of this — a broken build or failing test blocks the publish rather than shipping a broken package.

## 10. Ongoing maintenance, once it's out

- **Semver discipline.** Once real users depend on the CLI flags/config shape, treat a breaking flag rename or config format change as a major version bump, not a patch.
- **A `CHANGELOG.md`** — doesn't need to be elaborate, but "what changed between versions" matters more once people aren't tracking the repo directly.
- **npm provenance**, if publishing from GitHub Actions (`npm publish --provenance`) — adds a verifiable link back to the exact commit/workflow that produced the package, which is increasingly expected for CLI tools that execute with real permissions (this one launches a real browser and calls out to paid APIs — provenance is a reasonable trust signal to offer, not a hard requirement).
- **A GitHub Actions release workflow** that runs `npm run build && npm test` on every tag push before publishing, so a publish is never a manual, un-verified `npm publish` from a laptop with uncommitted changes sitting around.

## Pre-publish checklist

- [ ] `private: false` (or the key removed)
- [ ] `bin` field points at the compiled entry point
- [ ] `files` allowlist includes `dist/` and `test-fixtures/`, excludes everything else
- [ ] `npm run build` produces working `dist/cli/index.js` with the shebang intact
- [ ] `LICENSE` file present, matches `license` field
- [ ] `README.md` covers pitch, requirements, quick start, safety disclaimer, flags, config format, personas, output layout
- [ ] Playwright browser install step documented (or added as `postinstall`, deliberately)
- [ ] `engines.node` reflects the real minimum, not just "whatever I happened to be running"
- [ ] `npm pack --dry-run` output reviewed by hand
- [ ] `npm pack` + local `npm install` smoke test passes
- [ ] `npm test` passes (`agent-loop`, `config`, `logger`, `response-variants` at minimum)
