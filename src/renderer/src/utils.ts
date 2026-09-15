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

/** 根据二级小类 id，返回「一级 / 二级」展示路径 */
export function findCategoryPath(categories: Category[], id: string): string {
  for (const c of categories) {
    if (c.id === id) return c.name
    const child = c.children?.find((s) => s.id === id)
    if (child) return `${c.name} / ${child.name}`
  }
  return '未分类'
}

/** 根据二级小类 id，返回所属的一级大类 */
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
