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

## Install

```sh
git clone https://github.com/stuffbucket/woodchipper.git
cd woodchipper
mise trust
mise run setup
```

Setup can take several minutes because it builds the local runtime and checks its dependency graph.

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

The TUI accepts normal requests and these direct commands:

```text
/triage /path/to/target
/trace /path/to/target "feature or behavior"
/clone-spec /path/to/target
/audit /path/to/target
/ledger
/doctor
```

Start with `/triage` if you do not know which analysis path applies.

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
