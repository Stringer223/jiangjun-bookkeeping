// 将军记账 —— 主进程 / 渲染进程共享的数据类型

/** 记账分类（两级：一级大类含 children 二级小类） */
export interface Category {
  id: string
  name: string
  children?: Category[]
}

/** 一笔花销记录。金额以「分」为单位存储，避免浮点误差 */
export interface Expense {
  id: string
  amountCents: number
  categoryId: string // 二级小类 id
  date: string // YYYY-MM-DD
  note?: string
  createdAt: number
}

/** 账单查询过滤条件 */
export interface ExpenseFilter {
  start?: string
  end?: string
  categoryId?: string
  keyword?: string
}

/** 暴露给渲染进程的 API（preload 通过 contextBridge 注入 window.api） */
export interface Api {
  getCategories: () => Promise<Category[]>
  setCategories: (categories: Category[]) => Promise<Category[]>
  listExpenses: (filter?: ExpenseFilter) => Promise<Expense[]>
  addExpense: (input: Omit<Expense, 'id' | 'createdAt'>) => Promise<Expense>
  updateExpense: (expense: Expense) => Promise<Expense>
  deleteExpense: (id: string) => Promise<void>
  exportCsv: (csv: string, defaultName: string) => Promise<boolean>
}
