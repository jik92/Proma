import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { writeJsonFileAtomic } from '../src/main/lib/safe-file'

interface PackagingRuntimeChecks {
  assertPackagingTarget(platform: string, arch: string, hostPlatform?: string, hostArch?: string): void
  assertStagedRuntime(appDir: string): void
  smokeSharp(executable: string, sharpPath: string): void
}
const { assertPackagingTarget, assertStagedRuntime, smokeSharp }: PackagingRuntimeChecks = require('./packaging-runtime-checks.cjs')
const fixtures: string[] = []

function createFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'proma-packaging-'))
  fixtures.push(dir)
  mkdirSync(join(dir, 'dist'))
  for (const name of ['main', 'agent-runtime', 'terminal-runtime', 'preload']) {
    writeFileSync(join(dir, 'dist', `${name}.cjs`), '')
  }
  mkdirSync(join(dir, 'node_modules', 'sharp'), { recursive: true })
  writeJsonFileAtomic(join(dir, 'node_modules', 'sharp', 'package.json'), { name: 'sharp' }, true)
  return dir
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('Given Electron 安装包需要与目标平台一致的原生依赖', () => {
  it('When 在 Windows x64 构建 Windows x64 Then 允许打包', () => {
    expect(() => assertPackagingTarget('win32', 'x64', 'win32', 'x64')).not.toThrow()
  })

  it('When 用 macOS ARM64 依赖打包 Windows x64 Then 在生成 exe 前拒绝混装', () => {
    expect(() => assertPackagingTarget('win32', 'x64', 'darwin', 'arm64')).toThrow('win32-x64 机器或 CI Runner')
  })

  it('When 操作系统相同但架构不符 Then 仍然拒绝混装', () => {
    expect(() => assertPackagingTarget('darwin', 'x64', 'darwin', 'arm64')).toThrow('不能把')
  })

  it('When 已构建所有进程并同步依赖 Then 通过准备校验', () => {
    expect(() => assertStagedRuntime(createFixture())).not.toThrow()
  })

  it('When 快速打包遗漏 utility process Then 拒绝发布缺失的运行时', () => {
    const dir = createFixture()
    rmSync(join(dir, 'dist', 'agent-runtime.cjs'))
    expect(() => assertStagedRuntime(dir)).toThrow('agent-runtime.cjs')
  })

  it('When 没有同步 sharp Then 提示同步命令', () => {
    const dir = createFixture()
    rmSync(join(dir, 'node_modules', 'sharp'), { recursive: true })
    expect(() => assertStagedRuntime(dir)).toThrow('sync:runtime-deps')
  })

  it('When sharp 仍是指向宿主工作区的链接 Then 拒绝使用外部依赖冒充已同步依赖', () => {
    const dir = createFixture()
    const source = createFixture()
    rmSync(join(dir, 'node_modules', 'sharp'), { recursive: true })
    symlinkSync(join(source, 'node_modules', 'sharp'), join(dir, 'node_modules', 'sharp'), 'junction')
    expect(() => assertStagedRuntime(dir)).toThrow('仍指向工作区外部依赖')
  })

  it('When Electron 加载真实 sharp 并编码 PNG Then 冒烟校验成功', () => {
    const electron: string = require('electron')
    expect(() => smokeSharp(electron, resolve(import.meta.dir, '../../..', 'node_modules', 'sharp'))).not.toThrow()
  })

  it('When 运行时原生模块无法加载 Then 冒烟校验阻止生成安装包', () => {
    const dir = createFixture()
    writeFileSync(join(dir, 'node_modules', 'sharp', 'index.js'), "throw new Error('缺少 win32-x64 原生模块')")
    const electron: string = require('electron')
    expect(() => smokeSharp(electron, join(dir, 'node_modules', 'sharp'))).toThrow('缺少 win32-x64 原生模块')
  })
})
