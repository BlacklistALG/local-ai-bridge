# First-time setup

Use a Windows PC with Node.js 22+, native Codex and Claude Code executables, and eligible subscription sign-ins. Git for Windows at a standard installation path is needed for project editing. No npm dependencies are required. Desktop chat apps alone are not sufficient: the bridge invokes their coding CLIs.

Ask the user which assistant will coordinate, whether they want Notion, and where private work should live if that is not already clear. Model IDs and role names are configurable; do not assume the author's models exist on another account. Inspect installed CLI help and versions before promising compatibility. The adapter checks its required flags and rejects incompatible versions at dispatch.

## Create a private installation

From the extracted skill folder, run:

```powershell
node scripts/setup.mjs --destination 'D:\AI-Workspace\my-bridge'
```

This copies only runtime source and tests to a **new** folder. It will not overwrite an existing installation, start workers, connect Notion, or register a service. The destination must be outside the public skill folder. Read the generated `config.json`; executable and model fields intentionally start empty.

Native executables can be found with `Get-Command codex -All` and `Get-Command claude -All`. Some results are wrapper scripts; find and select the actual native `.exe` for each. Do not copy credentials or session files. Ask the user to sign in through each provider's supported sign-in flow.

Either edit the new configuration or provide paths and models during setup:

```powershell
node scripts/setup.mjs --destination 'D:\AI-Workspace\my-bridge' --codex 'D:\Apps\Codex\codex.exe' --claude 'D:\Apps\Claude\claude.exe' --codex-model 'EXACT_CODEX_MODEL' --claude-model 'EXACT_CLAUDE_MODEL'
```

These are illustrative paths and model labels, not working defaults. Use exact IDs the local CLIs support for the user's account. Keep `subscriptionOnlyConfirmed` false until the user confirms paid extra usage/credits and automatic paid continuation are disabled. After that confirmation, set it true, or pass `--confirm-subscriptions-only` to a new setup. This setting records the user's confirmation; it cannot change or guarantee provider billing settings. Do not buy credits, reset usage, or fall back to model APIs.

Run inside the private installation:

```powershell
node scripts/doctor.mjs
node scripts/doctor.mjs --auth
node bridge.mjs roles
node --test tests/*.test.mjs
```

The first doctor checks configuration. The `--auth` option calls only installed CLI sign-in status commands and prints no account details. Neither invokes a model. Tests use simulated provider and Notion responses. A successful doctor does not establish model availability or end-to-end operation.

## Verify live handoffs

With setup/live-probe authorization, submit one short read-only task to `codex-worker` and one to `claude-worker`, then `run`. Request different brief readiness replies, inspect both results, and accept only verified results. These probes consume the user's included allowance. Record model-request versus model-attestation evidence separately; Codex streams may not identify the actual model. Do not use an account's remaining quota just to repeat a passing probe.

The default two-worker limit is one per provider. Add role definitions only when useful; each needs `name`, `provider`, `model`, `executable`, and `instructions`. Separate role names do not create extra usage allowance.

## Host installation

This is an Agent Skills folder: `SKILL.md` at the root, with scripts and references. Install the entire `local-ai-bridge` folder through the host's supported local skill/plugin flow, or place it in a supported skill directory. Claude Code documents personal skills at `~/.claude/skills/`; on Windows `~` is the user's profile. Codex can use its skill installer or its configured skills directory. Reload skill discovery if the host requires it.

Invoke: **Use $local-ai-bridge to set up Codex and Claude teamwork on this PC.** Claude Code can also invoke `/local-ai-bridge`. A host must have local command/file access; uploading this to a cloud-only chat does not grant access to a PC. Cowork/Grok compatibility depends on their actual local execution capabilities and is not guaranteed by recognizing SKILL.md.

Official references: [Agent Skills format](https://agentskills.io/specification), [OpenAI skill authoring](https://developers.openai.com/plugins/build/skills), [Claude Code skills](https://code.claude.com/docs/en/skills), [Codex Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox).
