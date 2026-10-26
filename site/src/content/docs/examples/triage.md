---
title: Triage an unfamiliar target
description: Identify an artifact, map its main components, and choose the next investigation points.
---

Use triage before tracing a feature or opening a large disassembly session.

## Run it

```text
/triage /path/to/target
```

You can also state the target type when known:

```text
Triage /Applications/Example.app. Map native code, Electron or web content, IPC, local data, and network endpoints. Do not execute it.
```

## What Woodchipper does

1. fingerprints the artifact and records its digest;
2. identifies the format, architecture, runtime, or container;
3. runs path-based static inspection before opening a disassembler session;
4. groups findings by subsystem such as network, filesystem, database, IPC, crypto, and UI;
5. names specific functions, modules, or channels for the next trace.

## Check the report

The report should contain:

```text
Target identity
- path and SHA-256
- format, architecture, runtime or compiler
- provider and tool limits

Subsystem map
- component
- entry point or module
- evidence ID and location

Next investigation points
- three specific functions, channels, or modules

Unknowns
- packed, generated, dynamic, or unexamined areas
```

Do not accept a generic recommendation such as "inspect the network code next." The report should
name the procedure, module, endpoint, or IPC channel to inspect.
