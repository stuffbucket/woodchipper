---
title: Supported targets
description: Target types and the first Woodchipper analysis path for each one.
---

Start with `/triage /path/to/target`. The table shows the analysis path Woodchipper should select.

| Target | Examples | First analysis path |
| --- | --- | --- |
| Native binary | PE, ELF, Mach-O, COFF, DOS, raw image | Format and layout, imports, strings, compiler/runtime markers |
| Go or Rust binary | Statically linked executables | Language metadata before general disassembly |
| Electron or JavaScript | `.app`, `.exe`, `app.asar`, minified bundles | Application and bundle summary, modules, IPC and API surfaces |
| Web capture | HAR, SAZ, mitmproxy, qlog | Hosts, requests, responses, cookies, headers, and protocol metadata |
| Android | APK, split APK, extracted package | Manifest, exported components, resources, classes, and references |
| Managed code | .NET PE/CLI, NativeAOT | Assembly metadata, types, members, and native boundaries |
| Flutter or Unity | Flutter bundle, IL2CPP metadata | Framework identification, metadata, native libraries, and assets |
| Apple bundle | `.app`, IPA, DMG, plist, NIB, CAR | Bundle inventory, plist data, interfaces, assets, and native code |
| Firmware | `.bin`, `.img`, UBI, SquashFS, raw MCU image | Entropy, regions, filesystems, boot code, and update paths |
| WASM or EVM | `.wasm`, contract bytecode | Imports, exports, interfaces, code structure, and storage behavior |
| Data or traffic | SQLite, PCAP, PCAPNG, sigrok | Schema, packets, streams, or decoded signal frames |
| Crash evidence | crash log, stack trace, ELF core | Registers, fault location, threads, and static localization |
| Model artifact | GGUF, Safetensors | Metadata, tensors, shapes, and format checks |

## Static and runtime work

Static tools read files and do not execute the target. Woodchipper uses them first.

Runtime tools include browser or Electron debugging, process capture, LLDB, GDB, Frida, and macOS UI
inspection. Use them only when:

- static evidence leaves a specific question open;
- the target is authorized for execution;
- the containment and stop conditions are stated.
