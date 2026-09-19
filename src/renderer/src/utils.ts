import type { Category } from '../../shared/types'

/** 分 -> 元（字符串，保留两位小数） */
export function centsToYuan(cents: number): string {
  return (cents / 100).toFixed(2)
}

/** 元 -> 分（四舍五入为整数） */
export function yuanToCents(yuan: number): number {
  return Math.round(yuan * 100)
}

/** 时间戳 -> YYYY-MM */
export function formatMonth(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 时间戳 -> YYYY-MM-DD */
export function formatDate(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 今天的 YYYY-MM-DD */
export function todayStr(): string {
  return formatDate(Date.now())
}

/** 分类树 -> Naive UI Cascader 的 options */
export function toCascaderOptions(
  categories: Category[]
): { label: string; value: string; children: { label: string; value: string }[] }[] {
  return categories.map((c) => ({
    label: c.name,
    value: c.id,
    children: (c.children ?? []).map((s) => ({ label: s.name, value: s.id }))
  }))
}

/**
 * 按分类 id 取展示路径：传二级 id 得「一级 / 二级」，传一级 id 得一级名。
 *
 * 找不到时返回「未分类」而不是抛错 —— 分类被删掉后，历史账目仍引用着旧 id，
 * 这条路径会真实走到，抛错会让整张账单渲染不出来。
 */
export function findCategoryPath(categories: Category[], id: string): string {
  for (const c of categories) {
    if (c.id === id) return c.name
    const child = c.children?.find((s) => s.id === id)
    if (child) return `${c.name} / ${child.name}`
  }
  return '未分类'
}

/**
 * 按分类 id 找它所属的一级大类：传一级 id 返回自身，传二级 id 返回其父级。
 *
 * 找不到返回 undefined，由调用方决定怎么兜底（界面上一律显示「未分类」）。
 */
export function findTopCategory(categories: Category[], id: string): Category | undefined {
  for (const c of categories) {
    if (c.id === id) return c
    if (c.children?.some((s) => s.id === id)) return c
  }
  return undefined
}

/** 最近 n 个月的 YYYY-MM 列表（含当前月），按时间升序 */
export function lastMonths(n: number): string[] {
  const res: string[] = []
  const now = new Date()
  for (let i = n - 1; i >= 0; i--) {
    const dt = new Date(now.getFullYear(), now.getMonth() - i, 1)
    res.push(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`)
  }
  return res
}
