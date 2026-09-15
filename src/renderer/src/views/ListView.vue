<script setup lang="ts">
import { ref, computed, onMounted, h } from 'vue'
import {
  useMessage,
  NButton,
  NSpace,
  NPopconfirm,
  NInputNumber,
  NModal
} from 'naive-ui'
import type { Category, Expense } from '../../../shared/types'
import {
  toCascaderOptions,
  findCategoryPath,
  centsToYuan,
  yuanToCents,
  formatMonth,
  formatDate
} from '../utils'

const message = useMessage()
const categories = ref<Category[]>([])
const expenses = ref<Expense[]>([])
const loading = ref(false)

const month = ref<number | null>(null)
const categoryId = ref<string | null>(null)
const keyword = ref('')

const cascaderOptions = computed(() => toCascaderOptions(categories.value))

async function load(): Promise<void> {
  loading.value = true
  try {
    const filter: { start?: string; end?: string; categoryId?: string; keyword?: string } = {}
    if (month.value) {
      const m = formatMonth(month.value)
      filter.start = `${m}-01`
      filter.end = `${m}-31`
    }
    if (categoryId.value) filter.categoryId = categoryId.value
    if (keyword.value.trim()) filter.keyword = keyword.value.trim()
    expenses.value = await window.api.listExpenses(filter)
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  categories.value = await window.api.getCategories()
  await load()
})

const totalCents = computed(() => expenses.value.reduce((s, e) => s + e.amountCents, 0))

const columns = computed(() => [
  { title: '日期', key: 'date', width: 120 },
  {
    title: '分类',
    key: 'category',
    width: 180,
    render: (row: Expense) => findCategoryPath(categories.value, row.categoryId)
  },
  {
    title: '金额',
    key: 'amount',
    width: 130,
    align: 'right',
    render: (row: Expense) => `¥ ${centsToYuan(row.amountCents)}`
  },
  { title: '备注', key: 'note', ellipsis: { tooltip: true } },
  {
    title: '操作',
    key: 'actions',
    width: 140,
    render: (row: Expense) =>
      h(NSpace, { size: 4 }, {
        default: () => [
          h(
            NButton,
            { size: 'small', quaternary: true, type: 'primary', onClick: () => openEdit(row) },
            { default: () => '编辑' }
          ),
          h(
            NPopconfirm,
            { onPositiveClick: () => remove(row) },
            {
              trigger: () =>
                h(
                  NButton,
                  { size: 'small', quaternary: true, type: 'error' },
                  { default: () => '删除' }
                ),
              default: () => '确定删除这条记录？'
            }
          )
        ]
      })
  }
])

// ---- 编辑弹窗 ----
const editOpen = ref(false)
const editingId = ref<string | null>(null)
const editAmount = ref<number | null>(null)
const editCategory = ref<string | null>(null)
const editDate = ref<number>(Date.now())
const editNote = ref('')

function openEdit(row: Expense): void {
  editingId.value = row.id
  editAmount.value = row.amountCents / 100
  editCategory.value = row.categoryId
  editDate.value = new Date(`${row.date}T00:00:00`).getTime()
  editNote.value = row.note ?? ''
  editOpen.value = true
}

async function saveEdit(): Promise<void> {
  if (editAmount.value === null || editAmount.value <= 0) {
    message.error('请输入正确的金额')
    return
  }
  if (!editCategory.value) {
    message.error('请选择分类')
    return
  }
  const original = expenses.value.find((e) => e.id === editingId.value)
  if (!original) return
  await window.api.updateExpense({
    ...original,
    amountCents: yuanToCents(editAmount.value),
    categoryId: editCategory.value,
    date: editDate.value ? formatDate(editDate.value) : original.date,
    note: editNote.value.trim() || undefined
  })
  editOpen.value = false
  message.success('已更新')
  await load()
}

async function remove(row: Expense): Promise<void> {
  await window.api.deleteExpense(row.id)
  message.success('已删除')
  await load()
}

async function exportCsv(): Promise<void> {
  const data = await window.api.listExpenses({})
  const escape = (s: string): string => s.replace(/,/g, '，').replace(/"/g, '""')
  const header = '日期,分类,金额(元),备注'
  const lines = data.map((e) => {
    const cat = findCategoryPath(categories.value, e.categoryId)
    return `${e.date},${escape(cat)},${centsToYuan(e.amountCents)},${escape(e.note ?? '')}`
  })
  const csv = [header, ...lines].join('\r\n')
  const ok = await window.api.exportCsv(csv, `账单_${formatMonth(Date.now())}.csv`)
  if (ok) message.success('导出成功')
  else message.info('已取消导出')
}
</script>

<template>
  <div>
    <n-card :bordered="false">
      <n-space style="margin-bottom: 16px" :size="12" wrap>
        <n-date-picker
          v-model:value="month"
          type="month"
          clearable
          placeholder="按月份筛选"
          style="width: 160px"
          @update:value="load"
        />
        <n-cascader
          v-model:value="categoryId"
          :options="cascaderOptions"
          clearable
          placeholder="按分类筛选"
          style="width: 220px"
          @update:value="load"
        />
        <n-input
          v-model:value="keyword"
          placeholder="搜索备注"
          clearable
          style="width: 180px"
          @keyup.enter="load"
          @clear="load"
        />
        <n-button @click="load">查询</n-button>
        <n-button @click="exportCsv">导出 CSV</n-button>
      </n-space>

      <n-data-table
        :columns="columns"
        :data="expenses"
        :loading="loading"
        :bordered="false"
        size="small"
      />

      <div style="margin-top: 16px; text-align: right; font-size: 15px; color: #1e293b">
        共 {{ expenses.length }} 条，合计
        <span style="font-weight: 700; color: #e11d48">¥ {{ centsToYuan(totalCents) }}</span>
      </div>
    </n-card>

    <n-modal
      v-model:show="editOpen"
      preset="card"
      title="编辑记录"
      style="width: 480px"
      :mask-closable="false"
    >
      <n-form label-placement="top">
        <n-form-item label="金额（人民币）">
          <n-input-number
            v-model:value="editAmount"
            :min="0"
            :precision="2"
            :step="1"
            style="width: 100%"
          >
            <template #prefix>¥</template>
          </n-input-number>
        </n-form-item>
        <n-form-item label="分类">
          <n-cascader
            v-model:value="editCategory"
            :options="cascaderOptions"
            clearable
            style="width: 100%"
          />
        </n-form-item>
        <n-form-item label="日期">
          <n-date-picker v-model:value="editDate" type="date" style="width: 100%" />
        </n-form-item>
        <n-form-item label="备注">
          <n-input v-model:value="editNote" type="textarea" :rows="2" />
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="editOpen = false">取消</n-button>
          <n-button type="primary" @click="saveEdit">保存</n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>
