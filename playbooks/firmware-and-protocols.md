# Playbook 4: Firmware, Protocols, File Formats & Defensive Protection Research

Derived from `REA-Prompts` (Sections 3, 7, 12, 13, and 14) and `morluto/rea`'s firmware, packet,
signal, and binary diagnostics workflows.

> **Responsible Research Rule:** Use only on hardware, firmware, and software you own or are
> explicitly authorized to inspect (interoperability, defensive hardening, CTFs, academic research).
> Document algorithms and detection surfaces—do not patch or bypass third-party licensing or live
> multiplayer protections.

---

## 1. Firmware Image & Embedded MCU Triage

**When to use:** Analyzing router/IoT firmware images (`.bin`, `.img`) or raw microcontroller blobs
(ARM, MIPS, RISC-V, m68k, 6502).

### Agent Execution Sequence

1. **Container & Region Triage (Static Only):**
   - Run `inspect_firmware_regions` and `inspect_binary_layout` (`detail: "summary"`) to identify SquashFS, JFFS2, UBI, cramfs, bootloaders, and kernels with exact byte offsets.
   - Extract partitions into a new empty folder via `extract_firmware`.
2. **Headerless MCU / Raw Binary Mapping:**
   - Open raw firmware in Ghidra (`open_binary` with `format: "raw-binary"`, `architecture`, and `entry_point`).
   - Locate vector tables, reset handlers, peripheral MMIO base addresses (UART, SPI, I2C, radio), and RTOS fingerprints (FreeRTOS, Zephyr) via strings and literal pools.
3. **OTA & Network Surface:**
   - Trace hardcoded endpoints, MQTT/HTTP parsers, OTA signature verification routines, and embedded keys/certificates with function address citations.

---

## 2. Binary File-Format & Wire-Protocol Extraction

**When to use:** Recovering a proprietary file format, IPC message schema, or network wire protocol
to build an interoperable reader/decoder.

### Agent Execution Sequence

1. **Locate Parser & Serializer Routines:**
   - Trace from file open/read calls or network socket handlers (`search_strings`, `search_procedures`, `xrefs`, `analyze_function`).
   - If saved traffic exists, inspect `.pcap`/`.pcapng` (`inspect_pcap_capture`, `inspect_packet_capture`), `.har`/`.saz` (`inspect_web_network_capture`), or logic-analyzer traces (`decode_signal_recording`).
2. **Recover Field-by-Field Schema:**
   - Document magic bytes, version headers, field offsets, byte widths, endianness, varint/TLV framing, and checksum/CRC algorithms.
3. **Deliverable:**
   - Produce a self-contained Python/TypeScript struct or protobuf reader plus a decoded example message built from the binary's constants.

---

## 3. Defensive Protection, Anti-Cheat & CTF Algorithm Documentation

**When to use:** Evaluating the strength of your own product's protection, studying defensive
anti-cheat/IOMMU/DMA telemetry in a lab you own, or solving CTF/crackme challenges.

### Agent Execution Sequence

1. **Protection & Telemetry Surface Mapping:**
   - Identify integrity checks, anti-debug/anti-VM probes, process/module/PCIe/IOMMU enumeration routines, and license/flag validation functions (`analyze_function`, `procedure_assembly`).
   - Separate "code present statically" from "behavior observed at runtime."
2. **Algorithm Documentation & Hardening Assessment:**
   - For CTFs / algorithm recovery: Decompile the validation transform, document the exact mathematical constraints (`address → instruction → conclusion`), and write a standalone verification harness.
   - For defensive product assessment: Classify checks as **load-bearing** vs. **cosmetic/trivially bypassable**, and recommend concrete architectural hardening mapped to exact code locations.
