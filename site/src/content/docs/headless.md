---
title: Run headless
description: Start the Woodchipper daemon and send work from a terminal or local Claude Code session.
---

The interactive TUI is the simplest way to start. Use the daemon when another local process or
Claude Code session should submit work.

## Start the daemon

```sh
mise run daemon
```

The daemon registers an authenticated local peer and listens on a Unix domain socket. It does not
open a network port.

## List peers

In another terminal:

```sh
mise run ctl -- peers
```

## Check status

```sh
mise run ctl -- status woodchipper
```

## Send a task

```sh
mise run ctl -- send woodchipper \
  "Triage /path/to/target. Return observations, inferences, and unknowns." \
  --wait
```

Use `--steer` for streaming control when needed.

## Read the evidence ledger

```sh
mise run ctl -- ledger woodchipper
```

## Use a local Claude Code session

A running Woodchipper appears as a local peer. Discover it with `ListAgents`, then send a bounded
request to the peer named `woodchipper`.

The peer records and socket are runtime state, not Claude Code configuration. They are removed on a
clean shutdown. Start the TUI with `--no-peer`, or set `WOODCHIPPER_NO_PEER=1`, when peer discovery is
not wanted.
