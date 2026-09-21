#!/usr/bin/env node
/**
 * DSH 子代理会话模型切换补丁 —— 跨平台应用器（Windows / macOS / Linux）
 *
 * 用法：
 *   node apply-subagent-model-patch.mjs             # 应用（自动定位 dsh 安装根）
 *   node apply-subagent-model-patch.mjs --check     # 只检查，不写盘
 *   node apply-subagent-model-patch.mjs --verify    # 验证运行实例实际加载的是否已打补丁
 *   node apply-subagent-model-patch.mjs --scan      # 列出机器上所有同名包副本及补丁状态
 *   node apply-subagent-model-patch.mjs --revert    # 回滚（用备份文件还原）
 *   node apply-subagent-model-patch.mjs --dsh <安装根目录>
 *   node apply-subagent-model-patch.mjs --profile <profile 目录>   # 配合 --verify
 *
 * 目标：把 <dsh>/node_modules/@deepseek-ai/{dsh-subagent, dsh-api-session-controller,
 *      dsh-client-ui-model-selection} 三个核心包，以及 profile 下可选的第三方
 *      模型选择插件（dsh-model-garden / dsh-model-picker，若已安装）按补丁改写。
 * 安全性：幂等（已打补丁的文件跳过）、逐 hunk 唯一锚点匹配（bundle 变了会明确报错而不乱写）、
 *        自动适配 LF/CRLF、写前自动备份、支持 --revert 回滚。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 解析 dsh 安装根（含 package.json name=@deepseek-ai/dsh 的目录）。 */
function resolveDshRoot(explicit) {
  const tried = [];
  const consider = (candidate, why) => {
    if (candidate === undefined) return undefined;
    tried.push(candidate + '  (' + why + ')');
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(candidate, 'package.json'), 'utf8'));
      if (pkg.name === '@deepseek-ai/dsh') return candidate;
    } catch {}
    return undefined;
  };
  if (explicit !== undefined) {
    const direct = consider(path.resolve(explicit), '--dsh');
    if (direct !== undefined) return direct;
    const nested = consider(path.resolve(explicit, 'node_modules', '@deepseek-ai', 'dsh'), '--dsh/node_modules');
    if (nested !== undefined) return nested;
    return { error: 'cannot find a @deepseek-ai/dsh package under ' + explicit };
  }
  // 1) 本脚本所在目录向上找
  let dir = HERE;
  for (let i = 0; i < 12; i++) {
    const hit = consider(dir, 'walk-up');
    if (hit !== undefined) return hit;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 2) node 全局模块目录（npm -g / nvm / AppData\npm 等）
  for (const g of (process.env.NODE_PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const hit = consider(path.join(g, '@deepseek-ai', 'dsh'), 'NODE_PATH');
    if (hit !== undefined) return hit;
  }
  const globalRoots = [
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules'),
    path.join(path.dirname(process.execPath), 'node_modules'),
    path.join(process.env.APPDATA ?? '', 'npm', 'node_modules'),
    path.join(process.env.LOCALAPPDATA ?? '', 'npm', 'node_modules'),
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules'),
    '/usr/local/lib/node_modules', '/usr/lib/node_modules',
  ];
  for (const root of globalRoots) {
    const hit = consider(path.join(root, '@deepseek-ai', 'dsh'), 'global-root');
    if (hit !== undefined) return hit;
  }
  // 3) dsh 自己解析
  try {
    const require_ = createRequire(import.meta.url);
    const entry = require_.resolve('@deepseek-ai/dsh/package.json');
    const hit = consider(path.dirname(entry), 'require.resolve');
    if (hit !== undefined) return hit;
  } catch {}
  return { error: 'cannot locate the dsh installation. Pass --dsh <path-to-dsh-package>.\nTried:\n  ' + tried.join('\n  ') };
}

function parseArgs(argv) {
  const out = { mode: 'apply', dsh: undefined, profile: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check' || a === '--dry-run') out.mode = 'check';
    else if (a === '--revert' || a === '--undo') out.mode = 'revert';
    else if (a === '--verify') out.mode = 'verify';
    else if (a === '--scan') out.mode = 'scan';
    else if (a === '--dsh') out.dsh = argv[++i];
    else if (a === '--profile') out.profile = argv[++i];
    else if (a === '--help' || a === '-h') out.mode = 'help';
    else throw new Error('unknown argument: ' + a);
  }
  return out;
}

/** 是否已打补丁：全部 hunk 的新文本都在（按文件换行风格）。 */
function isPatchedFile(specFile, text) {
  const crlf = text.includes('\r\n');
  return specFile.hunks.every(h => findAnchor(text, h.neu) !== undefined);
}

/** DSH home：优先环境变量，其次 ~/.dsh。 */
function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh');
}

/** dsh 的 profile 目录（默认 web）。 */
function defaultProfileDir() {
  return path.join(dshHome(), 'profiles', 'web');
}

/**
 * 用 Node 的解析规则从某个目录出发解析包——这正是 dsh 进程加载模块的方式。
 * @returns 解析到的 package.json 路径，或 { error }。
 */
function resolveFrom(anchorDir, pkg) {
  try {
    const req = createRequire(path.join(anchorDir, '__probe__.cjs'));
    return req.resolve(pkg + '/package.json');
  } catch (error) {
    return { error: error.code ?? String(error) };
  }
}

/** 扫描给定根目录下所有同名包副本（跟随 symlink）。 */
function scanCopies(roots) {
  const found = new Map();
  const seen = new Set();
  const visit = (dir, depth) => {
    if (depth > 6) return;
    let real;
    try { real = fs.realpathSync(dir); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);
    for (const file of spec.files) {
      const target = path.join(dir, ...file.package.split('/'), file.path);
      if (!fs.existsSync(target)) continue;
      const rec = found.get(real + '|' + file.package) ?? { dir: real, pkg: file.package, entries: [] };
      let patched = false;
      try { patched = isPatchedFile(file, fs.readFileSync(target, 'utf8')); } catch {}
      rec.entries.push({ path: file.path, patched });
      found.set(real + '|' + file.package, rec);
    }
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (e.name === '.git') continue;
      visit(path.join(dir, e.name), depth + 1);
    }
  };
  for (const r of roots) if (fs.existsSync(r)) visit(r, 0);
  return [...found.values()];
}

const HELP = [
  'DSH 子代理会话模型切换补丁应用器',
  '',
  '  node apply-subagent-model-patch.mjs --check           只检测（不写盘）',
  '  node apply-subagent-model-patch.mjs --scan            列出机器上所有同名包副本及补丁状态',
  '  node apply-subagent-model-patch.mjs --verify          验证"运行实例实际加载的副本"是否已打补丁',
  '  node apply-subagent-model-patch.mjs                   应用补丁',
  '  node apply-subagent-model-patch.mjs --revert          回滚（从备份还原）',
  '  node apply-subagent-model-patch.mjs --dsh <路径>      指定 dsh 安装包目录',
  '  node apply-subagent-model-patch.mjs --verify --profile <目录>   指定要验证的 profile',
  '',
  '应用后必须**重启 dsh 进程**（后端模块在启动时载入）。',
].join('\n');

const args = parseArgs(process.argv.slice(2));
if (args.mode === 'help') { console.log(HELP); process.exit(0); }

const spec = JSON.parse(fs.readFileSync(path.join(HERE, 'hunks.json'), 'utf8'));

// ---- --scan：列出所有副本及状态（避免"改了没被加载的那一份"）----
if (args.mode === 'scan') {
  const home = dshHome();
  const roots = [
    args.dsh,
    path.join(home, 'profiles'),
    path.join(home, 'profiles', 'node_modules'),
    path.join(home, 'node_modules'),
    path.join(process.execPath, '..', '..', 'lib', 'node_modules'),
    path.join(process.env.APPDATA ?? '', 'npm', 'node_modules'),
    path.join(process.env.LOCALAPPDATA ?? '', 'npm', 'node_modules'),
    '/usr/local/lib/node_modules', '/usr/lib/node_modules',
  ].filter(r => r !== undefined && r !== '');
  const copies = scanCopies(roots);
  if (copies.length === 0) { console.log('no copies of the three packages found under:\n  ' + roots.join('\n  ')); }
  const rows = [];
  for (const c of copies) {
    const all = c.entries.every(e => e.patched);
    const some = c.entries.some(e => e.patched);
    rows.push({ state: all ? 'PATCHED' : some ? 'PARTIAL' : 'pristine', dir: c.dir, pkg: c.pkg, files: c.entries.length });
  }
  rows.sort((a, b) => (a.pkg === b.pkg ? (a.state < b.state ? -1 : 1) : (a.pkg < b.pkg ? -1 : 1)));
  for (const r of rows) console.log(r.state.padEnd(9) + r.pkg + '  (' + r.files + ' files)\n          ' + r.dir);
  console.log('\ntip: run with --verify to check which copy the running web profile actually loads.');
  process.exit(0);
}

// ---- --verify：用 Node 解析规则确认 profile 实际加载的副本 ----
if (args.mode === 'verify') {
  const profileDir = args.profile !== undefined ? path.resolve(args.profile) : defaultProfileDir();
  console.log('profile: ' + profileDir);
  if (!fs.existsSync(profileDir)) { console.error('error: profile directory does not exist: ' + profileDir); process.exit(2); }
  let bad = 0;
  for (const pkg of [...new Set(spec.files.map(f => f.package))]) {
    const resolvedPath = resolveFrom(profileDir, pkg);
    if (typeof resolvedPath === 'object') { console.error('UNRESOLVED ' + pkg + ' (' + resolvedPath.error + ')'); bad++; continue; }
    const pkgRoot = path.dirname(resolvedPath);
    for (const file of spec.files.filter(f => f.package === pkg)) {
      const target = path.join(pkgRoot, file.path);
      let text;
      try { text = fs.readFileSync(target, 'utf8'); } catch { console.error('MISSING    ' + pkg + '/' + file.path); bad++; continue; }
      const ok = isPatchedFile(file, text);
      console.log((ok ? 'OK        ' : 'NOT-PATCHED ') + pkg + '/' + file.path);
      if (!ok) bad++;
    }
    console.log('            loaded from ' + pkgRoot);
  }
  console.log('');
  console.log(bad === 0
    ? 'verify: the running web profile resolves every patched file. Restart dsh to load backend changes.'
    : 'verify: ' + bad + ' file(s) NOT patched on the copy this profile loads. Run --scan then apply with --dsh pointing at that installation, or patch that copy.');
  process.exit(bad === 0 ? 0 : 1);
}

const resolved = resolveDshRoot(args.dsh);
if (typeof resolved === 'object' && resolved.error !== undefined) {
  console.error('error: ' + resolved.error);
  process.exit(2);
}
const dshRoot = resolved;

// 版本提示（非阻断）
try {
  const v = JSON.parse(fs.readFileSync(path.join(dshRoot, 'package.json'), 'utf8')).version;
  if (v !== spec.target.versionVerified) {
    console.warn('warn: dsh ' + v + ' was not the verified version (' + spec.target.versionVerified + '). If it fails, re-derive the patch from the new bundle.');
  } else {
    console.log('dsh ' + v + ' at ' + dshRoot);
  }
} catch {}

/**
 * 备份根目录。每个 dsh 安装各占一个子目录——否则对 A 安装打完补丁后再给 B 安装打，
 * B 的备份会被 A 的备份"占用"（existsSync 命中即跳过写入），导致对 B 执行 --revert
 * 时还原成 A 的原始文件。用安装根路径的稳定散列做隔离键。
 */
const BACKUP_ROOT = path.join(HERE, 'backup-auto');
const BACKUP_DIR = path.join(BACKUP_ROOT, installKey(dshRoot));

/** 由安装根路径派生一个稳定、文件系统安全的短键。 */
function installKey(root) {
  let h = 5381;
  const normalized = path.resolve(root);
  for (let i = 0; i < normalized.length; i++) h = ((h * 33) ^ normalized.charCodeAt(i)) >>> 0;
  const safe = path.basename(normalized).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 24);
  return safe + '-' + h.toString(16).padStart(8, '0');
}

/** 定位补丁目标文件所在目录：dsh 核心包在安装根 node_modules 下；第三方 profile 插件在 ~/.dsh/profiles/web/node_modules 下。 */
function targetDir(file) {
  if (file.base === 'profile') {
    return path.join(dshHome(), 'profiles', 'web', 'node_modules', ...file.package.split('/'));
  }
  return path.join(dshRoot, 'node_modules', ...file.package.split('/'));
}

/**
 * 匹配一段锚点，容忍换行风格差异。依次尝试：
 *   1) 原文（LF）；2) 全 CRLF；3) "换行风格无关"的正则（\r 可有可无）。
 * 第 3 种用于目标文件换行混杂（部分 CRLF + 部分 LF）的情况。
 * @returns { index, length }（length 为原文实际命中长度）或 undefined。
 */
function findAnchor(text, anchor) {
  const exact = text.indexOf(anchor);
  if (exact >= 0) return { index: exact, length: anchor.length };
  const crlfAnchor = anchor.split('\n').join('\r\n');
  const asCrlf = text.indexOf(crlfAnchor);
  if (asCrlf >= 0) return { index: asCrlf, length: crlfAnchor.length };
  const m = new RegExp(anchorToPattern(anchor)).exec(text);
  return m === null ? undefined : { index: m.index, length: m[0].length };
}
/** 锚点在文本中出现的次数（用于歧义检测），同样容忍换行风格。 */
function countAnchor(text, anchor) {
  return (text.match(new RegExp(anchorToPattern(anchor), 'g')) ?? []).length;
}
/** 把锚点转成换行风格无关的正则源码：转义元字符，换行写成 \r?\n。 */
function anchorToPattern(anchor) {
  const META = /[.*+?^()$|[\]\\{}]/g;
  return anchor.replace(META, '\\$&').split('\n').join('\r?\n');
}
/**
 * 目标文件的主要换行风格：按**多数派**判断（CRLF 行数 > LF 行数 才按 CRLF 写出）。
 * 早先"出现过任意 CRLF 就按 CRLF"会让一个几乎全 LF、只有个别 CRLF 的文件，
 * 被插入整段 CRLF 新内容，从而引入混合换行（审查实测 L1）。
 */
function detectCrlf(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lfOnly = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lfOnly;
}
/** 把补丁里的替换文本按目标文件的主要换行风格写出，避免引入混合换行。 */
function toStyleText(text, crlf) {
  return crlf ? text.split('\n').join('\r\n') : text;
}

let applied = 0, skipped = 0, failed = 0, reverted = 0, missingBackup = 0, optionalSkipped = 0;

// ---- 阶段一：规划（只读，绝不写盘）----
// 关键安全保证：全部文件校验通过后才进入写入阶段。否则"前几个文件已写入、后面一个失败"
// 会留下半打补丁的安装（后端包互相依赖，比完全不打更难排查）。单文件内部本就整份计算后
// 才写出，因此不会有半成品文件。
const plan = [];

for (const file of spec.files) {
  const target = path.join(targetDir(file), file.path);
  const label = file.package + '/' + file.path;
  const backup = path.join(BACKUP_DIR, file.package.replace('@deepseek-ai/', ''), file.path.replace(/\//g, '__'));
  if (!fs.existsSync(target)) {
    // 非运行时入口（如 dsh-subagent/lib/types/continuation.js）在新版本里可能被删除；
    // 它只是"保持源码树自洽"的附带补丁，缺失不应让整次应用失败。
    if (file.optional === true) { console.log('OPTIONAL ' + label + ' (absent in this version; skipped)'); optionalSkipped++; continue; }
    console.error('MISSING  ' + label + ' (not found: ' + target + ')'); failed++; continue;
  }
  const original = fs.readFileSync(target, 'utf8');
  // 换行风格：文件里出现 \r\n 即按 CRLF 写出（Windows 上 git autocrlf 的常见结果）。
  const crlf = detectCrlf(original);
  // 判定"已打补丁"同样用未加风格的锚点，由 findAnchor 容忍 CRLF/混合换行。
  const isPatched = file.hunks.every(h => findAnchor(original, h.neu) !== undefined);

  if (args.mode === 'revert') {
    if (!fs.existsSync(backup)) {
      if (file.optional === true) { console.log('OPTIONAL ' + label + ' (no backup; skipped)'); optionalSkipped++; continue; }
      console.error('NO-BACKUP ' + label + ' (looked for ' + backup + ')'); missingBackup++; continue;
    }
    plan.push({ kind: 'revert', label, target, text: fs.readFileSync(backup, 'utf8'), before: original });
    continue;
  }
  if (isPatched) { console.log('SKIP     ' + label + ' (already patched)'); skipped++; continue; }

  // 计算新内容：要求每个 hunk 的 old 恰好出现一次
  let text = original;
  let ok = true;
  for (let i = 0; i < file.hunks.length; i++) {
    const h = file.hunks[i];
    // 匹配用"未加风格的 LF 锚点"，由 findAnchor/countAnchor 内部容忍 CRLF 与混合换行。
    // 若先把锚点转成 CRLF 再交给它们，会生成 \r\r?\n 而无法命中。
    const anchor = h.old;
    const replacement = toStyleText(h.neu, crlf);
    const hits = countAnchor(text, anchor);
    if (hits === 0) { console.error('FAILED   ' + label + ' hunk#' + (i + 1) + ': anchor text not found (bundle changed?)'); ok = false; break; }
    if (hits > 1) { console.error('FAILED   ' + label + ' hunk#' + (i + 1) + ': anchor text is ambiguous (appears ' + hits + ' times)'); ok = false; break; }
    const hit = findAnchor(text, anchor);
    text = text.slice(0, hit.index) + replacement + text.slice(hit.index + hit.length);
  }
  if (!ok) { failed++; continue; }
  if (args.mode === 'check') { console.log('OK       ' + label + ' (all ' + file.hunks.length + ' hunks anchor cleanly' + (crlf ? '; CRLF detected, newline style preserved' : '') + ')'); applied++; continue; }
  plan.push({ kind: 'apply', label, target, text, backup, original, hunks: file.hunks.length });
}

// ---- 阶段二：写入（有任何失败则整体不写）----
if (failed > 0 || missingBackup > 0) {
  console.error('');
  console.error('aborted: ' + failed + ' file(s) failed and ' + missingBackup + ' lacked a backup; NOTHING was written.');
  console.error('the installation is left exactly as it was.');
  process.exit(1);
}

/** 已写入的项目，用于 I/O 失败时按逆序回滚。 */
const written = [];
let ioFailure;

for (const item of plan) {
  try {
    if (item.kind === 'revert') {
      fs.writeFileSync(item.target, item.text);
      written.push({ target: item.target, before: item.before });
      console.log('reverted ' + item.label);
      reverted++;
      continue;
    }
    fs.mkdirSync(path.dirname(item.backup), { recursive: true });
    // 备份只在"内容与现有备份一致"或"尚无备份"时写入；
    // 若已存在**不同内容**的备份，说明该备份属于另一次安装/另一种换行状态，
    // 绝不能覆盖成错误的还原源——直接报错中止（见 H2）。
    if (fs.existsSync(item.backup)) {
      const existing = fs.readFileSync(item.backup, 'utf8');
      if (existing !== item.original) {
        throw new Error('backup at ' + item.backup + ' holds different content than the current file; '
          + 'refusing to overwrite it. That backup belongs to another installation, or the file changed '
          + 'after the backup was taken (e.g. dsh was upgraded and re-patched). '
          + 'Inspect it, then move/remove that backup directory and retry.');
      }
    } else {
      fs.writeFileSync(item.backup, item.original);
    }
    fs.writeFileSync(item.target, item.text);
    written.push({ target: item.target, before: item.original });
    console.log('PATCHED  ' + item.label + ' (' + item.hunks + ' hunks; backup: ' + item.backup + ')');
    applied++;
  } catch (error) {
    ioFailure = { error, label: item.label };
    break;
  }
}

// 写入期失败：按逆序把已写文件恢复原状，避免留下"半打补丁"的安装。
if (ioFailure !== undefined) {
  console.error('');
  console.error('FAILED   ' + ioFailure.label + ': ' + (ioFailure.error?.message ?? String(ioFailure.error)));
  let restored = 0;
  for (const w of written.reverse()) {
    try { fs.writeFileSync(w.target, w.before); restored++; }
    catch (rollbackError) { console.error('ROLLBACK-FAILED ' + w.target + ': ' + rollbackError.message); }
  }
  console.error('rolled back ' + restored + ' already-written file(s); the installation is back to its previous state.');
  console.error('note: backups created during this run are kept for inspection under ' + BACKUP_DIR + '.');
  process.exit(1);
}

console.log('');
const optionalNote = optionalSkipped > 0 ? ', ' + optionalSkipped + ' optional file(s) absent' : '';
console.log(args.mode === 'check'
  ? 'check: ' + applied + ' ready, ' + skipped + ' already patched' + optionalNote + ', ' + failed + ' failed'
  : args.mode === 'revert'
    ? 'revert: ' + reverted + ' restored' + optionalNote + ', ' + missingBackup + ' without backup'
    : 'apply: ' + applied + ' patched, ' + skipped + ' already patched' + optionalNote + ', ' + failed + ' failed');
if (args.mode === 'apply' && applied > 0) console.log('NEXT: restart the dsh process (backend modules load at startup).');
process.exit(failed > 0 || missingBackup > 0 ? 1 : 0);
