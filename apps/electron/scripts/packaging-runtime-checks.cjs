/** 打包入口与产物的原生运行时校验，防止宿主平台依赖混入安装包。 */
const { existsSync, realpathSync } = require('node:fs')
const { join, relative, isAbsolute } = require('node:path')
const { spawnSync } = require('node:child_process')

function assertPackagingTarget(platform, arch, hostPlatform = process.platform, hostArch = process.arch) {
  if (platform !== hostPlatform || arch !== hostArch) {
    throw new Error(
      `[packaging] 不能把 ${hostPlatform}-${hostArch} 的运行时依赖打包为 ${platform}-${arch}。`
      + `请在 ${platform}-${arch} 机器或 CI Runner 上执行 bun install --frozen-lockfile，再执行对应的 dist 命令。`
      + 'sharp、esbuild、node-pty、OfficeCLI 和 Proma CLI 都必须匹配目标平台。',
    )
  }
}

function assertStagedRuntime(appDir) {
  for (const name of ['main', 'agent-runtime', 'terminal-runtime', 'preload']) {
    if (!existsSync(join(appDir, 'dist', `${name}.cjs`))) {
      throw new Error(`[packaging] 缺少 dist/${name}.cjs，请先执行 bun run build`)
    }
  }
  const nodeModules = join(appDir, 'node_modules')
  const sharpManifest = join(nodeModules, 'sharp', 'package.json')
  if (!existsSync(sharpManifest)) {
    throw new Error('[packaging] 缺少已同步的 sharp，请先执行 bun run sync:runtime-deps')
  }
  const location = relative(realpathSync(nodeModules), realpathSync(sharpManifest))
  if (location.startsWith('..') || isAbsolute(location)) {
    throw new Error('[packaging] sharp 仍指向工作区外部依赖，请先执行 bun run sync:runtime-deps')
  }
}

/** 使用 Electron 自身加载 sharp 并编码图片，同时验证 addon 和 libvips 动态库。 */
function smokeSharp(executable, sharpPath) {
  const script = `
    const sharp = require(${JSON.stringify(sharpPath)});
    sharp({ create: { width: 2, height: 2, channels: 4, background: '#336699' } })
      .png().toBuffer().then(buffer => {
        if (buffer.length === 0) throw new Error('图片编码结果为空');
        console.log('[packaging] sharp 原生模块与图片编码验证通过');
      }).catch(error => { console.error(error); process.exitCode = 1; });
  `
  const result = spawnSync(executable, ['--eval', script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  })
  if (result.error || result.status !== 0) {
    throw new Error(
      `[packaging] sharp 运行时验证失败，已停止生成安装包。请在目标平台重新执行 bun install --frozen-lockfile 和 bun run sync:runtime-deps。\n`
      + (result.error?.message || result.stderr || result.stdout || `退出码 ${result.status}`),
    )
  }
  console.log(result.stdout.trim())
}

module.exports = { assertPackagingTarget, assertStagedRuntime, smokeSharp }
