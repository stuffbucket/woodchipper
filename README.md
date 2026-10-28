# Woodchipper

**Woodchipper** combines four upstream projects into a unified, dual-surface reverse-engineering harness optimized for **Claude 5.5-series models** (`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-fable-5-1`):

1. **[`morluto/rea`](https://github.com/morluto/rea) (`rea-agents@6.7.0`)** — the Reverse Engineer Anything MCP server (`207` MCP tools, `153` CLI commands, `6` guided prompts), contracts, bridges, and reference documentation (`vendor/rea/`).
2. **[`JoasASantos/REA-Prompts`](https://github.com/JoasASantos/REA-Prompts) (REAP)** — the 16-section human-to-agent reverse-engineering prompt catalog (`vendor/rea-prompts/README.md`).
3. **[`earendil-works/pi`](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent@1.4.0`)** — vendored as a Git submodule at `vendor/pi` and customized with project-local extensions (`.pi/extensions/`), system prompts (`.pi/SYSTEM.md`), and a Claude Code `peerProtocol: 1` Unix Domain Socket (UDS) bridge.
4. **[`stuffbucket/gliner-runner`](https://github.com/stuffbucket/gliner-runner) (`@gliner-runner/onnx-runner@0.4.0`, `decide-340m`)** — vendored as a Git submodule at `vendor/gliner-runner` and wired via `.pi/extensions/lib/gliner-classifier.ts` (`woodchipper_classify` tool & `/gliner` command) to auto-pull `decide-340m` when missing and classify plain-English user questions and binary strings/imports without requiring reverse-engineering domain jargon.

**Documentation:** [stuffbucket.github.io/woodchipper](https://stuffbucket.github.io/woodchipper/)

---

## How the Repository Works

### 1. Dual-Surface Pi Harness (`./woodchipper` + `bin/woodchipper.mjs` + `.pi/extensions/`)

Woodchipper can be driven **directly by a human** in an interactive terminal TUI or **autonomously across instances** by Claude Code (`ListAgents` / `SendMessage`) and `woodchipper-ctl`:

- **`.pi/extensions/woodchipper-maximal.ts` (Maximal Preferred Provider & Refusal Failover)**
  - **Local `maximal` Provider (`http://127.0.0.1:4141`):** Defaults to `claude-sonnet-5-5-20260301`, probes available models on startup, and exposes `/maximal [status|models|refresh|use <model-id>]`.
  - **Automatic Cyber-Refusal Failover:** Detects false-positive cyber-policy refusals on authorized defensive/clean-room tasks and automatically fails over across `claude-sonnet-5-5-20260301 -> gemini-4-argon -> gpt-5.3-codex -> gpt-6`.

- **`.pi/extensions/woodchipper-rea.ts` (REA, GLiNER, Workspaces & Epistemology Extension)**
  - **Pi-Local REA MCP Wiring:** Automatically registers `pnpm exec rea mcp` through Pi's extension API with the repository as `cwd`, plus `GHIDRA_INSTALL_DIR` (`Ghidra 12.1.4`), `JAVA_HOME` (`Temurin JDK 21`), and `GHIDRA_HEADLESS_MAXMEM=4G` pre-resolved via `resolveReaProviderEnv()`. No Claude Code MCP configuration is created.
  - **Summary-First Context Guardrail (`tool_call`, `tool_result`, & `session_before_compact` hooks):** Intercepts all 14 `detail`-capable REA 6.7.0 tools (`analyze_javascript_application`, `inspect_binary_layout`, `inspect_macho`, `inspect_artifact`, `inspect_managed_artifact`, `inspect_managed_members`, `inspect_wasm_artifact`, `inspect_web_network_capture`, `decode_interface_builder`, `inspect_evm_interface`, `inspect_android_package`, `inspect_pcap_capture`, `inspect_dart_aot`, `get_evidence_bundle`) and injects `detail: "summary"` whenever `detail` is omitted. Oversized tool results (>32,000 characters) have their `ev_*` IDs scraped into the workspace ledger first and are capped with a retained-evidence paging hint; automatic context compaction preserves all `ev_*` receipts and unresolved unknowns via an Evidence Anchor.
  - **Destructive Git Blocker (`tool_call` + `user_bash` hooks):** Normalizes shell commands (stripping quote obfuscation, line continuations, and global git flags like `git -C <dir>`) and blocks `git reset --hard`, `git clean -fd`, `git checkout -- <path>`, `git switch -f`, `git stash drop/clear`, and working-tree `git restore` (`git restore --staged` remains allowed).
  - **Isolated Per-Target Workspaces & Three-Bucket Evidence Ledger (`workspaces/<slug>/`):** Extracts `evidence_id` and `parent_evidence_id` (`ev_...`) returned by REA tools (while ignoring non-REA built-in tools like `read`/`grep`/`bash`) and persists **Observations**, **Inferences**, and **Unknowns** inside git-ignored `workspaces/<slug>/` (`evidence-ledger.json` with atomic `0600` writes, human-readable `REPORT.md`, static reconnaissance `TRIAGE_MAP.md`, and isolated `sessions/` transcripts).
  - **Disk & Resource Hygiene (`.pi/extensions/lib/disk-hygiene.ts`):** Inspects and reclaims REA/Ghidra caches (`cache`), Docker build cache (`docker`), GLiNER ONNX models (`models`), and inactive workspaces (`workspaces`, `all`) via `./woodchipper clean` or `/clean`, backed by configurable thresholds in `~/.config/woodchipper/config.json` (`%APPDATA%\woodchipper\config.json` on Windows).
  - **Custom Tools & Slash Commands:** Registers model-callable tools (`woodchipper_triage`, `woodchipper_classify`, `woodchipper_ledger`, `woodchipper_playbook`) and interactive slash commands (`/start`, `/status [json]`, `/workspace`, `/triage <path>`, `/trace <path> <feature>`, `/clone-spec <path>`, `/audit <path>`, `/gliner`, `/maximal`, `/ledger [clear|json]`, `/doctor`, `/clean`, `/clear` / `/reset`, `/exit` / `/quit`).

- **`.pi/extensions/woodchipper-peer.ts` (Claude Code `peerProtocol: 1` & A2A Bridge)**
  - **Session Advertisement:** Writes `~/.claude/sessions/<pid>.json` (`peerProtocol: 1`, `kind: "interactive"`, `name: "woodchipper"`) and a `0600` authentication key at `~/.claude/sessions/<pid>.<sha256(socketPath)>.key`.
  - **UDS Server:** Listens on `/tmp/cc-socks/<pid>.sock` (symlinked at `.woodchipper/peer.sock`). All incoming `user`, `control`, and `a2a` frames require timing-safe `.key` token verification before execution.
  - **Cross-Instance Claude Code Integration:** Any local Claude Code session discovers `woodchipper` via `ListAgents` and can send tasks via `SendMessage({ to: "woodchipper", message: "Triage /path/to/binary" })`. Woodchipper sanitizes XML attributes/tags, prevents `is-reply="true"` auto-reply ping-pong loops, verifies reply sockets against live `~/.claude/sessions/<pid>.json` peers, executes the prompt with `expandPromptTemplates: false`, and returns the settled response when `agent_settled` fires.
  - **CLI Controller (`scripts/woodchipper-ctl.mjs`):** Inspects live peers (`peers`), queries status (`status`), halts active flows (`halt`), exports the 3-bucket Evidence Ledger (`ledger`), or sends synchronous (`--wait`) or streaming (`--steer`) prompts over UDS.

- **`.pi/extensions/pi-flow.ts` (Standalone RISC-Inspired Flow-Control Extension)**
  - **Separable & Cross-Platform (`darwin`, `linux`, `win32`):** Zero imports from Woodchipper or REA; communicates with host extensions strictly through `pi.events` (`flow:state`, `flow:progress`, `flow:cmd:halt`, `flow:cmd:status`).
  - **4-State Deterministic FSM (`IDLE`, `STEPPING`, `POLLING`, `SPAWNING`):** Exposes 7 sequential `model-only` tools (`flow_goal`, `flow_branch`, `flow_loop`, `flow_monitor`, `flow_mapreduce`, `flow_halt`, `flow_status`) and 8 slash commands (`/goal`, `/branch`, `/loop`, `/monitor`, `/watch`, `/mapreduce`, `/halt`, `/flow`). Tools are never hidden; blocked transitions return structured `BUSY_LOCKED` payloads with `retryAfterMs` and `waitHint`.
  - **Termination & Anti-Deadlock Guards:** Monotonic fuel (`maxIterations <= 50`) and wall-clock TTL deadlines, a 4-slot SHA-256 stagnation ring buffer (`stagnationCount >= 3` auto-halt), session-fenced state persistence, cross-platform ancestor PID tree & harness detection (`claude-code`, `claude-desktop`, `codex`, `copilot-cli`, `pi`, `woodchipper`), and a single-child read-only MapReduce runner (`MAX_CONCURRENCY = 1`, `PI_FLOW_DEPTH = 1`).

### Configuration Boundary

- REA MCP registration, guardrail hooks, skills, prompts, and tools are owned by project-local Pi files under `.pi/`; setup does not write `~/.pi/agent/mcp.json` or any Claude Code settings/hooks.
- The repository intentionally contains no root `.mcp.json`, `.claude/settings*.json`, `.claude/hooks/`, or `.claude-plugin/hooks/`. `.claude/workflows/` contains opt-in workflow source files only; it is not a hooks configuration.
- The optional peer extension creates transient discovery records and authentication keys in `~/.claude/sessions/` so a running Woodchipper can appear in Claude Code's `ListAgents`. These are runtime records, not Claude settings or hooks, and are removed on clean shutdown. Start Woodchipper with `--no-peer` or `WOODCHIPPER_NO_PEER=1` to avoid those records entirely.
- Per-target investigations, Evidence Ledgers (`evidence-ledger.json`), `REPORT.md`, `TRIAGE_MAP.md`, and Pi session transcripts stay under the git-ignored `workspaces/<slug>/` directory (`~/woodchipper/workspaces/<slug>/` when installed via Homebrew), while `.woodchipper/` holds only the staged audited Pi runtime and peer socket symlink.

### 2. Progressive-Disclosure Skill Pack (`skills/woodchipper*`)

Instead of loading all 80+ upstream REA reference docs and 207 tool schemas into context at once, Woodchipper provides **1 root router skill** and **8 domain sub-skills** (each validated to stay under 500 lines):

| Skill | Target Domain & Primary REA Tools |
| :--- | :--- |
| `skills/woodchipper/` | Root router, 3-bucket epistemology (`Observations`, `Inferences`, `Unknowns`), and 5.5-series operating rules |
| `skills/woodchipper-setup/` | `rea doctor`, Ghidra 12.1.4 + Temurin 21 headless setup, MCP vs. CLI fallback, timeout recovery |
| `skills/woodchipper-native/` | PE/ELF/Mach-O/COFF/raw binaries, Go (`inspect_go_binary`), Rust (`inspect_rust_binary`), GPU/ML models, Ghidra/IDA/Hopper sessions |
| `skills/woodchipper-js-web/` | Electron/ASAR (`inspect_electron_fuses`), minified JS bundles (`analyze_javascript_application` summary paging), HAR/SAZ/mitmproxy/qlog |
| `skills/woodchipper-mobile-managed/` | Android APK/JADX/Apktool (`inspect_android_package`), Flutter (`identify_flutter_build`, `inspect_dart_aot`), Unity IL2CPP (`open_binary` + `search_strings`), Godot PCK (`inspect_artifact`), .NET (`inspect_managed_artifact`, `inspect_managed_members`), Apple `.app`/`.ipa`/`.plist` |
| `skills/woodchipper-firmware-signals/` | Firmware regions & extraction (`inspect_firmware_regions`, `extract_firmware`, `inspect_binary_layout`), WASM (`inspect_wasm_artifact`), EVM (`inspect_evm_interface`), SQLite (`inspect_sqlite_database`), PCAP (`inspect_pcap_capture`), sigrok (`decode_signal_recording`) |
| `skills/woodchipper-runtime/` | Bounded dynamic validation: Browser/Electron CDP, POSIX PTY, LLDB native calls & macOS UI inspection, Frida, GDB, Rizin |
| `skills/woodchipper-reconstruction/` | Clean-room behavioral specifications (`CLONE_SPEC.md`), native-to-WASM porting plans, `build_reconstruction_obligation_ledger`, `verify_reconstruction` |
| `skills/woodchipper-audit/` | Defensive source-to-sink trust-boundary audits, Windows/macOS kernel IOCTLs, 1-day patch diffing (`compare_application_versions`, `compare_artifacts`, `compare_functions`), crash triage (`inspect_recorded_crash`), `record_unknown` |

### 3. Operational Playbooks (`playbooks/*.md`) & Multi-Agent Workflows (`.claude/workflows/*.js`)

- **Playbooks (`playbooks/`):** Translate `JoasASantos/REA-Prompts` (REAP) human investigative goals directly into `morluto/rea` tool sequences:
  1. `playbooks/triage-and-feature-trace.md` — Unfamiliar target mapping, single-feature end-to-end call-chain tracing, and business rule recovery.
  2. `playbooks/clean-room-and-porting.md` — Copyright-clean `CLONE_SPEC.md` behavioral generation and native-to-WASM porting.
  3. `playbooks/security-and-vr.md` — Trust-boundary & source-to-sink audits, kernel IOCTL enumeration, patch diffing, and crash root-cause analysis.
  4. `playbooks/firmware-and-protocols.md` — Firmware entropy/partition mapping, headerless MCU triage, and wire-protocol/file-format recovery.
- **Workflows (`.claude/workflows/`):** Five deterministic multi-agent orchestration scripts (`triage-target.js`, `trace-feature.js`, `clean-room-spec.js`, `security-audit.js`, `version-diff.js`) using `pipeline()`, `parallel()`, `agent()`, and multi-lens adversarial verification.

---

## Toolchain, Supply Chain & Headless Ghidra Readiness (`mise` + `pnpm`)

Woodchipper uses **`mise`** (`mise.toml`) and **`pnpm`** (`pnpm@12.11.2`):

- **Pinned Runtimes (`mise.toml`):**
  - `node = "24.22.1"`
  - `pnpm = "12.11.2"`
  - `python = "3.12.15"`
  - `java = "temurin-21.0.12+101.0.LTS"`
- **Pinned Dependency, Supply-Chain & Audit Overrides:**
  - `vendor/pi`, `vendor/gliner-runner`, `jose@6.2.13`, and `fast-uri@3.1.9` are exact gitlink SHA pins with adjacent semver comments in `.gitmodules`; the machine-readable SHAs also live in `vendor/MANIFEST.json` and `vendor/overrides/manifest.json`.
  - `.pnpmfile.cjs` and `scripts/apply-pnpm-tarball-policy.mjs` enforce `pnpmTarballUrlPolicy` so `pnpm-lock.yaml` never records rotating `*.pkgs.visualstudio.com` backend shard tarball URLs, while all GitHub Actions in `.github/workflows/*.yml` are pinned to full 40-char commit SHAs with `# vX.Y.Z` semver comments.
  - `jose` and `fast-uri` remain isolated source submodules because the configured proxy does not mirror those releases. `pnpm run build:overrides` copies them into the purpose-built `vendor/overrides/Dockerfile`, builds/packages them there, and exports ignored package trees without modifying either checkout.
  - Root pnpm resolution pins proxy-available `zod@4.6.7`. Pi is copied from its immutable submodule into ignored `.woodchipper/pi`, then `vendor/overrides/pi-audit.json` applies exact proxy-available Vitest, Vite, Undici, and Zod fixes plus the Docker-built `fast-uri@3.1.9` before an offline source build.
  - The Pi overlay reduces its audit report from 14 findings (7 high, 7 moderate) to zero. Two unpatchable proxy dependencies belong only to the sandbox and Gondolin example workspaces, which the runtime build excludes; the immutable upstream checkout still retains those examples. Removal and residual-audit details are in `vendor/overrides/README.md`.
- **Headless Ghidra 12.1.4 Provider:**
  - Installed at `~/.local/share/ghidra/ghidra_12.1.4_PUBLIC` with the compiled native macOS `arm64` Mach-O decompiler (`Ghidra/Features/Decompiler/os/mac_arm_64/decompile`) and `GHIDRA_HEADLESS_MAXMEM = "4G"`.
  - `.pi/extensions/woodchipper-rea.ts` registers REA directly with Pi and exports `GHIDRA_INSTALL_DIR`, `JAVA_HOME`, and `GHIDRA_HEADLESS_MAXMEM` automatically. The repository intentionally has no root `.mcp.json`, so opening it in Claude Code does not register REA there.
  - `mise run doctor` (`pnpm run doctor`) verifies `skill:identity` and all 9 `ghidra` provider checks (`"healthy": true`, `"environment_healthy": true`); project tests verify Pi's in-process MCP registration without requiring a user-global Pi MCP entry.

---

## Quick Start & Commands

### Install via Homebrew (macOS / Linux)

```bash
brew tap stuffbucket/tap
brew install woodchipper

# Launch interactive Woodchipper TUI (writes workspaces under ~/woodchipper/workspaces/<name>/)
woodchipper
```

### Run from Source Repository (`./woodchipper` or `mise`)

```bash
# 1. Single-command post-clone launcher (auto-trusts mise.toml, runs first-time setup
#    if needed, prompts for workspace up front, and opens the Woodchipper TUI)
./woodchipper           # or: mise run start / pnpm start

# Or run the build step explicitly beforehand (requires Docker with Buildx)
mise trust
mise run setup          # or: pnpm run setup

# 2. Check REA/Ghidra readiness and run end-to-end smoke verification
mise run doctor         # or: pnpm run doctor
mise run smoke          # or: ./woodchipper smoke

# 3. Launch interactive Woodchipper Pi TUI (human TUI + live Claude Code peerProtocol:1 socket)
mise run tui            # or: pnpm run woodchipper -- tui

# 4. Run headless Woodchipper Pi peer daemon for Claude Code SendMessage / woodchipper-ctl
mise run daemon         # or: pnpm run daemon

# 5. Inspect or drive live Woodchipper / Claude Code peers over UDS
mise run ctl -- peers
mise run ctl -- status woodchipper
mise run ctl -- halt woodchipper "Stop active monitor"
mise run ctl -- ledger woodchipper
mise run ctl -- send woodchipper "Triage /bin/ls" --wait

# 6. Inspect or reclaim disk space (REA/Ghidra caches, Docker build cache, GLiNER models, inactive workspaces)
./woodchipper clean status
./woodchipper clean cache       # or: mise run clean / /clean in the TUI

# 7. Run validation, unit/integration tests (40 tests), and the 28-mutant security/logic mutation suite
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
├── woodchipper                        # Single-command post-clone launcher (mise + setup + TUI)
├── bin/
│   └── woodchipper.mjs                # Unified Pi harness launcher (tui, daemon, rpc, ask, smoke, clean, build-pi)
├── .pi/
│   ├── settings.json                  # Project-local Pi configuration (tools, skills, extensions)
│   ├── SYSTEM.md                      # Woodchipper 5.5-series system prompt addendum
│   └── extensions/
│       ├── woodchipper-maximal.ts         # Maximal preferred model provider & refusal failover
│       ├── woodchipper-rea.ts             # REA MCP wiring, GLiNER, workspaces, guardrails, tools & commands
│       ├── woodchipper-peer.ts            # Claude Code peerProtocol:1 UDS server & claude_peers tool
│       ├── pi-flow.ts                     # Standalone RISC-inspired flow-control extension (/goal /branch /loop /monitor /watch /mapreduce /halt /flow)
│       └── lib/
│           ├── maximal-provider.ts        # Maximal localhost:4141 discovery, health checks, & refusal failover
│           ├── gliner-classifier.ts       # GLiNER decide-340m zero-shot intent & capability classifier
│           ├── evidence-ledger.ts         # Atomic 0600 3-bucket Evidence Ledger (workspaces/<slug>/evidence-ledger.json)
│           ├── disk-hygiene.ts            # Cross-platform disk & resource inspection, pruning, & config thresholds
│           ├── triage.ts                  # Target-free static triage, playbook loader, & rea doctor summary
│           ├── peer-protocol.ts           # Authenticated UDS peer server, XML escaping, & peer discovery
│           ├── schema.ts                  # JSON Schema builder for Pi extension tools
│           └── pi-flow/
│               ├── fsm.ts                 # 4-state mutex FSM, fuel/TTL counters, stagnation guard, & session-fenced state
│               ├── process-tree.ts        # Cross-platform (macOS, Linux, Windows) ancestor PID tree & harness detector
│               └── runners.ts             # Predicate evaluator, unified polling runner, & single-child MapReduce runner
├── .claude-plugin/
│   ├── marketplace.json               # Stuffbucket local plugin marketplace manifest
│   └── plugin.json                    # Claude Code plugin definition
├── .claude/
│   └── workflows/                     # Deterministic multi-agent workflows (triage, trace, clone-spec, audit, diff)
├── .github/
│   ├── codeql/codeql-config.yml       # Path-filtered CodeQL configuration
│   ├── dependabot.yml                 # Grouped GitHub Actions & npm Dependabot schedule
│   └── workflows/                     # SHA-pinned CI, CodeQL, Release, and GitHub Pages workflows
├── packaging/
│   └── homebrew/woodchipper.rb        # Homebrew tap formula template rendered on release
├── site/                              # Astro + Starlight public documentation site
├── mise.toml                          # Pinned toolchain (Node, pnpm, Python, Temurin 21) & tasks
├── skills/                            # 9 progressive-disclosure skills (<500 lines each)
├── playbooks/                         # 4 human + agent operational playbooks (REAP + REA unified)
├── vendor/                            # Pinned upstream files & submodules (vendor/MANIFEST.json)
│   ├── MANIFEST.json
│   ├── pi/                            # earendil-works/pi git submodule (@earendil-works/pi-coding-agent)
│   ├── gliner-runner/                 # stuffbucket/gliner-runner git submodule (@gliner-runner/onnx-runner)
│   ├── overrides/                     # Isolated source pins, audit overlay, and Docker package builder
│   │   ├── jose/                      # panva/jose@6.2.13 git submodule
│   │   ├── fast-uri/                  # fastify/fast-uri@3.1.9 git submodule
│   │   ├── pi-audit.json              # Exact proxy fixes + documented unavailable residuals for Pi
│   │   └── packages/                  # Ignored Docker-built package trees consumed by overrides
│   ├── rea/                           # morluto/rea@6.7.0 skills, docs, contracts, bridges
│   └── rea-prompts/                   # JoasASantos/REA-Prompts catalog
├── scripts/
│   ├── apply-pnpm-tarball-policy.mjs  # Strips rotating shard tarball URLs from pnpm-lock.yaml
│   ├── build-harness.mjs              # Verifies and prepares the Woodchipper Pi harness
│   ├── build-pi-overlay.mjs           # Stages and builds audited Pi without changing its submodule
│   ├── build-vendor-overrides.mjs     # Builds isolated proxy-gap packages through Docker Buildx
│   ├── codeql-languages.mjs           # Path-aware CodeQL language matrix selector
│   ├── mutation-test.mjs              # 28-mutant security & logic mutation test runner
│   ├── render-homebrew-formula.mjs    # Renders packaging/homebrew/woodchipper.rb from release SHA256SUMS
│   ├── smoke-test.mjs                 # End-to-end smoke test against tests/fixtures/sample-electron-app
│   ├── sync-to-stuffbucket-skills.mjs # Copies skills/woodchipper* into ../skills
│   ├── update-vendor.mjs              # Updates vendor/ from upstream git repos
│   ├── validate.mjs                   # Validates skills, workflows, Pi harness, supply chain, and vendor manifest
│   └── woodchipper-ctl.mjs            # CLI controller for Claude Code & Woodchipper UDS peers
└── tests/
    ├── validate-woodchipper.test.mjs  # Skill, workflow, supply-chain, and vendor manifest tests
    ├── pi-extension.test.mjs          # Woodchipper REA Pi extension, git blocker, & Evidence Ledger tests
    ├── peer-extension.test.mjs        # Claude Code peerProtocol:1 UDS auth, loop prevention, & A2A tests
    ├── maximal-extension.test.mjs     # Maximal provider discovery, auth priority, & refusal failover tests
    └── pi-flow.test.mjs               # Pi Flow FSM, stagnation, cross-platform PID tree, MapReduce depth=1, & /halt tests
```
