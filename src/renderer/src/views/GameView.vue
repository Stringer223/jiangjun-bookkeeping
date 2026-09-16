<script setup lang="ts">
// 贪吃蛇 —— 视图层
// 只负责三件事：画 Canvas、把用户操作转发给 useSnakeGame、渲染分数与状态覆盖层。
// 游戏规则一律不在这里实现（见 game/logic.ts）。

import { computed, onMounted, ref, watch } from 'vue'
import { BOARD_CELLS, CELL_PX, SPEED_OPTIONS, useSnakeGame } from '../game/useSnakeGame'
import { DIR_VECTORS, type Direction, type GameState } from '../game/logic'

const game = useSnakeGame()
const canvasRef = ref<HTMLCanvasElement | null>(null)

/** 棋盘逻辑边长（像素） */
const boardPx = BOARD_CELLS * CELL_PX

// ---- 配色（与 App 现有视觉体系保持一致）----
const COLOR = {
  bg: '#f8fafc',
  grid: '#eaeff5',
  snake: '#6366f1',
  snakeHead: '#4f46e5',
  food: '#e11d48',
  focus: '#c7d2fe'
}

/** 覆盖层状态 */
const overlay = computed<{ title: string; desc: string; action: string } | null>(() => {
  const s = game.state.value
  if (s.over) {
    const title =
      s.reason === 'wall' ? '撞墙了' : s.reason === 'self' ? '咬到自己了' : '通关！整块棋盘都是你的'
    return { title, desc: `本局得分 ${s.score}`, action: '再来一局' }
  }
  if (game.paused.value) return { title: '已暂停', desc: '空格继续', action: '继续' }
  if (!game.running.value) return { title: '贪吃蛇', desc: '方向键 / WASD 转向，空格开始', action: '开始游戏' }
  return null
})

const isNewRecord = computed(() => {
  const s = game.state.value
  return s.over && s.score > 0 && s.score >= game.best.value
})

// ---- 绘制 ----
function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.lineTo(x + w - rr, y)
  ctx.arcTo(x + w, y, x + w, y + rr, rr)
  ctx.lineTo(x + w, y + h - rr)
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr)
  ctx.lineTo(x + rr, y + h)
  ctx.arcTo(x, y + h, x, y + h - rr, rr)
  ctx.lineTo(x, y + rr)
  ctx.arcTo(x, y, x + rr, y, rr)
  ctx.closePath()
}

function draw(): void {
  const el = canvasRef.value
  if (!el) return
  const ctx = el.getContext('2d')
  if (!ctx) return

  const size = boardPx
  const dpr = window.devicePixelRatio || 1
  const backing = Math.round(size * dpr)
  if (el.width !== backing) {
    el.width = backing
    el.height = backing
  }
  // 用 DPR 缩放矩阵，后续全部按逻辑像素作图（高分屏不会糊）
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  ctx.fillStyle = COLOR.bg
  ctx.fillRect(0, 0, size, size)

  // 网格
  ctx.strokeStyle = COLOR.grid
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let i = 1; i < BOARD_CELLS; i++) {
    const p = Math.round(i * CELL_PX) + 0.5
    ctx.moveTo(p, 0)
    ctx.lineTo(p, size)
    ctx.moveTo(0, p)
    ctx.lineTo(size, p)
  }
  ctx.stroke()

  const s: GameState = game.state.value

  // 食物
  const foodCx = s.food.x * CELL_PX + CELL_PX / 2
  const foodCy = s.food.y * CELL_PX + CELL_PX / 2
  ctx.fillStyle = COLOR.food
  ctx.beginPath()
  ctx.arc(foodCx, foodCy, CELL_PX * 0.3, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = '#fda4af'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(foodCx, foodCy, CELL_PX * 0.3, 0, Math.PI * 2)
  ctx.stroke()

  // 蛇身（从尾到头绘制，保证头部压在最上层）
  for (let i = s.snake.length - 1; i >= 0; i--) {
    const seg = s.snake[i]
    if (!seg) continue
    const inset = i === 0 ? 1 : 2
    const x = seg.x * CELL_PX + inset
    const y = seg.y * CELL_PX + inset
    const w = CELL_PX - inset * 2
    ctx.fillStyle = i === 0 ? COLOR.snakeHead : COLOR.snake
    drawRoundedRect(ctx, x, y, w, w, i === 0 ? 8 : 6)
    ctx.fill()
  }

  // 蛇头朝向的眼睛：让方向一目了然
  const head = s.snake[0]
  if (head) {
    const vec = DIR_VECTORS[s.dir]
    const hx = head.x * CELL_PX + CELL_PX / 2
    const hy = head.y * CELL_PX + CELL_PX / 2
    const forward = CELL_PX * 0.16
    const side = CELL_PX * 0.17
    // 垂直于前进方向的分量
    const px = -vec.y
    const py = vec.x
    ctx.fillStyle = '#ffffff'
    for (const sign of [1, -1]) {
      ctx.beginPath()
      ctx.arc(
        hx + vec.x * forward + px * side * sign,
        hy + vec.y * forward + py * side * sign,
        CELL_PX * 0.09,
        0,
        Math.PI * 2
      )
      ctx.fill()
    }
  }
}

onMounted(draw)
watch(() => game.state.value, draw)
watch(() => game.speed.value, draw)

// ---- 交互 ----
function onPrimaryAction(): void {
  if (game.running.value && !game.state.value.over && !game.paused.value) return
  if (game.paused.value && !game.state.value.over) game.togglePause()
  else game.start()
}

const PAD: { dir: Direction; label: string }[] = [
  { dir: 'up', label: '↑' },
  { dir: 'left', label: '←' },
  { dir: 'down', label: '↓' },
  { dir: 'right', label: '→' }
]

/** 屏幕上直接嵌在棋盘四周的方向键（鼠标用户不必回到键盘） */
const padRows: (Direction | null)[][] = [
  [null, 'up', null],
  ['left', 'down', 'right']
]
</script>

<template>
  <div class="game-page">
    <n-card :bordered="false">
      <n-space justify="space-between" align="center" :wrap="false" style="margin-bottom: 16px">
        <n-space align="center" :size="20">
          <div class="stat">
            <div class="stat-label">本局得分</div>
            <div class="stat-value">{{ game.state.value.score }}</div>
          </div>
          <div class="stat">
            <div class="stat-label">
              最高分 · {{ SPEED_OPTIONS.find((o) => o.value === game.speed.value)?.label }}
            </div>
            <div class="stat-value best">{{ game.best.value }}</div>
          </div>
          <n-tag v-if="isNewRecord" type="error" size="small" :bordered="false">新纪录！</n-tag>
        </n-space>

        <n-space align="center" :size="12">
          <n-radio-group v-model:value="game.speed.value" size="small">
            <n-radio-button v-for="o in SPEED_OPTIONS" :key="o.value" :value="o.value">
              {{ o.label }}
            </n-radio-button>
          </n-radio-group>
          <n-button
            size="small"
            :disabled="!game.running.value || game.state.value.over"
            @click="game.togglePause()"
          >
            {{ game.paused.value ? '继续' : '暂停' }}
          </n-button>
          <n-button size="small" type="primary" @click="game.start()">重新开始</n-button>
        </n-space>
      </n-space>

      <div class="board-wrap" :style="{ width: boardPx + 'px' }">
        <canvas
          ref="canvasRef"
          class="board"
          :style="{ width: boardPx + 'px', height: boardPx + 'px' }"
        />
        <div v-if="overlay" class="overlay">
          <div class="overlay-title">{{ overlay.title }}</div>
          <div class="overlay-desc">{{ overlay.desc }}</div>
          <n-button type="primary" @click="onPrimaryAction">{{ overlay.action }}</n-button>
        </div>
      </div>

      <n-space vertical :size="6" align="center" style="margin-top: 16px">
        <div v-for="(row, ri) in padRows" :key="ri" class="pad-row">
          <template v-for="(d, ci) in row" :key="ci">
            <n-button
              v-if="d"
              class="pad-btn"
              size="small"
              :disabled="!game.running.value || game.paused.value"
              @click="game.turn(d)"
            >
              {{ PAD.find((p) => p.dir === d)?.label }}
            </n-button>
            <span v-else class="pad-btn pad-placeholder"></span>
          </template>
        </div>
        <n-text depth="3" style="font-size: 12px">
          方向键 / WASD 转向 · 空格 暂停或继续 · R 重开
        </n-text>
      </n-space>
    </n-card>
  </div>
</template>

<style scoped>
.stat-label {
  font-size: 12px;
  color: #64748b;
}
.stat-value {
  font-size: 26px;
  font-weight: 700;
  line-height: 1.25;
  color: #1e293b;
}
.stat-value.best {
  color: #6366f1;
}

.board-wrap {
  position: relative;
  margin: 0 auto;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  overflow: hidden;
}
.board {
  display: block;
}
.overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: rgba(248, 250, 252, 0.88);
  backdrop-filter: blur(2px);
}
.overlay-title {
  font-size: 20px;
  font-weight: 700;
  color: #1e293b;
}
.overlay-desc {
  font-size: 13px;
  color: #64748b;
}

.pad-row {
  display: flex;
  gap: 6px;
}
.pad-btn {
  width: 44px;
}
.pad-placeholder {
  display: inline-block;
}
</style>
