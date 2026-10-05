const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function context(options = {}) {
  const platform = options.platform || process.platform;
  return { platform, env: options.env || process.env, home: options.home || os.homedir(),
    fs: options.fs || fs, path: platform === 'win32' ? path.win32 : path.posix };
}

function defaultCodexCommand(platform = process.platform) {
  return platform === 'win32' ? 'codex.cmd' : 'codex';
}

function isDefaultCodexCommand(value) {
  return /^(?:codex(?:\.cmd|\.bat|\.exe)?)?$/i.test(String(value || '').trim());
}

function executable(file, ctx) {
  try {
    if (!ctx.fs.statSync(file).isFile()) return false;
    ctx.fs.accessSync(file, ctx.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch { return false; }
}

function buildCodexEnvironment(options = {}) {
  const ctx = context(options);
  if (ctx.platform === 'win32') return { ...ctx.env };
  const additions = [ctx.env.NVM_BIN, ctx.env.VOLTA_HOME && ctx.path.join(ctx.env.VOLTA_HOME, 'bin'),
    ctx.env.npm_config_prefix && ctx.path.join(ctx.env.npm_config_prefix, 'bin'),
    ctx.path.join(ctx.home, '.local/bin'), ctx.path.join(ctx.home, '.npm-global/bin'),
    ctx.path.join(ctx.home, '.volta/bin')];
  if (ctx.platform === 'darwin') additions.push('/opt/homebrew/bin', '/usr/local/bin');
  additions.push('/usr/bin', '/bin');
  // Finder does not inherit a login shell's PATH. Include installed Node versions
  // without executing shell startup files or mutating the user's environment.
  const nvmRoot = ctx.path.join(ctx.env.NVM_DIR || ctx.path.join(ctx.home, '.nvm'), 'versions/node');
  try {
    const versions = ctx.fs.readdirSync(nvmRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^v\d+\.\d+\.\d+$/.test(entry.name))
      .map(entry => entry.name).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
    additions.push(...versions.map(version => ctx.path.join(nvmRoot, version, 'bin')));
  } catch {}
  // An npm CLI's shebang uses /usr/bin/env node. Prefer its paired Node when
  // the selected CLI belongs to a version manager, instead of a different Node
  // inherited from Finder/Homebrew. Absolute custom CLI paths keep this pairing too.
  const command = String(options.command || '');
  const pairedBin = ctx.path.isAbsolute(command) ? ctx.path.dirname(command) : '';
  const paired = pairedBin && executable(ctx.path.join(pairedBin, 'node'), ctx) ? [pairedBin] : [];
  return { ...ctx.env, PATH: [...new Set([...paired, ...(ctx.env.PATH || '').split(':'), ...additions].filter(Boolean))].join(':') };
}

function findDesktopCodexExecutable(options = {}) {
  const ctx = context(options);
  if (ctx.platform !== 'win32') return '';
  const root = ctx.path.join(ctx.env.LOCALAPPDATA || ctx.path.join(ctx.home, 'AppData/Local'), 'OpenAI/Codex/bin');
  const candidates = [ctx.path.join(root, 'codex.exe')];
  try {
    for (const entry of ctx.fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(ctx.path.join(root, entry.name, 'codex.exe'));
    }
  } catch {}
  return candidates.filter(file => executable(file, ctx))
    .sort((a, b) => ctx.fs.statSync(b).mtimeMs - ctx.fs.statSync(a).mtimeMs)[0] || '';
}

function resolveCodexCmdPath(value, options = {}) {
  const ctx = context(options);
  const raw = String(value || '').trim();
  if (!isDefaultCodexCommand(raw)) {
    if (ctx.platform === 'win32') {
      const root = ctx.path.join(ctx.env.LOCALAPPDATA || ctx.path.join(ctx.home, 'AppData/Local'), 'OpenAI/Codex/bin');
      const relative = ctx.path.relative(root, raw);
      if (!ctx.fs.existsSync(raw) && relative && !relative.startsWith('..') && !ctx.path.isAbsolute(relative)
        && ctx.path.basename(raw).toLowerCase() === 'codex.exe') return findDesktopCodexExecutable(options) || raw;
    }
    return raw;
  }
  if (ctx.platform === 'win32') {
    const desktop = findDesktopCodexExecutable(options);
    if (desktop) return desktop;
    const searchPath = Object.entries(ctx.env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
    for (const directory of searchPath.split(';')) {
      const dir = directory.replace(/^"|"$/g, '');
      if (!ctx.path.isAbsolute(dir)) continue;
      for (const name of [...new Set([raw || 'codex.cmd', 'codex.exe', 'codex.cmd', 'codex.bat'])]) {
        const candidate = ctx.path.join(dir, name);
        if (executable(candidate, ctx)) return candidate;
      }
    }
    return raw || defaultCodexCommand(ctx.platform);
  }
  const env = buildCodexEnvironment(options);
  for (const directory of env.PATH.split(':').filter(directory => ctx.path.isAbsolute(directory))) {
    const candidate = ctx.path.join(directory, 'codex');
    if (executable(candidate, ctx)) return candidate;
  }
  return defaultCodexCommand(ctx.platform);
}

function detectCodexInstallation(value, options={}) {
  const ctx=context(options),command=resolveCodexCmdPath(value,options);
  if(ctx.path.isAbsolute(command))return {installed:executable(command,ctx),path:command};
  const env=buildCodexEnvironment(options);
  const searchPath=Object.entries(env).find(([key])=>ctx.platform==='win32'?key.toLowerCase()==='path':key==='PATH')?.[1] || '';
  const names=ctx.platform==='win32' && !ctx.path.extname(command)?[command+'.exe',command+'.cmd',command+'.bat']:[command];
  for(const directory of searchPath.split(ctx.platform==='win32'?';':':')){
    const dir=directory.replace(/^"|"$/g,'');if(!ctx.path.isAbsolute(dir))continue;
    for(const name of names){const candidate=ctx.path.join(dir,name);if(executable(candidate,ctx))return {installed:true,path:candidate};}
  }
  return {installed:false,path:command};
}
module.exports = { defaultCodexCommand, isDefaultCodexCommand, resolveCodexCmdPath, buildCodexEnvironment, detectCodexInstallation };
