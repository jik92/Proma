/**
 * 自动更新 IPC 处理器
 *
 * 注册更新相关的 IPC 通道，供渲染进程调用。
 */

import { ipcMain } from 'electron'
import { UPDATER_IPC_CHANNELS } from './updater-types'
import type { UpdateStatus } from './updater-types'
import {
  cancelIdleInstall,
  checkForUpdates,
  getUpdateStatus,
  installWhenIdle,
  isUpdateFeedConfigured,
} from './auto-updater'

/** 注册更新 IPC 处理器（更新源未配置时跳过，渲染进程会隐藏更新 UI） */
export function registerUpdaterIpc(): void {
  if (!isUpdateFeedConfigured()) {
    console.log('[更新 IPC] 未配置更新源，跳过更新 IPC 注册')
    return
  }
  console.log('[更新 IPC] 正在注册更新 IPC 处理器...')

  ipcMain.handle(
    UPDATER_IPC_CHANNELS.CHECK_FOR_UPDATES,
    async (): Promise<void> => {
      await checkForUpdates()
    }
  )

  ipcMain.handle(
    UPDATER_IPC_CHANNELS.GET_STATUS,
    async (): Promise<UpdateStatus> => {
      return getUpdateStatus()
    }
  )

  ipcMain.handle(
    UPDATER_IPC_CHANNELS.INSTALL_WHEN_IDLE,
    (): boolean => {
      return installWhenIdle()
    }
  )

  ipcMain.handle(
    UPDATER_IPC_CHANNELS.CANCEL_IDLE_INSTALL,
    (): void => {
      cancelIdleInstall()
    }
  )

  console.log('[更新 IPC] 更新 IPC 处理器注册完成')
}
