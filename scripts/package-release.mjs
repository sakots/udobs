import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// リポジトリ全体を圧縮せず、配布に必要なものだけを収集する。
const files = [
  'package.json', 'pnpm-lock.yaml', 'tsconfig.json',
  '.env.example', '.gitignore', 'README.md', 'CHANGELOG.md', 'LICENSE',
  'src', 'scripts', 'test', 'docs', 'openspec/specs', 'openspec/config.yaml',
];
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const name = `udobs-${version}`;
const output = resolve('release');
const temporary = await mkdtemp(join(tmpdir(), 'udobs-release-'));

try {
  const staging = join(temporary, name);
  await mkdir(staging);
  for (const file of files) {
    const destination = join(staging, file);
    await mkdir(resolve(destination, '..'), { recursive: true });
    await cp(file, destination, { recursive: true });
  }
  await mkdir(output, { recursive: true });
  // 既存アーカイブへ追記せず、常に同じ収集内容から作り直す。
  for (const extension of ['zip', 'tar.gz', '7z']) {
    await rm(join(output, `${name}.${extension}`), { force: true });
  }
  const options = { cwd: temporary, stdio: 'inherit' };
  execFileSync('zip', ['-qr', join(output, `${name}.zip`), name], options);
  execFileSync('tar', ['-czf', join(output, `${name}.tar.gz`), name], options);
  execFileSync('7z', ['a', '-t7z', join(output, `${name}.7z`), name], options);
  console.log(`配布物を作成しました: ${output}/${name}.{zip,tar.gz,7z}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
