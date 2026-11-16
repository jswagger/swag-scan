#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url));
const TARGETS = ['.github/skills', '.agents/skills'];
const USAGE = `Usage: node scripts/install-copilot.mjs [--project DIR] [--target ${TARGETS.join('|')}] [--force]

Copies skills/ (including the shared review-tools-common helper) into a project.
  --project DIR  project root to install into (default: current directory)
  --target PATH  skills folder inside the project (default: ${TARGETS[0]})
  --force        overwrite skill folders that already exist`;

function parseArgs(argv) {
  const options = { project: process.cwd(), target: TARGETS[0], force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--force') options.force = true;
    else if (arg === '--project') options.project = argv[++i];
    else if (arg === '--target') options.target = argv[++i];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.project || !options.target) throw new Error('Missing value for an option.');
  return options;
}

function listSkillFolders() {
  return readdirSync(SKILLS_DIR).filter((name) => statSync(path.join(SKILLS_DIR, name)).isDirectory());
}

function install({ project, target, force }) {
  const destination = path.resolve(project, target);
  if (path.relative(path.resolve(project), destination).startsWith('..')) {
    throw new Error(`--target must stay inside the project: ${target}`);
  }
  const folders = listSkillFolders();
  const existing = folders.filter((name) => existsSync(path.join(destination, name)));
  if (existing.length > 0 && !force) {
    throw new Error(`Already installed: ${existing.join(', ')} in ${destination}. Re-run with --force to overwrite.`);
  }
  mkdirSync(destination, { recursive: true });
  for (const name of folders) {
    cpSync(path.join(SKILLS_DIR, name), path.join(destination, name), {
      recursive: true,
      filter: (source) => !source.split(path.sep).includes('test'),
    });
  }
  return { destination, folders };
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
  } else {
    const { destination, folders } = install(options);
    console.log(`Installed ${folders.join(', ')} into ${destination}`);
  }
} catch (error) {
  console.error(`${error.message}\n\n${USAGE}`);
  process.exit(1);
}
