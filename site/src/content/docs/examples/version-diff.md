---
title: Compare two versions
description: Find changed behavior, inspect related callers, and separate code changes from build noise.
---

Use version comparison for regressions, patch review, and defensive incomplete-fix checks.

## Run it

In the TUI, provide both paths and the question:

```text
Compare /path/to/version-1 and /path/to/version-2. Identify changed behavior in the file parser, show the checks added or removed, and inspect callers and sibling parsers for variants. Ignore signing and layout-only changes.
```

When using Claude Code, you can also ask to run Woodchipper's opt-in `version-diff` workflow for the
two artifacts.

## What Woodchipper does

- identifies both artifacts and records their digests;
- compares modules, exports, strings, and function inventories;
- matches native functions or JavaScript modules across versions;
- decompiles or expands only the changed areas needed for the question;
- classifies changes as behavioral, structural, generated, signed, or unresolved;
- checks callers and related functions for variants of the same bug or validation gap.

## Check the report

The report should distinguish:

- **added behavior**;
- **removed behavior**;
- **changed guards or bounds checks**;
- **changed callers or data flow**;
- **build noise** such as addresses, signatures, or generated metadata;
- **unmatched functions or modules** that still need inspection.

A security patch pattern is evidence of a possible issue in the older version. It is not proof of
exploitability without reachability, preconditions, and impact.
