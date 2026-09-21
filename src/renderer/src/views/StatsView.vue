<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useMessage } from 'naive-ui'
import type { Category, Expense } from '../../../shared/types'
import { centsToYuan, formatMonth, findTopCategory, lastMonths } from '../utils'

const message = useMessage()
const categories = ref<Category[]>([])
const expenses = ref<Expense[]>([])
const month = ref<number | null>(Date.now())

onMounted(async () => {
  // 两个 await 串着裸跑时，前一个失败会让后一个永远不执行，页面停在半空白状态
  try {
    categories.value = await window.api.getCategories()
    expenses.value = await window.api.listExpenses({})
  } catch {
    message.error('统计数据加载失败，请重启应用后再试')
  }
})

const currentMonth = computed(() => formatMonth(month.value ?? Date.now()))

const monthExpenses = computed(() =>
  expenses.value.filter((e) => e.date.startsWith(currentMonth.value))
)

const monthTotal = computed(() => monthExpenses.value.reduce((s, e) => s + e.amountCents, 0))

/** 「分类已删除」的历史账目在统计里的占位 key。不能用名字，名字会撞 */
const UNCATEGORIZED_KEY = '__uncategorized__'

interface CatBar {
  /** 聚合键（一级分类 id），同时作为 v-for 的 key —— 名字可以重复，id 不行 */
  id: string
  name: string
  total: number
  percent: number
}

const categoryBars = computed<CatBar[]>(() => {
  const map = new Map<string, number>()
  for (const e of monthExpenses.value) {
    const top = findTopCategory(categories.value, e.categoryId)
    // 用 id 而不是名字聚合：分类名可以重复（CategoryView 的 confirm() 没有唯一性校验），
    // 拿 name 当 key 会把两个同名分类的支出并成一条 —— 总数看着对，明细对不上，
    // 而且 v-for 的 key 重复会让 Vue 复用错误的 DOM 节点
    const key = top?.id ?? UNCATEGORIZED_KEY
    map.set(key, (map.get(key) ?? 0) + e.amountCents)
  }
  const total = monthTotal.value
  return Array.from(map.entries())
    .map(([id, cents]) => ({
      id,
      // 分类被删掉后历史账目仍引用旧 id，findTopCategory 返回 undefined，
      // 统一兜底成「未分类」（与 utils.ts 的 findCategoryPath 同一套路）
      name: categories.value.find((c) => c.id === id)?.name ?? '未分类',
      total: cents,
      percent: total > 0 ? (cents / total) * 100 : 0
    }))
    .sort((a, b) => b.total - a.total)
})

const maxCatTotal = computed(() => Math.max(1, ...categoryBars.value.map((b) => b.total)))

const monthlyTrend = computed(() =>
  lastMonths(6).map((m) => ({
    month: m,
    total: expenses.value.filter((e) => e.date.startsWith(m)).reduce((s, e) => s + e.amountCents, 0)
  }))
)

const maxMonthTotal = computed(() => Math.max(1, ...monthlyTrend.value.map((m) => m.total)))
</script>

<template>
  <div>
    <n-card :bordered="false" style="margin-bottom: 16px">
      <n-space align="center" :size="16">
        <n-date-picker v-model:value="month" type="month" clearable style="width: 160px" />
        <div>
          <div class="total-label">{{ currentMonth }} 总支出</div>
          <div class="total-value">¥ {{ centsToYuan(monthTotal) }}</div>
        </div>
      </n-space>
    </n-card>

    <n-grid :cols="2" :x-gap="16" responsive="screen">
      <n-grid-item>
        <n-card title="分类占比" :bordered="false">
          <div v-if="categoryBars.length === 0" class="empty">该月暂无记录</div>
          <div v-for="b in categoryBars" :key="b.id" class="bar-row">
            <div class="bar-label">{{ b.name }}</div>
            <div class="bar-track">
              <div class="bar-fill cat" :style="{ width: (b.total / maxCatTotal) * 100 + '%' }"></div>
            </div>
            <div class="bar-value">¥ {{ centsToYuan(b.total) }} · {{ b.percent.toFixed(1) }}%</div>
          </div>
        </n-card>
      </n-grid-item>
      <n-grid-item>
        <n-card title="近 6 个月支出" :bordered="false">
          <div v-for="m in monthlyTrend" :key="m.month" class="bar-row">
            <div class="bar-label">{{ m.month }}</div>
            <div class="bar-track">
              <div class="bar-fill month" :style="{ width: (m.total / maxMonthTotal) * 100 + '%' }"></div>
            </div>
            <div class="bar-value">¥ {{ centsToYuan(m.total) }}</div>
          </div>
        </n-card>
      </n-grid-item>
    </n-grid>
  </div>
</template>

<style scoped>
.total-label {
  font-size: 13px;
  color: #64748b;
}
.total-value {
  font-size: 28px;
  font-weight: 700;
  color: #e11d48;
  line-height: 1.3;
}
.empty {
  color: #94a3b8;
  padding: 24px 0;
  text-align: center;
}
.bar-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.bar-label {
  width: 76px;
  flex-shrink: 0;
  font-size: 13px;
  color: #334155;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bar-track {
  flex: 1;
  height: 10px;
  background: #f1f5f9;
  border-radius: 5px;
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  border-radius: 5px;
  transition: width 0.3s ease;
}
.bar-fill.cat {
  background: #6366f1;
}
.bar-fill.month {
  background: #0ea5e9;
}
.bar-value {
  width: 130px;
  flex-shrink: 0;
  text-align: right;
  font-size: 12px;
  color: #475569;
}
</style>
