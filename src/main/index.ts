import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import {
  load,
  getCategories,
  setCategories,
  countCategoryUsage,
  listExpenses,
  addExpense,
  updateExpense,
  deleteExpense
} from './store'
import type { Category, Expense, ExpenseFilter } from '../shared/types'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 920,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: '将军记账',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  await load()

  ipcMain.handle('categories:get', () => getCategories())
  ipcMain.handle('categories:set', (_e, categories: Category[]) => setCategories(categories))
  ipcMain.handle('categories:usage', (_e, categoryId: string) => countCategoryUsage(categoryId))
  ipcMain.handle('expenses:list', (_e, filter?: ExpenseFilter) => listExpenses(filter))
  ipcMain.handle('expenses:add', (_e, input: Omit<Expense, 'id' | 'createdAt'>) => addExpense(input))
  ipcMain.handle('expenses:update', (_e, expense: Expense) => updateExpense(expense))
  ipcMain.handle('expenses:delete', (_e, id: string) => deleteExpense(id))
  ipcMain.handle('export:csv', async (_e, csv: string, defaultName: string) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出账单',
      defaultPath: defaultName,
      filters: [{ name: 'CSV 文件', extensions: ['csv'] }]
    })
    if (canceled || !filePath) return false
    // 写入 UTF-8 BOM，保证 Excel 打开中文不乱码
    await fs.writeFile(filePath, '﻿' + csv, 'utf-8')
    return true
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
