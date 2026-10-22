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

test('vendored upstream files and manifest are present', () => {
  const manifestPath = path.join(ROOT, 'vendor', 'MANIFEST.json')
  assert.ok(fs.existsSync(manifestPath))
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  assert.equal(manifest.upstreams.rea.package, 'rea-agents@6.7.0')
  assert.ok(fs.existsSync(path.join(ROOT, 'vendor', 'rea-prompts', 'README.md')))
  assert.ok(fs.existsSync(path.join(ROOT, 'vendor', 'rea', 'contracts', 'toolContracts.ts')))
  assert.ok(fs.existsSync(path.join(ROOT, 'vendor', 'rea', 'skills', 'reverse-engineer-anything', 'SKILL.md')))
})
