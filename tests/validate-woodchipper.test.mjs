import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const EXPECTED_SKILLS = [
  'woodchipper',
  'woodchipper-setup',
  'woodchipper-native',
  'woodchipper-js-web',
  'woodchipper-mobile-managed',
  'woodchipper-firmware-signals',
  'woodchipper-runtime',
  'woodchipper-reconstruction',
  'woodchipper-audit'
]

const EXPECTED_WORKFLOWS = [
  'triage-target.js',
  'trace-feature.js',
  'clean-room-spec.js',
  'security-audit.js',
  'version-diff.js'
]

test('all 9 woodchipper skills exist, have valid frontmatter, and stay under 500 lines', () => {
  for (const skill of EXPECTED_SKILLS) {
    const p = path.join(ROOT, 'skills', skill, 'SKILL.md')
    assert.ok(fs.existsSync(p), `Missing ${p}`)
    const content = fs.readFileSync(p, 'utf8')
    const lines = content.split('\n').length
    assert.ok(lines <= 500, `${skill}/SKILL.md has ${lines} lines (max 500)`)
    assert.match(content, new RegExp(`^---\\nname: ${skill}\\ndescription: .+\\n[\\s\\S]*?\\n---`, 'm'))
  }
})

test('all 5 multi-agent workflows exist and begin with a pure literal meta export', () => {
  for (const wf of EXPECTED_WORKFLOWS) {
    const p = path.join(ROOT, '.claude', 'workflows', wf)
    assert.ok(fs.existsSync(p), `Missing ${p}`)
    const content = fs.readFileSync(p, 'utf8')
    assert.ok(content.startsWith('export const meta = {'), `${wf} must begin with export const meta = {`)
    assert.doesNotMatch(content, /\bDate\.now\s*\(|\bMath\.random\s*\(/, `${wf} must be deterministic`)
  }
})

test('MCP and runtime hooks remain owned by project-local Pi configuration', () => {
  for (const rel of [
    '.mcp.json',
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.claude/hooks',
    '.claude-plugin/hooks'
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, rel)), false, `${rel} must not configure Claude Code`)
  }

  const piSettings = JSON.parse(fs.readFileSync(path.join(ROOT, '.pi', 'settings.json'), 'utf8'))
  assert.ok(piSettings.extensions.includes('./extensions/woodchipper-rea.ts'))

  const reaExtension = fs.readFileSync(path.join(ROOT, '.pi', 'extensions', 'woodchipper-rea.ts'), 'utf8')
  assert.match(reaExtension, /pi\.registerMcpServer\("rea"/)
  assert.match(reaExtension, /cwd: projectRoot/)

  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.equal(packageJson.files.includes('.mcp.json'), false)
  assert.doesNotMatch(packageJson.scripts.doctor, /--client\s+(?:claude_code|pi)/)
})

test('temporary proxy-gap packages stay isolated as Docker-built submodule overrides', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const workspaceConfig = fs.readFileSync(path.join(ROOT, 'pnpm-workspace.yaml'), 'utf8')
  assert.match(
    workspaceConfig,
    /^packages:\n  - site\n\noverrides:\n  # jose v6\.2\.13 source SHA 316b7f2cb41b8377515d9cc2e81e03f8e50ee935\n  jose: link:vendor\/overrides\/packages\/jose\n  # fast-uri v3\.1\.9 source SHA 0def70338a0fa2f12a10c83ae8eafc2139ae9a07\n  fast-uri: link:vendor\/overrides\/packages\/fast-uri\n  # GHSA-mrhx-c7xc-m3w5 is fixed in zod >=4\.6\.6; 4\.6\.7 is mirrored by the proxy\.\n  zod: 4\.6\.7\n\nallowBuilds:\n  frida: true\n$/
  )
  assert.ok(
    packageJson.scripts.setup.indexOf('node scripts/build-vendor-overrides.mjs') <
      packageJson.scripts.setup.indexOf('pnpm install')
  )

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor', 'overrides', 'manifest.json'), 'utf8'))
  assert.equal(manifest.temporary, true)
  assert.equal(manifest.packages.jose.version, '6.2.13')
  assert.equal(manifest.packages.jose.commit, '316b7f2cb41b8377515d9cc2e81e03f8e50ee935')
  assert.equal(manifest.packages['fast-uri'].version, '3.1.9')
  assert.equal(manifest.packages['fast-uri'].commit, '0def70338a0fa2f12a10c83ae8eafc2139ae9a07')

  const gitmodules = fs.readFileSync(path.join(ROOT, '.gitmodules'), 'utf8')
  assert.match(gitmodules, /# jose v6\.2\.13 @ 316b7f2cb41b8377515d9cc2e81e03f8e50ee935/)
  assert.match(gitmodules, /# fast-uri v3\.1\.9 @ 0def70338a0fa2f12a10c83ae8eafc2139ae9a07/)

  const dockerfile = fs.readFileSync(path.join(ROOT, 'vendor', 'overrides', 'Dockerfile'), 'utf8')
  assert.match(dockerfile, /FROM \$\{NODE_IMAGE\} AS jose-builder/)
  assert.match(dockerfile, /--mount=type=secret,id=npmrc/)
  assert.match(dockerfile, /FROM scratch AS package-export/)

  const builder = fs.readFileSync(path.join(ROOT, 'scripts', 'build-vendor-overrides.mjs'), 'utf8')
  assert.match(builder, /"buildx",\s*\n\s*"build"/)
  assert.doesNotMatch(builder, /run\("npm"/)

  const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
  assert.match(gitignore, /^vendor\/overrides\/packages\/$/m)
})

test('Pi build uses a separate exact audit overlay without modifying the submodule', () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor', 'overrides', 'pi-audit.json'), 'utf8'))
  assert.deepEqual(config.source, {
    package: '@earendil-works/pi-coding-agent',
    version: '1.4.0',
    commit: 'cae8d69e572e038d584c881efd1818e40571fb7c',
    submodule: 'vendor/pi'
  })
  assert.equal(config.expected_lock_versions['node_modules/vitest'], '4.1.12')
  assert.equal(config.expected_lock_versions['node_modules/vite'], '8.3.4')
  assert.equal(config.expected_lock_versions['node_modules/undici'], '8.12.3')
  assert.equal(config.overrides.vite, '8.3.4')
  assert.equal(config.overrides['@cloudflare/vitest-plugin'].zod, '4.6.7')
  assert.equal(config.overrides.ajv['fast-uri'], 'file:vendor/overrides/packages/fast-uri')
  assert.deepEqual(config.exclude_from_runtime_build.devDependencies, ['@anthropic-ai/sandbox-runtime'])
  assert.deepEqual(config.exclude_from_runtime_build.workspaces, [
    'packages/coding-agent/examples/extensions/sandbox',
    'packages/coding-agent/examples/extensions/gondolin'
  ])
  assert.deepEqual(config.allowed_audit_findings, {})

  const gitmodules = fs.readFileSync(path.join(ROOT, '.gitmodules'), 'utf8')
  assert.match(
    gitmodules,
    /# @earendil-works\/pi-coding-agent v1\.4\.0 @ cae8d69e572e038d584c881efd1818e40571fb7c/
  )

  const builder = fs.readFileSync(path.join(ROOT, 'scripts', 'build-pi-overlay.mjs'), 'utf8')
  assert.match(builder, /fs\.cpSync\(sourceRoot, outputRoot/)
  assert.match(builder, /fs\.rmSync\(path\.join\(outputRoot, "package-lock\.json"\)/)
  assert.match(builder, /\["run", "build:offline"\]/)
  assert.doesNotMatch(builder, /writeFileSync\([^\n]*vendor["', ]+pi/)

  const launcher = fs.readFileSync(path.join(ROOT, 'bin', 'woodchipper.mjs'), 'utf8')
  assert.ok(launcher.indexOf('".woodchipper",\n\t\t"pi"') < launcher.indexOf('"vendor", "pi"'))
})

test('vendored upstream files and manifest are present', () => {
  const manifestPath = path.join(ROOT, 'vendor', 'MANIFEST.json')
  assert.ok(fs.existsSync(manifestPath))
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  assert.equal(manifest.upstreams.rea.package, 'rea-agents@6.7.0')
  assert.ok(fs.existsSync(path.join(ROOT, 'vendor', 'rea-prompts', 'README.md')))
  assert.ok(fs.existsSync(path.join(ROOT, 'vendor', 'rea', 'contracts', 'toolContracts.ts')))
  assert.ok(fs.existsSync(path.join(ROOT, 'vendor', 'rea', 'skills', 'reverse-engineer-anything', 'SKILL.md')))
})

test('documentation site has pinned dependencies, examples, and a Pages workflow', () => {
  const sitePackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'site', 'package.json'), 'utf8'))
  assert.equal(sitePackage.dependencies.astro, '7.3.8')
  assert.equal(sitePackage.dependencies['@astrojs/starlight'], '0.42.6')

  for (const rel of [
    'site/src/pages/index.astro',
    'site/src/content/docs/start.md',
    'site/src/content/docs/what-it-does.md',
    'site/src/content/docs/examples/triage.md',
    'site/src/content/docs/examples/feature-trace.md',
    'site/src/content/docs/examples/clean-room-spec.md',
    'site/src/content/docs/examples/security-audit.md',
    'site/src/content/docs/examples/version-diff.md',
    'site/src/content/docs/examples/firmware.md'
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `Missing ${rel}`)
  }

  const config = fs.readFileSync(path.join(ROOT, 'site', 'astro.config.mjs'), 'utf8')
  assert.match(config, /"\/woodchipper\/"/)
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'site.yml'), 'utf8')
  assert.match(workflow, /actions\/configure-pages@[0-9a-f]{40}/)
  assert.match(workflow, /actions\/deploy-pages@[0-9a-f]{40}/)
})
