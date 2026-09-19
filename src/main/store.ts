import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { Category, Expense, ExpenseFilter } from '../shared/types'

/** 内置默认分类（一级大类 -> 二级小类） */
const DEFAULT_CATEGORY_DEFS: { name: string; children: string[] }[] = [
  { name: '餐饮食品', children: ['早餐', '午餐', '晚餐', '外卖', '零食饮料', '聚餐宴请', '食材生鲜'] },
  { name: '交通出行', children: ['公交地铁', '打车网约车', '加油充电', '停车费', '汽车保养维修', '火车高铁', '飞机票', '共享单车'] },
  { name: '购物消费', children: ['服饰鞋包', '日用品', '数码家电', '美妆护肤', '家居家具', '母婴用品'] },
  { name: '居住生活', children: ['房租', '水电燃气', '物业费', '宽带网络', '家居维修'] },
  { name: '娱乐休闲', children: ['电影演出', '游戏充值', '旅游度假', '运动健身', '宠物', '酒吧KTV'] },
  { name: '医疗健康', children: ['门诊看病', '药品', '体检', '牙科眼科', '保健养生'] },
  { name: '人情往来', children: ['红包礼金', '请客送礼', '捐款'] },
  { name: '教育培训', children: ['学费', '书籍', '网课', '考试报名', '文具'] },
  { name: '其他', children: ['其他杂项'] }
]

/** 预置分类 id 集合（用于识别/迁移：预置分类锁定，不可改名或删除） */
const PRESET_IDS = new Set<string>()
DEFAULT_CATEGORY_DEFS.forEach((def, i) => {
  PRESET_IDS.add(`c${i + 1}`)
  def.children.forEach((_, j) => PRESET_IDS.add(`c${i + 1}-${j + 1}`))
})

export function buildDefaultCategories(): Category[] {
  return DEFAULT_CATEGORY_DEFS.map((def, i) => ({
    id: `c${i + 1}`,
    name: def.name,
    isPreset: true,
    children: def.children.map((name, j) => ({ id: `c${i + 1}-${j + 1}`, name, isPreset: true }))
  }))
}

/** 依据 id 校正 isPreset 标记（兼容旧数据迁移，并防止预置分类被误标为用户分类） */
function markPreset(categories: Category[]): Category[] {
  return categories.map((c) => ({
    ...c,
    isPreset: PRESET_IDS.has(c.id),
    children: (c.children ?? []).map((s) => ({ ...s, isPreset: PRESET_IDS.has(s.id) }))
  }))
}

interface Db {
  categories: Category[]
  expenses: Expense[]
}

let db: Db = { categories: [], expenses: [] }

/** 数据目录名。写死在这里，不让它跟着 app.getName() 走。 */
const DATA_DIR_NAME = '将军记账'

/** 早期开发模式沿用的目录名（当时 userData 跟随 package.json 的 name） */
const LEGACY_DIR_NAME = 'jiangjun-bookkeeping'

/**
 * 钉死数据目录，必须在 app ready 之前调用。
 *
 * 不钉死的话，userData 会跟着 app.getName() 走：打包后是 productName「将军记账」，
 * 开发模式是 package.json 的 name「jiangjun-bookkeeping」。两种运行方式各存一份
 * data.json，换个方式打开 App 就会看到空账本，像是账目丢了。
 */
export function pinDataLocation(): void {
  app.setPath('userData', join(app.getPath('appData'), DATA_DIR_NAME))
}

/**
 * 把早期留在旧目录里的账目搬到新目录，在 load() 之前调用。
 *
 * 只在「新目录还没有数据」且「旧目录有数据」时复制一份；只复制不删除，
 * 旧文件始终留作兜底 —— 迁移逻辑万一出错，账目也还能手工捞回来。
 */
export async function migrateLegacyData(): Promise<void> {
  const legacyPath = join(app.getPath('appData'), LEGACY_DIR_NAME, 'data.json')

  if (await exists(dataPath())) return
  if (!(await exists(legacyPath))) return

  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.copyFile(legacyPath, dataPath())
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

function dataPath(): string {
  return join(app.getPath('userData'), 'data.json')
}

export async function load(): Promise<void> {
  try {
    const raw = await fs.readFile(dataPath(), 'utf-8')
    const parsed = JSON.parse(raw)
    db = {
      categories: Array.isArray(parsed.categories) ? parsed.categories : [],
      expenses: Array.isArray(parsed.expenses) ? parsed.expenses : []
    }
  } catch {
    db = { categories: buildDefaultCategories(), expenses: [] }
    await persist()
  }
  if (!db.categories || db.categories.length === 0) {
    db.categories = buildDefaultCategories()
  }
  if (!Array.isArray(db.expenses)) db.expenses = []
  db.categories = markPreset(db.categories)
}

async function persist(): Promise<void> {
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(dataPath(), JSON.stringify(db, null, 2), 'utf-8')
}

export function getCategories(): Category[] {
  return db.categories
}

export async function setCategories(categories: Category[]): Promise<Category[]> {
  db.categories = markPreset(categories)
  await persist()
  return db.categories
}

/** 统计某分类（含其所有二级小类）被多少条账目引用，用于删除前校验 */
export function countCategoryUsage(categoryId: string): number {
  const ids = new Set<string>([categoryId])
  const top = db.categories.find((c) => c.id === categoryId)
  top?.children?.forEach((s) => ids.add(s.id))
  return db.expenses.filter((e) => ids.has(e.categoryId)).length
}

export function listExpenses(filter?: ExpenseFilter): Expense[] {
  let list = [...db.expenses]
  if (filter?.start) list = list.filter((e) => e.date >= filter.start!)
  if (filter?.end) list = list.filter((e) => e.date <= filter.end!)
  if (filter?.categoryId) list = list.filter((e) => e.categoryId === filter.categoryId)
  if (filter?.keyword) {
    const kw = filter.keyword.trim().toLowerCase()
    if (kw) list = list.filter((e) => (e.note ?? '').toLowerCase().includes(kw))
  }
  return list.sort((a, b) =>
    a.date === b.date ? b.createdAt - a.createdAt : a.date < b.date ? 1 : -1
  )
}

export async function addExpense(input: Omit<Expense, 'id' | 'createdAt'>): Promise<Expense> {
  const expense: Expense = { ...input, id: randomUUID(), createdAt: Date.now() }
  db.expenses.push(expense)
  await persist()
  return expense
}

export async function updateExpense(expense: Expense): Promise<Expense> {
  const idx = db.expenses.findIndex((e) => e.id === expense.id)
  if (idx === -1) throw new Error('记录不存在')
  db.expenses[idx] = expense
  await persist()
  return expense
}

export async function deleteExpense(id: string): Promise<void> {
  db.expenses = db.expenses.filter((e) => e.id !== id)
  await persist()
}
