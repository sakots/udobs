import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const packager = fileURLToPath(new URL('../scripts/package-release.mjs', import.meta.url));

test('3形式の配布物は設定例と起動用ファイルを保持し、個人設定やログを除外する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'udobs-release-test-'));
  try {
    const files = {
      'package.json': JSON.stringify({ version: '1.2.3', type: 'module' }),
      'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
      'tsconfig.json': '{}',
      '.env.example': 'OBS_PASSWORD=\n',
      '.gitignore': '.env\n',
      'README.md': 'setup instructions',
      'CHANGELOG.md': 'changes',
      'LICENSE': 'license',
      'src/index.ts': 'console.log("app");',
      'scripts/start.mjs': 'console.log("launcher");',
      'test/example.test.ts': '// test',
      'docs/development.md': 'development',
      'openspec/specs/example/spec.md': 'specification',
      'openspec/config.yaml': 'schema: spec-driven',
      '.env': 'PRIVATE_PASSWORD=secret',
      'logs/private.log': 'private conversation',
      '.git/config': 'private repository metadata',
      'node_modules/private/index.js': 'local dependency',
      'dist/src/index.js': 'stale build',
      'openspec/changes/private/proposal.md': 'unreleased work',
    };
    for (const [path, content] of Object.entries(files)) {
      const destination = join(root, path);
      await mkdir(join(destination, '..'), { recursive: true });
      await writeFile(destination, content);
    }
    execFileSync(process.execPath, [packager], { cwd: root, stdio: 'pipe' });
    assert.deepEqual((await readdir(join(root, 'release'))).sort(), [
      'udobs-1.2.3.7z', 'udobs-1.2.3.tar.gz', 'udobs-1.2.3.zip',
    ]);
    for (const extension of ['zip', 'tar.gz', '7z']) {
      const extraction = join(root, `extract-${extension}`);
      await mkdir(extraction);
      const archive = join(root, 'release', `udobs-1.2.3.${extension}`);
      if (extension === 'tar.gz') {
        execFileSync('tar', ['-xzf', archive, '-C', extraction]);
      } else {
        execFileSync('7z', ['x', archive, `-o${extraction}`], { stdio: 'pipe' });
      }
      assert.deepEqual(await readdir(extraction), ['udobs-1.2.3']);
      const packaged = join(extraction, 'udobs-1.2.3');
      const paths = (await readdir(packaged, { recursive: true })).sort();
      for (const [path, content] of Object.entries(files)) {
        const excluded = path === '.env' || ['logs/', '.git/', 'node_modules/', 'dist/', 'openspec/changes/']
          .some(prefix => path.startsWith(prefix));
        if (excluded) {
          assert.ok(!paths.includes(path), `${extension}: ${path} must not be distributed`);
        } else {
          assert.equal(await readFile(join(packaged, path), 'utf8'), content, `${extension}: ${path}`);
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
