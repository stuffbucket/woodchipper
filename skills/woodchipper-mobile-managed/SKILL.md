---
name: woodchipper-mobile-managed
description: Reverse engineer Android APKs (JADX, Apktool, JEB, ADB), Flutter apps, Unity IL2CPP metadata, Godot PCK archives, .NET managed PE/CLI assemblies, .NET NativeAOT binaries, Apple macOS/iOS bundles (.app, IPA, DMG, plists, Interface Builder NIBs, Asset Catalogs), and PyInstaller executables using REA. Use when analyzing mobile apps, game engines, managed .NET code, or packaged app bundles.
license: MIT
metadata:
  author: stuffbucket
  version: "1.0.0"
---

# Woodchipper Mobile, Managed & Packaged Application Analysis

Use this skill for Android/Flutter/JEB targets, .NET/Unity/Godot targets, Apple `.app`/IPA/DMG
bundles, and PyInstaller or archive containers.

## 1. Android APKs, Resources, JEB & ADB

- **Static Decompilation (JADX — Target-Free):**
  - Do NOT call `open_binary`. Call `inspect_android_package` on the APK path for manifest permissions, exported components, and coverage.
  - Follow up with `search_android_classes`, `inspect_android_class` (check `overload_index` for overloaded methods), `inspect_android_method`, and `trace_android_references`.
  - Requires `REA_JADX_MCP_JAR` (0.7.1) and full JDK 17+ (`JAVA_HOME`).
- **Android Resources (Apktool — Target-Free):**
  - Call `decode_android_resources` for decoded `AndroidManifest.xml`, string tables, locales, and version facts without running JADX.
- **JEB Decompiler Projects:**
  - With `REA_JEB_MCP_URL` pointing to a JEB MCP server, use `open_jeb_project`, `list_jeb_units`, and `decompile_jeb_item`.
- **Android Devices via ADB:**
  - Use `list_adb_devices`, `inspect_adb_device`, `list_adb_packages`, `inspect_adb_package`, `pull_adb_package`, `read_adb_logcat`, `capture_adb_screen`.
- **Epistemic Rule for Android:** Strings or domain names in an APK are static observations; never conclude a domain is contacted at runtime from a string literal alone.

## 2. Game Engines: Flutter, Unity IL2CPP & Godot PCK

- **Flutter APKs (Built-in Static):**
  - Call `identify_flutter_build` and `inspect_dart_aot` (`detail: "summary"`) directly on the APK (no Flutter SDK needed) to recover Dart snapshot hashes, per-ABI `libapp.so`/`libflutter.so` digests, and engine build provenance.
- **Unity IL2CPP (`GameAssembly.dll` / `libil2cpp.so` + `global-metadata.dat`):**
  - Open `GameAssembly.dll` or `libil2cpp.so` with `open_binary` and correlate recovered string literals and symbol names (`search_strings`, `list_names`, `inspect_binary_layout`) against `global-metadata.dat`.
- **Godot PCK Archives (Built-in Static v2, v3, v4):**
  - Call `open_binary` then `inspect_artifact` (`detail: "summary"`), or CLI `inspect-artifact --detail summary --evidence_output PATH` (which also detects embedded EOF-trailer PCKs). Page via `inspect_analysis_view` (`kind: "inventory"`).

## 3. .NET Managed PE/CLI & NativeAOT

- **Standard Managed PE/CLI (Built-in Execution-Free):**
  - Call `inspect_managed_artifact` (`detail: "summary"`) for MVID, frameworks, references, and resources, then page via `inspect_analysis_view` (`kind: "managed"`).
  - Call `inspect_managed_members` (`detail: "summary"`, `type_names: [...]`) and page `types`, `methods`, `fields`, `call_edges`, `field_accesses`, or `user_strings` via `inspect_analysis_view` (`kind: "managed-members"`).
  - Use `inspect_managed_native_boundaries` to map P/Invoke and COM interop boundaries.
- **.NET NativeAOT:**
  - NativeAOT compiles to native machine code (no CIL bodies). Route through `woodchipper-native` (`open_binary` with Ghidra) + REA's built-in .NET 8 RTR 9.1 snapshot parser (`vendor/rea/docs/ghidra-nativeaot.md`).

## 4. Apple Bundles (`.app`, IPA, DMG) & PyInstaller

- **Apple Plists, Keyed Archives, NIBs & Asset Catalogs:**
  - Target-free plist/archive inspection: call `inspect_plist` (`path`) or `inspect_keyed_archive` (`path`).
  - Active-session bundle resource inspection: call `open_binary` on the `.app` or resource file, then use `decode_interface_builder` (`detail: "summary"`, NIB/Storyboard) or `inspect_asset_catalog` (`Assets.car`).
- **Apple Bundle Graph & Dylib Resolution:**
  - Call `open_binary` + `inspect_artifact` (`detail: "summary"`), then pass the inventory to `project_apple_application_graph` to map XPC services, app extensions, frameworks, and privileged helpers.
  - Call `trace_dylib_resolution` to resolve `@rpath`, `@loader_path`, and `@executable_path` across the bundle.
- **PyInstaller Executables & General Archives (ZIP/APK/IPA/MSIX/DMG):**
  - Call `open_binary` on the executable or archive, then `inspect_artifact` (`detail: "summary"`). For PyInstaller, the CArchive is the application layer (the native prefix is just the bootloader). Call `extract_artifact` when materialized files are needed in an owned temp folder.

## Deep References

- Android reference: `vendor/rea/skills/reverse-engineer-anything/references/android-applications.md`
- Native/Managed/Apple reference: `vendor/rea/skills/reverse-engineer-anything/references/native-and-artifacts.md`
