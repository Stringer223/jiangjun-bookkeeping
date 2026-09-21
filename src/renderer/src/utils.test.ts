import { describe, expect, it } from 'vitest'
import {
  centsToYuan,
  findCategoryPath,
  findTopCategory,
  formatDate,
  formatMonth,
  lastMonths,
  toCascaderOptions,
  todayStr,
  yuanToCents
} from './utils'
import type { Category } from '../../shared/types'

/** 测试用分类树：一个含两个二级小类的、一个含单个二级小类的 */
const CATEGORIES: Category[] = [
  {
    id: 'c1',
    name: '餐饮食品',
    isPreset: true,
    children: [
      { id: 'c1-1', name: '早餐', isPreset: true },
      { id: 'c1-2', name: '午餐', isPreset: true }
    ]
  },
  {
    id: 'c2',
    name: '交通出行',
    isPreset: true,
    children: [{ id: 'c2-1', name: '公交地铁', isPreset: true }]
  }
]

describe('金额换算', () => {
  it('分转元保留两位小数', () => {
    expect(centsToYuan(12345)).toBe('123.45')
    expect(centsToYuan(0)).toBe('0.00')
    // 1 分要显示成 0.01，不能被舍成 0.0
    expect(centsToYuan(1)).toBe('0.01')
  })

  it('元转分四舍五入到整数分', () => {
    expect(yuanToCents(123.45)).toBe(12345)
    expect(yuanToCents(0)).toBe(0)
    expect(yuanToCents(0.01)).toBe(1)
    // 19.99 * 100 在浮点下是 1998.9999...，仍必须进位到 1999，不能变成 1998
    expect(yuanToCents(19.99)).toBe(1999)
  })

  it('分 → 元 → 分 可以往返', () => {
    for (const cents of [1, 99, 100, 12345, 99999]) {
      expect(yuanToCents(Number(centsToYuan(cents)))).toBe(cents)
    }
  })
})

describe('日期格式化', () => {
  // 用本地时间构造，避免测试机时区不同导致断言飘移
  const ts = new Date(2026, 8, 15, 13, 30).getTime() // 2026-09-15

  it('格式化为 YYYY-MM', () => {
    expect(formatMonth(ts)).toBe('2026-09')
  })

  it('格式化为 YYYY-MM-DD，月/日不足两位要补零', () => {
    expect(formatDate(ts)).toBe('2026-09-15')
    expect(formatDate(new Date(2026, 0, 5).getTime())).toBe('2026-01-05')
    expect(formatDate(new Date(2026, 11, 31).getTime())).toBe('2026-12-31')
  })

  it('todayStr 就是今天的 YYYY-MM-DD', () => {
    expect(todayStr()).toBe(formatDate(Date.now()))
    expect(todayStr()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('最近 n 个月（lastMonths）', () => {
  it('返回 n 个月，含当前月，且按时间升序', () => {
    const ms = lastMonths(3)
    expect(ms).toHaveLength(3)
    expect(ms[2]).toBe(formatMonth(Date.now()))
    expect([...ms].sort()).toEqual(ms)
  })

  it('跨年时月份编号仍然合法（不能出现 2025-13 这种）', () => {
    for (const m of lastMonths(13)) {
      expect(m).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/)
    }
  })

  it('n 为 0 时返回空数组', () => {
    expect(lastMonths(0)).toEqual([])
  })
})

describe('分类查找', () => {
  it('传二级 id 返回「一级 / 二级」路径', () => {
    expect(findCategoryPath(CATEGORIES, 'c1-2')).toBe('餐饮食品 / 午餐')
  })

  it('传一级 id 只返回一级名', () => {
    expect(findCategoryPath(CATEGORIES, 'c1')).toBe('餐饮食品')
  })

  it('找不到时返回「未分类」，而不是抛错或返回空串', () => {
    // 分类被删掉后，历史账目仍引用着旧 id，这条路径会真实走到
    expect(findCategoryPath(CATEGORIES, '已删除的id')).toBe('未分类')
  })

  it('findTopCategory 对一级和二级 id 都返回所属大类', () => {
    expect(findTopCategory(CATEGORIES, 'c2')?.id).toBe('c2')
    expect(findTopCategory(CATEGORIES, 'c2-1')?.id).toBe('c2')
    expect(findTopCategory(CATEGORIES, '已删除的id')).toBeUndefined()
  })
})

describe('toCascaderOptions', () => {
  it('把分类树转成 label/value 结构', () => {
    expect(toCascaderOptions(CATEGORIES)[0]).toEqual({
      label: '餐饮食品',
      value: 'c1',
      children: [
        { label: '早餐', value: 'c1-1' },
        { label: '午餐', value: 'c1-2' }
      ]
    })
  })

  it('没有二级小类的一级分类要「省略」children 字段，否则在 Cascader 里根本选不中', () => {
    // 关键区别：省略字段 vs children: []。
    // Naive UI 底层按 `!getChildren(node)` 判叶子（treemate/es/utils.js），
    // 而空数组是 truthy，于是这种分类会被当成父节点 —— 点它只会展开一个空的
    // 二级面板，永远无法选中，用户新建了一级大类却没法用它记账。
    // 旧断言写的是 toEqual([])，等于把这个 bug 钉死在测试里。
    const opts = toCascaderOptions([{ id: 'c9', name: '其他', isPreset: true }])
    expect(opts[0].children).toBeUndefined()
  })

  it('没有二级小类时「children 这个键都不存在」，序列化结果里也搜不到', () => {
    // 比 toBeUndefined 更严：{ children: undefined } 也能让 toBeUndefined 通过，
    // 但字段存在本身在合并 / 序列化 / 展开赋值时仍可能变回 []，
    // 于是又被 Naive UI 当成父节点。用 in 确认键确实没被定义出来
    const opt = toCascaderOptions([{ id: 'c9', name: '其他', isPreset: true }])[0]
    expect('children' in opt).toBe(false)
    expect(JSON.stringify(opt)).toBe('{"label":"其他","value":"c9"}')
  })

  it('children 是空数组（新建大类还没加小类）时，同样要省略该字段', () => {
    // 这条和「字段缺失」不是同一条路径：新建一级大类后 store 里存的就是 children: [],
    // 走的是 (c.children ?? []).map() 得到空数组这个分支，
    // 而空数组是 truthy —— 稍一写成 ?? [] 之外还要判长度，就会漏掉它
    const opt = toCascaderOptions([{ id: 'user-1', name: '我的大类', isPreset: false, children: [] }])[0]
    expect('children' in opt).toBe(false)
  })
})
