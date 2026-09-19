import { describe, expect, it } from 'vitest'
import {
  createInitialState,
  DIR_VECTORS,
  isOpposite,
  requestTurn,
  samePoint,
  spawnFood,
  step
} from './logic'
import type { GameState, Point } from './logic'

/** 固定返回 0 的随机源：spawnFood 会取空格列表的第一个 */
const rngZero = () => 0

/** 造一个可控的初始状态，只写关心的字段，其余用默认值 */
function makeState(over: Partial<GameState> = {}): GameState {
  return {
    snake: [
      { x: 5, y: 5 },
      { x: 4, y: 5 },
      { x: 3, y: 5 }
    ],
    food: { x: 9, y: 9 },
    dir: 'right',
    nextDir: null,
    score: 0,
    over: false,
    reason: null,
    ticks: 0,
    ...over
  }
}

describe('方向与坐标', () => {
  it('isOpposite 只对 180° 反向成立', () => {
    expect(isOpposite('up', 'down')).toBe(true)
    expect(isOpposite('right', 'left')).toBe(true)
    expect(isOpposite('up', 'up')).toBe(false)
    expect(isOpposite('up', 'left')).toBe(false)
  })

  it('DIR_VECTORS 四向向量正确（y 轴向下为正）', () => {
    expect(DIR_VECTORS.up).toEqual({ x: 0, y: -1 })
    expect(DIR_VECTORS.down).toEqual({ x: 0, y: 1 })
    expect(DIR_VECTORS.left).toEqual({ x: -1, y: 0 })
    expect(DIR_VECTORS.right).toEqual({ x: 1, y: 0 })
  })

  it('samePoint 按坐标值比较，不看引用', () => {
    expect(samePoint({ x: 1, y: 2 }, { x: 1, y: 2 })).toBe(true)
    expect(samePoint({ x: 1, y: 2 }, { x: 2, y: 1 })).toBe(false)
  })
})

describe('初始状态 createInitialState', () => {
  it('蛇长 3、朝右、分数 0、未结束', () => {
    const s = createInitialState(20, 12, rngZero)
    expect(s.snake).toHaveLength(3)
    expect(s.dir).toBe('right')
    expect(s.score).toBe(0)
    expect(s.over).toBe(false)
    expect(s.ticks).toBe(0)
  })

  it('蛇头在正中一行，蛇身向左延伸', () => {
    const s = createInitialState(20, 12, rngZero)
    expect(s.snake[0]).toEqual({ x: 10, y: 6 })
    expect(s.snake[1]).toEqual({ x: 9, y: 6 })
  })

  it('初始食物不会落在蛇身上', () => {
    const s = createInitialState(20, 12, rngZero)
    expect(s.snake.some((p) => samePoint(p, s.food))).toBe(false)
  })

  it('棋盘小到放不下蛇身也不抛错', () => {
    expect(() => createInitialState(2, 2, rngZero)).not.toThrow()
  })
})

describe('投放食物 spawnFood', () => {
  it('不会投在蛇身上', () => {
    const snake: Point[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 }
    ]
    const f = spawnFood(snake, 4, 4, rngZero)
    expect(f).not.toBeNull()
    expect(snake.some((p) => samePoint(p, f!))).toBe(false)
  })

  it('随机数取到上界时下标也不越界', () => {
    // rng() 理论上可返回接近 1 的值，下标必须被钳制在 [0, free.length-1]，
    // 否则会取到 undefined 而让食物"消失"
    for (const r of [0, 0.5, 0.9999999999, 1]) {
      const f = spawnFood([], 4, 4, () => r)
      expect(f).not.toBeUndefined()
      expect(f!.x).toBeGreaterThanOrEqual(0)
      expect(f!.x).toBeLessThan(4)
      expect(f!.y).toBeGreaterThanOrEqual(0)
      expect(f!.y).toBeLessThan(4)
    }
  })

  it('棋盘被蛇占满时返回 null（代表通关）', () => {
    const full: Point[] = []
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) full.push({ x, y })
    expect(spawnFood(full, 2, 2, rngZero)).toBeNull()
  })
})

describe('转向 requestTurn', () => {
  it('接受垂直方向的转向，记入 nextDir', () => {
    expect(requestTurn(makeState(), 'up').nextDir).toBe('up')
  })

  it('忽略与当前方向相同的输入', () => {
    expect(requestTurn(makeState(), 'right').nextDir).toBeNull()
  })

  it('忽略 180° 掉头（允许的话等于操作即自杀）', () => {
    expect(requestTurn(makeState(), 'left').nextDir).toBeNull()
  })

  it('游戏已结束时原样返回，不接受输入', () => {
    const over = makeState({ over: true, reason: 'wall' })
    expect(requestTurn(over, 'up')).toBe(over)
  })

  it('缓冲只保留一格：连按两个方向以最后一个未被拒绝的为准', () => {
    const s = requestTurn(requestTurn(makeState(), 'up'), 'down')
    expect(s.nextDir).toBe('down')
  })
})

describe('推进一 tick（step）', () => {
  it('没吃到食物时整体前移，蛇长不变', () => {
    const s = step(makeState(), 20, 20, rngZero)
    expect(s.snake[0]).toEqual({ x: 6, y: 5 })
    expect(s.snake).toHaveLength(3)
    expect(s.score).toBe(0)
    expect(s.ticks).toBe(1)
  })

  it('吃到食物时蛇变长、分数 +1', () => {
    const s = step(makeState({ food: { x: 6, y: 5 } }), 20, 20, rngZero)
    expect(s.score).toBe(1)
    expect(s.snake).toHaveLength(4)
    expect(s.snake[0]).toEqual({ x: 6, y: 5 })
  })

  it('吃到食物后新投放的食物不会落在蛇身上', () => {
    const s = step(makeState({ food: { x: 6, y: 5 } }), 20, 20, rngZero)
    expect(s.snake.some((p) => samePoint(p, s.food))).toBe(false)
  })

  it('nextDir 生效后清空，且方向改变', () => {
    const s = step(makeState({ nextDir: 'up' }), 20, 20, rngZero)
    expect(s.dir).toBe('up')
    expect(s.nextDir).toBeNull()
    expect(s.snake[0]).toEqual({ x: 5, y: 4 })
  })

  it('撞墙时结束，原因为 wall', () => {
    const s = step(makeState({ snake: [{ x: 19, y: 5 }], dir: 'right' }), 20, 20, rngZero)
    expect(s.over).toBe(true)
    expect(s.reason).toBe('wall')
  })

  it('撞到自己身体时结束，原因为 self', () => {
    const s = step(
      makeState({
        snake: [
          { x: 5, y: 5 },
          { x: 5, y: 4 },
          { x: 5, y: 3 },
          { x: 5, y: 2 }
        ],
        dir: 'up'
      }),
      20,
      20,
      rngZero
    )
    expect(s.over).toBe(true)
    expect(s.reason).toBe('self')
  })

  it('没吃到食物时，头可以走进尾巴腾出的那一格', () => {
    // 蛇绕成 2x2，头朝右，正前方恰好是尾巴所在格。
    // 因为尾巴同时在移开，这一步不算撞自己 —— 这是最容易写错的分支。
    const s = step(
      makeState({
        snake: [
          { x: 0, y: 0 },
          { x: 0, y: 1 },
          { x: 1, y: 1 },
          { x: 1, y: 0 }
        ],
        dir: 'right'
      }),
      20,
      20,
      rngZero
    )
    expect(s.over).toBe(false)
    expect(s.snake[0]).toEqual({ x: 1, y: 0 })
    expect(s.snake).toHaveLength(4)
  })

  it('但吃到食物时尾巴不缩，同样的走法就算撞自己', () => {
    // 与上一条对照：食物恰好在尾巴那一格，尾巴这一 tick 不会移开，于是撞上
    const s = step(
      makeState({
        snake: [
          { x: 0, y: 0 },
          { x: 0, y: 1 },
          { x: 1, y: 1 },
          { x: 1, y: 0 }
        ],
        dir: 'right',
        food: { x: 1, y: 0 }
      }),
      20,
      20,
      rngZero
    )
    expect(s.over).toBe(true)
    expect(s.reason).toBe('self')
  })

  it('蛇占满棋盘时吃到最后一个食物判为通关', () => {
    const s = step(
      makeState({ snake: [{ x: 0, y: 0 }], dir: 'right', food: { x: 1, y: 0 } }),
      2,
      1,
      rngZero
    )
    expect(s.over).toBe(true)
    expect(s.reason).toBe('win')
  })

  it('已结束的状态再 step 不会变化', () => {
    const over = makeState({ over: true, reason: 'wall' })
    expect(step(over, 20, 20, rngZero)).toBe(over)
  })

  it('不修改传入的 state（纯函数）', () => {
    const state = makeState()
    const before = JSON.stringify(state)
    step(state, 20, 20, rngZero)
    expect(JSON.stringify(state)).toBe(before)
  })
})
