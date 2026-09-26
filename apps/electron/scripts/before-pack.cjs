const { join } = require('node:path')
const { Arch } = require('builder-util')
const { assertPackagingTarget, assertStagedRuntime, smokeSharp } = require('./packaging-runtime-checks.cjs')

module.exports = async function beforePack(context) {
  assertPackagingTarget(context.electronPlatformName, Arch[context.arch])
  const appDir = context.packager.info.appDir
  assertStagedRuntime(appDir)
  smokeSharp(require('electron'), join(appDir, 'node_modules', 'sharp'))
}
