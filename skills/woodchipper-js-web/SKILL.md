---
name: woodchipper-js-web
description: Reverse engineer Electron apps, ASAR archives, minified/bundled JavaScript, source maps, and recorded web network captures (HAR, Fiddler Everywhere SAZ, mitmproxy, HTTP/3 qlog) using REA. Covers summary-first application graph paging, IPC/contextBridge security auditing, and API-surface/agent-environment projection. Use when analyzing Electron or web apps, tracing JS features, or inspecting network captures.
license: MIT
metadata:
  author: stuffbucket
  version: "1.0.0"
---

# Woodchipper JavaScript, Electron & Web Network Capture Analysis

Use this skill for Electron applications (`app.asar` or extracted trees), bundled/minified web
JavaScript, source maps, and offline network recordings (`.har`, `.saz`, mitmproxy, aioquic `.qlog`).

## 1. Static JavaScript & Electron Analysis (Target-Free)

Do NOT call `open_binary` for a JavaScript tree or ASAR. No native disassembler is required.

1. **Optional Unbundling (Wakaru on Linux x64):**
   - If JavaScript is heavily bundled/minified and Wakaru is installed, run `recover_javascript_sources` with an absolute `path` (and optional `additional_paths`), then analyze the returned `analysis_input` directory.
2. **Analyze with `detail: "summary"` First:**
   - Call `analyze_javascript_application` with `input_path` and `detail: "summary"`.
   - If you already know the target files, pass `source_paths: ["package.json", "main.js", "preload.js"]` to bound analysis time and heap. Never pass `source_paths: []` (invalid).
   - Retain `normalized_result.parent_evidence_id` (`ev_...`) for all follow-up queries.
3. **Drill into the Graph Without Re-Running Analysis:**
   - **Page module identities:**

     ```json
     {
       "source": { "kind": "retained-evidence", "evidence_id": "ev_ACTUAL_PARENT_ID" },
       "view": { "kind": "page", "collection": "modules", "offset": 0, "limit": 16 }
     }
     ```

   - **Inspect a specific module by `node_id`:** (Preferred over `path` because one path can have asset, bundled, and source roles):

     ```json
     {
       "source": { "kind": "retained-evidence", "evidence_id": "ev_ACTUAL_PARENT_ID" },
       "view": { "kind": "item", "collection": "modules", "selector": { "node_id": "jag_node_ACTUAL_ID" } }
     }
     ```

   - **Query typed reference pages:**

     ```json
     {
       "source": { "kind": "retained-evidence", "evidence_id": "ev_ACTUAL_PARENT_ID" },
       "view": { "kind": "javascript", "collection": "modules", "projection": "references", "where": { "path": "main.js", "kind": "javascript-module" }, "offset": 0, "limit": 16 }
     }
     ```

4. **Trace a Feature Seed Narrowly:**
   - Call `trace_application_feature` on the retained `parent_evidence_id` for a specific literal `node_id`, route, string, API, IPC channel, or native `.node` export.
   - Prefer `direction: "incoming"` or `"outgoing"` over `"both"`—bidirectional traces traverse containment edges and can pull in unrelated sibling modules.
5. **Electron IPC & Fuse Discipline:**
   - Check packaged Electron fuses with `inspect_electron_fuses` before attempting inspector attachment (`EnableNodeCliInspectArguments` disabled means `--inspect` is ignored).
   - `BrowserWindow` preferences, `contextBridge` exports, and `ipcMain.handle`/`on` registrations are static syntax observations. Only a unique exact literal IPC channel name supports an inferred renderer-to-main pairing; dynamic channel names remain **Unknown**.

## 2. Offline Web Network Captures (HAR / SAZ / mitmproxy / qlog)

Use `inspect_web_network_capture` to inspect saved `.har`, Fiddler Everywhere `.saz` (`format: "saz"`),
native mitmproxy captures, or aioquic 1.5.0 JSON 0.3 `.qlog` files—without fetching live URLs:

1. **Start with Summary & Page Records:**
   - Request `detail: "summary"`, then page records via `inspect_analysis_view` with `view: {kind: "capture", detail: "preview", offset: 0, limit: 20}`.
2. **Protobuf / gRPC Payloads:**
   - Use `inspect_analysis_view` with `view: {kind: "protobuf", collection: "bodies" | "frames" | "fields"}` and batch exact record ordinals.
3. **API Surface & Agent Environment Projection:**
   - Project HAR captures into grouped endpoint templates via `view: {kind: "api-surface", include_query_parameter_names: true}`.
   - Project into an executable mock/replay environment manifest via `view: {kind: "environment-manifest"}` and `view: {kind: "environment-state"}` (served via `rea environment-serve`).

## Deep References

- Full JS/Electron recipes: `vendor/rea/skills/reverse-engineer-anything/references/javascript-applications.md`
- Guides: `vendor/rea/docs/javascript-application-workflows.md`, `vendor/rea/docs/web-network-captures.md`, `vendor/rea/docs/electron-fuses.md`
