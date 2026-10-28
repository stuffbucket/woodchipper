---
title: What it does
description: Capabilities, limits, and when Woodchipper is the right tool.
---

Woodchipper helps an agent inspect software artifacts when source code is missing, incomplete, or
not the final authority for what shipped.

## Use Woodchipper for

- native PE, ELF, Mach-O, COFF, DOS, and raw binaries;
- Electron applications, ASAR archives, JavaScript bundles, HAR files, and web captures;
- Android packages, Flutter applications, .NET assemblies, Unity IL2CPP, and Apple bundles;
- firmware images, raw MCU code, WASM, EVM bytecode, SQLite files, packet captures, and logic traces;
- recorded crashes and core dumps;
- clean-room behavior specifications;
- defensive source-to-sink audits;
- behavioral comparisons between versions.

## Use normal repository tools instead when

You have a complete source repository and the question can be answered by reading, searching,
building, or testing that source. Woodchipper adds value when the claim depends on a compiled or
packaged artifact.

## What Woodchipper controls

Woodchipper:

1. identifies the target before opening a large analysis session;
2. selects inspection tools that match the artifact;
3. requests summaries before large symbol tables, bundle maps, or decompilations;
4. keeps evidence IDs and artifact locations with findings;
5. separates observations, inferences, and unknowns;
6. uses runtime inspection only when static evidence is not enough and the scope allows it.

## What it does not do

Woodchipper does not:

- make an unknown binary safe to run;
- grant authorization to inspect third-party software;
- turn a static code path into proof that the path is reachable;
- copy proprietary source, assets, branding, or license material into a clean-room specification;
- remove the need for a reviewer;
- merge or deploy a result by itself.

A report can end as inconclusive. The report should state the missing evidence and the next bounded
check that could resolve it.

## Local configuration, model resilience, and zero-jargon routing

REA registration (`rea-agents@6.7.0`), prompts, skills, hooks, the GLiNER (`decide-340m`) classifier (`vendor/gliner-runner`), the `maximal` provider (`http://127.0.0.1:4141`), and per-target workspaces (`workspaces/<slug>/`) are self-contained inside the project-local Pi harness:

- **Appliance-to-Expert Adaptation & Proactive Feedback:** By default, Woodchipper operates as an autonomous reverse-engineering appliance—translating plain-English questions via GLiNER (`decide-340m`, auto-pulled into `vendor/gliner-runner/models` when needed) into the right playbook and sub-skill without requiring domain jargon. As the user demonstrates reverse-engineering fluency, it escalates technical depth while still pushing back constructively against premature dynamic execution or whole-binary dumps.
- **Maximal Provider & Automatic Refusal Failover:** Connects to `maximal` on `http://127.0.0.1:4141` (`claude-sonnet-5-5-20260301` default) and automatically fails over across `claude-sonnet-5-5-20260301 -> gemini-4-argon -> gpt-5.3-codex -> gpt-6` if an upstream model endpoint triggers a false-positive cyber-policy refusal.
- **Deterministic Flow Control (`pi-flow`):** Includes a standalone, cross-platform (`darwin`, `linux`, `win32`) RISC-inspired flow-control extension (`.pi/extensions/pi-flow.ts`) providing `/goal`, `/branch`, `/loop`, `/monitor` (`/watch`), single-child `/mapreduce` (`PI_FLOW_DEPTH=1`), and `/halt` with monotonic fuel/TTL budgets, 3-turn stagnation detection, and ancestor PID deadlock guards.
- **Zero Global State Leakage:** Setup does not add global Claude Code hooks or MCP settings, blocks global `~/.agents/skills`, and isolates XDG and session state inside `workspaces/`. The optional local peer socket can be disabled with `--no-peer` or `WOODCHIPPER_NO_PEER=1`.
