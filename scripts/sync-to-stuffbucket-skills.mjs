#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DEFAULT_TARGET = path.resolve(ROOT, '..', 'skills', 'plugins', 'stuffbucket', 'skills')
const targetSkillsDir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_TARGET

if (!fs.existsSync(targetSkillsDir)) {
  console.error(`Target directory does not exist: ${targetSkillsDir}`)
  process.exit(1)
}

const sourceSkillsDir = path.join(ROOT, 'skills')
const skillFolders = fs.readdirSync(sourceSkillsDir).filter((f) => fs.statSync(path.join(sourceSkillsDir, f)).isDirectory())

for (const folder of skillFolders) {
  const src = path.join(sourceSkillsDir, folder)
  const dest = path.join(targetSkillsDir, folder)
  fs.cpSync(src, dest, { recursive: true })
  console.log(`Synced skills/${folder} -> ${dest}`)
}
