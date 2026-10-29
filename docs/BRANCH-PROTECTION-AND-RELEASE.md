# GitHub branch protection and CI for Amayurena

## Protection of main (repository owner action required)

The GitHub connector cannot change repository branch rules. An owner or administrator should open
**Settings → Rules → Rulesets → New branch ruleset** in `Aspksa/Amayurena`.

Set:
- Target branch: `main`; enforcement: **Active**.
- Require a pull request before merging. Block force pushes and deletions.
- Require status checks to pass, and require branches to be up to date.
- Required status check: `agent-catalog` (the stable job id of Fast checks).
- Do not allow bypasses for routine feature work. Use administrator emergency bypass only if documented.
- Optional review requirement: one approving review, if a separate reviewer is available; otherwise use PR plus required checks.
- Prefer squash merging and delete branches after merging.

**Do not mark browser-smoke or windows-portable as globally mandatory.**
The full QA workflow has PR path filters and deliberately does not run on every documentation-only change.
For major changes touching UI/server/scripts it runs automatically; it can also run via
**Actions → Full QA (browser and Windows) → Run workflow**. Release publishing always invokes
both Full QA jobs and cannot publish unless they succeed.

## Release workflow (manual first release)

The first release must be intentionally triggered by a maintainer. Once the changes to
`scripts/release-bundle.cjs`, `.github/workflows/full-qa.yml` and
`.github/workflows/publish-release.yml` have been merged into `main`:

1. Confirm `project-version.json` contains the desired stable version (currently 0.18.0).
2. Open **Actions → Publish verified portable release → Run workflow** on `main` and supply `v0.18.0`
   (or the updated version from the manifest).
3. The workflow verifies it is releasing the exact latest `main` commit and checks the tag matches
   the manifest. It runs headless Chromium and Windows smoke tests, the Node suite, and only then
   builds a ZIP. It verifies each archive entry against the source, then publishes the ZIP and
   SHA-256 sidecar in an official GitHub Release.
4. Verify the GitHub Release asset includes a GitHub-generated `sha256:` digest. If GitHub does not
   expose this digest, the client updater intentionally refuses installation. Do not bypass the check.
5. Test upgrading from an older portable release on a disposable copy of the application folder,
   including failure recovery and restart. Never run the first upgrade test against irreplaceable user data.

**Known limit:** automated Windows smoke verifies a portable launch, localhost, and saved knowledge
inside a path containing Cyrillic, spaces and ampersands. It does not replace a manual Windows GUI
test of real update, shutdown, Windows Defender, permissions, and rollback after a failed launch.
Neither the first official Release nor the remote branch rules are created automatically by this file.

## Existing fast CI

`Fast checks / agent-catalog` runs on every pull request and every push to `main`.
It checks all root JavaScript, all Node tests, and the full Node regression suite on Node 22.
Keep this check fast and required. Use Full QA for substantial UI, launch, or update changes.
