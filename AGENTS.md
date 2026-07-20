# ccsm agent guide

## Update-source contract

- `config.updateSource` is exactly `npm` or `github`; the default is `npm`.
- Never silently fall back between update sources. A source-specific failure
  must be returned to `/api/version` or shown by the upgrade helper.
- `npm` checks with the user's global npm configuration and installs
  `@bakapiano/ccsm@<version>`.
- `github` checks the latest published GitHub Release and installs its exact
  `bakapiano-ccsm-<version>.tgz` asset. Dependencies still resolve through
  the user's npm configuration.
- The version check and install path must use the same selected source and
  exact version.

## Validation

- Run `node --check` for every changed JavaScript file and `git diff --check`.
- Run `npm pack --dry-run --json --ignore-scripts` before a release.
- For Settings or updater changes, run the dev backend on port 7788 with an
  isolated `CCSM_HOME`, then exercise source selection and `/api/version` in
  a browser. Do not reuse or mutate the production `~/.ccsm` data.
- When testing an upgrade, use an isolated `installPrefix` and `respawn:false`
  unless the user explicitly asks to replace the production install.

## Release process

Never release, publish, push, or create a tag without explicit user
permission. Releases are CI-driven; never run `npm publish` locally.

1. Confirm `main` matches `origin/main`, the worktree contains only intended
   changes, checks pass, and `CHANGELOG.md` describes the new version.
2. Commit the implementation, then run:

   ```powershell
   npm --prefix . version patch -m "v%s"
   git push origin main
   git push origin vX.Y.Z
   ```

3. Monitor all three pre-publish workflows:
   - `Deploy frontend to GitHub Pages`
   - `Draft GitHub Release on tag push`
   - `pages-build-deployment`

   The draft workflow must attach exactly these assets:
   - `bakapiano-ccsm-X.Y.Z.tgz`
   - `bakapiano-ccsm-X.Y.Z.tgz.sha256`

4. Verify both `https://bakapiano.github.io/ccsm/X.Y.Z/` and its
   `js/main.js` return HTTP 200. Inspect the draft assets before publishing.
5. Publish the draft with `gh release edit vX.Y.Z --draft=false`. This triggers
   `Publish to npm`, which downloads and publishes the same Release `.tgz`
   with provenance.
6. Monitor npm CI, confirm its log ends with `+ @bakapiano/ccsm@X.Y.Z`, verify
   the release is public, and confirm the local worktree is clean and synced.

See `CLAUDE.md` for expanded commands and recovery notes.
