---
title: Trace one feature
description: Follow a user action, command, or message to its final side effect.
---

Choose one visible behavior. Good starting points include a menu label, command-line flag, log key,
IPC channel, URL path, or error message.

## Run it

```text
/trace /path/to/target "Export the current document"
```

Or enter a more specific request:

```text
Trace the --sync command from argument parsing to the final network request. Include process boundaries, input transformations, and error paths. Stop after the request is submitted.
```

## What Woodchipper does

- finds a static seed such as a string, command flag, handler, or exported symbol;
- follows callers, callees, references, or module edges;
- records both sides of IPC, RPC, JNI, native-addon, or process boundaries;
- identifies data transformations and final side effects;
- records indirect or runtime-only branches as unknowns.

## Check the report

The main table should use this shape:

| Hop | Layer | Function or module | Address or node | Evidence | Transformation or side effect |
| --- | --- | --- | --- | --- | --- |
| 1 | Entry | Named seed | Location | Evidence ID | Input accepted |
| 2 | Dispatch | Handler | Location | Evidence ID | Input validated or changed |
| 3 | Boundary | IPC, RPC, or call | Both sides | Evidence IDs | Data crosses boundary |
| 4 | Effect | Filesystem, network, database, or UI | Location | Evidence ID | Final effect |

A matching string on each side of a boundary is useful evidence, but it is not proof of runtime use.
Ask for a bounded runtime check if reachability matters and execution is authorized.
