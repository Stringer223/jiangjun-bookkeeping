import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Expense } from '../shared/types'

/**
 * 用 vi.hoisted 是为了绕开 vi.mock 的提升：mock 工厂会在文件顶部被提前执行，
 * 那时普通变量还没初始化，只有 hoisted 出来的对象才拿得到。
 */
const env = vi.hoisted(() => ({ root: '', setPathCalls: [] as Array<[string, string]> }))

// 只替换 electron 模块（store.ts 只用它算路径），文件读写走真实 fs，
// 所以测的是真实的序列化、筛选、排序逻辑，而不是一堆假替身。
// setPath 顺手把调用参数记下来，用来验证 pinDataLocation 到底钉到了哪。
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'appData' ? env.root : env.root + '/将军记账'),
    setPath: (name: string, path: string) => {
      env.setPathCalls.push([name, path])
    }
  }
}))

let store: typeof import('./store')

/** 临时数据目录（每个用例一套，互不干扰） */
const dataDir = (): string => join(env.root, '将军记账')
const dataFile = (): string => join(dataDir(), 'data.json')

/** 绕过 store 直接往数据文件里塞内容，用来构造可控的初始数据 */
async function seedFile(content: string): Promise<void> {
  await mkdir(dataDir(), { recursive: true })
  await writeFile(dataFile(), content, 'utf-8')
}

async function seedExpenses(rows: Array<Partial<Expense> & { date: string }>): Promise<void> {
  const expenses: Expense[] = rows.map((r, i) => ({
    id: r.id ?? `e${i + 1}`,
    amountCents: r.amountCents ?? 100,
    categoryId: r.categoryId ?? 'c1-1',
    date: r.date,
    note: r.note,
    createdAt: r.createdAt ?? 1000 + i
  }))
  await seedFile(JSON.stringify({ categories: store.buildDefaultCategories(), expenses }))
  await store.load()
}

beforeEach(async () => {
  env.root = await mkdtemp(join(tmpdir(), 'jizhang-test-'))
  store = await import('./store')
  // load() 读不到文件时会回落到默认分类，等于给每个用例一个干净起点
  await store.load()
})

afterEach(async () => {
  await rm(env.root, { recursive: true, force: true })
})

describe('首次加载', () => {
  it('没有数据文件时生成默认分类，并把文件落盘', async () => {
    const cats = store.getCategories()
    expect(cats.length).toBe(9)
    expect(cats[0].name).toBe('餐饮食品')
    expect(store.listExpenses()).toEqual([])

    // 文件必须真的写出来了，否则下次启动又会重来一遍
    const raw = JSON.parse(await readFile(dataFile(), 'utf-8'))
    expect(raw.categories.length).toBe(9)
  })

  it('数据文件损坏时回退到默认分类，而不是崩溃', async () => {
    await seedFile('{ 这不是合法的 JSON')
    await store.load()
    expect(store.getCategories().length).toBe(9)
    expect(store.listExpenses()).toEqual([])
  })
})

describe('分类管理', () => {
  it('保存后重新加载仍在（持久化往返）', async () => {
    const cats = store.getCategories()
    cats[0].name = '吃吃喝喝'
    await store.setCategories(cats)

    await store.load()
    expect(store.getCategories()[0].name).toBe('吃吃喝喝')
  })

  it('用户自建分类不会被误标成预置分类', async () => {
    // 就算外面谎报 isPreset: true，也要按 id 纠正回来
    await store.setCategories([
      { id: 'c1', name: '餐饮食品', isPreset: false },
      { id: 'user-1', name: '我的分类', isPreset: true }
    ])
    const cats = store.getCategories()
    expect(cats.find((c) => c.id === 'c1')?.isPreset).toBe(true)
    expect(cats.find((c) => c.id === 'user-1')?.isPreset).toBe(false)
  })

  it('统计一级分类用量时，把它所有二级小类也算进去', async () => {
    await seedExpenses([
      { date: '2026-09-01', categoryId: 'c1-1' },
      { date: '2026-09-02', categoryId: 'c1-2' },
      { date: '2026-09-03', categoryId: 'c2-1' }
    ])
    expect(store.countCategoryUsage('c1')).toBe(2)
    expect(store.countCategoryUsage('c1-1')).toBe(1)
    expect(store.countCategoryUsage('c9')).toBe(0)
  })

  it('分类已被删掉、历史账目仍引用旧 id 时，用量照样能数出来', async () => {
    // 删除分类后历史账目还留着旧 id，这条路径会真实走到；
    // countCategoryUsage 里 find 的结果做了可选链，找不到分类时不能抛
    await seedExpenses([
      { date: '2026-09-01', categoryId: 'c2-1' },
      { date: '2026-09-02', categoryId: 'c2-2' }
    ])
    await store.setCategories([{ id: 'c1', name: '餐饮食品', isPreset: true, children: [] }])
    expect(store.countCategoryUsage('c2-1')).toBe(1)
  })
})

describe('记账增删改', () => {
  it('新增会生成 id 与 createdAt 并落盘', async () => {
    const e = await store.addExpense({ amountCents: 3550, categoryId: 'c1-1', date: '2026-09-15' })
    expect(e.id).toBeTruthy()
    expect(e.createdAt).toBeGreaterThan(0)
    expect(store.listExpenses()).toHaveLength(1)

    const raw = JSON.parse(await readFile(dataFile(), 'utf-8'))
    expect(raw.expenses[0].amountCents).toBe(3550)
  })

  it('修改不存在的记录会抛错', async () => {
    await expect(
      store.updateExpense({ id: '不存在', amountCents: 1, categoryId: 'c1-1', date: '2026-09-15', createdAt: 1 })
    ).rejects.toThrow('记录不存在')
  })

  it('修改已存在的记录会覆盖原值', async () => {
    const e = await store.addExpense({ amountCents: 100, categoryId: 'c1-1', date: '2026-09-15' })
    await store.updateExpense({ ...e, amountCents: 999 })
    expect(store.listExpenses()[0].amountCents).toBe(999)
  })

  it('删除后列表里就没有了', async () => {
    const e = await store.addExpense({ amountCents: 100, categoryId: 'c1-1', date: '2026-09-15' })
    await store.deleteExpense(e.id)
    expect(store.listExpenses()).toEqual([])
  })

  it('删除不存在的 id 是静默 no-op，不会抛错也不会误伤别的记录', async () => {
    // 界面上点删除时，记录可能已经被别处删掉了；这里必须安静地什么都不做，
    // 而不是抛错（会让整个操作卡住）或顺手删掉相邻记录
    const e = await store.addExpense({ amountCents: 100, categoryId: 'c1-1', date: '2026-09-15' })
    await expect(store.deleteExpense('这个-id-根本不存在')).resolves.toBeUndefined()
    expect(store.listExpenses().map((x) => x.id)).toEqual([e.id])
  })
})

describe('账单列表筛选与排序', () => {
  beforeEach(async () => {
    await seedExpenses([
      { date: '2026-08-01', categoryId: 'c1-1', note: '早餐 豆浆油条', createdAt: 10 },
      { date: '2026-09-01', categoryId: 'c1-2', note: '午餐', createdAt: 20 },
      { date: '2026-09-15', categoryId: 'c2-1', note: '打车', createdAt: 30 },
      { date: '2026-09-15', categoryId: 'c1-1', note: '夜宵', createdAt: 40 }
    ])
  })

  it('按日期区间筛选（含两端）', () => {
    const r = store.listExpenses({ start: '2026-09-01', end: '2026-09-15' })
    expect(r).toHaveLength(3)
    expect(r.every((e) => e.date >= '2026-09-01' && e.date <= '2026-09-15')).toBe(true)
  })

  it('只给 start 时，之后的全部返回', () => {
    expect(store.listExpenses({ start: '2026-09-15' })).toHaveLength(2)
  })

  it('只给 end 时，之前（含当天）的全部返回', () => {
    // 单边区间和只给 start 是对称的两个分支，分别用 >= 和 <=，写反了筛选就静默失效
    const r = store.listExpenses({ end: '2026-09-01' })
    expect(r).toHaveLength(2)
    expect(r.every((e) => e.date <= '2026-09-01')).toBe(true)
  })

  it('按分类筛选只匹配该二级小类', () => {
    expect(store.listExpenses({ categoryId: 'c1-1' })).toHaveLength(2)
  })

  it('按关键词搜备注，忽略大小写和首尾空格', () => {
    expect(store.listExpenses({ keyword: '  豆浆  ' })).toHaveLength(1)
    expect(store.listExpenses({ keyword: '午餐' })).toHaveLength(1)
    expect(store.listExpenses({ keyword: '不存在的词' })).toHaveLength(0)
  })

  it('关键词为空串时不当作筛选条件', () => {
    expect(store.listExpenses({ keyword: '   ' })).toHaveLength(4)
  })

  it('默认按日期倒序；同一天则按录入时间倒序', () => {
    const r = store.listExpenses()
    expect(r.map((e) => e.date)).toEqual(['2026-09-15', '2026-09-15', '2026-09-01', '2026-08-01'])
    // 同为 09-15 的两条，createdAt 大的（40 夜宵）要排在前面
    expect(r[0].note).toBe('夜宵')
    expect(r[1].note).toBe('打车')
  })

  it('筛选条件可以叠加', () => {
    const r = store.listExpenses({ start: '2026-09-01', categoryId: 'c1-1' })
    expect(r).toHaveLength(1)
    expect(r[0].note).toBe('夜宵')
  })

  it('备注为空的记录不会让关键词筛选崩掉', async () => {
    await seedExpenses([{ date: '2026-09-20', categoryId: 'c1-1' }])
    expect(store.listExpenses({ keyword: '任意' })).toEqual([])
  })
})

describe('load 读取旧数据时的容错', () => {
  it('categories 是空数组时，回落成 9 个默认分类', async () => {
    // 不能直接把空数组用起来：那样界面上一个分类都没有，等于没法记账
    await seedFile(JSON.stringify({ categories: [], expenses: [] }))
    await store.load()
    const cats = store.getCategories()
    expect(cats).toHaveLength(9)
    expect(cats[0].name).toBe('餐饮食品')
  })

  it('categories 不是数组时，回落成默认分类', async () => {
    await seedFile(JSON.stringify({ categories: '不是数组', expenses: [] }))
    await store.load()
    expect(store.getCategories()).toHaveLength(9)
  })

  it('expenses 是字符串时按空数组处理，不崩', async () => {
    await seedFile(JSON.stringify({ categories: store.buildDefaultCategories(), expenses: '不是数组' }))
    await store.load()
    expect(store.listExpenses()).toEqual([])
  })

  it('expenses 是 null 时按空数组处理，不崩', async () => {
    await seedFile(JSON.stringify({ categories: store.buildDefaultCategories(), expenses: null }))
    await store.load()
    expect(store.listExpenses()).toEqual([])
  })

  it('expenses 是对象时按空数组处理，不崩', async () => {
    // Array.isArray 对 {} 也是 false；若改成 typeof 判断就会漏掉这种脏数据，
    // 之后 listExpenses 的 [...db.expenses] 会直接抛 "not iterable"
    await seedFile(JSON.stringify({ categories: store.buildDefaultCategories(), expenses: { a: 1 } }))
    await store.load()
    expect(store.listExpenses()).toEqual([])
  })

  it('文件是合法 JSON 但不是对象（null）时，回落默认分类且不崩', async () => {
    // JSON.parse('null') 不抛错，但紧接着取 .categories 会 TypeError，
    // 得靠 catch 兜住 —— 和「非法 JSON」是两条不同的路径
    await seedFile('null')
    await store.load()
    expect(store.getCategories()).toHaveLength(9)
    expect(store.listExpenses()).toEqual([])
  })

  it('分类缺 children 字段时不崩，children 兜底成空数组', async () => {
    // 早期版本的数据可能压根没写过 children；markPreset 用 ?? [] 兜住了，
    // 这里确认兜住，并且下游 countCategoryUsage 的可选链也不会抛
    await seedFile(
      JSON.stringify({
        categories: [{ id: 'c1', name: '餐饮食品', isPreset: true }],
        expenses: [{ id: 'e1', amountCents: 100, categoryId: 'c1', date: '2026-09-15', createdAt: 1 }]
      })
    )
    await store.load()
    expect(store.getCategories()[0].children).toEqual([])
    expect(store.countCategoryUsage('c1')).toBe(1)
  })

  it('文件里存的 isPreset 被篡改时，按 id 校正回来', async () => {
    // isPreset 决定分类是否锁定（不可改名/删除）。文件被手改或旧版本写错时，
    // 若不起纠正，预置分类会被当成自建分类而允许删除，自建分类反被锁死
    await seedFile(
      JSON.stringify({
        categories: [
          { id: 'c1', name: '餐饮食品', isPreset: false, children: [{ id: 'c1-1', name: '早餐', isPreset: false }] },
          { id: 'user-1', name: '我的分类', isPreset: true, children: [] }
        ],
        expenses: []
      })
    )
    await store.load()
    const cats = store.getCategories()
    const c1 = cats.find((c) => c.id === 'c1')
    expect(c1?.isPreset).toBe(true)
    // c1-1 是 c1 的二级小类，不在顶层列表里，得往 children 里找
    expect(c1?.children?.find((s) => s.id === 'c1-1')?.isPreset).toBe(true)
    expect(cats.find((c) => c.id === 'user-1')?.isPreset).toBe(false)
  })
})

describe('pinDataLocation 钉死数据目录', () => {
  it('把 userData 指向 appData 下的「将军记账」目录', async () => {
    // 不钉死的话，打包版（productName）和开发版（package.json name）会用两个
    // 不同的 userData 目录各存一份 data.json，换个方式启动就看到空账本
    env.setPathCalls.length = 0
    await store.pinDataLocation()
    expect(env.setPathCalls).toEqual([['userData', join(env.root, '将军记账')]])
  })
})

describe('migrateLegacyData 旧目录迁移', () => {
  const legacyDir = (): string => join(env.root, 'jiangjun-bookkeeping')
  const legacyFile = (): string => join(legacyDir(), 'data.json')

  const LEGACY_PAYLOAD = JSON.stringify({
    categories: [{ id: 'c1', name: '餐饮食品', isPreset: true, children: [{ id: 'c1-1', name: '早餐', isPreset: true }] }],
    expenses: [{ id: 'legacy-1', amountCents: 1234, categoryId: 'c1-1', date: '2025-01-01', createdAt: 1 }]
  })

  async function seedLegacy(content: string): Promise<void> {
    await mkdir(legacyDir(), { recursive: true })
    await writeFile(legacyFile(), content, 'utf-8')
  }

  it('新目录还没有数据、旧目录有数据时，把旧账本复制到新路径', async () => {
    // 用户之前用开发版记过账，换了打包版启动；新目录空着，就得从旧目录搬过来，
    // 否则账目看起来就是"丢了"
    await rm(dataDir(), { recursive: true, force: true })
    await seedLegacy(LEGACY_PAYLOAD)

    await store.migrateLegacyData()

    const raw = JSON.parse(await readFile(dataFile(), 'utf-8'))
    expect(raw.expenses).toHaveLength(1)
    expect(raw.expenses[0].amountCents).toBe(1234)
  })

  it('新目录已经有数据时绝不覆盖，原账本原样保留', async () => {
    // 最要命的一条：新目录里是当前正在用的账本，被旧数据盖掉就是直接丢账目
    const e = await store.addExpense({ amountCents: 9999, categoryId: 'c1-1', date: '2026-09-15' })
    await seedLegacy(LEGACY_PAYLOAD)

    await store.migrateLegacyData()

    const raw = JSON.parse(await readFile(dataFile(), 'utf-8'))
    expect(raw.expenses).toHaveLength(1)
    expect(raw.expenses[0].id).toBe(e.id)
    expect(raw.expenses[0].amountCents).toBe(9999)
  })

  it('只复制不删除，迁移后旧文件仍然留着兜底', async () => {
    // 作者刻意不删旧文件：万一迁移逻辑出错，账目还能手工捞回来
    await rm(dataDir(), { recursive: true, force: true })
    await seedLegacy(LEGACY_PAYLOAD)

    await store.migrateLegacyData()

    expect(await readFile(legacyFile(), 'utf-8')).toBe(LEGACY_PAYLOAD)
  })

  it('旧目录不存在时静默返回，不报错也不凭空造出多余文件', async () => {
    // 全新用户（从没用过开发版）走的就是这条路径，不能因此启动失败。
    // 先抹掉新目录，否则会停在第一个 exists 判断上，测不到「旧目录不存在」这一层
    await rm(dataDir(), { recursive: true, force: true })

    await expect(store.migrateLegacyData()).resolves.toBeUndefined()
    await expect(access(legacyDir())).rejects.toThrow()
    await expect(access(dataFile())).rejects.toThrow()
  })
})
