'use strict';

const fs = require('fs');
const path = require('path');

const TS_MARKERS = ['tsconfig.json', 'jsconfig.json'];
const PY_MARKERS = ['pyrightconfig.json'];
const PYPROJECT = 'pyproject.toml';
const ESLINT_MARKERS = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yaml',
  '.eslintrc.yml',
  '.eslintrc'
];
const RUFF_MARKERS = ['ruff.toml', '.ruff.toml'];
const PRETTIER_MARKERS = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.yaml',
  '.prettierrc.yml',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs'
];

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isInsideRoot(dir, root) {
  if (!root) return true;
  const rel = path.relative(path.resolve(root), path.resolve(dir));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function hasPyrightToml(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return /\[tool\.pyright\]/i.test(raw);
  } catch {
    return false;
  }
}

function findProjectRoot(absFilePath, workspaceRoot, serverKey) {
  const boundary = workspaceRoot ? path.resolve(workspaceRoot) : null;
  let dir = path.dirname(path.resolve(absFilePath));

  for (let i = 0; i < 24; i++) {
    if (serverKey === 'typescript') {
      for (const marker of TS_MARKERS) {
        if (isFile(path.join(dir, marker))) return dir;
      }
    } else if (serverKey === 'python') {
      for (const marker of PY_MARKERS) {
        if (isFile(path.join(dir, marker))) return dir;
      }
      const toml = path.join(dir, PYPROJECT);
      if (isFile(toml) && hasPyrightToml(toml)) return dir;
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    if (boundary && !isInsideRoot(parent, boundary)) break;
    dir = parent;
  }

  if (boundary && isInsideRoot(path.dirname(path.resolve(absFilePath)), boundary)) {
    return boundary;
  }
  return path.dirname(path.resolve(absFilePath));
}

function findWorkspaceTsProjectRoot(workspaceRoot) {
  const boundary = workspaceRoot ? path.resolve(workspaceRoot) : null;
  if (!boundary) return null;
  let dir = boundary;
  for (let i = 0; i < 24; i++) {
    for (const marker of TS_MARKERS) {
      if (isFile(path.join(dir, marker))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    if (!isInsideRoot(parent, boundary)) break;
    dir = parent;
  }
  return null;
}

function findWorkspacePyProjectRoot(workspaceRoot) {
  const boundary = workspaceRoot ? path.resolve(workspaceRoot) : null;
  if (!boundary) return null;
  let dir = boundary;
  for (let i = 0; i < 24; i++) {
    for (const marker of PY_MARKERS) {
      if (isFile(path.join(dir, marker))) return dir;
    }
    const toml = path.join(dir, PYPROJECT);
    if (isFile(toml) && hasPyrightToml(toml)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    if (!isInsideRoot(parent, boundary)) break;
    dir = parent;
  }
  return null;
}

function hasEslintPackageJson(dir) {
  const pkgPath = path.join(dir, 'package.json');
  if (!isFile(pkgPath)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg && pkg.eslintConfig) return true;
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    return !!(deps.eslint || deps['@eslint/js']);
  } catch {
    return false;
  }
}

function hasRuffToml(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return /\[tool\.ruff\]/i.test(raw);
  } catch {
    return false;
  }
}

function hasPrettierPackageJson(dir) {
  const pkgPath = path.join(dir, 'package.json');
  if (!isFile(pkgPath)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg && pkg.prettier) return true;
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    return !!deps.prettier;
  } catch {
    return false;
  }
}

function findWorkspaceEslintProjectRoot(workspaceRoot) {
  const boundary = workspaceRoot ? path.resolve(workspaceRoot) : null;
  if (!boundary) return null;
  let dir = boundary;
  for (let i = 0; i < 24; i++) {
    for (const marker of ESLINT_MARKERS) {
      if (isFile(path.join(dir, marker))) return dir;
    }
    if (hasEslintPackageJson(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    if (!isInsideRoot(parent, boundary)) break;
    dir = parent;
  }
  return null;
}

function findWorkspaceRuffProjectRoot(workspaceRoot) {
  const boundary = workspaceRoot ? path.resolve(workspaceRoot) : null;
  if (!boundary) return null;
  let dir = boundary;
  for (let i = 0; i < 24; i++) {
    for (const marker of RUFF_MARKERS) {
      if (isFile(path.join(dir, marker))) return dir;
    }
    const toml = path.join(dir, PYPROJECT);
    if (isFile(toml) && hasRuffToml(toml)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    if (!isInsideRoot(parent, boundary)) break;
    dir = parent;
  }
  return null;
}

function findWorkspacePrettierProjectRoot(workspaceRoot) {
  const boundary = workspaceRoot ? path.resolve(workspaceRoot) : null;
  if (!boundary) return null;
  let dir = boundary;
  for (let i = 0; i < 24; i++) {
    for (const marker of PRETTIER_MARKERS) {
      if (isFile(path.join(dir, marker))) return dir;
    }
    if (hasPrettierPackageJson(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    if (!isInsideRoot(parent, boundary)) break;
    dir = parent;
  }
  return null;
}

module.exports = {
  findProjectRoot,
  findWorkspaceTsProjectRoot,
  findWorkspacePyProjectRoot,
  findWorkspaceEslintProjectRoot,
  findWorkspaceRuffProjectRoot,
  findWorkspacePrettierProjectRoot,
  isInsideRoot
};
