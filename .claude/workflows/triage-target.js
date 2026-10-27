export const meta = {
  name: 'triage-target',
  description: 'Parallel multi-facet reverse-engineering triage of an executable, bundle, or directory using REA',
  whenToUse: 'Use when given an unfamiliar binary, app bundle, ASAR, APK, or firmware image to map its architecture, entry points, and top investigation seeds',
  phases: [
    { title: 'Facet Sweep', detail: 'parallel static metadata, layout, strings, and capability probes' },
    { title: 'Synthesize Map', detail: 'merge into an Evidence-backed triage map and seed list' },
  ],
}

const target = typeof args === 'string' ? args : (args && args.target ? args.target : '')
if (!target) {
  throw new Error('Pass the target path via args (e.g. args: "/abs/path/to/target" or args: { target: "/abs/path" })')
}

const FACET_SCHEMA = {
  type: 'object',
  properties: {
    facet: { type: 'string' },
    observations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          evidence_id: { type: 'string' },
          location: { type: 'string' },
        },
        required: ['claim', 'evidence_id', 'location'],
      },
    },
    inferences: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          confidence: { type: 'string' },
          basis: { type: 'string' },
        },
        required: ['claim', 'confidence', 'basis'],
      },
    },
    unknowns: {
      type: 'array',
      items: { type: 'string' },
    },
    candidate_seeds: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name_or_address: { type: 'string' },
          rationale: { type: 'string' },
        },
        required: ['name_or_address', 'rationale'],
      },
    },
  },
  required: ['facet', 'observations', 'inferences', 'unknowns', 'candidate_seeds'],
}

const FACETS = [
  {
    key: 'container-and-metadata',
    prompt: `Target: ${target}
Use REA target-free tools (or CLI pnpm exec rea) to identify the container format, compiler/runtime metadata, build IDs, and regions without running a heavy disassembler import if possible:
- Check inspect_binary_layout, inspect_go_binary, inspect_rust_binary, inspect_pe_resources, inspect_firmware_regions, inspect_plist, or inspect_electron_fuses as applicable to the target type.
Return only verified Observations (with evidence_id and file/range location), Inferences, Unknowns, and candidate entry seeds.`,
  },
  {
    key: 'structure-and-layout',
    prompt: `Target: ${target}
Use REA with detail: "summary" first to map the structural layout of ${target}:
- For JS/Electron: analyze_javascript_application (detail: "summary") + inspect_analysis_view module pages.
- For ELF/Mach-O/PE: inspect_binary_layout (detail: "summary") or open_binary + inspect_macho (detail: "summary") / binary_overview.
- For APK/Archive/Apple bundle: inspect_android_package, inspect_plist, or open_binary + inspect_artifact (detail: "summary").
Never dump full multi-MB outputs into context. Return Observations, Inferences, Unknowns, and structural entry seeds.`,
  },
  {
    key: 'capabilities-and-strings',
    prompt: `Target: ${target}
Use REA to inventory externally visible capabilities (network endpoints, filesystem/SQLite access, IPC channels, crypto/auth routines, CLI flags) in ${target}.
Use search_strings, search_procedures, or inspect_analysis_view reference pages. Group findings by capability and cite exact evidence_id and address/node_id.`,
  },
]

phase('Facet Sweep')
log(`Running parallel 3-facet static triage on ${target}`)
const facetResults = (
  await parallel(
    FACETS.map((f) => () =>
      agent(f.prompt, {
        label: `triage:${f.key}`,
        phase: 'Facet Sweep',
        schema: FACET_SCHEMA,
      })
    )
  )
).filter(Boolean)

phase('Synthesize Map')
const synthesis = await agent(
  `Synthesize these parallel REA triage facet results for ${target} into a concise, high-signal TRIAGE_MAP report.
Strict rules:
1. Keep Observations, Inferences, and Unknowns in separate sections.
2. Every Observation must preserve its exact evidence_id and address/node_id location.
3. Recommend the Top 3 high-value features or procedures to investigate next with exact seed identifiers.

Facet Data:
${JSON.stringify(facetResults, null, 2)}`,
  {
    label: 'synthesize:triage-map',
    phase: 'Synthesize Map',
  }
)

return {
  target,
  facets: facetResults,
  triage_map: synthesis,
}
