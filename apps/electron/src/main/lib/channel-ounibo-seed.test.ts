import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

type ChannelManagerModule = typeof import('./channel-manager')

let channelManager: ChannelManagerModule
let tempHome: string
const originalHome = process.env.HOME
const originalPromaDev = process.env.PROMA_DEV

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(process.env.HOME ?? tempHome, 'Library', 'Application Support'),
  },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: {
    openExternal: async () => undefined,
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

function readChannelsFile(): { version: number; channels: Array<Record<string, unknown>> } {
  const raw = readFileSync(join(tempHome, '.proma', 'channels.json'), 'utf-8')
  return JSON.parse(raw) as { version: number; channels: Array<Record<string, unknown>> }
}

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'proma-channel-ounibo-seed-'))
  process.env.HOME = tempHome
  process.env.PROMA_DEV = '0'
  channelManager = await import('./channel-manager')
})

beforeEach(() => {
  rmSync(join(tempHome, '.proma'), { recursive: true, force: true })
})

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalPromaDev === undefined) {
    delete process.env.PROMA_DEV
  } else {
    process.env.PROMA_DEV = originalPromaDev
  }
  rmSync(tempHome, { recursive: true, force: true })
})

describe('欧尼博内置渠道种子（开箱即用）', () => {
  test('Given 全新安装没有渠道配置 When listChannels Then 自动创建启用的欧尼博渠道并持久化', () => {
    const channels = channelManager.listChannels()

    const ounibo = channels.find((c) => c.baseUrl.includes('llm.ounirobot.com'))
    expect(ounibo).toBeDefined()
    expect(ounibo?.name).toBe('欧尼博 AI')
    expect(ounibo?.provider).toBe('custom')
    expect(ounibo?.baseUrl).toBe('https://llm.ounirobot.com/v1/chat/completions')
    expect(ounibo?.enabled).toBe(true)
    expect(ounibo?.models).toEqual([{ id: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash', enabled: true }])

    // 配置文件应已写盘，且密钥可解密回内置明文（本测试环境 safeStorage 不可用，按明文存取）
    expect(existsSync(join(tempHome, '.proma', 'channels.json'))).toBe(true)
    expect(ounibo ? channelManager.decryptApiKey(ounibo.id) : '').toBe(
      '89f015591a03d3ce621e30f09b9bb07610fe7e6996d20f19b7addf07bcc01745',
    )
  })

  test('Given 全新安装 When listChannels Then 同时补齐未启用的 DeepSeek 预设渠道', () => {
    const channels = channelManager.listChannels()

    const deepseek = channels.find((c) => c.provider === 'deepseek')
    expect(deepseek).toBeDefined()
    expect(deepseek?.enabled).toBe(false)
  })

  test('Given 已有欧尼博渠道 When listChannels Then 不重复创建', () => {
    channelManager.listChannels()
    channelManager.listChannels()

    const stored = readChannelsFile()
    const ouniboChannels = stored.channels.filter((c) =>
      typeof c.baseUrl === 'string' && c.baseUrl.includes('llm.ounirobot.com'),
    )
    expect(ouniboChannels).toHaveLength(1)
  })

  test('Given 用户删除了欧尼博渠道 When listChannels Then 与 DeepSeek 预设一致地重新补齐', () => {
    const first = channelManager.listChannels()
    const ouniboId = first.find((c) => c.baseUrl.includes('llm.ounirobot.com'))?.id
    expect(ouniboId).toBeDefined()
    if (!ouniboId) return

    channelManager.deleteChannel(ouniboId)
    const afterDelete = channelManager.listChannels()
    expect(afterDelete.some((c) => c.baseUrl.includes('llm.ounirobot.com'))).toBe(true)
  })
})
