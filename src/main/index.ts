import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import {
  pinDataLocation,
  migrateLegacyData,
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

// 必须在 app ready 之前执行，否则 Electron 已经按默认目录初始化过了
pinDataLocation()

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
      // 关沙箱是为了让 preload 能用 Node 能力（下方 contextIsolation 仍开着，
      // 渲染进程本身拿不到 Node）。若将来 preload 不再需要 Node 能力，应改回 true
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // 只放行 http(s)。这个回调由页面里的 window.open / target=_blank 触发，
    // 等于渲染进程可以借它打开任意协议 —— file:// 能读本地文件，
    // 自定义协议可能唤起本机其它程序。所以必须做白名单，不能照单全收。
    // 注意：这不改变「一律 deny 窗口」的结论，只是决定要不要交给系统打开
    if (/^https?:\/\//i.test(details.url)) {
      // openExternal 由系统处理，失败时系统自己会提示（如「没有关联的应用」），
      // 这里不弹窗重复打扰；但要接住 rejection，免得变成 unhandled rejection
      shell.openExternal(details.url).catch(() => {})
    }
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** 金额上限：一亿元（单位：分）。超过这个数基本可以断定是渲染进程传错了数据 */
const MAX_AMOUNT_CENTS = 100_000_000_00
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 校验「一笔账目」的入参。
 *
 * 渲染进程是不可信输入源：IPC 就是信任边界，越过它之后必须按外部输入对待。
 * TS 的类型注解在运行时会被抹掉，挡不住任何东西 —— 而一段坏数据一旦落盘
 * 就是持久化的（amountCents 为 NaN 会让整张账单显示 ¥ NaN，date 非 'YYYY-MM-DD'
 * 会让 listExpenses 的字典序筛选静默失效）。
 */
function assertExpenseInput(v: unknown): asserts v is Omit<Expense, 'id' | 'createdAt'> {
  const o = v as Record<string, unknown> | null
  if (!o || typeof o !== 'object') throw new Error('参数不合法：需要一个账目对象')
  if (
    typeof o.amountCents !== 'number' ||
    !Number.isInteger(o.amountCents) ||
    o.amountCents <= 0 ||
    o.amountCents > MAX_AMOUNT_CENTS
  ) {
    throw new Error('参数不合法：amountCents 必须是 0～1 亿元之间的整数（单位：分）')
  }
  if (typeof o.categoryId !== 'string' || !o.categoryId) {
    throw new Error('参数不合法：categoryId 不能为空')
  }
  if (typeof o.date !== 'string' || !DATE_RE.test(o.date)) {
    throw new Error("参数不合法：date 必须是 'YYYY-MM-DD'")
  }
  if (o.note !== undefined && typeof o.note !== 'string') {
    throw new Error('参数不合法：note 必须是字符串')
  }
}

/** 注册全部 IPC handler。抽成具名函数，让启动错误处理与接口注册能分开读。 */
function registerIpcHandlers(): void {
  ipcMain.handle('categories:get', () => getCategories())

  ipcMain.handle('categories:set', (_e, categories: unknown) => {
    if (!Array.isArray(categories)) throw new Error('参数不合法：categories 必须是数组')
    for (const c of categories) {
      const o = c as Partial<Category> | null
      if (!o || typeof o.id !== 'string' || !o.id || typeof o.name !== 'string' || !o.name.trim()) {
        throw new Error('参数不合法：每个分类都要有非空的 id 与 name')
      }
    }
    return setCategories(categories as Category[])
  })

  ipcMain.handle('categories:usage', (_e, categoryId: unknown) => {
    if (typeof categoryId !== 'string' || !categoryId) {
      throw new Error('参数不合法：categoryId 不能为空')
    }
    return countCategoryUsage(categoryId)
  })

  ipcMain.handle('expenses:list', (_e, filter: unknown) => {
    // 筛选条件允许整体省略；给了就必须是对象（多余字段忽略即可）
    if (filter !== undefined && (typeof filter !== 'object' || filter === null)) {
      throw new Error('参数不合法：filter 必须是对象或省略')
    }
    return listExpenses(filter as ExpenseFilter | undefined)
  })

  ipcMain.handle('expenses:add', (_e, input: unknown) => {
    assertExpenseInput(input)
    return addExpense(input)
  })

  ipcMain.handle('expenses:update', (_e, expense: unknown) => {
    assertExpenseInput(expense)
    if (typeof (expense as Expense).id !== 'string' || !(expense as Expense).id) {
      throw new Error('参数不合法：id 不能为空')
    }
    return updateExpense(expense as Expense)
  })

  ipcMain.handle('expenses:delete', (_e, id: unknown) => {
    if (typeof id !== 'string' || !id) throw new Error('参数不合法：id 不能为空')
    return deleteExpense(id)
  })

  ipcMain.handle('export:csv', async (_e, csv: unknown, defaultName: unknown) => {
    if (typeof csv !== 'string') throw new Error('参数不合法：csv 必须是字符串')
    // defaultName 会进 showSaveDialog 的 defaultPath，只允许纯文件名：
    // 带上路径分隔符或 .. 就等于让渲染进程指定任意落盘位置
    const safeName =
      typeof defaultName === 'string' && defaultName.length <= 100 && !/[/\\]|\.\./.test(defaultName)
        ? defaultName
        : `账单_${new Date().toISOString().slice(0, 7)}.csv`

    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出账单',
      defaultPath: safeName,
      filters: [{ name: 'CSV 文件', extensions: ['csv'] }]
    })
    if (canceled || !filePath) return false
    // 写入 UTF-8 BOM，保证 Excel 打开中文不乱码。
    // 用 '\ufeff' 转义写法而不是裸字符：BOM 在编辑器里是不可见的，
    // 很容易被格式化工具或误删吃掉，而那时 Excel 打开就变乱码了
    await fs.writeFile(filePath, '\ufeff' + csv, 'utf-8')
    return true
  })
}

app.whenReady().then(async () => {
  try {
    await migrateLegacyData()
    await load()
  } catch (err) {
    // 不兜住的话 whenReady 的 promise 直接 reject，createWindow() 永远不会执行，
    // 用户看到的只是「双击图标没反应」—— 既没有窗口也没有任何提示，完全无从排查。
    // 这里刻意不吞错、不回落空账本：读不出来时宁可不启动，也不覆盖用户的数据文件
    dialog.showErrorBox(
      '账本读取失败，已停止启动',
      '启动时无法读取账本数据。你的数据文件没有被改动，请不要反复重启。\n\n' +
        `原因：${err instanceof Error ? err.message : String(err)}\n` +
        `数据文件：${join(app.getPath('userData'), 'data.json')}`
    )
    app.quit()
    return
  }

  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
