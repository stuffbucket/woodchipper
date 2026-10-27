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

## Summary-first analysis and context protection

Large inspections return a summary and a parent evidence ID (`ev_...`). Woodchipper then reads only the pages
needed for the current question via `inspect_analysis_view`. This applies across all 14 `detail`-capable REA `6.7.0` tools (`analyze_javascript_application`, `inspect_binary_layout`, `inspect_macho`, `inspect_artifact`, `inspect_managed_artifact`, `inspect_managed_members`, `inspect_wasm_artifact`, `inspect_web_network_capture`, `decode_interface_builder`, `inspect_evm_interface`, `inspect_android_package`, `inspect_pcap_capture`, `inspect_dart_aot`, and `get_evidence_bundle`).

Oversized tool results (>32,000 characters) have their `ev_*` IDs scraped into the workspace ledger first and are automatically capped with a retained-evidence paging hint. During automatic context compaction, Woodchipper preserves all `ev_*` receipts, virtual addresses, and unresolved unknowns via a persistent workspace Evidence Anchor.

## Isolated per-target workspaces (`workspaces/<slug>/`)

Every target or named investigation receives its own git-ignored directory under `workspaces/<slug>/` (configured up front on launch or switched via `/workspace <name>`):

- `workspaces/<slug>/REPORT.md` — human-readable Three-Bucket Evidence Report updated automatically as findings are recorded;
- `workspaces/<slug>/TRIAGE_MAP.md` — target-free static reconnaissance summary;
- `workspaces/<slug>/evidence-ledger.json` — structured JSON ledger;
- `workspaces/<slug>/sessions/` — isolated Pi session transcripts (never written to global `~/.pi/agent/sessions`).

Both the repository `.gitignore` and `workspaces/.gitignore` (`*`) ignore all workspace contents so reverse-engineering artifacts and reports are never committed to Git.

## Report checklist

Before using a result, check that:

- the target identity and digest are present;
- consequential claims point to evidence;
- confidence appears only on inferences;
- dynamic behavior is not claimed from static presence alone;
- unexamined paths and tool limits are listed;
- each important unknown has a next check.
