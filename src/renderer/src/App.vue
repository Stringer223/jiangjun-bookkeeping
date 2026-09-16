<script setup lang="ts">
import { ref, computed } from 'vue'
import { zhCN, dateZhCN } from 'naive-ui'
import RecordView from './views/RecordView.vue'
import ListView from './views/ListView.vue'
import StatsView from './views/StatsView.vue'
import CategoryView from './views/CategoryView.vue'
import GameView from './views/GameView.vue'

const activeKey = ref('record')

const menuOptions = [
  { label: '记一笔', key: 'record' },
  { label: '账单', key: 'list' },
  { label: '统计', key: 'stats' },
  { label: '分类管理', key: 'category' },
  { label: '休闲', key: 'game' }
]

const activeView = computed(() => {
  switch (activeKey.value) {
    case 'list':
      return ListView
    case 'stats':
      return StatsView
    case 'category':
      return CategoryView
    case 'game':
      return GameView
    default:
      return RecordView
  }
})
</script>

<template>
  <n-config-provider :locale="zhCN" :date-locale="dateZhCN">
    <n-message-provider>
      <n-dialog-provider>
        <n-layout has-sider style="height: 100vh">
          <n-layout-sider bordered :width="200" :collapsed-width="64" show-trigger>
            <div class="brand">⚔️ 将军记账</div>
            <n-menu
              :value="activeKey"
              :options="menuOptions"
              @update:value="(k: string) => (activeKey = k)"
            />
          </n-layout-sider>
          <n-layout>
            <n-layout-content content-style="padding: 20px 24px;">
              <component :is="activeView" />
            </n-layout-content>
          </n-layout>
        </n-layout>
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>

<style>
html,
body,
#app {
  margin: 0;
  height: 100%;
}
body {
  font-family: system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif;
  -webkit-font-smoothing: antialiased;
}
.brand {
  height: 56px;
  display: flex;
  align-items: center;
  padding-left: 20px;
  font-size: 17px;
  font-weight: 700;
  color: #1e293b;
  white-space: nowrap;
  overflow: hidden;
}
</style>
