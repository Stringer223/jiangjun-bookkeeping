import { contextBridge, ipcRenderer } from 'electron'
import type { Api, Category, Expense, ExpenseFilter } from '../shared/types'

const api: Api = {
  getCategories: () => ipcRenderer.invoke('categories:get'),
  setCategories: (categories: Category[]) => ipcRenderer.invoke('categories:set', categories),
  listExpenses: (filter?: ExpenseFilter) => ipcRenderer.invoke('expenses:list', filter),
  addExpense: (input) => ipcRenderer.invoke('expenses:add', input),
  updateExpense: (expense: Expense) => ipcRenderer.invoke('expenses:update', expense),
  deleteExpense: (id: string) => ipcRenderer.invoke('expenses:delete', id),
  exportCsv: (csv: string, defaultName: string) => ipcRenderer.invoke('export:csv', csv, defaultName)
}

contextBridge.exposeInMainWorld('api', api)
