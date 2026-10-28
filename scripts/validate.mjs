#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

let errors = 0
function fail(msg) {
  console.error(`FAIL: ${msg}`)
  errors++
}
function ok(msg) {
  console.log(`OK:   ${msg}`)
}
function gitlinkCommit(relativePath) {
  const entry = execFileSync('git', ['ls-files', '--stage', '--', relativePath], {
    cwd: ROOT,
    encoding: 'utf8'
  }).trim()
  return entry.split(/\s+/)[1]
}

// 1. Validate Skills (frontmatter, naming, <= 500 lines)
const skillsDir = path.join(ROOT, 'skills')
const skillFolders = fs.readdirSync(skillsDir).filter((f) => fs.statSync(path.join(skillsDir, f)).isDirectory())
for (const folder of skillFolders) {
  const skillPath = path.join(skillsDir, folder, 'SKILL.md')
  if (!fs.existsSync(skillPath)) {
    fail(`Missing SKILL.md in skills/${folder}`)
    continue
  }
  const text = fs.readFileSync(skillPath, 'utf8')
  const lines = text.split('\n').length
  if (lines > 500) {
    fail(`skills/${folder}/SKILL.md exceeds 500 lines (${lines})`)
  }
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---/)
  if (!fmMatch) {
    fail(`skills/${folder}/SKILL.md missing YAML frontmatter`)
    continue
  }
  const fm = fmMatch[1]
  const nameMatch = fm.match(/^name:\s*(.+)$/m)
  const descMatch = fm.match(/^description:\s*(.+)$/m)
  if (!nameMatch || nameMatch[1].trim() !== folder) {
    fail(`skills/${folder}/SKILL.md name frontmatter does not match directory name`)
  }
  if (!descMatch || descMatch[1].trim().length === 0 || descMatch[1].trim().length > 1024) {
    fail(`skills/${folder}/SKILL.md description invalid or > 1024 chars`)
  }
  ok(`Skill ${folder} (${lines} lines)`)
}

// 2. Validate Workflows (.claude/workflows/*.js)
const workflowsDir = path.join(ROOT, '.claude', 'workflows')
const workflowFiles = fs.readdirSync(workflowsDir).filter((f) => f.endsWith('.js'))
for (const wf of workflowFiles) {
  const wfPath = path.join(workflowsDir, wf)
  const code = fs.readFileSync(wfPath, 'utf8')
  if (!code.startsWith('export const meta = {')) {
    fail(`.claude/workflows/${wf} must start with pure literal "export const meta = {"`)
  }
  if (/\bDate\.now\s*\(|\bMath\.random\s*\(|\bnew\s+Date\s*\(\s*\)/.test(code)) {
    fail(`.claude/workflows/${wf} contains non-deterministic Date.now()/Math.random()/new Date()`)
  }
  ok(`Workflow ${wf}`)
}

// 3. Enforce the Pi-owned configuration boundary and gitignored workspaces/
const gitignoreText = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
if (!/^workspaces\/$/m.test(gitignoreText)) {
  fail('.gitignore must ignore workspaces/ so reverse-engineering work is never committed')
} else {
  ok('Workspace isolation: workspaces/ is gitignored')
}
const forbiddenClaudeConfig = [
  '.mcp.json',
  '.claude/settings.json',
  '.claude/hooks',
  '.claude-plugin/hooks'
]
for (const rel of forbiddenClaudeConfig) {
  if (fs.existsSync(path.join(ROOT, rel))) {
    fail(`Claude configuration must remain absent; configure Woodchipper through Pi instead: ${rel}`)
  }
}
const localSettingsPath = path.join(ROOT, '.claude/settings.local.json')
if (fs.existsSync(localSettingsPath)) {
  const localSettings = JSON.parse(fs.readFileSync(localSettingsPath, 'utf8'))
  if (localSettings.mcpServers || localSettings.hooks || localSettings.enabledMcpjsonServers?.length) {
    fail('Claude local settings must not configure MCP servers or hooks; configure Woodchipper through Pi instead: .claude/settings.local.json')
  }
}
if (!forbiddenClaudeConfig.some((rel) => fs.existsSync(path.join(ROOT, rel)))) {
  ok('Configuration boundary: MCP, extensions, and hooks are owned by project-local Pi configuration')
}

// 4. Validate Playbooks & Vendor Manifest
const manifestPath = path.join(ROOT, 'vendor', 'MANIFEST.json')
if (!fs.existsSync(manifestPath)) {
  fail('Missing vendor/MANIFEST.json')
} else {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (!manifest.upstreams?.rea?.commit || !manifest.upstreams?.rea_prompts?.commit) {
    fail('vendor/MANIFEST.json missing upstream commit pins')
  } else {
    ok(`Vendor manifest pinned (rea: ${manifest.upstreams.rea.commit.slice(0, 8)}, rea-prompts: ${manifest.upstreams.rea_prompts.commit.slice(0, 8)})`)
  }
}

// 5. Validate isolated source-built dependency overrides
const overrideManifestPath = path.join(ROOT, 'vendor', 'overrides', 'manifest.json')
if (!fs.existsSync(overrideManifestPath)) {
  fail('Missing vendor/overrides/manifest.json')
} else {
  const overrideManifest = JSON.parse(fs.readFileSync(overrideManifestPath, 'utf8'))
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const workspaceConfig = fs.readFileSync(path.join(ROOT, 'pnpm-workspace.yaml'), 'utf8')
  const gitmodules = fs.readFileSync(path.join(ROOT, '.gitmodules'), 'utf8')
  const expectedOverrides = {
    jose: 'link:vendor/overrides/packages/jose',
    'fast-uri': 'link:vendor/overrides/packages/fast-uri'
  }

  for (const [name, expectedOverride] of Object.entries(expectedOverrides)) {
    const entry = overrideManifest.packages?.[name]
    if (!entry?.commit || !entry?.version || entry.override !== expectedOverride) {
      fail(`Temporary override manifest is incomplete for ${name}`)
      continue
    }

    const sourcePackagePath = path.join(ROOT, entry.submodule, 'package.json')
    if (!fs.existsSync(sourcePackagePath)) {
      fail(`Missing temporary override submodule: ${entry.submodule}`)
      continue
    }

    const sourcePackage = JSON.parse(fs.readFileSync(sourcePackagePath, 'utf8'))
    if (sourcePackage.name !== name || sourcePackage.version !== entry.version) {
      fail(`Temporary override source mismatch for ${name}@${entry.version}`)
    }

    const sourceCommit = execFileSync('git', ['-C', path.join(ROOT, entry.submodule), 'rev-parse', 'HEAD'], {
      encoding: 'utf8'
    }).trim()
    if (sourceCommit !== entry.commit || gitlinkCommit(entry.submodule) !== entry.commit) {
      fail(`Temporary override source or gitlink SHA mismatch for ${name}: ${sourceCommit}`)
    }
    if (!gitmodules.includes(`# ${name} v${entry.version} @ ${entry.commit}`)) {
      fail(`.gitmodules is missing the semver/SHA comment for ${name}`)
    }
    if (!workspaceConfig.includes(`# ${name} v${entry.version} source SHA ${entry.commit}`)) {
      fail(`pnpm-workspace.yaml is missing the semver/SHA comment for ${name}`)
    }
    if (!workspaceConfig.includes(`  ${name}: ${expectedOverride}`)) {
      fail(`pnpm override mismatch for ${name}`)
    }
  }

  if (!workspaceConfig.includes('  zod: 4.6.7')) {
    fail('pnpm must pin proxy-available zod@4.6.7')
  }

  const setup = packageJson.scripts?.setup ?? ''
  const overrideBuild = 'node scripts/build-vendor-overrides.mjs'
  if (setup.indexOf(overrideBuild) === -1 || setup.indexOf(overrideBuild) > setup.indexOf('pnpm install')) {
    fail('setup must build local dependency overrides before pnpm install')
  } else {
    ok('Temporary dependency overrides are isolated, SHA-pinned, and built before install')
  }
}

const piAuditPath = path.join(ROOT, 'vendor', 'overrides', 'pi-audit.json')
if (!fs.existsSync(piAuditPath)) {
  fail('Missing vendor/overrides/pi-audit.json')
} else {
  const piAudit = JSON.parse(fs.readFileSync(piAuditPath, 'utf8'))
  const piPackagePath = path.join(ROOT, piAudit.source.submodule, 'packages', 'coding-agent', 'package.json')
  const piPackage = JSON.parse(fs.readFileSync(piPackagePath, 'utf8'))
  const piCommit = execFileSync('git', ['-C', path.join(ROOT, piAudit.source.submodule), 'rev-parse', 'HEAD'], {
    encoding: 'utf8'
  }).trim()
  const gitmodules = fs.readFileSync(path.join(ROOT, '.gitmodules'), 'utf8')
  const pinComment = `# ${piAudit.source.package} v${piAudit.source.version} @ ${piAudit.source.commit}`

  if (piPackage.name !== piAudit.source.package || piPackage.version !== piAudit.source.version) {
    fail('Pi audit overlay source package identity does not match vendor/pi')
  }
  if (
    piCommit !== piAudit.source.commit ||
    gitlinkCommit(piAudit.source.submodule) !== piAudit.source.commit ||
    !gitmodules.includes(pinComment)
  ) {
    fail('Pi submodule SHA pin or adjacent semver comment is inconsistent')
  }
  const excludedWorkspaces = piAudit.exclude_from_runtime_build?.workspaces ?? []
  const allowedFindings = Object.keys(piAudit.allowed_audit_findings ?? {})
  if (
    !piAudit.exclude_from_runtime_build?.devDependencies?.includes('@anthropic-ai/sandbox-runtime') ||
    !excludedWorkspaces.includes('packages/coding-agent/examples/extensions/sandbox') ||
    !excludedWorkspaces.includes('packages/coding-agent/examples/extensions/gondolin') ||
    allowedFindings.length !== 0
  ) {
    fail('Pi audit overlay must exclude only the unpatchable example roots and allow no audit findings')
  } else {
    ok('Pi source is SHA-pinned and its zero-finding proxy audit overlay is documented')
  }
}

// 6. Validate Pi Harness & Submodule (.pi/extensions/*, bin/woodchipper.mjs, vendor/pi)
const requiredHarnessFiles = [
  '.pi/settings.json',
  '.pi/SYSTEM.md',
  '.pi/extensions/woodchipper-maximal.ts',
  '.pi/extensions/woodchipper-rea.ts',
  '.pi/extensions/woodchipper-peer.ts',
  '.pi/extensions/pi-flow.ts',
  '.pi/extensions/lib/maximal-provider.ts',
  '.pi/extensions/lib/gliner-classifier.ts',
  '.pi/extensions/lib/evidence-ledger.ts',
  '.pi/extensions/lib/disk-hygiene.ts',
  '.pi/extensions/lib/triage.ts',
  '.pi/extensions/lib/peer-protocol.ts',
  '.pi/extensions/lib/schema.ts',
  '.pi/extensions/lib/pi-flow/fsm.ts',
  '.pi/extensions/lib/pi-flow/process-tree.ts',
  '.pi/extensions/lib/pi-flow/runners.ts',
  'woodchipper',
  'bin/woodchipper.mjs',
  'scripts/woodchipper-ctl.mjs',
  'scripts/build-harness.mjs',
  'scripts/build-vendor-overrides.mjs',
  'scripts/build-pi-overlay.mjs',
  'vendor/overrides/Dockerfile',
  'vendor/overrides/pi-audit.json',
  'vendor/pi/package.json',
  'vendor/pi/packages/coding-agent/package.json',
  'vendor/gliner-runner/packages/onnx-runner/package.json',
  'site/package.json',
  'site/astro.config.mjs',
  'site/src/pages/index.astro',
  'site/src/content/docs/start.md',
  'site/src/content/docs/examples/index.md',
  '.github/workflows/site.yml',
  '.github/workflows/ci.yml',
  '.github/workflows/codeql.yml',
  '.github/codeql/codeql-config.yml',
  '.github/dependabot.yml',
  '.pnpmfile.cjs',
  'scripts/apply-pnpm-tarball-policy.mjs',
  'scripts/codeql-languages.mjs',
  'scripts/render-homebrew-formula.mjs',
  'packaging/homebrew/woodchipper.rb'
]
for (const rel of requiredHarnessFiles) {
  const p = path.join(ROOT, rel)
  if (!fs.existsSync(p)) {
    fail(`Missing required project file: ${rel}`)
  } else {
    ok(`Project file ${rel}`)
  }
}

// 7. Validate REA 6.7.0 Contract Alignment across skills, playbooks, workflows, and Pi extensions
const toolContractsPath = path.join(ROOT, 'node_modules', 'rea-agents', 'dist', 'contracts', 'toolContracts.js')
if (!fs.existsSync(toolContractsPath)) {
  fail('Missing node_modules/rea-agents/dist/contracts/toolContracts.js')
} else {
  const { TOOL_CONTRACTS } = await import(toolContractsPath)
  const validReaTools = new Set(TOOL_CONTRACTS.map((c) => c.name))
  const detailReaTools = TOOL_CONTRACTS.filter((c) => Boolean(c.inputSchema?.shape && 'detail' in c.inputSchema.shape)).map((c) => c.name)
  const { HIGH_VOLUME_REA_TOOLS } = await import(path.join(ROOT, '.pi', 'extensions', 'woodchipper-rea.ts'))

  for (const dt of detailReaTools) {
    if (!HIGH_VOLUME_REA_TOOLS.has(dt)) {
      fail(`HIGH_VOLUME_REA_TOOLS in .pi/extensions/woodchipper-rea.ts is missing detail-capable REA tool: ${dt}`)
    }
  }
  for (const ht of HIGH_VOLUME_REA_TOOLS) {
    if (!validReaTools.has(ht)) {
      fail(`HIGH_VOLUME_REA_TOOLS contains unknown REA tool: ${ht}`)
    }
  }

  const forbiddenRemovedTools = [
    'inspect_desktop_application',
    'open_bundle_resources',
    'inspect_elf_notes',
    'inspect_byte_entropy',
    'inspect_il2cpp_metadata',
    'inspect_gpu_code_objects',
    'inspect_model_artifact',
    'match_native_functions',
    'diff_binaries'
  ]
  const scanDirs = ['skills', 'playbooks', '.claude/workflows', '.pi', 'site/src/content/docs']
  const filesToCheck = ['README.md', 'CLAUDE.md', 'AGENTS.md']
  for (const d of scanDirs) {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(rel)
        else if (/\.(md|ts|js|mjs)$/.test(entry.name)) filesToCheck.push(rel)
      }
    }
    walk(path.join(ROOT, d))
  }
  let alignmentClean = true
  for (const f of filesToCheck) {
    const abs = path.isAbsolute(f) ? f : path.join(ROOT, f)
    const content = fs.readFileSync(abs, 'utf8')
    for (const bad of forbiddenRemovedTools) {
      if (content.includes(bad)) {
        fail(`Non-existent REA 6.7.0 tool '${bad}' referenced in ${path.relative(ROOT, abs)}`)
        alignmentClean = false
      }
    }
  }
  if (alignmentClean && HIGH_VOLUME_REA_TOOLS.size === detailReaTools.length) {
    ok(`REA 6.7.0 contract alignment (${validReaTools.size} MCP tools, ${detailReaTools.length} detail-capable summary-guarded tools)`)
  }
}

// 8. Validate the public documentation site, Pages deployment, and supply-chain / CI workflows
const sitePackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'site', 'package.json'), 'utf8'))
const siteConfig = fs.readFileSync(path.join(ROOT, 'site', 'astro.config.mjs'), 'utf8')
const siteWorkflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'site.yml'), 'utf8')
if (
  sitePackage.dependencies?.astro !== '7.3.8' ||
  sitePackage.dependencies?.['@astrojs/starlight'] !== '0.42.6' ||
  !siteConfig.includes('"/woodchipper/"') ||
  !siteWorkflow.includes('actions/configure-pages@') ||
  !siteWorkflow.includes('actions/deploy-pages@')
) {
  fail('Documentation site must keep exact Astro/Starlight pins, the Pages base path, and the Pages deployment workflow')
} else {
  ok('Documentation site is version-pinned and configured for GitHub Pages')
}

// 9. Validate pnpm tarball policy, GitHub Actions SHA + semver comments, Dependabot, CodeQL, and Homebrew formula template
try {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'apply-pnpm-tarball-policy.mjs'), '--check'], {
    cwd: ROOT,
    stdio: 'pipe'
  })
  ok('Supply chain: pnpm-lock.yaml passes tarball URL policy (no rotating shard hosts)')
} catch (err) {
  fail(`pnpm-lock.yaml failed tarball URL policy check: ${err.message}`)
}

const ghWorkflowsDir = path.join(ROOT, '.github', 'workflows')
for (const wfFile of fs.readdirSync(ghWorkflowsDir).filter((f) => f.endsWith('.yml'))) {
  const wfText = fs.readFileSync(path.join(ghWorkflowsDir, wfFile), 'utf8')
  const usesLines = wfText.split(/\r?\n/).filter((l) => /^\s*-?\s*uses:\s*/.test(l))
  for (const line of usesLines) {
    if (!/@[0-9a-f]{40}\s+#\s*v\d+\.\d+\.\d+/.test(line)) {
      fail(`.github/workflows/${wfFile} action is not SHA-pinned with a '# vX.Y.Z' semver comment: ${line.trim()}`)
    }
  }
  ok(`GitHub workflow ${wfFile} (${usesLines.length} SHA-pinned actions with semver comments)`)
}

if (errors > 0) {
  console.error(`\nValidation failed with ${errors} error(s).`)
  process.exit(1)
} else {
  console.log('\nAll Woodchipper checks passed.')
}
