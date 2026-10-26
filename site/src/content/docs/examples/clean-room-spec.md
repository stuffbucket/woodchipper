---
title: Write a clean-room specification
description: Record compatible behavior without copying implementation code or protected assets.
---

Use this when a separate implementation team needs behavior, data contracts, and acceptance tests.
Do not use it to copy source, assets, branding, license keys, or other protected material.

## Run it

```text
/clone-spec /path/to/target
```

For a narrower result:

```text
Write a clean-room specification for the target's project-file parser. Cover the header, record layout, version handling, errors, and round-trip behavior. Mark every unverified rule as unknown.
```

## What Woodchipper records

- inputs, outputs, and error behavior;
- state transitions and boundary conditions;
- file, database, network, and IPC schemas;
- user-visible commands and interactions when they matter to compatibility;
- acceptance obligations for an independent implementation.

## Check the report

Each requirement should cite evidence or state that it is unknown:

```text
REQ-FILE-004
The reader rejects a record whose declared size exceeds the remaining bytes.
Evidence: ev_031 at function 0x... and branch 0x...

REQ-FILE-005
The handling of duplicate record IDs is unknown.
Next check: construct a two-record input with the same ID and compare the result.
```

The specification should state behavior. It should not reproduce decompiled source as the proposed
implementation.
