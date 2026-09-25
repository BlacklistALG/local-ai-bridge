---
name: local-ai-bridge
description: Set up and coordinate a local Windows task bridge between subscription-authenticated Codex and Claude Code, with isolated project edits, independent review, and optional Notion progress updates. Use for cross-provider AI teamwork or installing this bridge, not ordinary single-assistant coding.
license: MIT
metadata:
  version: "0.1.0"
---

# Local AI Bridge

Requires Windows, Node.js 22+, native Codex and Claude Code CLIs, eligible subscriptions, and local command/file access. Git is needed for editing; Notion is optional.

Coordinate separate worker sessions through the bundled deterministic queue. The user chooses their contact assistant and role names; do not import the original author's models, accounts, or board. Local refers to coordination and files: the models still run through their online providers.

## Choose the operation

- **New setup:** read [setup](references/setup.md). Run `scripts/setup.mjs` to create a separate private installation. Never use the shareable skill folder as the active queue. Reuse an existing installation when the user already has one; do not create a competing bridge or overwrite its configuration.
- **Coordinate work:** read [workflow](references/workflow.md), inspect that installation's configuration and current queue, then dispatch only the scoped work the user requested.
- **Connect Notion:** read [Notion setup](references/notion.md). It is optional. Each installation needs its own board IDs and authorized OAuth grant. The grant may cover everything the account can access; the implementation limits card operations to the configured data source.
- **Diagnose or recover:** read [troubleshooting](references/troubleshooting.md). Stop at an authentication, quota, uncertain termination, or stale integration boundary instead of weakening safeguards.

## Operating contract

1. Check local execution availability, native CLI versions, subscription sign-in, exact available model IDs, and the user's included-usage settings. Do not interpret installing this skill as authorization to spend money or run a model. Keep paid model API fallback, purchases, extra usage, and automatic quota resets disabled. The software cannot override provider account billing settings.
2. Start with one Codex and one Claude read-only task in separate folders, at most two workers total. Live probes consume included allowance and require a task request or setup authorization. If a provider is unavailable, report the blocker; do not fabricate a working connection or change the requested model.
3. Use stable request keys for retries and local queue IDs for dependencies and board cards. Worker completion enters Review. Inspect output against acceptance criteria before `accept`; a confident answer is not acceptance evidence.
4. Editing requires a registered trusted Git project, clean source, exact allowed paths, acceptance criteria, isolated worktree, passing registered tests, and approval by a different role bound to the exact patch. Assess both outputs before local `integrate`. No automatic push or deployment. Do not edit an approved patch or normalize a malformed review decision to make it pass; obtain a valid fresh review.
5. Workers do not recursively invoke the bridge or route jobs back to the contact assistant. The coordinating assistant decides follow-up work. Roles are separate sessions, not shared memory or extra subscription quotas.
6. Check `notion-status` before claiming automatic synchronization. A configuration file or exported metadata is not proof. Verify a live state transition on the same card. The PC must remain awake and online; no startup service is installed.
7. Report completed work, verification, and actual limitations. Never publish private configuration, queue history, prompts, credentials, or raw outputs. A host's approval requirements still apply to persistent access and other consequential actions.

The release's [README](README.md) describes compatibility and its validation boundary. For a normal task, load only the relevant reference above.
