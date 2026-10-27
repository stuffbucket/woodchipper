---
title: Get started
description: Install Woodchipper, check REA and Ghidra, and inspect the first target.
---

Woodchipper runs from its repository. It uses a project-local Pi harness and a local REA server.

## Before you start

You need:

- Git;
- [mise](https://mise.jdx.dev/);
- Docker with Buildx for the first setup;
- an artifact you own or are authorized to inspect.

The first setup installs pinned Node, pnpm, Python, and Java versions, initializes the Git submodules,
builds two temporary dependency packages in Docker, and builds the local Pi runtime.

## Install & Launch (Single Command)

```sh
git clone https://github.com/stuffbucket/woodchipper.git
cd woodchipper
./woodchipper
```

Or using `mise`:

```sh
mise run start
```

On first launch, `./woodchipper` (and `mise run start`) automatically trusts `mise.toml`, installs the pinned toolchain if missing, runs the one-time setup if the harness has not been built yet, and opens the interactive Woodchipper TUI. On every subsequent launch it opens the TUI immediately.

If you prefer to run the build step separately beforehand:

```sh
mise run setup
```

## Check the tools

```sh
mise run doctor
```

The check covers REA, the skill installation, Java, and headless Ghidra. Fix a failed check before
running an investigation.

## Open Woodchipper

```sh
mise run tui
```

You can also verify the entire harness end-to-end against the bundled sample Electron application in two seconds:

```sh
mise run smoke
```

The TUI displays an orientation banner on startup and accepts plain-English questions as well as direct slash commands:

```text
/start /path/to/target
/triage /path/to/target
/trace /path/to/target "feature or behavior"
/clone-spec /path/to/target
/audit /path/to/target
/gliner [status|ensure-model|classify <text>]
/maximal [status|models|refresh|use <model-id>]
/ledger
/doctor
```

Start with `/start /path/to/target` or simply ask a plain-English question (for example, `"What is /path/to/target and does it phone home?"`). Every target automatically receives its own isolated workspace under `workspaces/<target-slug>/` containing `REPORT.md`, `TRIAGE_MAP.md`, `evidence-ledger.json`, and `sessions/`.

## First triage

```text
/triage /Applications/Example.app
```

For a binary:

```text
/triage /path/to/program
```

For firmware:

```text
/triage /path/to/router-firmware.bin
```

The first report should include:

- the target path, digest, format, and architecture or runtime;
- the major components and entry points found by static inspection;
- specific functions, modules, or channels worth tracing next;
- tool limits and unexamined areas.

Woodchipper uses static inspection first. It should ask before running a target or attaching a
runtime tool when the request did not already authorize that step.

## Ask the next question

After triage, ask one narrow question:

```text
Trace what happens when the user selects Export. Stop at the final filesystem or network side effect.
```

```text
List the externally reachable IPC handlers and show the validation on each input.
```

```text
Recover the file header and record layout used by this parser. Produce a small reader and tests.
```

Use `/ledger` to inspect the evidence recorded during the session.

## Next

- [What it does](/woodchipper/what-it-does/)
- [Supported targets](/woodchipper/supported-targets/)
- [Examples](/woodchipper/examples/)
- [Run headless](/woodchipper/headless/)
