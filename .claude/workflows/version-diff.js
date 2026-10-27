export const meta = {
  name: 'version-diff',
  description: 'Compare two application or binary versions across artifacts, functions, and exports to isolate behavioral and security changes',
  whenToUse: 'Use when comparing <old_path> and <new_path> of an application or binary for patch diffing, incomplete-fix hunting, or regression analysis',
  phases: [
    { title: 'Diff Tracks', detail: 'parallel artifact, function-match, and application-graph comparisons' },
    { title: 'Synthesize Delta', detail: 'separate real behavioral/security changes from compiler/bundler noise' },
  ],
}

const oldPath = args && (args.old_path || args.left) ? (args.old_path || args.left) : ''
const newPath = args && (args.new_path || args.right) ? (args.new_path || args.right) : ''
if (!oldPath || !newPath) {
  throw new Error('Pass args: { old_path: "/abs/path/v1", new_path: "/abs/path/v2" }')
}

const TRACK_SCHEMA = {
  type: 'object',
  properties: {
    track: { type: 'string' },
    behavioral_deltas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          component_or_function: { type: 'string' },
          old_location: { type: 'string' },
          new_location: { type: 'string' },
          evidence_ids: { type: 'array', items: { type: 'string' } },
          change_summary: { type: 'string' },
          security_or_functional_impact: { type: 'string' },
        },
        required: [
          'component_or_function',
          'old_location',
          'new_location',
          'evidence_ids',
          'change_summary',
          'security_or_functional_impact',
        ],
      },
    },
    build_noise: { type: 'array', items: { type: 'string' } },
    unknowns: { type: 'array', items: { type: 'string' } },
  },
  required: ['track', 'behavioral_deltas', 'build_noise', 'unknowns'],
}

const TRACKS = [
  {
    key: 'artifact-and-metadata-diff',
    prompt: `Old version: ${oldPath}
New version: ${newPath}
Use REA to compare artifact inventories, dependencies, permissions, or embedded metadata (inspect_artifact -> compare_artifacts, inspect_go_binary, inspect_rust_binary, inspect_android_package, or compare_application_versions).
Separate real dependency/permission/asset changes from build-timestamp/ordinal noise.`,
  },
  {
    key: 'code-and-function-diff',
    prompt: `Old version: ${oldPath}
New version: ${newPath}
Use REA to match and compare code between ${oldPath} and ${newPath}:
- Native: list_procedures on both -> analyze_function on modified pairs -> compare_functions & find_changed_behavior.
- JS/Electron: analyze_javascript_application on both -> compare_application_versions & compare_javascript_export_shapes.
- WASM: compare_wasm_interfaces.
Identify added bounds checks, changed logic branches, and any sibling callers that missed a security patch.`,
  },
]

phase('Diff Tracks')
const trackResults = (
  await parallel(
    TRACKS.map((t) => () =>
      agent(t.prompt, {
        label: `diff:${t.key}`,
        phase: 'Diff Tracks',
        schema: TRACK_SCHEMA,
      })
    )
  )
).filter(Boolean)

phase('Synthesize Delta')
const report = await agent(
  `Synthesize a Version Diff & Patch Analysis Report comparing:
- Baseline: ${oldPath}
- Candidate: ${newPath}

Data from diff tracks:
${JSON.stringify(trackResults, null, 2)}

Structure the report into:
1. Confirmed Behavioral & Security Changes (with exact old/new locations and evidence_ids)
2. Candidate Incomplete Fixes / Variant Hypotheses
3. Filtered Build / Bundler Noise
4. Unmatched Frontier & Residual Unknowns`,
  {
    label: 'synthesize:version-diff',
    phase: 'Synthesize Delta',
  }
)

return {
  old_path: oldPath,
  new_path: newPath,
  tracks: trackResults,
  report,
}
