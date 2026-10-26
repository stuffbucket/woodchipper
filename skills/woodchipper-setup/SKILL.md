---
name: woodchipper-setup
description: Diagnose and repair REA (rea-agents) MCP connection, CLI availability, provider readiness (Ghidra, Hopper, IDA, Kuna, JADX, WABT, TShark), client/server deadline timeouts, and transport truncation. Use only when REA tools are absent, return provider_unavailable or provider_timeout, or when the user asks to install, configure, or troubleshoot REA.
license: MIT
metadata:
  author: stuffbucket
  version: "1.0.0"
---

# Woodchipper Setup, Connection & Deadline Recovery

Read this skill only when an operation hits a concrete connection, registration, approval, timeout,
or provider blocker—or when explicitly asked to set up or update REA. If REA tools are already
connected and responsive, proceed directly to the target skill without running `doctor` or `setup`.

## 1. Diagnose Before Repairing

Never blindly re-run `setup` for every error. Different failure modes have distinct remedies:

| Observed Blocker | Root Cause | Exact Remedy |
| :--- | :--- | :--- |
| No REA tools in active session | Pi extension not loaded, or MCP not connected | Run `pnpm exec rea doctor --provider ghidra --skill --json`, then verify `.pi/settings.json` loads `woodchipper-rea.ts`. Do not use `--client pi`: REA's client check targets user-global `~/.pi/agent/mcp.json`, while Woodchipper registers in-process. |
| Registration missing or stale | Project-local Pi extension failed to register `rea` | Inspect `.pi/extensions/woodchipper-rea.ts` and restart the Woodchipper session. Do not run client-global `rea setup`; Woodchipper owns registration through `pi.registerMcpServer()`. |
| Registration aligned, tools still absent | Current session started before registration | Restart/reconnect the agent session. `doctor` checks config files on disk, not live session sockets. |
| `provider_unavailable` on native/Android/firmware tool | Missing external engine (Ghidra, Hopper, IDA, JADX, Binwalk) | Inspect `binary_session` with `{}` (`result.tool_availability`). Continue with built-in static tools (`inspect_go_binary`, `inspect_rust_binary`, `inspect_elf_notes`, `inspect_pe_resources`, `analyze_javascript_application`) that need no external engine. |
| `resource_constraint` (`details.resource: "transport"`) | Full Evidence exceeds MCP frame limit | Do NOT rerun the analysis. Call `inspect_analysis_view` with the reported `evidence_reference` (`detail: "summary"` or paged collection), or call `export_evidence_bundle` to disk. |
| Client truncated JSON output without REA error | Host tool-output display cap | Treat preview as incomplete. Use the retained `parent_evidence_id` with `inspect_analysis_view` to fetch smaller pages. |

## 2. Client Deadlines vs. Server/Provider Deadlines

Confusing client timeouts with server timeouts causes duplicate heavy imports:

1. **Client Timeout (`timed out awaiting tools/call` with no REA payload):**
   - The host stopped waiting, but the REA server or Ghidra import may still be running or cleaning up.
   - **Do NOT repeat the identical call immediately.** Check `binary_session` and `get_evidence_bundle` (`detail: "summary"`) first.
   - If the host deadline is too short, increase the client's MCP tool timeout (e.g. `tool_timeout_sec` in Codex) or run the heavy import via the CLI (`pnpm exec rea analyze <path> --provider ghidra --json`), which bypasses the MCP client timeout.
2. **Server/Provider Timeout (REA returns `provider_timeout` JSON error):**
   - The provider reached its internal budget:
     - **Ghidra cold startup/import:** Default is `330000` ms (5.5 min). Raise via `REA_GHIDRA_STARTUP_TIMEOUT_MS=1800000` in the environment launching REA (or via CLI). Note: changing shell env vars does not affect an already-running MCP server process without restart.
     - **JavaScript static analysis:** Default per-source budget is `300000` ms (`analysis_timeout_ms`) and `1024` MiB (`max_heap_mb`). Pass explicit `source_paths` to scope analysis to relevant files, or reuse `error.details.partial_observation` in `inspect_analysis_view`.
     - **JADX Android operations:** Controlled by `REA_JADX_OPERATION_TIMEOUT_MS` (default `120000` ms) and `REA_JADX_HEAP_MIB`.

## 3. Direct CLI Fallback (Zero MCP Overhead)

Every core REA capability works directly from the terminal via `pnpm exec rea` (or `mise run rea --`)
and outputs canonical Evidence JSON. When an MCP reply is too large or a provider takes 15+ minutes
to import a massive binary, run the CLI command and redirect stdout to a workspace file:

```bash
# JavaScript / Electron app (redirect large output to file, then query summary view)
pnpm exec rea analyze-javascript-application /abs/path/to/app --json > app-evidence.json
jq -c '{source: {kind: "inline", evidence: .}, view: {kind: "summary"}}' app-evidence.json > app-view.json
pnpm exec rea inspect-analysis-view app-view.json

# Native binary with Ghidra and extended startup deadline
REA_GHIDRA_STARTUP_TIMEOUT_MS=1800000 pnpm exec rea analyze /abs/path/to/binary --provider ghidra --json > binary-overview.json
```

## 4. External Provider Environment Variables

REA never auto-installs Homebrew, Node, Java, Ghidra, IDA, JADX, Binwalk, or Unblob. Configure existing tools via environment variables:

- **Ghidra:** `GHIDRA_INSTALL_DIR` or `REA_GHIDRA_HEADLESS_PATH`, `REA_GHIDRA_STARTUP_TIMEOUT_MS`
- **Hopper:** Installed on macOS/Linux; first-run GUI license/demo dialog must be completed once in the user session.
- **IDA Pro:** `provider_id: "ida"` (uses `mrexodia/ida-pro-mcp` or headless IDA). Always pass the original binary path to `open_binary`, never `.idb`/`.i64`.
- **Kuna:** `REA_KUNA_COMMAND` (`provider_id: "kuna"`). Searches cached `.c`/`.asm` exports directly via `raw_result.source`.
- **Android JADX:** `REA_JADX_MCP_JAR` (headless JADX MCP JAR 0.7.1) + `JAVA_HOME` (full JDK 17+ with `jdk.compiler`).
- **JEB:** `REA_JEB_MCP_URL` pointing to a running JEB MCP endpoint.
- **WASM (WABT):** `REA_WABT_BIN_DIRECTORY` (WABT 1.0.42).
- **Packets (TShark):** `REA_TSHARK_COMMAND` (Wireshark/TShark 4.x).
- **Signals (sigrok):** `REA_SIGROK_COMMAND` (sigrok-cli 0.7.2).

For detailed troubleshooting tables, read `vendor/rea/skills/reverse-engineer-anything/references/connection-and-recovery.md` and `vendor/rea/docs/installation.md`.
