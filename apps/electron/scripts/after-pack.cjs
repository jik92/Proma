const { join } = require('node:path')
const { smokeSharp } = require('./packaging-runtime-checks.cjs')

module.exports = async function afterPack(context) {
  const name = context.packager.appInfo.productFilename
  const platform = context.electronPlatformName
  const contents = join(context.appOutDir, `${name}.app`, 'Contents')
  const executable = platform === 'darwin'
    ? join(contents, 'MacOS', name)
    : join(context.appOutDir, platform === 'win32' ? `${name}.exe` : context.packager.executableName)
  const resources = platform === 'darwin' ? join(contents, 'Resources') : join(context.appOutDir, 'resources')
  // 从最终 ASAR 加载，避免只验证构建机的 node_modules 而遗漏解包后的动态库。
  smokeSharp(executable, join(resources, 'app.asar', 'node_modules', 'sharp'))
}
