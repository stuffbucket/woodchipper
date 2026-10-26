---
title: Examples
description: Common Woodchipper jobs with requests to enter and report sections to check.
sidebar:
  label: Overview
---

Each example starts with an authorized artifact on disk. Run `mise run tui`, then enter the request
shown on the page.

The examples show report structure rather than fixed output. Addresses, modules, and evidence IDs
come from the target being inspected.

## Start with a map

| Job | Use it when | Result |
| --- | --- | --- |
| [Triage a target](/woodchipper/examples/triage/) | You have not inspected the artifact before | Identity, subsystem map, next investigation points |
| [Trace a feature](/woodchipper/examples/feature-trace/) | You need one end-to-end behavior | Hop table with calls, data changes, and side effects |

## Produce a specification or finding

| Job | Use it when | Result |
| --- | --- | --- |
| [Write a clean-room spec](/woodchipper/examples/clean-room-spec/) | A separate team will implement compatible behavior | Evidence-linked requirements and unknowns |
| [Audit a trust boundary](/woodchipper/examples/security-audit/) | You need to inspect untrusted inputs and sensitive operations | Source-to-sink paths, guards, preconditions, and validation steps |

## Compare or unpack artifacts

| Job | Use it when | Result |
| --- | --- | --- |
| [Compare two versions](/woodchipper/examples/version-diff/) | A release changed behavior or may contain a security fix | Changed functions, behavior, callers, and residual variants |
| [Inspect firmware](/woodchipper/examples/firmware/) | You have a firmware image or raw MCU binary | Regions, filesystems, boot path, interfaces, and update checks |

## Before using a report

Check the [evidence rules](/woodchipper/evidence/). Static presence does not prove runtime
reachability. An unverified path belongs under **Unknowns**, with the next check needed to resolve it.
