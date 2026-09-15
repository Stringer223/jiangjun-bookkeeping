<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { useMessage } from 'naive-ui'
import type { Category } from '../../../shared/types'

const message = useMessage()
const categories = ref<Category[]>([])

const dialog = reactive({
  show: false,
  title: '',
  name: '',
  type: '' as '' | 'addTop' | 'addChild' | 'renameTop' | 'renameChild',
  parentId: '',
  childId: ''
})

onMounted(async () => {
  categories.value = await window.api.getCategories()
})

async function persist(): Promise<void> {
  categories.value = await window.api.setCategories(JSON.parse(JSON.stringify(categories.value)))
}

function openAddTop(): void {
  Object.assign(dialog, { show: true, title: '添加一级大类', name: '', type: 'addTop', parentId: '', childId: '' })
}
function openAddChild(parentId: string): void {
  Object.assign(dialog, { show: true, title: '添加二级小类', name: '', type: 'addChild', parentId, childId: '' })
}
function openRenameTop(cat: Category): void {
  Object.assign(dialog, { show: true, title: '重命名一级大类', name: cat.name, type: 'renameTop', parentId: cat.id, childId: '' })
}
function openRenameChild(cat: Category, child: Category): void {
  Object.assign(dialog, { show: true, title: '重命名二级小类', name: child.name, type: 'renameChild', parentId: cat.id, childId: child.id })
}

function onChildClick(cat: Category, child: Category): void {
  if (child.isPreset) return
  openRenameChild(cat, child)
}

function confirm(): void {
  const name = dialog.name.trim()
  if (!name) {
    message.error('请输入名称')
    return
  }
  switch (dialog.type) {
    case 'addTop':
      categories.value.push({ id: 'c' + Date.now(), name, children: [], isPreset: false })
      break
    case 'addChild': {
      const p = categories.value.find((c) => c.id === dialog.parentId)
      p?.children?.push({ id: `${dialog.parentId}-${Date.now()}`, name, isPreset: false })
      break
    }
    case 'renameTop': {
      const p = categories.value.find((c) => c.id === dialog.parentId)
      if (p) p.name = name
      break
    }
    case 'renameChild': {
      const p = categories.value.find((c) => c.id === dialog.parentId)
      const s = p?.children?.find((x) => x.id === dialog.childId)
      if (s) s.name = name
      break
    }
  }
  dialog.show = false
  void persist()
}

async function removeTop(id: string): Promise<void> {
  const cat = categories.value.find((c) => c.id === id)
  if (cat?.isPreset) {
    message.error('预置分类不可删除')
    return
  }
  const usage = await window.api.countCategoryUsage(id)
  if (usage > 0) {
    message.error(`该分类下有 ${usage} 条账目，请先修改这些账目的分类再删除`)
    return
  }
  categories.value = categories.value.filter((c) => c.id !== id)
  void persist()
  message.success('已删除')
}

async function removeChild(parentId: string, childId: string): Promise<void> {
  const p = categories.value.find((c) => c.id === parentId)
  const s = p?.children?.find((x) => x.id === childId)
  if (s?.isPreset) {
    message.error('预置分类不可删除')
    return
  }
  const usage = await window.api.countCategoryUsage(childId)
  if (usage > 0) {
    message.error(`该分类下有 ${usage} 条账目，请先修改这些账目的分类再删除`)
    return
  }
  if (p) p.children = (p.children ?? []).filter((x) => x.id !== childId)
  void persist()
  message.success('已删除')
}
</script>

<template>
  <div>
    <n-card :bordered="false">
      <n-space style="margin-bottom: 16px" justify="space-between" align="center">
        <n-text depth="3">共 {{ categories.length }} 个一级大类 · 预置分类已锁定，自建分类可重命名/删除</n-text>
        <n-button type="primary" @click="openAddTop">+ 添加一级大类</n-button>
      </n-space>

      <n-space vertical :size="12">
        <n-card v-for="cat in categories" :key="cat.id" size="small" :bordered="true">
          <template #header>
            <n-space justify="space-between" align="center" :wrap="false">
              <n-space :size="8" align="center" :wrap="false">
                <n-text strong style="font-size: 15px">{{ cat.name }}</n-text>
                <n-tag v-if="cat.isPreset" size="small" :bordered="false" type="default">预置</n-tag>
              </n-space>
              <n-space :size="4">
                <n-button v-if="!cat.isPreset" size="tiny" quaternary type="primary" @click="openRenameTop(cat)">重命名</n-button>
                <n-button size="tiny" quaternary type="primary" @click="openAddChild(cat.id)">+ 小类</n-button>
                <n-popconfirm v-if="!cat.isPreset" @positive-click="removeTop(cat.id)">
                  <template #trigger>
                    <n-button size="tiny" quaternary type="error">删除</n-button>
                  </template>
                  删除「{{ cat.name }}」及其所有小类？
                </n-popconfirm>
              </n-space>
            </n-space>
          </template>

          <div class="chips">
            <span v-for="child in cat.children ?? []" :key="child.id" class="chip">
              <n-tag
                round
                :type="child.isPreset ? 'default' : 'primary'"
                :style="child.isPreset ? '' : 'cursor: pointer'"
                @click="onChildClick(cat, child)"
              >
                {{ child.name }}
              </n-tag>
              <button
                v-if="!child.isPreset"
                class="chip-del"
                title="删除小类"
                @click="removeChild(cat.id, child.id)"
              >✕</button>
            </span>
            <n-text v-if="!(cat.children ?? []).length" depth="3">暂无小类</n-text>
          </div>
        </n-card>
      </n-space>
    </n-card>

    <n-modal
      v-model:show="dialog.show"
      preset="card"
      :title="dialog.title"
      style="width: 400px"
      :mask-closable="false"
    >
      <n-input
        v-model:value="dialog.name"
        placeholder="请输入名称"
        @keyup.enter="confirm"
      />
      <template #footer>
        <n-space justify="end">
          <n-button @click="dialog.show = false">取消</n-button>
          <n-button type="primary" @click="confirm">确定</n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.chip-del {
  border: none;
  background: transparent;
  color: #94a3b8;
  cursor: pointer;
  font-size: 12px;
  padding: 2px 4px;
  border-radius: 4px;
}
.chip-del:hover {
  color: #e11d48;
  background: #fee2e2;
}
</style>
