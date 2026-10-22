export const meta = {
  name: 'trace-feature',
  description: 'End-to-end feature tracing across entry points with adversarial Evidence verification',
  whenToUse: 'Use when tracing how a specific feature, button, CLI flag, or IPC channel works in a binary or application',
  phases: [
    { title: 'Discover Seeds', detail: 'identify entry-point procedures, modules, or strings for the feature' },
    { title: 'Trace Chains', detail: 'walk call chains and data flow per seed' },
    { title: 'Adversarial Verify', detail: 'skeptically verify each hop against REA Evidence' },
  ],
}

const target = args && args.target ? args.target : ''
const feature = args && args.feature ? args.feature : ''
if (!target || !feature) {
  throw new Error('Pass args: { target: "/abs/path/to/target", feature: "feature description or symbol" }')
}

const SEEDS_SCHEMA = {
  type: 'object',
  properties: {
    seeds: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          kind: { type: 'string' },
          evidence_id: { type: 'string' },
          rationale: { type: 'string' },
        },
        required: ['id', 'kind', 'evidence_id', 'rationale'],
      },
    },
  },
  required: ['seeds'],
}

const CHAIN_SCHEMA = {
  type: 'object',
  properties: {
    seed_id: { type: 'string' },
    hops: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          function_or_module: { type: 'string' },
          address_or_node: { type: 'string' },
          evidence_id: { type: 'string' },
          effect: { type: 'string' },
          is_inference: { type: 'boolean' },
        },
        required: ['function_or_module', 'address_or_node', 'evidence_id', 'effect', 'is_inference'],
      },
    },
    unknowns: { type: 'array', items: { type: 'string' } },
  },
  required: ['seed_id', 'hops', 'unknowns'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    supported: { type: 'boolean' },
    critique: { type: 'string' },
    surviving_hops: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          function_or_module: { type: 'string' },
          address_or_node: { type: 'string' },
          evidence_id: { type: 'string' },
          effect: { type: 'string' },
          bucket: { type: 'string' },
        },
        required: ['function_or_module', 'address_or_node', 'evidence_id', 'effect', 'bucket'],
      },
    },
    unresolved_gaps: { type: 'array', items: { type: 'string' } },
  },
  required: ['supported', 'critique', 'surviving_hops', 'unresolved_gaps'],
}

phase('Discover Seeds')
const seedDiscovery = await agent(
  `Target: ${target}
Feature to trace: ${feature}
Use REA (summary-first) to locate up to 4 concrete entry-point seeds (procedure addresses/names, module node_ids, IPC channels, or string xref sites) for "${feature}". Do not execute the target.`,
  {
    label: `seeds:${feature}`,
    phase: 'Discover Seeds',
    schema: SEEDS_SCHEMA,
  }
)

const seeds = seedDiscovery && seedDiscovery.seeds ? seedDiscovery.seeds.slice(0, 4) : []
if (seedDiscovery && seedDiscovery.seeds && seedDiscovery.seeds.length > 4) {
  log(`Bounded seed list from ${seedDiscovery.seeds.length} to top 4 seeds`)
}

const verifiedChains = await pipeline(
  seeds,
  (seed) =>
    agent(
      `Target: ${target}
Feature: ${feature}
Seed: ${JSON.stringify(seed)}
Trace forward from this seed using REA (analyze_function, procedure_callees, xrefs, or trace_application_feature with direction: "outgoing"). Record every hop with exact address_or_node and evidence_id. Mark any indirect call or dynamic IPC channel as an inference or unknown.`,
      {
        label: `trace:${seed.id}`,
        phase: 'Trace Chains',
        schema: CHAIN_SCHEMA,
      }
    ),
  (chain, seed) =>
    agent(
      `Adversarially verify this reverse-engineering call chain for "${feature}" in ${target}:
${JSON.stringify(chain, null, 2)}

Try to refute each hop:
- Does it cite a concrete evidence_id and address/node_id?
- Did it confuse a string literal or dynamic IPC channel with confirmed runtime execution?
- Classify surviving hops strictly into bucket: "Observation" or "Inference", and move unsupported leaps into unresolved_gaps.`,
      {
        label: `verify:${seed.id}`,
        phase: 'Adversarial Verify',
        schema: VERDICT_SCHEMA,
      }
    ).then((verdict) => (verdict ? { seed, chain, verdict } : null))
)

return {
  target,
  feature,
  results: verifiedChains.filter(Boolean),
}
