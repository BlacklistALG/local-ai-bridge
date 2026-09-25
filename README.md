# Local AI Bridge

A shareable Agent Skill with a bundled Windows bridge for coordinating **Codex and Claude Code using your own subscriptions**. Your chosen assistant coordinates; separate workers complete scoped tasks, review each other's changes, and optionally mirror progress to your own Notion board.

**Status: Windows reference release, v0.1.0.** Local orchestration; online models. No paid model API fallback. Not affiliated with OpenAI, Anthropic, xAI, or Notion.

## What you get

- Separate worker sessions and folders, with one worker per provider and two in total by default.
- A durable task queue with dependencies, duplicate-request protection, and review before acceptance.
- Isolated Git worktrees, scoped edits, registered tests, independent exact-patch review, and local integration.
- Optional Notion OAuth and a background watcher for your own board.
- Configurable model IDs, roles, executable paths, projects, and board IDs.

## Start here

Install this entire folder as a local skill in a host with command and file access on your Windows PC. Then ask:

> Use $local-ai-bridge to set up Codex and Claude teamwork using my existing subscriptions. Keep Notion optional and start with read-only tasks.

Or follow [setup instructions](references/setup.md) and run:

```powershell
node scripts/setup.mjs --destination 'D:\AI-Workspace\my-bridge'
```

Use a **new private folder outside this skill**. Setup creates blank model/executable settings and disables Notion and editing until configured. It never copies the author's accounts, creates a paid account, invokes a model, or starts a service. No npm install is needed.

Requirements: Windows, Node.js 22+, native Codex and Claude Code CLIs with eligible subscription sign-ins. Git for Windows is required for editing. Included-usage limits still apply, and account billing settings must be checked by the owner. CLI features and model availability vary; setup must verify the actual installation.

Read [workflow](references/workflow.md), [Notion setup](references/notion.md), or [troubleshooting](references/troubleshooting.md) as needed. A skill cannot grant a cloud chat access to your PC or silently join desktop conversations.

## Sharing

Publish **this clean skill folder or its release ZIP**, never an active private bridge installation. The latter contains configuration, queue history, project work, and possibly credentials. The release excludes those records and contains no working Notion board IDs or model/account defaults. Its source is under the [MIT license](LICENSE).

A GitHub repository plus versioned ZIP releases is the suggested starting distribution. Keep one source tree, tagged versions, validation notes, and reproducible tests. A host-specific plugin wrapper or marketplace submission can follow once installation feedback is available; this package does not claim marketplace approval.

Before redistributing a modified copy, run the [release checker](scripts/check-release.mjs) and tests:

```powershell
node scripts/check-release.mjs
node --test scripts/setup.test.mjs scripts/bridge/tests/*.test.mjs
```

## Validation and limits

The originating private installation completed live Codex-to-Claude and Claude-to-Codex edit/review/integration pilots, plus automatic Notion card creation and status propagation. This public derivative replaces fixed board identity with user configuration and adds isolated setup. Automated results and package checks are recorded in [VALIDATION.md](VALIDATION.md). A new user's live account, model availability, and Notion board must still be tested; the author's successful connection is not inherited.

The coordinating assistant decides follow-up work and assesses reviews. No automatic planner loop, push, deployment, shared chat memory, or unsolicited Grok callback is included. The watcher requires an awake, online PC; no Windows startup service is installed. macOS/Linux and desktop-only hosts without local CLI access are outside this release's supported setup.

Format references: [Agent Skills specification](https://agentskills.io/specification), [OpenAI skills](https://developers.openai.com/plugins/build/skills), [Claude Code skills](https://code.claude.com/docs/en/skills).
