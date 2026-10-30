#!/usr/bin/env node
// Provision (or reset) the dsh-https login password without going through the
// browser. This is the escape hatch for the first setup and for a forgotten
// password: it writes <dataDir>/auth/{password.hash,secret} with 0600 and, when
// asked, drops the plaintext into a 0600 file the operator can read.
//
// Usage:
//   node scripts/provision-auth.mjs [options]
//
//   --data-dir <dir>        plugin data dir (default: $DSH_HOME/https)
//   --password-file <path>  read the password from this file, or create it with
//                           the generated password (0600). Nothing secret is
//                           printed to stdout when this option is used.
//   --stdin                 read the password from standard input
//   --print                 print the generated password to stdout (default when
//                           neither --password-file nor --stdin is given)
//   --rotate-only           keep the current password, only rotate the session
//                           secret (logs every browser out)
//   --clear                 delete password.hash: back to first-run setup
//   --status                show what exists; never prints secrets
//   --quiet                 only print the data dir

import { access, readFile, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { MIN_PASSWORD_LENGTH } from '../lib/auth/core.js';
import { AuthStore } from '../lib/auth/store.js';

const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function usage(extra = '') {
  if (extra) process.stderr.write(`${extra}\n`);
  process.stderr.write(
    [
      '用法: node scripts/provision-auth.mjs [--data-dir <dir>] [--password-file <path>] [--stdin]',
      '                                   [--print] [--rotate-only] [--clear] [--status] [--quiet]',
      '',
      `密码至少 ${MIN_PASSWORD_LENGTH} 位。默认把插件数据目录当作 $DSH_HOME/https。`,
      '',
    ].join('\n'),
  );
  process.exit(2);
}

function parseArgs(argv) {
  const out = {
    dataDir: '',
    passwordFile: '',
    stdin: false,
    print: false,
    rotateOnly: false,
    clear: false,
    status: false,
    quiet: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) usage(`缺少 ${arg} 的参数`);
      return argv[index];
    };
    if (arg === '--data-dir') out.dataDir = next();
    else if (arg === '--password-file') out.passwordFile = next();
    else if (arg === '--stdin') out.stdin = true;
    else if (arg === '--print') out.print = true;
    else if (arg === '--rotate-only') out.rotateOnly = true;
    else if (arg === '--clear') out.clear = true;
    else if (arg === '--status') out.status = true;
    else if (arg === '--quiet') out.quiet = true;
    else if (arg === '-h' || arg === '--help') usage();
    else usage(`未知参数: ${arg}`);
  }
  return out;
}

function generatePassword() {
  const groups = [];
  for (let group = 0; group < 4; group += 1) {
    let chunk = '';
    for (let index = 0; index < 4; index += 1) {
      chunk += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }
    groups.push(chunk);
  }
  return groups.join('-');
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const dataDir = options.dataDir
    ? path.resolve(options.dataDir)
    : path.join(home, 'https');
  const store = new AuthStore({ dir: path.join(dataDir, 'auth'), logger: console });
  await store.init();

  if (options.status) {
    const hash = await store.readPasswordHash();
    const secret = await exists(store.secretFile);
    const token = await exists(store.setupTokenFile);
    process.stdout.write(
      JSON.stringify(
        {
          dataDir,
          authDir: store.dir,
          passwordConfigured: Boolean(hash),
          sessionSecret: secret,
          pendingSetupToken: token,
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  if (options.clear) {
    await store.clearPassword();
    process.stdout.write(`已删除密码文件 ${store.passwordFile}；下次打开入口会回到「一次性口令首次设置」流程。\n`);
    return;
  }

  if (options.rotateOnly) {
    const hash = await store.readPasswordHash();
    if (!hash) {
      process.stderr.write('当前没有设置密码，--rotate-only 无意义；请直接运行本脚本生成新密码。\n');
      process.exit(1);
    }
    await store.rotateSecret();
    process.stdout.write('已轮换会话签名密钥：所有已登录浏览器都会下线，密码不变。\n');
    return;
  }

  let password = '';
  let fromFile = false;
  if (options.stdin) {
    password = await readStdin();
  } else if (options.passwordFile && (await exists(options.passwordFile))) {
    password = (await readFile(options.passwordFile, 'utf8')).trim();
    fromFile = true;
  } else {
    password = generatePassword();
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    process.stderr.write(`密码至少需要 ${MIN_PASSWORD_LENGTH} 位。\n`);
    process.exit(1);
  }

  await store.setPassword(password);

  if (options.passwordFile && !fromFile) {
    await writeFile(options.passwordFile, `${password}\n`, { mode: 0o600 });
    await chmod(options.passwordFile, 0o600);
  }

  if (options.quiet) {
    process.stdout.write(`${store.dir}\n`);
    return;
  }

  if (options.passwordFile) {
    process.stdout.write(
      [
        `访问密码已写入 ${store.passwordFile}（0600）`,
        fromFile && !options.print ? `密码来自 ${options.passwordFile}` : `明文保存在 ${options.passwordFile}（0600，可读完即删）`,
        '所有已登录浏览器已下线。',
        '',
      ].join('\n'),
    );
    if (options.print && !fromFile) process.stdout.write(`新密码: ${password}\n`);
    return;
  }

  process.stdout.write(
    [
      '已生成新的访问密码（只显示这一次）:',
      '',
      `    ${password}`,
      '',
      `密码哈希保存在 ${store.passwordFile}（0600），会话密钥已轮换，所有浏览器已下线。`,
      '忘记时重新运行本脚本即可重置；也可以用 --password-file <路径> 避免密码出现在终端记录里。',
      '',
    ].join('\n'),
  );
}

main().catch((error) => {
  process.stderr.write(`provision-auth 失败: ${error && error.message ? error.message : String(error)}\n`);
  process.exit(1);
});