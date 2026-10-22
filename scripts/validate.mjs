#!/usr/bin/env node
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

// 3. Validate Playbooks & Vendor Manifest
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

if (errors > 0) {
  console.error(`\nValidation failed with ${errors} error(s).`)
  process.exit(1)
} else {
  console.log('\nAll Woodchipper checks passed.')
}
