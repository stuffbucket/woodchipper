---
name: woodchipper-firmware-signals
description: Reverse engineer embedded firmware images (Binwalk, Unblob, byte entropy, headerless raw MCU blobs), WebAssembly (WASM / WAT), Ethereum EVM bytecode, SQLite database snapshots, packet captures (PCAP / TShark), and logic-analyzer signal recordings (sigrok) using REA. Use when analyzing firmware, IoT blobs, smart contracts, WASM modules, SQLite stores, network pcaps, or hardware logic traces.
license: MIT
metadata:
  author: stuffbucket
  version: "1.0.0"
---

# Woodchipper Firmware, WASM, EVM, SQLite, Packets & Signals

Use this skill for firmware images, MCU dumps, WebAssembly modules, EVM bytecode, SQLite databases,
recorded network packets (`.pcap`/`.pcapng`), and logic-analyzer captures.

## 1. Firmware Images & Headerless MCU Blobs

1. **Entropy & Region Triage:**
   - Run `inspect_byte_entropy` on the image to spot compressed/encrypted partitions vs. code/strings.
   - Run `inspect_firmware_regions` (uses Binwalk/Unblob on Linux) to identify partition tables, SquashFS/JFFS2/UBI/cramfs filesystems, bootloaders, and kernels.
2. **Controlled Extraction:**
   - Call `extract_firmware` with a caller-selected **new absolute output directory** to unpack filesystems and hand off extracted ELF/raw binaries to `woodchipper-native`.
3. **Headerless Raw Firmware / MCU Dumps:**
   - When opening a raw binary without ELF/PE/Mach-O headers in Ghidra, call `open_binary` with `format: "raw-binary"`, `architecture` (`x86`, `x86_64`, `arm`, `arm64`, `6502`, or `m68k`), and `entry_point` (`0x...` hex).

## 2. WebAssembly (WASM) & EVM Bytecode (Target-Free)

- **WebAssembly (`inspect_wasm_artifact`):**
  - Requires WABT 1.0.42 (`REA_WABT_BIN_DIRECTORY`). Pass `detail: "summary"` first to retain full Evidence and get validation, section counts, and WAT identity.
  - Page `exports`, `imports`, `sections`, `candidates`, `glue`, or `WAT` text (UTF-16 code unit offsets) via `inspect_analysis_view` (`view: {kind: "wasm", facet: "exports", offset: 0, limit: 32}`).
  - Compare two WASM modules with `compare_wasm_interfaces`.
- **EVM Bytecode (`inspect_evm_interface`):**
  - Pass a local file with `encoding: "raw"` or `"hex"` and `detail: "summary"`.
  - Extracts dispatch selectors, byte offsets, inferred argument types, and mutability via offline `evmole` (no chain RPC lookup or execution). Page via `inspect_analysis_view` using `parent_evidence_id`.

## 3. SQLite Database Snapshots (`inspect_sqlite_database`)

- Requires Node.js 24.15+ or 26+. Operates on a private copy of the database and sibling `-wal` (preserving both SHA-256 digests).
- **Schema-first discipline:** Call `inspect_sqlite_database` with no table to get the compact table inventory, or pass `schema_scope: "database"` for full schema DDL.
- When sampling rows, specify an exact ordinary `table`, explicit `columns` (to avoid huge blobs), and `row_limit` (default 20). Remember row order is unspecified and views/virtual tables are schema-only.

## 4. Recorded Network Packets (PCAP / PCAPNG)

Never performs live network capture; operates strictly on saved capture files:

- **High-Level Endpoint / DNS / TLS SNI / HTTP Summary:**
  - Call `inspect_pcap_capture` (`detail: "summary"`) using Wireshark 4.x `tshark` and `capinfos`, then page via `inspect_analysis_view` (`kind: "pcap"`).
- **Selected Field & Filter Extraction:**
  - First discover valid protocol/field names with `inspect_packet_fields`.
  - Then call `inspect_packet_capture` with explicit TShark fields, display filters, and decode-as rules (`match_offset` / `match_limit`, default 50 matching frames).

## 5. Recorded Logic-Analyzer Signals (sigrok)

- First query installed decoders, channels, and options via `inspect_signal_decoders`.
- Then call `decode_signal_recording` with explicit decoder, channel mapping, and protocol options (`REA_SIGROK_COMMAND`, sigrok-cli 0.7.2). Page literal output lines with `line_offset` / `line_limit` (default 50).

## Deep References

- Guides: `vendor/rea/docs/firmware-analysis.md`, `vendor/rea/docs/raw-binary.md`, `vendor/rea/docs/wasm-artifacts.md`, `vendor/rea/docs/evm-bytecode.md`, `vendor/rea/docs/sqlite-databases.md`, `vendor/rea/docs/packet-captures.md`, `vendor/rea/docs/pcap-analysis.md`, `vendor/rea/docs/signal-recordings.md`
