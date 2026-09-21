import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'fs/promises'
// 和 store.ts 用同一个导入写法拿 promises 对象，vi.spyOn 才能改到 store 真正调用的那个方法
import { promises as fs } from 'fs'
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

/** 按前缀找目录里的文件：corrupt / rejected 的后缀是时间戳，没法预先写死全名 */
async function findFilesByPrefix(prefix: string): Promise<string[]> {
  const names = await readdir(dataDir())
  return names.filter((n) => n.startsWith(prefix))
}

/**
 * 往 expenses 里塞一条「原始 JSON 文本」写的记录。
 *
 * 不能借 JSON.stringify：它会把 NaN / Infinity 变成 null，想造出「解析后是非有限数」
 * 的 1e999（JSON.parse('1e999') === Infinity）就只能手写文本。
 */
async function seedRawElement(element: string): Promise<void> {
  await seedFile(
    `{"categories":${JSON.stringify(store.buildDefaultCategories())},"expenses":[${element}]}`
  )
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

  it('修改记录时 createdAt 沿用原值，传入的非法值不会落盘', async () => {
    // 故意传一个非数字的 createdAt：IPC 层的 assertExpenseInput 不校验这个字段，
    // 而读盘的 isExpense 要求它是有限数字、否则整条记录被丢弃。
    // 修改是**整条替换**，所以这里若照单全收，就会落一条「本次保存成功、
    // 下次启动凭空消失」的记录 —— 而项目纪律是「丢启动可以，丢数据不行」。
    const e = await store.addExpense({ amountCents: 100, categoryId: 'c1-1', date: '2026-09-15' })
    const saved = await store.updateExpense({
      ...e,
      amountCents: 999,
      createdAt: 'oops' as unknown as number
    })

    expect(saved.createdAt).toBe(e.createdAt)
    expect(store.listExpenses()[0].createdAt).toBe(e.createdAt)
    // 落盘的也得是原值 —— 只对内存里负责不够，重启读的是文件
    const raw = JSON.parse(await readFile(dataFile(), 'utf-8'))
    expect(raw.expenses[0].createdAt).toBe(e.createdAt)
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

describe('load 首次启动（ENOENT 分支）', () => {
  it('新目录里只写出 data.json，不留 tmp / corrupt / rejected 残渣', async () => {
    // beforeEach 已经在全新目录里跑过一次 load，走的正是 ENOENT 分支。
    // 这里盯的是「补偿逻辑别越界」：rename 留证、写 rejected 文件都只该在
    // 内容损坏 / 有脏记录时发生；一旦被挪进 ENOENT 分支，文件根本不存在，
    // rename 会抛 ENOENT —— 用户第一次启动就直接失败
    expect(await readdir(dataDir())).toEqual(['data.json'])
  })
})

describe('load 内容损坏（JSON 解析失败）', () => {
  it('把坏文件改名留证，且留证内容与原文件一致（不是留个空壳）', async () => {
    // 直接覆盖写等于抹掉用户唯一的一份账目，之后连手工捞回来的机会都没有。
    // 所以光「回落到默认分类」不算过关，必须先留一份真的能读回来的证据
    const broken = '{ 这不是合法的 JSON'
    await seedFile(broken)
    await store.load()

    const backups = await findFilesByPrefix('data.json.corrupt-')
    expect(backups).toHaveLength(1)
    expect(await readFile(join(dataDir(), backups[0]), 'utf-8')).toBe(broken)
  })

  it('留证之后再回落默认分类并落盘，启动仍然可用', async () => {
    await seedFile('{ 这不是合法的 JSON')
    await store.load()
    expect(store.getCategories()).toHaveLength(9)
    // 新文件必须真的写出来，否则下次启动又会再走一遍损坏分支
    expect(JSON.parse(await readFile(dataFile(), 'utf-8')).categories).toHaveLength(9)
  })
})

describe('load 遇到非 ENOENT 的读错误', () => {
  it('一个字节都不写盘（不能把「读不出来」当成「首次启动」）', async () => {
    // 用真实 fs 造错、不 mock：把 data.json 换成同名目录，readFile 会抛 EISDIR。
    // 旧实现把所有异常都当首次启动，于是这条路径会当场用一份空账本覆盖掉用户的
    // 数据文件 —— 而这种覆盖是不可恢复的
    await rm(dataFile(), { force: true })
    await mkdir(dataFile())

    await expect(store.load()).rejects.toThrow()

    // 判别依据是「没写盘」这一组：目标位置还是那个目录，没被写成文件、没被删掉，
    // 也没有留下 tmp / corrupt 残渣。
    // 注意不能只断言 rejects —— 被吞掉错误之后，persist() 自己也会因为
    // rename 到目录上而失败再抛出来，"抛了错"这件事本身区分不出对错
    expect((await stat(dataFile())).isDirectory()).toBe(true)
    expect(await readdir(dataDir())).toEqual(['data.json'])
  })

  it('抛出的是原先那个读错误本身，而不是包装过或换成别的错误', async () => {
    // index.ts 靠这个错误决定弹什么提示、并停止启动；错误被替换掉就会误导排查
    await rm(dataFile(), { force: true })
    await mkdir(dataFile())

    await expect(store.load()).rejects.toMatchObject({ code: 'EISDIR' })
  })
})

describe('load 逐条校验账目记录（isExpense）', () => {
  /** 一条完整合法记录，作为对照组 */
  const GOOD =
    '"id":"e1","amountCents":100,"categoryId":"c1-1","date":"2026-09-15","createdAt":1'
  const rec = (fields: string): string => `{${fields}}`

  it('合法记录被保留（对照组）', async () => {
    await seedRawElement(rec(GOOD))
    expect(store.listExpenses().map((e) => e.id)).toEqual(['e1'])
  })

  it('note 缺字段时保留，它是可选字段而不是必填', async () => {
    // 把 note 也纳入必填会让所有「没写备注」的历史账目被当成脏数据丢掉
    await seedRawElement(rec(GOOD))
    expect(store.listExpenses()[0].note).toBeUndefined()
  })

  const BAD_RECORDS: Array<[string, string]> = [
    ['id 缺字段', rec('"amountCents":100,"categoryId":"c1-1","date":"2026-09-15","createdAt":1')],
    ['id 是空串', rec('"id":"","amountCents":100,"categoryId":"c1-1","date":"2026-09-15","createdAt":1')],
    ['amountCents 缺字段', rec('"id":"e1","categoryId":"c1-1","date":"2026-09-15","createdAt":1')],
    ['amountCents 是字符串', rec('"id":"e1","amountCents":"100","categoryId":"c1-1","date":"2026-09-15","createdAt":1')],
    ['amountCents 是 null（NaN/Infinity 被 stringify 后的样子）', rec('"id":"e1","amountCents":null,"categoryId":"c1-1","date":"2026-09-15","createdAt":1')],
    ['amountCents 溢出成 Infinity', rec('"id":"e1","amountCents":1e999,"categoryId":"c1-1","date":"2026-09-15","createdAt":1')],
    ['categoryId 缺字段', rec('"id":"e1","amountCents":100,"date":"2026-09-15","createdAt":1')],
    ['date 不是 YYYY-MM-DD（"今天"）', rec('"id":"e1","amountCents":100,"categoryId":"c1-1","date":"今天","createdAt":1')],
    ['date 月日没补零', rec('"id":"e1","amountCents":100,"categoryId":"c1-1","date":"2026-9-5","createdAt":1')],
    ['createdAt 是字符串', rec('"id":"e1","amountCents":100,"categoryId":"c1-1","date":"2026-09-15","createdAt":"1"')],
    ['createdAt 溢出成 Infinity', rec('"id":"e1","amountCents":100,"categoryId":"c1-1","date":"2026-09-15","createdAt":1e999')],
    ['note 不是字符串', rec('"id":"e1","amountCents":100,"categoryId":"c1-1","date":"2026-09-15","createdAt":1,"note":123')]
  ]

  // 一条坏记录足以让整张账单显示 ¥ NaN 并把排序打乱，所以逐条钉死
  for (const [label, element] of BAD_RECORDS) {
    it(`丢弃脏记录：${label}`, async () => {
      await seedRawElement(element)
      expect(store.listExpenses()).toEqual([])
    })
  }

  it('丢弃脏记录：元素是 null', async () => {
    await seedRawElement('null')
    expect(store.listExpenses()).toEqual([])
  })

  it('丢弃脏记录：元素是字符串', async () => {
    await seedRawElement('"不是对象"')
    expect(store.listExpenses()).toEqual([])
  })

  it('被丢弃的记录会写进 rejected 文件留证，内容就是被丢掉的那条', async () => {
    // 不留证的话用户只看到账目莫名变少，也没法手工把数据捞回来
    const dirty = '{"id":"e-bad"}'
    await seedRawElement(rec(GOOD) + ',' + dirty)

    expect(store.listExpenses().map((e) => e.id)).toEqual(['e1'])

    const files = await findFilesByPrefix('data.json.rejected')
    expect(files).toHaveLength(1)
    expect(JSON.parse(await readFile(join(dataDir(), files[0]), 'utf-8'))).toEqual(
      JSON.parse(`[${dirty}]`)
    )
  })

  it('记录全都合法时不产生 rejected 文件，免得天天误报「有数据被丢」', async () => {
    await seedExpenses([{ date: '2026-09-15' }, { date: '2026-09-16' }])
    expect(await findFilesByPrefix('data.json.rejected')).toEqual([])
  })

  it('反复启动不会累积 rejected 文件（同一批脏记录只留一份证据）', async () => {
    // load() 刻意不写回 data.json，所以脏记录会一直留在原文件里、每次启动都被重新过滤一遍。
    // 如果留证文件名带时间戳，就会每次开机复制一份内容完全相同的证据出来，无限累积 ——
    // 这条钉住的是「文件名必须稳定」，去掉时间戳之后才成立
    const dirty = '{"id":"e-bad"}'
    await seedRawElement(rec(GOOD) + ',' + dirty)

    await store.load()
    await store.load()
    await store.load()

    const files = await findFilesByPrefix('data.json.rejected')
    expect(files).toHaveLength(1)
    // 内容也要是那份没变的证据，而不是被后一次加载覆盖成别的东西
    expect(JSON.parse(await readFile(join(dataDir(), files[0]), 'utf-8'))).toEqual(
      JSON.parse(`[${dirty}]`)
    )
  })

  it('金额为 0 / 负数 / 浮点的记录会被丢弃（App 自己造不出这三种）', async () => {
    // 收紧 isExpense 口径后才成立：旧的 Number.isFinite 会放行它们，
    // 显示出来就是 ¥ 0.00 / ¥ -12.00 / ¥ 12.34 这类不该出现的账目
    await seedRawElement(
      [
        rec('"id":"zero","amountCents":0,"categoryId":"c1-1","date":"2026-09-15","createdAt":1'),
        rec('"id":"neg","amountCents":-100,"categoryId":"c1-1","date":"2026-09-15","createdAt":1'),
        rec('"id":"float","amountCents":12.34,"categoryId":"c1-1","date":"2026-09-15","createdAt":1')
      ].join(',')
    )
    expect(store.listExpenses()).toEqual([])
  })

  it('categoryId 为空串的记录会被丢弃', async () => {
    // 空串会让账目落进「引用了一个不存在的分类」的状态，界面显示成「未分类」，
    // 用户以为分类丢了却查不出原因
    await seedRawElement(
      rec('"id":"e1","amountCents":100,"categoryId":"","date":"2026-09-15","createdAt":1')
    )
    expect(store.listExpenses()).toEqual([])
  })
})

describe('原子写（persist）', () => {
  it('写盘结束后目录里不残留 data.json.tmp', async () => {
    // tmp 是写盘的中间产物，残留说明 rename 那一步没走到，
    // 目录里会多出一个可能被误当成数据文件的半成品
    await store.addExpense({ amountCents: 100, categoryId: 'c1-1', date: '2026-09-15' })
    expect(await findFilesByPrefix('data.json.tmp')).toEqual([])
    expect(await readdir(dataDir())).toEqual(['data.json'])
  })

  it('写盘后 data.json 是完整可解析的 JSON，内容与内存里那份一致', async () => {
    const e = await store.addExpense({ amountCents: 3550, categoryId: 'c1-1', date: '2026-09-15' })
    expect(JSON.parse(await readFile(dataFile(), 'utf-8')).expenses).toEqual([e])
  })
})

describe('落盘失败时回滚内存', () => {
  /** 让 persist() 的最后一步 rename 失败，模拟磁盘满 / 权限不足 / 文件被占用 */
  function breakPersist(): void {
    vi.spyOn(fs, 'rename').mockRejectedValue(new Error('磁盘已满'))
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('新增失败后这条记录不留在内存里', async () => {
    // 不回滚的话界面显示「已记一笔」但磁盘上什么都没有，重启后记录消失 ——
    // 用户以为自己记过账，实际什么都没留下
    const kept = await store.addExpense({ amountCents: 100, categoryId: 'c1-1', date: '2026-09-15' })
    breakPersist()

    await expect(
      store.addExpense({ amountCents: 200, categoryId: 'c1-1', date: '2026-09-16' })
    ).rejects.toThrow('磁盘已满')

    expect(store.listExpenses().map((e) => e.id)).toEqual([kept.id])
  })

  it('修改失败后原值还在，不会被改后的值污染', async () => {
    const e = await store.addExpense({ amountCents: 100, categoryId: 'c1-1', date: '2026-09-15' })
    breakPersist()

    await expect(store.updateExpense({ ...e, amountCents: 999 })).rejects.toThrow('磁盘已满')

    expect(store.listExpenses()[0].amountCents).toBe(100)
  })

  it('删除失败后记录还在', async () => {
    const e = await store.addExpense({ amountCents: 100, categoryId: 'c1-1', date: '2026-09-15' })
    breakPersist()

    await expect(store.deleteExpense(e.id)).rejects.toThrow('磁盘已满')

    expect(store.listExpenses().map((x) => x.id)).toEqual([e.id])
  })

  it('保存分类失败后分类树退回原样', async () => {
    // setCategories 是整树覆盖保存：留在内存里的「假状态」会在下一次保存时被固化下来
    breakPersist()

    await expect(store.setCategories([{ id: 'user-1', name: '我的分类' }])).rejects.toThrow(
      '磁盘已满'
    )

    const cats = store.getCategories()
    expect(cats).toHaveLength(9)
    expect(cats[0].name).toBe('餐饮食品')
  })

  it('失败一次之后再保存仍能成功，内存数组没有被改坏', async () => {
    // addExpense 的回滚用的是 pop()，一旦将来换成按 id 删或下标删，
    // 很容易在「失败后重试」这条路径上误伤别的记录
    const spy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('磁盘已满'))

    await expect(
      store.addExpense({ amountCents: 100, categoryId: 'c1-1', date: '2026-09-15' })
    ).rejects.toThrow('磁盘已满')
    expect(spy).toHaveBeenCalledTimes(1)

    const ok = await store.addExpense({ amountCents: 200, categoryId: 'c1-1', date: '2026-09-16' })
    expect(store.listExpenses().map((e) => e.id)).toEqual([ok.id])
  })
})
