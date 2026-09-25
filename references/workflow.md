# Task coordination

All commands below run inside the user's private bridge installation. Read its `config.json` and inspect `node bridge.mjs list` before dispatching. Keep this local state authoritative; Notion is a view of it.

## Read-only jobs

Write a request to the ignored `work/` folder (create it first):

```json
{
  "role": "codex-worker",
  "title": "Review the provided design",
  "prompt": "Assess the supplied design against its acceptance criteria. Return findings only; do not modify files. Include the design text or authorized file paths here.",
  "origin": "coordinator",
  "requestKey": "design-review-001",
  "dependsOn": [],
  "acceptanceCriteria": "Identify concrete issues and explain the evidence."
}
```

```powershell
node bridge.mjs submit --file work/request.json
node bridge.mjs run
node bridge.mjs show TASK_ID
node bridge.mjs accept TASK_ID
```

Replace `TASK_ID` with the returned ID. Inspect the actual result before acceptance. Use the same `requestKey` only for retries of the same task. Dependencies receive accepted prerequisite results. Run again after accepting prerequisites; the queue does not create or dispatch follow-up tasks by itself. `run` executes all currently eligible jobs within its cap, so inspect the queue before running it.

Use `cancel TASK_ID` for a queued or completed task when appropriate. Running tasks and active integrations require separate recovery; do not change state files to force them through.

## Register a trusted project

In the private configuration, set `sandboxMode` to `workspace-write` for authorized editing and add a named project:

```json
{
  "projects": {
    "my-project": {
      "path": "D:/Projects/my-project",
      "testCommand": {
        "executable": "D:/Tools/node/node.exe",
        "args": ["--test", "tests/*.test.mjs"],
        "timeoutMs": 120000
      }
    }
  }
}
```

Merge these fields into the existing config; do not replace the roles or other settings. Use real absolute paths and a trusted command suitable for that project. Shell wrappers such as npm.cmd, PowerShell, and sh are rejected; invoke a real executable with explicit arguments. Tests execute project code with the current user's permissions and a filtered environment, not in a separate VM.

The source must be a clean Git repository with an initial commit. Keep request files under the bridge's ignored `work/`, not as untracked files in the source repository. Projects need a local branch for integration.

An editing request additionally needs:

```json
{
  "mode": "workspace-write",
  "project": "my-project",
  "allowedPaths": ["src/example.mjs", "tests/example.test.mjs"],
  "acceptanceCriteria": "Describe observable behavior and the tests that establish it."
}
```

`allowedPaths` are exact relative files or directory prefixes ending in `/`, with no globs, parent traversal, or `.git`. Prefer a small file scope. The worker edits an isolated worktree. Out-of-scope changes, test-created changes, symlinks, failed tests, or changed source history block integration.

## Review and integration

```powershell
node bridge.mjs review EDITING_TASK_ID claude-worker
node bridge.mjs run
node bridge.mjs show REVIEW_TASK_ID
node bridge.mjs integrate EDITING_TASK_ID REVIEW_TASK_ID
```

For Claude-written changes, use `codex-worker` as reviewer. The independent review is a separate read-only job containing the exact patch, acceptance criteria, and test evidence. Both adapters require a structured decision. The coordinator must assess that decision and the original result before integration.

Integration creates a local commit; it never pushes or deploys. A changed patch requires fresh tests and a fresh review. If another task changed the source first, resubmit against the new source; automatic rebasing is not implemented. Plain `accept` cannot accept editing jobs.

## Other entry assistants

Grok or another assistant can use this same CLI only if it has user-authorized command execution on this PC. Give it the private installation path, Node executable, and this workflow. Do not advertise a generic Grok API, automatic shared chat memory, or unsolicited callbacks: none is included. Workers must not invoke the bridge or route tasks recursively back to the coordinator.
