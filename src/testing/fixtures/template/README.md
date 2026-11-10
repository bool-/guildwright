# Fixture template (src/testing/fixtures/template)

The contract `src/cli/template.ts` reads, at its smallest: a tree `init` writes, and a
`MANIFEST.json` listing the gated files (`.github/**`, `AGENTS.md`) with their sha256. PR 1.5
builds the real `template/` to the same shape. The real template's `package.json` also lists
the engine at its exact version; this one leaves it out and depends on `vendor/local-dep`
instead, so `npm install --package-lock-only` and `npm ci` resolve it with no registry.
