'use strict';

const path = require('path');

const DIEYUN_DIR_NAME = '.dieyun';
const INDEX_DB_NAME = 'index.sqlite';

function workspaceDieyunDir(workspaceRoot) {
  return path.join(path.resolve(String(workspaceRoot || '/')), DIEYUN_DIR_NAME);
}

function workspaceIndexDbPath(workspaceRoot) {
  return path.join(workspaceDieyunDir(workspaceRoot), INDEX_DB_NAME);
}

module.exports = {
  workspaceDieyunDir,
  workspaceIndexDbPath
};
