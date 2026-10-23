# Contributing to Haul Download Manager

Thanks for helping! Bug reports, ideas, documentation fixes and code are all welcome.

## Reporting bugs

1. Check the [Troubleshooting](README.md#troubleshooting) table and the existing issues first.
2. Open a new issue using the **Bug report** template. Include:
   - the Haul version (bottom of the Settings panel) and your Windows version (`winver`);
   - whether you use the installer or the portable build;
   - exact steps to reproduce, and what you expected instead;
   - relevant lines from `%APPDATA%\Haul Download Manager\logs\haul.log`.
3. The log already hides URL query strings and passwords, but **review it before posting** and remove anything private (for example internal host names). Never post links that contain access tokens.

Security vulnerabilities should **not** be reported as public issues; see [SECURITY.md](SECURITY.md).

## Suggesting features

Open an issue with the **Feature request** template and describe the problem you want solved. Small, focused proposals are easiest to accept.

## Development setup

You need Windows 10/11 x64, Node.js 22.13+ and Git.

```powershell
npm ci
npm start          # build and run the app
npm test           # unit + integration tests (offline, local test server)
npm run typecheck
npm run e2e        # drive the real app through its UI
```

See [Building from source](README.md#building-from-source) for all commands and the project layout.

## Pull requests

- Keep changes focused; one topic per pull request.
- Match the existing style: TypeScript strict mode, small modules, no new runtime dependencies without discussion.
- The download engine (`src/main/engine/`) must stay free of Electron imports so it can be tested under plain Node.
- Add or update tests for behaviour changes. Engine changes should come with a test against the controllable server in `tests/helpers/testServer.ts`.
- Run `npm run typecheck`, `npm test` and, for UI changes, `npm run e2e` before submitting. CI runs the same checks plus a packaged build.
- For changes to the transfer, resume or recovery code, also run the randomised soak (PowerShell: `$env:HAUL_CHAOS_SEEDS=30; npm test`) and, if you can spare ~400 MB of bandwidth, `node scripts/live-test.mjs --exe <packaged exe>` against real servers. For changes to the browser extension or the native messaging host, run `node scripts/browser-capture-test.mjs --exe <packaged exe>` (drives a real Microsoft Edge with the extension loaded).
- Never log full URLs: use `redactUrl()` / `redactText()` from `src/main/engine/urls.ts`.
- If you add a dependency that ships inside the app, add it to `SHIPPED` in `scripts/licenses.mjs` and make sure its license is compatible with MIT.

## Ground rules

- Do not contribute code, assets or text copied from proprietary download managers or other software you do not have the right to share.
- Do not add features that bypass authentication, paywalls, DRM, or rate limits.
- Be respectful. Harassment of any kind is not tolerated.

By contributing, you agree that your contributions are licensed under the MIT License.
