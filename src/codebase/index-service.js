'use strict';

const path = require('path');
const crypto = require('crypto');
const { INDEX_FILE_MAX_BYTES } = require('../gateway/fs-read-limits');

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.dieyun',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.next',
  '.nuxt',
  'target',
  'vendor',
  'win-unpacked'
]);

const IGNORE_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.zip',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.pdf',
  '.woff',
  '.woff2',
  '.ttf',
  '.mp4',
  '.mp3',
  '.sqlite',
  '.db'
]);

const TEXT_EXT = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.json',
  '.md',
  '.css',
  '.scss',
  '.html',
  '.htm',
  '.py',
  '.java',
  '.go',
  '.rs',
  '.sql',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.vue',
  '.svelte',
  '.sh',
  '.bat',
  '.ps1',
  '.cpp',
  '.c',
  '.h',
  '.hpp',
  '.cs',
  '.rb',
  '.php',
  '.swift',
  '.kt'
]);

const MAX_FILE_BYTES = INDEX_FILE_MAX_BYTES;
const MAX_FILES = 8000;

function hashRoot(root) {
  return crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);
}

function isRemoteWorkspaceKey(key) {
  return /^ssh:\/\//i.test(String(key || '').trim());
}

function normalizeWorkspaceKey(workspaceKey) {
  const raw = String(workspaceKey || '').trim();
  if (!raw) return '';
  if (isRemoteWorkspaceKey(raw)) return raw.replace(/\/+$/, '') || raw;
  return path.resolve(raw);
}

function hashWorkspaceKey(workspaceKey) {
  const key = normalizeWorkspaceKey(workspaceKey);
  if (!key) return '';
  if (isRemoteWorkspaceKey(key)) {
    return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  }
  return hashRoot(key);
}

function shouldSkipDir(name) {
  return IGNORE_DIRS.has(name) || name.startsWith('.');
}

function isTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (IGNORE_EXT.has(ext)) return false;
  if (TEXT_EXT.has(ext)) return true;
  const base = path.basename(filePath);
  return (
    base === 'Dockerfile' ||
    base === 'Makefile' ||
    base.startsWith('.env') ||
    !ext
  );
}

module.exports = {
  hashWorkspaceKey,
  normalizeWorkspaceKey,
  isRemoteWorkspaceKey,
  MAX_FILES,
  MAX_FILE_BYTES,
  shouldSkipDir,
  isTextFile
};
