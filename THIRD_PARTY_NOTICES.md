# Third-party notices

## codex-mcp-bridge peer adapter

Source package: `@minhspark/codex-mcp-bridge`, version 2.4.0, MIT.

Copyright (c) 2026 Bui Dang Minh.

The minimal local import/resource closure of `src/peer-protocol.mjs` is vendored
under `vendor/codex-mcp-bridge/src`. Its original full license is retained at
`vendor/codex-mcp-bridge/LICENSE`. No third-party npm install scripts are run.

Local modifications:

- Resolve Claude sessions/projects through CODEX_BRIDGE_CLAUDE_HOME or
  CLAUDE_CONFIG_DIR before the normal user-home fallback.
- Resolve Windows PowerShell and module directories through SystemRoot/WINDIR
  instead of assuming the operating system is installed on the C drive.

## npm runtime dependencies

`@modelcontextprotocol/sdk` (MIT), `zod` (MIT), and `@iarna/toml` (ISC) are
downloaded by npm according to package-lock.json. Their packages retain their
own licenses. Transitive dependencies retain their respective notices inside
node_modules; node_modules is not included in the source ZIP.
