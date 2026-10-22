#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodchipper-vendor-'))

try {
  console.log('Cloning upstream repositories into temp directory...')
  execFileSync('git', ['clone', '--depth', '1', 'https://github.com/morluto/rea.git', path.join(tmpDir, 'rea')], { stdio: 'inherit' })
  execFileSync('git', ['clone', '--depth', '1', 'https://github.com/JoasASantos/REA-Prompts.git', path.join(tmpDir, 'rea-prompts')], { stdio: 'inherit' })

  const reaCommit = execFileSync('git', ['-C', path.join(tmpDir, 'rea'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const reaDate = execFileSync('git', ['-C', path.join(tmpDir, 'rea'), 'log', '-1', '--format=%ci'], { encoding: 'utf8' }).trim()
  const reapCommit = execFileSync('git', ['-C', path.join(tmpDir, 'rea-prompts'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const reapDate = execFileSync('git', ['-C', path.join(tmpDir, 'rea-prompts'), 'log', '-1', '--format=%ci'], { encoding: 'utf8' }).trim()

  const reaPkg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'rea', 'package.json'), 'utf8'))

  // Copy REA-Prompts
  fs.mkdirSync(path.join(ROOT, 'vendor', 'rea-prompts'), { recursive: true })
  fs.copyFileSync(path.join(tmpDir, 'rea-prompts', 'README.md'), path.join(ROOT, 'vendor', 'rea-prompts', 'README.md'))

  // Copy REA core docs, skills, contracts, and bridges
  const reaDest = path.join(ROOT, 'vendor', 'rea')
  fs.mkdirSync(reaDest, { recursive: true })
  for (const topFile of ['README.md', 'AGENTS.md', 'LICENSE', 'DISCLAIMER.md', 'THIRD_PARTY_NOTICES.md', 'package.json', 'server.json']) {
    const srcFile = path.join(tmpDir, 'rea', topFile)
    if (fs.existsSync(srcFile)) fs.copyFileSync(srcFile, path.join(reaDest, topFile))
  }
  fs.cpSync(path.join(tmpDir, 'rea', 'docs'), path.join(reaDest, 'docs'), { recursive: true })
  fs.cpSync(path.join(tmpDir, 'rea', '.agents', 'skills'), path.join(reaDest, 'skills'), { recursive: true })
  fs.cpSync(path.join(tmpDir, 'rea', 'bridge'), path.join(reaDest, 'bridge'), { recursive: true })
  fs.mkdirSync(path.join(reaDest, 'contracts'), { recursive: true })
  for (const contractFile of ['cliCommandNames.ts', 'promptContracts.ts', 'toolContracts.ts']) {
    const srcContract = path.join(tmpDir, 'rea', 'src', 'contracts', contractFile)
    if (fs.existsSync(srcContract)) fs.copyFileSync(srcContract, path.join(reaDest, 'contracts', contractFile))
  }

  const manifest = {
    vendored_at: new Date().toISOString().slice(0, 10),
    upstreams: {
      rea: {
        repository: 'https://github.com/morluto/rea',
        package: `${reaPkg.name}@${reaPkg.version}`,
        commit: reaCommit,
        commit_date: reaDate,
        license: reaPkg.license || 'Apache-2.0',
        included_paths: [
          'vendor/rea/skills/',
          'vendor/rea/docs/',
          'vendor/rea/contracts/',
          'vendor/rea/bridge/',
          'vendor/rea/README.md',
          'vendor/rea/AGENTS.md',
          'vendor/rea/LICENSE',
          'vendor/rea/DISCLAIMER.md',
          'vendor/rea/THIRD_PARTY_NOTICES.md',
          'vendor/rea/package.json',
          'vendor/rea/server.json'
        ]
      },
      rea_prompts: {
        repository: 'https://github.com/JoasASantos/REA-Prompts',
        commit: reapCommit,
        commit_date: reapDate,
        included_paths: ['vendor/rea-prompts/README.md']
      }
    }
  }
  fs.writeFileSync(path.join(ROOT, 'vendor', 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(`Updated vendor/ to rea@${reaPkg.version} (${reaCommit.slice(0, 8)}) and REA-Prompts (${reapCommit.slice(0, 8)})`)
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}
