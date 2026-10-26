---
title: Audit a trust boundary
description: Trace untrusted inputs to sensitive operations and record the checks on each path.
---

Use this only for software you own or are authorized to test. Static findings are candidates until
reachability and impact are verified.

## Run it

```text
/audit /path/to/target
```

A narrow request gives a better result:

```text
Audit exported Android components. Trace intent and deep-link inputs to file access, command execution, WebView navigation, and database queries. Record every validation check and stop before dynamic testing.
```

## What Woodchipper does

1. lists entry points that accept files, network data, IPC, intents, environment values, or command-line input;
2. lists sensitive operations such as process launch, unsafe memory copies, file writes, external URL opening, and SQL execution;
3. traces candidate paths between each source and sink;
4. records bounds checks, allowlists, authentication, and other guards;
5. states the preconditions and smallest controlled validation step.

## Check the report

| Field | Required content |
| --- | --- |
| Source | Address or node, evidence ID, and attacker-controlled fields |
| Sink | Address or node, evidence ID, and sensitive operation |
| Guards | Checks observed on the path, including failure branches |
| Reachability | Observed, inferred, or unknown |
| Preconditions | Permissions, state, format, or user action required |
| Impact | What could happen if the path is reachable |
| Next check | A minimal authorized validation step |

Do not treat a dangerous import, API name, or static call as a confirmed vulnerability by itself.
