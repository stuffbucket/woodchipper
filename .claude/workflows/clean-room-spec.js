export const meta = {
  name: 'clean-room-spec',
  description: 'Multi-agent clean-room behavioral extraction and CLONE_SPEC.md synthesis with completeness critic',
  whenToUse: 'Use when studying an application or binary to produce a clean-room behavioral specification (CLONE_SPEC.md) or WASM portability plan',
  phases: [
    { title: 'Subsystem Extraction', detail: 'parallel behavioral extraction across UI, state, persistence, and wire/IPC' },
    { title: 'Completeness Critic', detail: 'audit extracted contracts against REA obligation ledgers and residual unknowns' },
    { title: 'Author Spec', detail: 'compile Evidence-cited CLONE_SPEC.md without proprietary code or assets' },
  ],
}

const target = typeof args === 'string' ? args : (args && args.target ? args.target : '')
if (!target) {
  throw new Error('Pass target path via args (e.g. args: "/abs/path/to/app" or args: { target: "/abs/path/to/app" })')
}

const SUBSYSTEM_SCHEMA = {
  type: 'object',
  properties: {
    domain: { type: 'string' },
    contracts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          behavior: { type: 'string' },
          inputs_outputs: { type: 'string' },
          edge_cases: { type: 'string' },
          evidence_id: { type: 'string' },
          location: { type: 'string' },
        },
        required: ['behavior', 'inputs_outputs', 'edge_cases', 'evidence_id', 'location'],
      },
    },
    unknowns: { type: 'array', items: { type: 'string' } },
  },
  required: ['domain', 'contracts', 'unknowns'],
}

const CRITIC_SCHEMA = {
  type: 'object',
  properties: {
    missing_modalities: { type: 'array', items: { type: 'string' } },
    unverified_claims: { type: 'array', items: { type: 'string' } },
    residual_unknowns: { type: 'array', items: { type: 'string' } },
  },
  required: ['missing_modalities', 'unverified_claims', 'residual_unknowns'],
}

const DOMAINS = [
  {
    key: 'ui-and-commands',
    prompt: `Target: ${target}
Clean-room behavioral extraction — Domain: UI, Views, Commands & Interaction Model.
Use REA (summary-first) to recover user-visible screens/routes, command dispatch, keyboard shortcuts, and state transitions. Cite evidence_id and address/node_id for every rule. Never copy proprietary code or assets.`,
  },
  {
    key: 'core-logic-and-rules',
    prompt: `Target: ${target}
Clean-room behavioral extraction — Domain: Core Business Logic, Algorithms & Constants.
Use REA to recover core state machines, algorithms, constants, and lookup tables. Cite evidence_id and address/node_id for every rule.`,
  },
  {
    key: 'persistence-and-files',
    prompt: `Target: ${target}
Clean-room behavioral extraction — Domain: Persistence, SQLite Schemas, Config & File Formats.
Use REA (inspect_sqlite_database, inspect_plist, analyze_function, or JS module views) to document every file format, database table, and settings schema. Cite evidence_id and location.`,
  },
  {
    key: 'network-and-ipc',
    prompt: `Target: ${target}
Clean-room behavioral extraction — Domain: Network Protocols, Wire Formats & IPC Channels.
Use REA to document IPC channels (contextBridge / ipcMain / XPC) and network endpoints/wire framing. Distinguish confirmed literal matches from dynamic Unknowns.`,
  },
]

phase('Subsystem Extraction')
const domainExtractions = (
  await parallel(
    DOMAINS.map((d) => () =>
      agent(d.prompt, {
        label: `extract:${d.key}`,
        phase: 'Subsystem Extraction',
        schema: SUBSYSTEM_SCHEMA,
      })
    )
  )
).filter(Boolean)

phase('Completeness Critic')
const critique = await agent(
  `Review these extracted clean-room behavioral contracts for ${target}:
${JSON.stringify(domainExtractions, null, 2)}

Act as a Completeness Critic (using build_reconstruction_obligation_ledger or list_unknowns if available):
1. Which modalities or subsystems were not inspected?
2. Which claims lack concrete REA evidence_id/location citations?
3. What must be explicitly marked as UNKNOWN in CLONE_SPEC.md?`,
  {
    label: 'critic:completeness',
    phase: 'Completeness Critic',
    schema: CRITIC_SCHEMA,
  }
)

phase('Author Spec')
const cloneSpec = await agent(
  `Compile a complete, clean-room CLONE_SPEC.md for ${target} from the extracted contracts and completeness critique below.
Rules:
- Cite [Evidence: <evidence_id> @ <location>] on every behavioral requirement.
- Explicitly list every item from the Completeness Critic under an "## Open Unknowns & Verification Obligations" section.
- Include zero proprietary code or assets.

Extractions:
${JSON.stringify(domainExtractions, null, 2)}

Critique:
${JSON.stringify(critique, null, 2)}`,
  {
    label: 'author:CLONE_SPEC.md',
    phase: 'Author Spec',
  }
)

return {
  target,
  extractions: domainExtractions,
  critique,
  clone_spec_markdown: cloneSpec,
}
