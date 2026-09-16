// 贪吃蛇 —— 纯逻辑层
// 设计约束：本文件不依赖 Vue、不依赖 DOM、不依赖任何浏览器 API（随机源可注入）。
// 因此它是可单测的纯函数集合：给定状态 + 输入，必然得到确定的新状态。

/** 四向 */
export type Direction = 'up' | 'down' | 'left' | 'right'

/** 棋盘坐标（左上角为 0,0） */
export interface Point {
  x: number
  y: number
}

/** 游戏结束原因：撞墙 / 撞自己 / 填满棋盘（通关） */
export type OverReason = 'wall' | 'self' | 'win'

/** 一局游戏的完整状态（不可变，每次变更返回新对象） */
export interface GameState {
  /** 蛇身坐标，索引 0 恒为蛇头 */
  snake: Point[]
  /** 食物坐标 */
  food: Point
  /** 当前生效方向 */
  dir: Direction
  /** 已在等待被消费的转向（输入缓冲），每个 tick 最多消费一次 */
  nextDir: Direction | null
  /** 吃到的食物数量（= 分数） */
  score: number
  /** 是否已结束 */
  over: boolean
  /** 结束原因，仅在 over === true 时有值 */
  reason: OverReason | null
  /** 已推进的步数 */
  ticks: number
}

/** 随机数源，便于测试时注入确定性随机 */
export type Rng = () => number

export const DIR_VECTORS: Record<Direction, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 }
}

const OPPOSITE: Record<Direction, Direction> = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left'
}

export function isOpposite(a: Direction, b: Direction): boolean {
  return OPPOSITE[a] === b
}

export function samePoint(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y
}

function cellKey(x: number, y: number): string {
  return `${x},${y}`
}

/** 初始蛇长 */
const INITIAL_LENGTH = 3

/**
 * 生成初始状态：蛇横置于棋盘正中一行、朝右，长度 INITIAL_LENGTH。
 * 若棋盘太小放不下，仍返回最短可用状态（不抛错，交给上层做尺寸校验）。
 */
export function createInitialState(
  width: number,
  height: number,
  rng: Rng = Math.random
): GameState {
  const cy = Math.floor(height / 2)
  const headX = Math.min(Math.floor(width / 2), Math.max(0, width - 1))
  const snake: Point[] = []
  for (let i = 0; i < INITIAL_LENGTH; i++) {
    snake.push({ x: Math.max(0, headX - i), y: cy })
  }
  const base: GameState = {
    snake,
    food: { x: 0, y: 0 },
    dir: 'right',
    nextDir: null,
    score: 0,
    over: false,
    reason: null,
    ticks: 0
  }
  const food = spawnFood(snake, width, height, rng)
  // 理论上只有棋盘被塞满才为 null，此处退化时把食物放角落
  return { ...base, food: food ?? { x: 0, y: 0 } }
}

/**
 * 在所有空格中均匀随机投放一个食物。
 * @returns 空格坐标；棋盘已无空位（蛇占满）时返回 null，表示通关。
 */
export function spawnFood(
  snake: Point[],
  width: number,
  height: number,
  rng: Rng = Math.random
): Point | null {
  const occupied = new Set(snake.map((p) => cellKey(p.x, p.y)))
  const free: Point[] = []
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!occupied.has(cellKey(x, y))) free.push({ x, y })
    }
  }
  if (free.length === 0) return null
  const idx = Math.min(free.length - 1, Math.floor(rng() * free.length))
  return free[idx]
}

/**
 * 请求转向（来自键盘输入）。
 *
 * 规则：
 * - 与当前方向相同 → 忽略；
 * - 与当前方向相反（180° 掉头）→ 忽略。这一步是必须的：蛇头在单个 tick 内只前进一格，
 *   若允许掉头，新蛇头坐标必然落在自己第二节身上，等于"操作即自杀"；
 * - 其余方向记入 nextDir 缓冲，在下一个 tick 生效。
 *
 * 注意：缓冲只保留一格，同一 tick 内连按多个方向时以第一个不被拒绝的为准。
 * 这是刻意的取舍 —— 若要支持"一个 tick 内连转两次"需要队列，但经典玩法并不需要。
 */
export function requestTurn(state: GameState, dir: Direction): GameState {
  if (state.over) return state
  if (dir === state.dir) return state
  if (isOpposite(dir, state.dir)) return state
  return { ...state, nextDir: dir }
}

/**
 * 推进一 tick。纯函数：不修改传入的 state。
 */
export function step(
  state: GameState,
  width: number,
  height: number,
  rng: Rng = Math.random
): GameState {
  if (state.over) return state

  const dir = state.nextDir ?? state.dir
  const vec = DIR_VECTORS[dir]
  const head = state.snake[0]
  const head0: Point = head ?? { x: 0, y: 0 }
  const next: Point = { x: head0.x + vec.x, y: head0.y + vec.y }
  const ticks = state.ticks + 1

  // 撞墙（不穿墙）
  if (next.x < 0 || next.y < 0 || next.x >= width || next.y >= height) {
    return { ...state, dir, nextDir: null, over: true, reason: 'wall', ticks }
  }

  const ate = samePoint(next, state.food)
  // 撞自己判定：未吃到食物时，尾巴会同时移开，所以最后一节不算障碍
  const body = ate ? state.snake : state.snake.slice(0, -1)
  if (body.some((p) => samePoint(p, next))) {
    return { ...state, dir, nextDir: null, over: true, reason: 'self', ticks }
  }

  const snake = [next, ...bodyWithoutTail(state.snake, ate)]
  const score = ate ? state.score + 1 : state.score

  if (!ate) {
    return { ...state, snake, dir, nextDir: null, score, ticks }
  }

  // 吃到食物：重新投放；若已无空位，说明蛇占满棋盘 = 通关
  const food = spawnFood(snake, width, height, rng)
  if (!food) {
    return { ...state, snake, dir, nextDir: null, score, over: true, reason: 'win', ticks }
  }
  return { ...state, snake, food, dir, nextDir: null, score, ticks }
}

/** 吃到食物时保留整条蛇身，否则去掉尾巴 */
function bodyWithoutTail(snake: Point[], ate: boolean): Point[] {
  return ate ? snake : snake.slice(0, -1)
}
