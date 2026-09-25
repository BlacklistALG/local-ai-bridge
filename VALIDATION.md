# Public release validation

This is a Windows reference release derived from a private bridge with successful live cross-provider editing/review/integration and independent Notion synchronization. That originating installation's accounts, paths, board, credentials, queue history, and Git history are not part of this package.

This public derivative changes Notion from a fixed board to explicit per-installation IDs, adds an isolated installer and diagnostic helper, and supplies portable skill instructions. Both providers refuse dispatch until the recipient has confirmed included-usage settings. Setup copies the license and starts with editing and Notion disabled.

## Results — 25 September 2026

- Windows / Node.js 24.19.0: **118 automated tests passed, zero failures**. This includes runtime and setup tests. Provider and Notion operations are simulated in this suite.
- After the final generic-origin and installer-license adjustments, all **16 affected setup and queue tests passed** again.
- The bundled skill-creator format validator reports **Skill is valid**.
- The release checker passed across **37 source/documentation files** with no detected credential, fixed runtime board identity, personal Windows profile path, or unapproved state file. A separate scan for originating account, machine, board, and executable identifiers found no matches. Heuristic scanning is not a guarantee against every secret; only the reviewed source bundle is intended for sharing.
- An independent evaluator used the skill to create a new private installation with no accounts or Notion access. Setup preserved safe defaults, a repeated setup refused overwrite, doctor identified missing recipient configuration, and local role/status commands worked. No model was invoked or watcher launched. The evaluator caught a test fixture that lacked the newly mandatory synthetic board IDs; it was corrected before the passing release run.

The originating private installation and its running watcher were not modified by public packaging. The release is a clean source derivative, not an export of that installation.

Live recipient authentication and model availability are not established by automated fixtures. A new installation must perform its own authorized read-only probes and optional Notion transition check. No provider subscriptions or credentials are included. Windows only; no claim of macOS/Linux, marketplace, or desktop-only chat compatibility.
