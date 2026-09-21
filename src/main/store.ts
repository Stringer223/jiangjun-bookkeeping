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

/** 判断错误是不是「文件确实不存在」—— 只有这一种才允许当成首次启动 */
function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT'
}

/**
 * 账目记录的运行时校验。
 *
 * data.json 可能被手工改过、可能来自旧版本、也可能是拷贝迁移来的半成品；
 * 一条坏记录足以让整张账单显示成 ¥ NaN 并把排序打乱，所以宁可在入口丢掉它。
 *
 * 校验口径与 IPC 层的 `assertExpenseInput` 对齐：那一层挡的是渲染进程传来的参数，
 * 这一层挡的是**手工改过的文件**，两条入口都要守，松紧不能不一致。
 */
function isExpense(v: unknown): v is Expense {
  const e = v as Record<string, unknown> | null
  if (!e || typeof e !== 'object') return false
  return (
    typeof e.id === 'string' &&
    e.id.length > 0 &&
    // 金额必须是正整数：Number.isInteger 一并排掉 NaN / Infinity / 浮点。
    // 旧的 Number.isFinite 放行了 0、负数和 1.5，而这三者 App 自己永远造不出来，
    // 只可能是手工改过或迁移来的脏数据 —— 显示出来就是 ¥ 0.00 / ¥ -12.00
    typeof e.amountCents === 'number' &&
    Number.isInteger(e.amountCents) &&
    e.amountCents > 0 &&
    typeof e.categoryId === 'string' &&
    // 非空校验不能省：空串能让账目落进「引用了一个不存在的分类」的状态，
    // 界面上显示成「未分类」，用户以为分类丢了却查不出原因
    e.categoryId.length > 0 &&
    typeof e.date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(e.date) &&
    typeof e.createdAt === 'number' &&
    Number.isFinite(e.createdAt) &&
    (e.note === undefined || typeof e.note === 'string')
  )
}

/**
 * 把数据文件载入到内存。启动时调用一次。
 *
 * 关键纪律：**任何「读不出来」的情况都不许回写**。
 * 旧实现把所有异常都当成「首次启动」，于是杀毒软件临时占用（EACCES）、磁盘满、
 * 半截 JSON 全部走到「回落默认分类 + 立即落盘」—— 用一份空账本覆盖掉用户
 * 唯一的那个数据文件，而且没有备份，不可恢复。
 *
 * 现在按错误类型分流：
 * - `ENOENT`（文件真的不存在）→ 首次启动，生成默认分类并落盘
 * - JSON 解析失败（内容损坏）→ 先把坏文件改名留证，再回落默认分类
 * - 其他（EACCES / EIO / 磁盘满）→ 原样抛出，由 index.ts 弹错并退出
 */
export async function load(): Promise<void> {
  let raw: string
  try {
    raw = await fs.readFile(dataPath(), 'utf-8')
  } catch (err) {
    if (!isNotFound(err)) throw err
    // 真·首次启动
    db = { categories: buildDefaultCategories(), expenses: [] }
    await persist()
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 内容损坏（也含上次写盘只写了一半的情况）：先把坏文件改名留证再回落。
    // 直接覆盖写等于把用户唯一的一份账目抹掉，之后连手工捞回来的机会都没有
    await fs.rename(dataPath(), `${dataPath()}.corrupt-${Date.now()}`)
    db = { categories: buildDefaultCategories(), expenses: [] }
    await persist()
    return
  }

  const p = (parsed ?? {}) as { categories?: unknown; expenses?: unknown }
  const rawExpenses = Array.isArray(p.expenses) ? (p.expenses as unknown[]) : []
  const good = rawExpenses.filter(isExpense)

  db = {
    categories: Array.isArray(p.categories) ? (p.categories as Category[]) : [],
    expenses: good
  }
  if (db.categories.length === 0) db.categories = buildDefaultCategories()
  db.categories = markPreset(db.categories)

  // 丢掉脏记录时留一份证据，否则用户不知道少了东西，也没法手工把数据捞回来。
  //
  // 文件名刻意**不带时间戳**。本函数不写回 data.json（读盘路径不该顺手改用户的数据），
  // 所以那几条脏记录会一直留在文件里、每次启动都被重新过滤一遍；
  // 若用带时间戳的名字，就会每次开机复制一份内容完全相同的证据，无限累积。
  const rejected = rawExpenses.filter((e) => !isExpense(e))
  if (rejected.length > 0) {
    await fs.writeFile(
      `${dataPath()}.rejected.json`,
      JSON.stringify(rejected, null, 2),
      'utf-8'
    )
  }
}

/**
 * 把内存里的 db 落盘。
 *
 * 先写同目录的临时文件再 rename：同分区 rename 是原子的（Windows 上 libuv 走
 * MoveFileExW + MOVEFILE_REPLACE_EXISTING），这样 data.json 永远只可能是
 * 「旧的完整内容」或「新的完整内容」，不会出现写了一半的 JSON。
 *
 * 旧实现直接 writeFile 到目标文件，中途崩溃 / 掉电 / 写满就留下半截 JSON，
 * 而下次启动会把它当废文件处理 —— 两级串起来就是一次真实的丢账目。
 *
 * 注意本函数抛错时**不会**自动回滚内存，回滚由各个写操作自己负责。
 */
async function persist(): Promise<void> {
  const target = dataPath()
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(`${target}.tmp`, JSON.stringify(db, null, 2), 'utf-8')
  await fs.rename(`${target}.tmp`, target)
}

export function getCategories(): Category[] {
  return db.categories
}

export async function setCategories(categories: Category[]): Promise<Category[]> {
  const before = db.categories
  db.categories = markPreset(categories)
  try {
    await persist()
  } catch (err) {
    // 落盘失败必须把内存也退回去：setCategories 是整树覆盖保存，
    // 留在内存里的「假状态」会在下一次保存时被固化下来
    db.categories = before
    throw err
  }
  return db.categories
}

/** 统计某分类（含其所有二级小类）被多少条账目引用，用于删除前校验 */
export function countCategoryUsage(categoryId: string): number {
  const ids = new Set<string>([categoryId])
  const top = db.categories.find((c) => c.id === categoryId)
  top?.children?.forEach((s) => ids.add(s.id))
  return db.expenses.filter((e) => ids.has(e.categoryId)).length
}

/**
 * 按条件筛选账单，返回「日期倒序、同日按录入时间倒序」的新数组。
 *
 * 多个筛选条件是叠加关系（AND）。几个契约细节，调用方容易猜错：
 * - start / end 是闭区间，且按字符串字典序比较，因此 date 必须始终是 'YYYY-MM-DD'
 * - categoryId 是精确匹配，传一级大类 id 不会自动带上它的二级小类
 *   （注意这与 countCategoryUsage 的行为不同，那边是含子类的）
 * - keyword 只搜 note，不搜分类名；忽略大小写与首尾空格，纯空白视为未填
 * - 返回的是新数组，调用方改动它不会影响内部数据
 */
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
  try {
    await persist()
  } catch (err) {
    // 落盘失败必须把内存也退回去：否则界面显示「已记一笔」，重启后这条记录不存在，
    // 用户以为自己记过账，实际什么都没留下
    db.expenses.pop()
    throw err
  }
  return expense
}

export async function updateExpense(expense: Expense): Promise<Expense> {
  const idx = db.expenses.findIndex((e) => e.id === expense.id)
  if (idx === -1) throw new Error('记录不存在')
  const before = db.expenses[idx]
  // createdAt 一律沿用库里那条，不采信传入值。原因是这里**整条替换**而不是逐字段合并：
  // IPC 层的 assertExpenseInput 不校验 createdAt，而读盘的 isExpense 要求它是有限数字。
  // 照单全收的话，传一个缺失/非数字的 createdAt 进来会写盘「成功」，
  // 但下次启动就被 isExpense 丢进 rejected 文件 —— 账目凭空消失。
  // 何况编辑本来就不该能改「创建时间」。
  const updated: Expense = { ...expense, createdAt: before.createdAt }
  db.expenses[idx] = updated
  try {
    await persist()
  } catch (err) {
    db.expenses[idx] = before
    throw err
  }
  return updated
}

export async function deleteExpense(id: string): Promise<void> {
  const before = db.expenses
  db.expenses = db.expenses.filter((e) => e.id !== id)
  try {
    await persist()
  } catch (err) {
    db.expenses = before
    throw err
  }
}
