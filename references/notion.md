# Optional Notion board

Skip this entirely if the user does not want Notion. Local task execution works without it. Never use another person's board, private connector token, or pre-existing app credential.

## Create the user's board

Use the user's connected Notion tools or Notion UI to create or choose a task database. Preserve unrelated content. The bundled transport expects these exact property names and types:

| Property | Type / options |
|---|---|
| Task | Title |
| Status | Select: Backlog, Ready, Working, Review, Waiting for you, Blocked, Failed, Cancelled, Done |
| Owner | Select: every configured role's display name, such as Codex worker and Claude worker |
| Model | Text |
| Area | Select: IT Department, Daily Assistant, Shared Bridge |
| Local task ID | Text |
| Depends on | Text |
| Acceptance criteria | Text |
| Progress | Text |

Optional: Priority (select), Result (URL), Updated (last edited time). The bridge does not write the system timestamp. Use **Select**, not Notion's separate Status property type, for the schema above.

Create an unfiltered table view containing Local task ID. Use this view for recovery lookups, plus a separate Kanban view grouped by Status for people. The recovery view must belong to the selected data source, have no filters, and display Local task ID. Confirm the database, data source, and view IDs through actual Notion metadata; they are different IDs. Do not infer them from an arbitrary link or borrow sample UUIDs.

Edit the private configuration's `notion` object:

```json
{
  "syncMode": "disabled",
  "databaseId": "YOUR_DATABASE_UUID",
  "dataSourceId": "YOUR_DATA_SOURCE_UUID",
  "viewId": "YOUR_UNFILTERED_VIEW_UUID",
  "boardUrl": "YOUR_NOTION_BOARD_URL"
}
```

Values are explicit placeholders. The public bundle has no working board defaults. The transport verifies each card's parent data source and refuses cards outside the configured scope. Configuration is trusted local coordinator state; changing it can change that scope.

## Authorize and verify

From the private installation:

```powershell
node scripts/notion-auth.mjs login
```

Open the returned official Notion authorization URL in the user's browser. Complete the grant with whatever confirmation the host requires. Explain that Notion grants access according to the account's permissions; the board restriction is implemented in our code, not a narrow OAuth permission. The callback goes to a temporary loopback address. Credentials are encrypted using Windows CurrentUser DPAPI, restricted to that Windows account, and stored under `.private/`, excluded from source control. Do not print, copy, or publish them.

After `NOTION_CONNECTED`, change `syncMode` to `direct-mcp`, then:

```powershell
node bridge.mjs notion-sync
node bridge.mjs notion-start
node bridge.mjs notion-status
```

A status of `ok: true` with zero pending updates is required but does not replace a live transition test. Submit a clearly labeled, read-only synchronization diagnostic without running any model. Verify the watcher creates its Ready card with the queue ID. Cancel it locally; verify the **same** card becomes Cancelled. Cancelled is the expected outcome of this diagnostic. Leave it as evidence. Do not use a connected assistant tool to perform those writes and then attribute them to the watcher.

The hidden watcher survives the launching command. Queue mutations start it if configured and necessary. It is not a Windows startup service; after restart it resumes when a bridge queue command starts it or `notion-start` is invoked. No model calls are made for syncing. Notion availability, permissions, and plan limits can still block operations; do not promise free access to every Notion feature or upgrade a plan automatically.

The local queue owns synchronized fields. Manual card changes to those fields can be overwritten. Credentials and task content remain private; only the selected task metadata is mirrored, not raw prompts/results. Task titles and acceptance criteria can themselves be sensitive: keep them suitable for the board's audience.

Use `notion-stop` to request a graceful stop. To disable the feature, set `syncMode` to `disabled` and stop the watcher; revoke the connection through Notion if the user requests it. Stopping the watcher alone does not revoke OAuth access.

Official reference: [Build a Notion MCP client](https://developers.notion.com/guides/mcp/build-mcp-client).
