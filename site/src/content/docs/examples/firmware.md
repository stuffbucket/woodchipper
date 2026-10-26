---
title: Inspect firmware
description: Map firmware regions, filesystems, boot code, interfaces, and update verification.
---

Use this for firmware and hardware you own or are authorized to inspect. Start with static analysis.

## Run it

```text
Triage /path/to/firmware.bin as firmware. Map entropy, partitions, filesystems, boot code, processor architecture, network services, and the update verification path. Do not execute extracted files.
```

For a raw MCU image, include known loading information:

```text
Inspect /path/to/controller.bin as a raw ARM Cortex-M image loaded at 0x08000000. Locate the vector table, reset handler, memory-mapped peripherals, RTOS markers, and command parser.
```

## What Woodchipper does

- maps entropy and byte regions before extraction;
- identifies known filesystems, kernels, bootloaders, and compressed regions;
- extracts content to a separate directory when requested;
- locates vector tables, reset handlers, peripheral addresses, and RTOS markers in raw images;
- traces network parsers, update handlers, signature checks, and embedded credentials or certificates.

## Check the report

The report should include exact offsets for regions and extracted files. For raw firmware, it should
state the assumed architecture, base address, and entry point. If any of those are guessed, they
belong under inferences with competing values.

For update verification, ask for the complete path from update input to signature or hash decision.
A certificate or crypto import alone does not show that updates are checked.
