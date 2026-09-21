<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useMessage } from 'naive-ui'
import type { Category } from '../../../shared/types'
import { toCascaderOptions, yuanToCents, formatDate, todayStr } from '../utils'

const message = useMessage()
const categories = ref<Category[]>([])
const amount = ref<number | null>(null)
const categoryValue = ref<string | null>(null)
const date = ref<number>(Date.now())
const note = ref('')
const loading = ref(false)

const cascaderOptions = computed(() => toCascaderOptions(categories.value))

onMounted(async () => {
  try {
    categories.value = await window.api.getCategories()
  } catch {
    // 拉不到分类 → 选择框一片空白，用户会以为「没有分类可选」，于是完全没法记账。
    // 这条失败路径必须出声，否则表现为「这个软件坏了但我不知道哪坏了」
    message.error('分类加载失败，请重启应用后再试')
  }
})

async function submit(): Promise<void> {
  if (amount.value === null || amount.value <= 0) {
    message.error('请输入正确的金额')
    return
  }
  if (!categoryValue.value) {
    message.error('请选择分类')
    return
  }
  loading.value = true
  try {
    await window.api.addExpense({
      amountCents: yuanToCents(amount.value),
      categoryId: categoryValue.value,
      date: date.value ? formatDate(date.value) : todayStr(),
      note: note.value.trim() || undefined
    })
    message.success('已记一笔')
    amount.value = null
    categoryValue.value = null
    note.value = ''
    date.value = Date.now()
  } catch {
    message.error('保存失败，请重试')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <n-card title="记一笔" :bordered="false" style="max-width: 560px">
    <n-form label-placement="top">
      <n-form-item label="金额（人民币）">
        <n-input-number
          v-model:value="amount"
          :min="0"
          :precision="2"
          :step="1"
          placeholder="0.00"
          style="width: 100%"
        >
          <template #prefix>¥</template>
        </n-input-number>
      </n-form-item>
      <n-form-item label="分类">
        <n-cascader
          v-model:value="categoryValue"
          :options="cascaderOptions"
          placeholder="请选择分类（一级 / 二级）"
          clearable
          style="width: 100%"
        />
      </n-form-item>
      <n-form-item label="日期">
        <n-date-picker v-model:value="date" type="date" style="width: 100%" />
      </n-form-item>
      <n-form-item label="备注（可选）">
        <n-input
          v-model:value="note"
          type="textarea"
          placeholder="例如：和朋友聚餐"
          :rows="2"
        />
      </n-form-item>
      <n-button type="primary" block :loading="loading" @click="submit">保存</n-button>
    </n-form>
  </n-card>
</template>
