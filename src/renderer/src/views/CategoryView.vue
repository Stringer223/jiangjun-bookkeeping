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

/**
 * 统一包一层 IPC 调用：失败时给用户一条明确提示，而不是让按钮点了没反应。
 * 失败时返回 undefined，调用方据此中止后续流程。
 */
async function guard<T>(action: () => Promise<T>, failTip: string): Promise<T | undefined> {
  try {
    return await action()
  } catch {
    message.error(failTip)
    return undefined
  }
}

onMounted(async () => {
  const cats = await guard(() => window.api.getCategories(), '分类加载失败，请重启应用后再试')
  // 拉不到就保持空列表并已给出提示；不能让它抛出去，否则 onMounted 里后续逻辑全不执行
  if (cats) categories.value = cats
})

/**
 * 把当前分类树落盘，并在成功后提示 tip。
 *
 * 必须先做一次 JSON 往返：categories.value 是 Vue 响应式 Proxy，
 * 而 Proxy 无法通过 IPC 的结构化克隆，直接传会抛错。这不是冗余代码，别删。
 *
 * 失败时**不再谎报成功**，并从主进程重新拉一份状态覆盖回去：
 * setCategories 是整树覆盖保存，留在内存里的「假状态」会在下一次保存时被固化。
 */
async function persist(tip: string): Promise<void> {
  try {
    categories.value = await window.api.setCategories(JSON.parse(JSON.stringify(categories.value)))
    message.success(tip)
  } catch {
    // 回拉本身也可能失败。那种情况下只能维持界面现状 ——
    // 但绝不能把异常再抛出去盖掉原始错误，否则用户只会看到"点了没反应"
    try {
      categories.value = await window.api.getCategories()
    } catch {
      /* 拉不到就维持现状，下面的错误提示已经足够让用户知道该重试 */
    }
    message.error('保存失败，这次改动没有写入，请重试')
  }
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
  // 预置分类锁定，点击不做任何事（页面顶部已写明「预置分类已锁定」）。
  // 这里静默返回是有意的，不是漏了提示
  if (child.isPreset) return
  openRenameChild(cat, child)
}

async function confirm(): Promise<void> {
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
  await persist('已保存')
}

async function removeTop(id: string): Promise<void> {
  const cat = categories.value.find((c) => c.id === id)
  if (cat?.isPreset) {
    message.error('预置分类不可删除')
    return
  }
  const usage = await guard(() => window.api.countCategoryUsage(id), '查询分类用量失败，请重试')
  // 查不到用量就中止：不知道有没有账目引用就删，可能把还在用的分类干掉
  if (usage === undefined) return
  if (usage > 0) {
    message.error(`该分类下有 ${usage} 条账目，请先修改这些账目的分类再删除`)
    return
  }
  categories.value = categories.value.filter((c) => c.id !== id)
  await persist('已删除')
}

async function removeChild(parentId: string, childId: string): Promise<void> {
  const p = categories.value.find((c) => c.id === parentId)
  const s = p?.children?.find((x) => x.id === childId)
  if (s?.isPreset) {
    message.error('预置分类不可删除')
    return
  }
  const usage = await guard(() => window.api.countCategoryUsage(childId), '查询分类用量失败，请重试')
  if (usage === undefined) return
  if (usage > 0) {
    message.error(`该分类下有 ${usage} 条账目，请先修改这些账目的分类再删除`)
    return
  }
  if (p) p.children = (p.children ?? []).filter((x) => x.id !== childId)
  await persist('已删除')
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
