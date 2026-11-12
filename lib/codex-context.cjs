'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const SELECTED_PROJECT_PREFIX = 'electron-owner-value:selected-project:';

function codexHome() {
  const configured = process.env.CODEX_HOME;
  return path.resolve(configured && configured.trim() ? configured : path.join(os.homedir(), '.codex'));
}

async function normalizeExistingDirectory(candidate) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return null;
  const normalized = path.resolve(candidate);
  try {
    const stat = await fs.stat(normalized);
    return stat.isDirectory() ? normalized : null;
  } catch {
    return null;
  }
}

async function readCodexProject() {
  const statePath = path.join(codexHome(), '.codex-global-state.json');
  let state;
  try {
    state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  } catch {
    return null;
  }

  const selectedKey = Object.keys(state).find((key) => key.startsWith(SELECTED_PROJECT_PREFIX));
  const selected = selectedKey && state[selectedKey];
  const projectId = selected && typeof selected === 'object' && selected.projectId;
  const projectMap = state['local-projects'];
  const project = projectId && projectMap && typeof projectMap === 'object' ? projectMap[projectId] : null;
  const roots = project && Array.isArray(project.rootPaths)
    ? [...new Set((await Promise.all(project.rootPaths.map(normalizeExistingDirectory))).filter(Boolean))]
    : [];

  // A multi-root selection has no single repository root. Don't guess one.
  if (roots.length !== 1) return null;
  return {
    root: roots[0],
    key: String(projectId),
    source: 'codex-global-state:selected-project/local-projects.rootPaths',
  };
}

module.exports = { readCodexProject };
