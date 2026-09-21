// 贪吃蛇 —— 组合式封装
// 职责：把纯逻辑（logic.ts）接到「帧循环 / 键盘输入 / 暂停 / 计时 / 存档」上。
// 不含任何绘制代码 —— 画面由 GameView.vue 通过 Canvas 负责，两层互不依赖。

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import {
  createInitialState,
  requestTurn,
  step,
  type Direction,
  type GameState
} from './logic'

/** 难度档位 */
export type SpeedLevel = 'slow' | 'medium' | 'fast'

export interface SpeedOption {
  label: string
  value: SpeedLevel
  /** 每格的推进间隔（毫秒），越小越快 */
  interval: number
}

/** 三档速度：默认「中」 */
export const SPEED_OPTIONS: SpeedOption[] = [
  { label: '慢', value: 'slow', interval: 200 },
  { label: '中', value: 'medium', interval: 130 },
  { label: '快', value: 'fast', interval: 80 }
]

/** 兜底难度档：speed 在运行期被塞进非法值时用它的间隔 */
const FALLBACK_SPEED: SpeedLevel = 'medium'

/**
 * 难度 -> 每格间隔的查表，从 SPEED_OPTIONS 派生。
 *
 * 不另写一份数字：旧实现把「中」档的 130 在 intervalMs 的兜底分支里又抄了一遍，
 * 改 SPEED_OPTIONS 时极易漏掉那一处，兜底值就会与「中」档悄悄不一致。
 */
const INTERVAL_BY_SPEED = SPEED_OPTIONS.reduce((acc, o) => {
  acc[o.value] = o.interval
  return acc
}, {} as Record<SpeedLevel, number>)

/** 棋盘格数（正方形） */
export const BOARD_CELLS = 20

/** 单格逻辑像素，实际绘制时按 devicePixelRatio 放大 */
export const CELL_PX = 24

/** 单帧内最多补算的步数 */
const MAX_STEPS_PER_FRAME = 5

/** 单帧最多计入的时长（毫秒）—— 切到后台再回来时不会一次性连跳几十步 */
const MAX_FRAME_DELTA = 250

/**
 * 最高分存档：按难度分别记录。
 * 存在 localStorage（落在 Electron 的 userData 目录，与记账的 data.json 平级但互不干扰）——
 * 刻意不走主进程 IPC，这样游戏功能被移除时，主进程与数据层不需要任何回滚。
 */
const BEST_KEY_PREFIX = 'jj-snake-best:'

function readBest(level: SpeedLevel): number {
  try {
    const raw = window.localStorage.getItem(BEST_KEY_PREFIX + level)
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  } catch {
    return 0
  }
}

function writeBest(level: SpeedLevel, score: number): void {
  try {
    window.localStorage.setItem(BEST_KEY_PREFIX + level, String(score))
  } catch {
    // 存档失败不影响游戏本身
  }
}

/** 键盘映射（统一转小写后查表，兼容大小写与大小写锁定） */
const KEY_DIRECTIONS: Record<string, Direction> = {
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  w: 'up',
  s: 'down',
  a: 'left',
  d: 'right'
}

export interface SnakeGame {
  /** 当前局面 */
  state: Ref<GameState>
  /** 难度 */
  speed: Ref<SpeedLevel>
  /** 当前难度对应的最高分 */
  best: ComputedRef<number>
  /** 是否处于进行中（含暂停） */
  running: Ref<boolean>
  /** 是否暂停 */
  paused: Ref<boolean>
  /** 当前难度每格间隔（毫秒），供 UI 展示 */
  intervalMs: ComputedRef<number>
  /** 开新一局（也会把暂停状态清掉） */
  start: () => void
  /** 暂停 / 继续 */
  togglePause: () => void
  /** 转向请求（键盘与屏幕方向键共用） */
  turn: (dir: Direction) => void
}

/**
 * @param width  棋盘列数
 * @param height 棋盘行数
 */
export function useSnakeGame(width = BOARD_CELLS, height = BOARD_CELLS): SnakeGame {
  const speed = ref<SpeedLevel>('medium')
  const state = ref<GameState>(createInitialState(width, height))
  const running = ref(false)
  const paused = ref(false)
  const bestMap = ref<Record<SpeedLevel, number>>({
    slow: readBest('slow'),
    medium: readBest('medium'),
    fast: readBest('fast')
  })

  const best = computed(() => bestMap.value[speed.value])
  const intervalMs = computed(
    () => INTERVAL_BY_SPEED[speed.value] ?? INTERVAL_BY_SPEED[FALLBACK_SPEED]
  )

  // ---- 帧循环 ----
  let rafId = 0
  let lastTs = 0
  /** 累积的、尚未消费为一步的时间 */
  let acc = 0

  function frame(ts: number): void {
    rafId = window.requestAnimationFrame(frame)

    // 未开局 / 暂停 / 已结束：只对齐时间戳，不推进
    if (!running.value || paused.value || state.value.over) {
      lastTs = ts
      return
    }
    if (lastTs === 0) {
      lastTs = ts
      return
    }

    const interval = intervalMs.value
    acc += Math.min(ts - lastTs, MAX_FRAME_DELTA)
    lastTs = ts

    let guard = 0
    while (acc >= interval && guard < MAX_STEPS_PER_FRAME) {
      acc -= interval
      guard++
      const next = step(state.value, width, height)
      state.value = next
      if (next.over) return settle(next)
    }
    // 异常累积（如长时间卡顿）直接丢弃余量，避免下一帧连续追帧
    if (acc >= interval * MAX_STEPS_PER_FRAME) acc = 0
  }

  /** 结算：停表 + 刷新最高分 */
  function settle(finalState: GameState): void {
    acc = 0
    running.value = false
    if (finalState.score > bestMap.value[speed.value]) {
      bestMap.value = { ...bestMap.value, [speed.value]: finalState.score }
      writeBest(speed.value, finalState.score)
    }
  }

  function start(): void {
    state.value = createInitialState(width, height)
    running.value = true
    paused.value = false
    acc = 0
    lastTs = 0
  }

  function togglePause(): void {
    if (!running.value || state.value.over) return
    paused.value = !paused.value
  }

  function turn(dir: Direction): void {
    if (!running.value || paused.value) return
    state.value = requestTurn(state.value, dir)
  }

  // 换难度：重开一局（避免先在「慢」刷高分再切到「快」把记录带过去）。
  // 未开局时只把棋盘重置回初始态，不自动开始。
  watch(speed, () => {
    acc = 0
    lastTs = 0
    state.value = createInitialState(width, height)
    paused.value = false
  })

  // ---- 键盘 ----
  function onKeydown(e: KeyboardEvent): void {
    if (e.code === 'Space') {
      e.preventDefault()
      if (!running.value) start()
      else togglePause()
      return
    }

    const key = e.key.toLowerCase()
    if (key === 'r') {
      e.preventDefault()
      start()
      return
    }

    const dir = KEY_DIRECTIONS[key]
    if (dir) {
      // 方向键默认会滚动页面，必须拦掉
      e.preventDefault()
      turn(dir)
    }
  }

  onMounted(() => {
    window.addEventListener('keydown', onKeydown)
    rafId = window.requestAnimationFrame(frame)
  })

  // 页面切走时必须清理，否则 rAF 与键盘监听会一直挂在后台
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown)
    if (rafId) window.cancelAnimationFrame(rafId)
    rafId = 0
  })

  return { state, speed, best, running, paused, intervalMs, start, togglePause, turn }
}
