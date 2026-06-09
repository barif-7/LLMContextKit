#!/usr/bin/env node
/**
 * Adds HistoryKit to the local Claude Desktop config so the agent can call
 * its tools without manual JSON editing.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const platform = process.platform;
let configPath;
if (platform === 'darwin') {
  configPath = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
} else if (platform === 'win32') {
  configPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json');
} else {
  configPath = path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

const serverPath = path.resolve(__dirname, '..', 'historykit-mcp', 'dist', 'index.js');
const node22Path = path.join(os.homedir(), '.nvm', 'versions', 'node', 'v22.22.3', 'bin', 'node');
const nodeCommand = process.env.HISTORYKIT_NODE_BIN || (fs.existsSync(node22Path) ? node22Path : process.execPath);
const dbPath = process.env.HISTORYKIT_DB_PATH || (
  platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'historykit', 'historykit.db')
    : platform === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Roaming', 'HistoryKit', 'historykit.db')
      : path.join(os.homedir(), '.config', 'HistoryKit', 'historykit.db')
);

if (!fs.existsSync(serverPath)) {
  console.error('MCP server not built. Run: npm run mcp:build');
  process.exit(1);
}

let config = {};
if (fs.existsSync(configPath)) {
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch (e) { /* ignore */ }
}
config.mcpServers = config.mcpServers || {};
config.mcpServers.historykit = {
  command: nodeCommand,
  args: [serverPath],
  env: {
    HISTORYKIT_DB_PATH: dbPath,
  },
};

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

console.log('HistoryKit MCP installed to:');
console.log('  ' + configPath);
console.log('\nRestart Claude Desktop / Claude Code to load the new server.');
