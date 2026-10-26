---
title: Evidence and reports
description: How Woodchipper separates direct evidence, conclusions, and unresolved gaps.
---

Woodchipper uses three result types. Keep them separate in every report.

## Observation

An observation is returned directly by a tool. It should include enough information to find the
same item again:

- an REA `evidence_id`;
- an address range, file offset, module node ID, or file path;
- the target digest when the result depends on a specific artifact.

Example format:

```text
Observation · ev_014 · module node_203
The main process registers the "export-document" IPC handler.
```

## Inference

An inference is a conclusion drawn from observations. State its confidence and an alternative
explanation.

```text
Inference · high confidence
The renderer uses this handler for the Export action.
Alternative: another module calls the same handler directly.
```

Do not present an inference as a tool result.

## Unknown

An unknown is an important path, value, or behavior that has not been verified.

```text
Unknown
The export destination is computed at runtime.
Next check: capture one authorized export and correlate the filesystem write with ev_014.
```

A useful unknown includes the next check. It should not be a general statement that more work is
possible.

## Summary-first analysis

Large inspections return a summary and a parent evidence ID. Woodchipper then reads only the pages
needed for the current question. This applies to large JavaScript applications, binary layouts,
Mach-O files, managed assemblies, WASM artifacts, and web captures.

## Report checklist

Before using a result, check that:

- the target identity and digest are present;
- consequential claims point to evidence;
- confidence appears only on inferences;
- dynamic behavior is not claimed from static presence alone;
- unexamined paths and tool limits are listed;
- each important unknown has a next check.
