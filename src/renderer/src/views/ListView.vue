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
import type { Category, Expense, ExpenseFilter } from '../../../shared/types'
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
    // 用共享类型而不是就地重写一遍形状：两边字段一旦不同步，
    // 主进程那头改了筛选契约这里不会报错，只会静默失效
    const filter: ExpenseFilter = {}
    if (month.value) {
      const m = formatMonth(month.value)
      filter.start = `${m}-01`
      // 月末固定用 -31：date 是 'YYYY-MM-DD' 字符串，筛选走字典序比较，
      // 任何真实日期都 ≤ 'YYYY-MM-31'（不存在 -32 及以后的日期），
      // 所以二月、小月也无需按实际天数计算
      filter.end = `${m}-31`
    }
    if (categoryId.value) filter.categoryId = categoryId.value
    if (keyword.value.trim()) filter.keyword = keyword.value.trim()
    expenses.value = await window.api.listExpenses(filter)
  } catch {
    // 原来只有 try/finally、没有 catch：查询失败时表格会保留上一次的数据，
    // 用户看到的是「查询没反应」—— 实际显示的是旧结果，比直接报错更危险
    message.error('账单加载失败，请重试')
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  try {
    categories.value = await window.api.getCategories()
  } catch {
    message.error('分类加载失败，请重启应用后再试')
  }
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
  // 补 T00:00:00 是在告诉 JS 按【本地时间】解析。
  // 直接 new Date('2026-09-15') 会按 UTC 解析，东八区下变成前一天 08:00，
  // 回填到日期选择器整整差一天
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
  if (!original) {
    // 原来是裸 return：点了保存什么都没发生，用户会以为是自己没点到
    message.warning('这条记录已经不存在了，请关闭窗口后刷新列表')
    return
  }
  try {
    await window.api.updateExpense({
      ...original,
      amountCents: yuanToCents(editAmount.value),
      categoryId: editCategory.value,
      date: editDate.value ? formatDate(editDate.value) : original.date,
      note: editNote.value.trim() || undefined
    })
  } catch {
    // 失败时既不关弹窗也不提示的话，用户只会反复点保存
    message.error('保存失败，改动没有写入，请重试')
    return
  }
  editOpen.value = false
  message.success('已更新')
  await load()
}

async function remove(row: Expense): Promise<void> {
  try {
    await window.api.deleteExpense(row.id)
  } catch {
    message.error('删除失败，请重试')
    return
  }
  message.success('已删除')
  await load()
}

async function exportCsv(): Promise<void> {
  let data: Expense[]
  try {
    data = await window.api.listExpenses({})
  } catch {
    message.error('读取账单失败，无法导出')
    return
  }
  // CSV 转义按 RFC 4180：字段一律用双引号包裹，内部的双引号翻倍。
  // 这样逗号、换行、双引号都能原样保留。
  // 旧实现只把半角逗号换成全角（有损、不可逆），而且**拦不住备注里的回车** ——
  // 备注是 textarea，敲回车正是它引导用户做的事，一条带换行的备注
  // 就会把整份导出文件的列全部顶错位（注释里"以保证列数不错位"因此是不成立的）
  const quote = (s: string): string => `"${s.replace(/"/g, '""')}"`
  const header = ['日期', '分类', '金额(元)', '备注'].map(quote).join(',')
  const lines = data.map((e) => {
    const cat = findCategoryPath(categories.value, e.categoryId)
    return [e.date, cat, centsToYuan(e.amountCents), e.note ?? ''].map(quote).join(',')
  })
  const csv = [header, ...lines].join('\r\n')
  try {
    const ok = await window.api.exportCsv(csv, `账单_${formatMonth(Date.now())}.csv`)
    if (ok) message.success('导出成功')
    else message.info('已取消导出')
  } catch {
    // 写文件失败（磁盘满 / 无权限）原来是完全静默的
    message.error('导出失败，请检查目标目录是否可写')
  }
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
