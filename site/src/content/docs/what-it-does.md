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

## Local configuration

REA registration, prompts, skills, hooks, and the evidence ledger are part of the project-local Pi
harness. Setup does not add global Claude Code hooks or MCP settings. The optional local peer can be
disabled with `--no-peer` or `WOODCHIPPER_NO_PEER=1`.
