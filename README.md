# Woodchipper

**Woodchipper** combines three upstream projects into a unified, dual-surface reverse-engineering harness optimized for **Claude 5.5-series models** (`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-fable-5-1`):

1. **[`morluto/rea`](https://github.com/morluto/rea) (`rea-agents@6.7.0`)** — the Reverse Engineer Anything MCP server (`207` MCP tools, `153` CLI commands, `6` guided prompts), contracts, bridges, and reference documentation (`vendor/rea/`).
2. **[`JoasASantos/REA-Prompts`](https://github.com/JoasASantos/REA-Prompts) (REAP)** — the 16-section human-to-agent reverse-engineering prompt catalog (`vendor/rea-prompts/README.md`).
3. **[`earendil-works/pi`](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent@1.4.0`)** — vendored as a Git submodule at `vendor/pi` and customized with project-local extensions (`.pi/extensions/`), system prompts (`.pi/SYSTEM.md`), and a Claude Code `peerProtocol: 1` Unix Domain Socket (UDS) bridge.

**Documentation:** [stuffbucket.github.io/woodchipper](https://stuffbucket.github.io/woodchipper/)

---

## How the Repository Works

### 1. Dual-Surface Pi Harness (`bin/woodchipper.mjs` + `.pi/extensions/`)

Woodchipper can be driven **directly by a human** in an interactive terminal TUI or **autonomously across instances** by Claude Code (`ListAgents` / `SendMessage`) and `woodchipper-ctl`:

- **`.pi/extensions/woodchipper-rea.ts` (REA & Epistemology Extension)**
  - **Pi-Local REA MCP Wiring:** Automatically registers `pnpm exec rea mcp` through Pi's extension API with the repository as `cwd`, plus `GHIDRA_INSTALL_DIR` (`Ghidra 12.1.4`), `JAVA_HOME` (`Temurin JDK 21`), and `GHIDRA_HEADLESS_MAXMEM=4G` pre-resolved via `resolveReaProviderEnv()`. No Claude Code MCP configuration is created.
  - **Summary-First Context Guardrail (`tool_call` hook):** Intercepts high-volume REA tools (`analyze_javascript_application`, `inspect_binary_layout`, `inspect_macho`, `inspect_artifact`, `inspect_managed_artifact`, `inspect_wasm_artifact`, `inspect_web_network_capture`) and injects `detail: "summary"` whenever `detail` is omitted so initial calls never flood the model's context window.
  - **Destructive Git Blocker (`tool_call` + `user_bash` hooks):** Normalizes shell commands (stripping quote obfuscation, line continuations, and global git flags like `git -C <dir>`) and blocks `git reset --hard`, `git clean -fd`, `git checkout -- <path>`, `git switch -f`, `git stash drop/clear`, and working-tree `git restore` (`git restore --staged` remains allowed).
  - **Three-Bucket Evidence Ledger (`tool_result` hook + `woodchipper_ledger` tool):** Automatically extracts `evidence_id` and `parent_evidence_id` (`ev_...`) returned by REA tools (while ignoring non-REA built-in tools like `read`/`grep`/`bash` to prevent false positives) and persists **Observations**, **Inferences**, and **Unknowns** to `.woodchipper/evidence-ledger.json` with atomic `0600` writes and monotonic ID counters.
  - **Custom Tools & Slash Commands:** Registers model-callable tools (`woodchipper_triage`, `woodchipper_ledger`, `woodchipper_playbook`) and interactive slash commands (`/triage <path>`, `/trace <path> <feature>`, `/clone-spec <path>`, `/audit <path>`, `/ledger [clear|json]`, `/doctor`).

- **`.pi/extensions/woodchipper-peer.ts` (Claude Code `peerProtocol: 1` & A2A Bridge)**
  - **Session Advertisement:** Writes `~/.claude/sessions/<pid>.json` (`peerProtocol: 1`, `kind: "interactive"`, `name: "woodchipper"`) and a `0600` authentication key at `~/.claude/sessions/<pid>.<sha256(socketPath)>.key`.
  - **UDS Server:** Listens on `/tmp/cc-socks/<pid>.sock` (symlinked at `.woodchipper/peer.sock`). All incoming `user`, `control`, and `a2a` frames require timing-safe `.key` token verification before execution.
  - **Cross-Instance Claude Code Integration:** Any local Claude Code session discovers `woodchipper` via `ListAgents` and can send tasks via `SendMessage({ to: "woodchipper", message: "Triage /path/to/binary" })`. Woodchipper sanitizes XML attributes/tags, prevents `is-reply="true"` auto-reply ping-pong loops, verifies reply sockets against live `~/.claude/sessions/<pid>.json` peers, executes the prompt with `expandPromptTemplates: false`, and returns the settled response when `agent_settled` fires.
  - **CLI Controller (`scripts/woodchipper-ctl.mjs`):** Inspects live peers (`peers`), queries status (`status`), exports the 3-bucket Evidence Ledger (`ledger`), or sends synchronous (`--wait`) or streaming (`--steer`) prompts over UDS.

### Configuration Boundary

- REA MCP registration, guardrail hooks, skills, prompts, and tools are owned by project-local Pi files under `.pi/`; setup does not write `~/.pi/agent/mcp.json` or any Claude Code settings/hooks.
- The repository intentionally contains no root `.mcp.json`, `.claude/settings*.json`, `.claude/hooks/`, or `.claude-plugin/hooks/`. `.claude/workflows/` contains opt-in workflow source files only; it is not a hooks configuration.
- The optional peer extension creates transient discovery records and authentication keys in `~/.claude/sessions/` so a running Woodchipper can appear in Claude Code's `ListAgents`. These are runtime records, not Claude settings or hooks, and are removed on clean shutdown. Start Woodchipper with `--no-peer` or `WOODCHIPPER_NO_PEER=1` to avoid those records entirely.
- Harness state and the Evidence Ledger stay under the ignored project-local `.woodchipper/` directory.

### 2. Progressive-Disclosure Skill Pack (`skills/woodchipper*`)

Instead of loading all 80+ upstream REA reference docs and 207 tool schemas into context at once, Woodchipper provides **1 root router skill** and **8 domain sub-skills** (each validated to stay under 500 lines):

| Skill | Target Domain & Primary REA Tools |
| :--- | :--- |
| `skills/woodchipper/` | Root router, 3-bucket epistemology (`Observations`, `Inferences`, `Unknowns`), and 5.5-series operating rules |
| `skills/woodchipper-setup/` | `rea doctor`, Ghidra 12.1.4 + Temurin 21 headless setup, MCP vs. CLI fallback, timeout recovery |
| `skills/woodchipper-native/` | PE/ELF/Mach-O/COFF/raw binaries, Go (`inspect_go_binary`), Rust (`inspect_rust_binary`), GPU/ML models, Ghidra/IDA/Hopper sessions |
| `skills/woodchipper-js-web/` | Electron/ASAR (`inspect_electron_fuses`), minified JS bundles (`analyze_javascript_application` summary paging), HAR/SAZ/mitmproxy/qlog |
| `skills/woodchipper-mobile-managed/` | Android APK/JADX/Apktool (`inspect_android_package`), Flutter (`identify_flutter_build`), Unity IL2CPP (`inspect_il2cpp_metadata`), .NET (`inspect_managed_artifact`), Apple `.app`/`.ipa`/`.plist` |
| `skills/woodchipper-firmware-signals/` | Firmware entropy & extraction (`inspect_byte_entropy`, `inspect_firmware_regions`, `extract_firmware`), WASM (`inspect_wasm_artifact`), EVM, SQLite (`inspect_sqlite_database`), PCAP, sigrok |
| `skills/woodchipper-runtime/` | Bounded dynamic validation: Browser/Electron CDP, POSIX PTY, LLDB native calls & macOS UI inspection, Frida, GDB, Rizin |
| `skills/woodchipper-reconstruction/` | Clean-room behavioral specifications (`CLONE_SPEC.md`), native-to-WASM porting plans, `build_reconstruction_obligation_ledger`, `verify_reconstruction` |
| `skills/woodchipper-audit/` | Defensive source-to-sink trust-boundary audits, Windows/macOS kernel IOCTLs, 1-day patch diffing (`diff_binaries`), crash triage (`inspect_recorded_crash`), `record_unknown` |

### 3. Operational Playbooks (`playbooks/*.md`) & Multi-Agent Workflows (`.claude/workflows/*.js`)

- **Playbooks (`playbooks/`):** Translate `JoasASantos/REA-Prompts` (REAP) human investigative goals directly into `morluto/rea` tool sequences:
  1. `playbooks/triage-and-feature-trace.md` — Unfamiliar target mapping, single-feature end-to-end call-chain tracing, and business rule recovery.
  2. `playbooks/clean-room-and-porting.md` — Copyright-clean `CLONE_SPEC.md` behavioral generation and native-to-WASM porting.
  3. `playbooks/security-and-vr.md` — Trust-boundary & source-to-sink audits, kernel IOCTL enumeration, patch diffing, and crash root-cause analysis.
  4. `playbooks/firmware-and-protocols.md` — Firmware entropy/partition mapping, headerless MCU triage, and wire-protocol/file-format recovery.
- **Workflows (`.claude/workflows/`):** Five deterministic multi-agent orchestration scripts (`triage-target.js`, `trace-feature.js`, `clean-room-spec.js`, `security-audit.js`, `version-diff.js`) using `pipeline()`, `parallel()`, `agent()`, and multi-lens adversarial verification.

---

## Toolchain & Headless Ghidra Readiness (`mise` + `pnpm`)

Woodchipper uses **`mise`** (`mise.toml`) and **`pnpm`** (`pnpm@12.11.2`):

- **Pinned Runtimes (`mise.toml`):**
  - `node = "24.22.1"`
  - `pnpm = "12.11.2"`
  - `python = "3.12.15"`
  - `java = "temurin-21.0.12+101.0.LTS"`
- **Pinned Dependency & Audit Overrides:**
  - `vendor/pi`, `jose@6.2.13`, and `fast-uri@3.1.9` are exact gitlink SHA pins with adjacent semver comments in `.gitmodules`; the machine-readable SHAs also live in `vendor/MANIFEST.json` and `vendor/overrides/manifest.json`.
  - `jose` and `fast-uri` remain isolated source submodules because the configured proxy does not mirror those releases. `pnpm run build:overrides` copies them into the purpose-built `vendor/overrides/Dockerfile`, builds/packages them there, and exports ignored package trees without modifying either checkout.
  - Root pnpm resolution pins proxy-available `zod@4.6.7`. Pi is copied from its immutable submodule into ignored `.woodchipper/pi`, then `vendor/overrides/pi-audit.json` applies exact proxy-available Vitest, Vite, Undici, and Zod fixes plus the Docker-built `fast-uri@3.1.9` before an offline source build.
  - The Pi overlay reduces its audit report from 14 findings (7 high, 7 moderate) to zero. Two unpatchable proxy dependencies belong only to the sandbox and Gondolin example workspaces, which the runtime build excludes; the immutable upstream checkout still retains those examples.
  - Builders inherit the effective pnpm registry. The Docker build mounts `~/.npmrc` only as a BuildKit secret, while host-side npm uses the configured proxy normally. Removal and residual-audit details are in `vendor/overrides/README.md`.
- **Headless Ghidra 12.1.4 Provider:**
  - Installed at `~/.local/share/ghidra/ghidra_12.1.4_PUBLIC` with the compiled native macOS `arm64` Mach-O decompiler (`Ghidra/Features/Decompiler/os/mac_arm_64/decompile`) and `GHIDRA_HEADLESS_MAXMEM = "4G"`.
  - `.pi/extensions/woodchipper-rea.ts` registers REA directly with Pi and exports `GHIDRA_INSTALL_DIR`, `JAVA_HOME`, and `GHIDRA_HEADLESS_MAXMEM` automatically. The repository intentionally has no root `.mcp.json`, so opening it in Claude Code does not register REA there.
  - `mise run doctor` (`pnpm run doctor`) verifies `skill:identity` and all 9 `ghidra` provider checks (`"healthy": true`, `"environment_healthy": true`); project tests verify Pi's in-process MCP registration without requiring a user-global Pi MCP entry.

---

## Quick Start & Commands

```bash
# 1. Trust mise.toml, build temporary dependency overrides in Docker,
#    install pinned dependencies, and build the vendored Pi runtime
mise trust
mise run setup          # or: pnpm run setup (requires Docker with Buildx)

# 2. Check REA/Ghidra readiness (project tests validate the Pi-local registration)
mise run doctor         # or: pnpm run doctor

# 3. Launch interactive Woodchipper Pi TUI (human TUI + live Claude Code peerProtocol:1 socket)
mise run tui            # or: pnpm run woodchipper -- tui

# 4. Run headless Woodchipper Pi peer daemon for Claude Code SendMessage / woodchipper-ctl
mise run daemon         # or: pnpm run daemon

# 5. Inspect or drive live Woodchipper / Claude Code peers over UDS
mise run ctl -- peers
mise run ctl -- status woodchipper
mise run ctl -- ledger woodchipper
mise run ctl -- send woodchipper "Triage /bin/ls" --wait

# 6. Run validation, unit/integration tests, and the 13-mutant security/logic mutation suite
mise run validate       # or: pnpm run validate
mise run test           # or: pnpm test
mise run test:mutate    # or: pnpm run test:mutate
```

### Driving Woodchipper from Another Claude Code Instance

When `mise run tui` or `mise run daemon` is running:

1. In any Claude Code session on the same machine, run `ListAgents` — `woodchipper` appears as a local peer.
2. Send a task with `SendMessage({ to: "woodchipper", message: "Run static triage on /path/to/target and return the 3-bucket Evidence Ledger." })`.
3. Woodchipper executes the triage against the local `rea` MCP server and delivers the structured response back to your Claude Code session on completion.

---

## Repository Layout

```text
woodchipper/
├── bin/
│   └── woodchipper.mjs                # Unified Pi harness launcher (tui, daemon, rpc, ask, build-pi)
├── .pi/
│   ├── settings.json                  # Project-local Pi configuration (tools, skills, extensions)
│   ├── SYSTEM.md                      # Woodchipper 5.5-series system prompt addendum
│   └── extensions/
│       ├── woodchipper-rea.ts         # REA MCP wiring, summary-first & git guardrails, tools & commands
│       ├── woodchipper-peer.ts        # Claude Code peerProtocol:1 UDS server & claude_peers tool
│       └── lib/
│           ├── evidence-ledger.ts     # Atomic 0600 3-bucket Evidence Ledger (.woodchipper/evidence-ledger.json)
│           ├── triage.ts              # Target-free static triage, playbook loader, & rea doctor summary
│           ├── peer-protocol.ts       # Authenticated UDS peer server, XML escaping, & peer discovery
│           └── schema.ts              # JSON Schema builder for Pi extension tools
├── .claude-plugin/
│   ├── marketplace.json               # Stuffbucket local plugin marketplace manifest
│   └── plugin.json                    # Claude Code plugin definition
├── .claude/
│   └── workflows/                     # Deterministic multi-agent workflows (triage, trace, clone-spec, audit, diff)
├── mise.toml                          # Pinned toolchain (Node, pnpm, Python, Temurin 21) & tasks
├── skills/                            # 9 progressive-disclosure skills (<500 lines each)
├── playbooks/                         # 4 human + agent operational playbooks (REAP + REA unified)
├── vendor/                            # Pinned upstream files & submodules (vendor/MANIFEST.json)
│   ├── MANIFEST.json
│   ├── pi/                            # earendil-works/pi git submodule (@earendil-works/pi-coding-agent)
│   ├── overrides/                     # Isolated source pins, audit overlay, and Docker package builder
│   │   ├── jose/                      # panva/jose@6.2.13 git submodule
│   │   ├── fast-uri/                  # fastify/fast-uri@3.1.9 git submodule
│   │   ├── pi-audit.json              # Exact proxy fixes + documented unavailable residuals for Pi
│   │   └── packages/                  # Ignored Docker-built package trees consumed by overrides
│   ├── rea/                           # morluto/rea@6.7.0 skills, docs, contracts, bridges
│   └── rea-prompts/                   # JoasASantos/REA-Prompts catalog
├── scripts/
│   ├── build-harness.mjs              # Verifies and prepares the Woodchipper Pi harness
│   ├── build-pi-overlay.mjs            # Stages and builds audited Pi without changing its submodule
│   ├── build-vendor-overrides.mjs      # Builds isolated proxy-gap packages through Docker Buildx
│   ├── woodchipper-ctl.mjs            # CLI controller for Claude Code & Woodchipper UDS peers
│   ├── mutation-test.mjs              # 13-mutant security & logic mutation test runner
│   ├── validate.mjs                   # Validates skills, workflows, Pi harness, and vendor manifest
│   ├── sync-to-stuffbucket-skills.mjs # Copies skills/woodchipper* into ../skills
│   └── update-vendor.mjs              # Updates vendor/ from upstream git repos
└── tests/
    ├── validate-woodchipper.test.mjs  # Skill, workflow, and vendor manifest tests
    ├── pi-extension.test.mjs          # Woodchipper REA Pi extension, git blocker, & Evidence Ledger tests
    └── peer-extension.test.mjs        # Claude Code peerProtocol:1 UDS auth, loop prevention, & A2A tests
```
