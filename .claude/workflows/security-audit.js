export const meta = {
  name: 'security-audit',
  description: 'Trust-boundary and source-to-sink security audit with 3-lens adversarial verification',
  whenToUse: 'Use for authorized defensive vulnerability research on native binaries, kernel drivers, Electron apps, or Android APKs',
  phases: [
    { title: 'Find Candidates', detail: 'parallel source-to-sink hunters across trust boundaries' },
    { title: 'Adversarial Verify', detail: '3-lens skeptic panel (reachability, guards, impact) per candidate' },
  ],
}

const target = typeof args === 'string' ? args : (args && args.target ? args.target : '')
if (!target) {
  throw new Error('Pass authorized target path via args (e.g. args: "/abs/path/to/target")')
}

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          source_location: { type: 'string' },
          sink_location: { type: 'string' },
          evidence_ids: { type: 'array', items: { type: 'string' } },
          path_summary: { type: 'string' },
          observed_checks: { type: 'string' },
        },
        required: ['title', 'source_location', 'sink_location', 'evidence_ids', 'path_summary', 'observed_checks'],
      },
    },
  },
  required: ['candidates'],
}

const LENS_VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    lens: { type: 'string' },
    refuted: { type: 'boolean' },
    classification: { type: 'string' },
    reasoning: { type: 'string' },
    validation_experiment: { type: 'string' },
  },
  required: ['lens', 'refuted', 'classification', 'reasoning', 'validation_experiment'],
}

const HUNTERS = [
  {
    key: 'ipc-and-rpc-boundaries',
    prompt: `Authorized Target: ${target}
Hunt for trust-boundary flaws across IPC, RPC, IOCTL dispatch tables, exported Android components, or Electron contextBridge/ipcMain handlers using REA (static analysis only).
Trace untrusted input sources to privileged operations. Return candidate source-to-sink paths with exact addresses/node_ids and evidence_ids.`,
  },
  {
    key: 'memory-and-parser-sinks',
    prompt: `Authorized Target: ${target}
Hunt for unchecked lengths, integer overflows, or unsafe deserialization reaching memory/file parsers in ${target} using REA.
Trace from network/file input routines to memcpy/strcpy/allocations or parser loops. Cite exact addresses and evidence_ids.`,
  },
  {
    key: 'execution-and-crypto-sinks',
    prompt: `Authorized Target: ${target}
Hunt for command execution sinks (system, execve, CreateProcess, child_process, shell.openExternal), path traversal, or hardcoded cryptographic secrets/IVs in ${target} using REA.
Cite exact addresses/node_ids and evidence_ids.`,
  },
]

phase('Find Candidates')
const hunterOutputs = (
  await parallel(
    HUNTERS.map((h) => () =>
      agent(h.prompt, {
        label: `hunt:${h.key}`,
        phase: 'Find Candidates',
        schema: FINDINGS_SCHEMA,
      })
    )
  )
).filter(Boolean)

// Barrier: deduplicate across all hunters by source_location + sink_location before 3-lens verification
const seen = new Set()
const deduped = []
for (const out of hunterOutputs) {
  for (const c of out.candidates || []) {
    const key = `${c.source_location}->${c.sink_location}`
    if (!seen.has(key)) {
      seen.add(key)
      deduped.push(c)
    }
  }
}

const capped = deduped.slice(0, 6)
if (deduped.length > 6) {
  log(`Bounded verification from ${deduped.length} candidates to top 6`)
}

phase('Adversarial Verify')
const LENSES = [
  {
    key: 'reachability',
    desc: 'Can untrusted caller input actually reach this sink statically, or is the path dead/internal-only?',
  },
  {
    key: 'guards',
    desc: 'Inspect the intermediate functions in REA: are there bounds checks, type checks, or probe validations that neutralize the flaw?',
  },
  {
    key: 'impact',
    desc: 'Does crossing this boundary actually cross a privilege or trust boundary with real security impact, or is it self-inflicted?',
  },
]

const verified = (
  await parallel(
    capped.map((candidate) => () =>
      parallel(
        LENSES.map((lens) => () =>
          agent(
            `Adversarially verify this candidate finding in ${target} through the "${lens.key}" lens (${lens.desc}).
Candidate:
${JSON.stringify(candidate, null, 2)}

Default to refuted: true if the claim lacks REA Evidence or ignores an intermediate guard. Never classify a static hypothesis as a confirmed vulnerability without complete proof.`,
            {
              label: `verify:${lens.key}:${candidate.sink_location}`,
              phase: 'Adversarial Verify',
              schema: LENS_VERDICT_SCHEMA,
            }
          )
        )
      ).then((verdicts) => {
        const validVerdicts = verdicts.filter(Boolean)
        const survivingVotes = validVerdicts.filter((v) => !v.refuted).length
        return {
          candidate,
          survives: survivingVotes >= 2,
          verdicts: validVerdicts,
        }
      })
    )
  )
).filter(Boolean)

return {
  target,
  total_candidates: deduped.length,
  verified_findings: verified.filter((v) => v.survives),
  refuted_findings: verified.filter((v) => !v.survives),
}
