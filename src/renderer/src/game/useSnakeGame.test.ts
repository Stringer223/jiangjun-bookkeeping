// @vitest-environment jsdom
// useSnakeGame 依赖 window（rAF / 键盘 / localStorage）与 Vue 组件生命周期，
// 所以只有本文件切到 jsdom；vitest.config.ts 的全局 environment 保持 node，其他纯逻辑用例不受影响。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick } from 'vue'
import type { App } from 'vue'
import { BOARD_CELLS, SPEED_OPTIONS, useSnakeGame } from './useSnakeGame'
import type { SnakeGame, SpeedLevel } from './useSnakeGame'

// ---------- 假 rAF：把帧回调抓在手里，测试里手动按时间戳喂，不依赖真实计时器 ----------

const pending = new Map<number, FrameRequestCallback>()
let rafSeq = 0
let rafCalls = 0
let cancelCalls: number[] = []
let clock = 0

function installFakeRaf(): void {
  pending.clear()
  rafSeq = 0
  rafCalls = 0
  cancelCalls = []
  clock = 0

  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafSeq += 1
    rafCalls += 1
    pending.set(rafSeq, cb)
    return rafSeq
  })
  // 真实浏览器里被取消的回调不会再执行，这里也要同步删掉，
  // 否则「卸载后帧循环停止」的断言就成了假的
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    cancelCalls.push(id)
    pending.delete(id)
  })
}

/** 手动喂一帧：把当前挂起的回调以 clock + delta 的时间戳执行一次（frame 每次都会重新排下一帧） */
function tick(delta: number): void {
  clock += delta
  for (const [id, cb] of [...pending]) {
    pending.delete(id)
    cb(clock)
  }
}

// ---------- 挂载：用一个最小内联组件承载 onMounted / onBeforeUnmount，不引入 @vue/test-utils ----------

let app: App
let appMounted = false
let game!: SnakeGame

function mount(width = BOARD_CELLS, height = BOARD_CELLS): void {
  app = createApp(
    defineComponent({
      setup() {
        game = useSnakeGame(width, height)
        return () => h('div')
      }
    })
  )
  app.mount(document.createElement('div'))
  appMounted = true
}

/** 最高分是 setup 时读的，要验证存档必须「先写 localStorage 再挂载」 */
function remount(width = BOARD_CELLS, height = BOARD_CELLS): void {
  if (appMounted) app.unmount()
  appMounted = false
  mount(width, height)
}

// ---------- 键盘 ----------

function press(key: string, code = key): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true })
  window.dispatchEvent(e)
  return e
}

function pressSpace(): KeyboardEvent {
  return press(' ', 'Space')
}

// ---------- 常用局面 ----------

/** 中档 20×20：蛇头在 (10,10) 朝右，一路向右第 10 步撞墙 */
function playUntilOver(): void {
  game.start()
  tick(1000) // 首帧只对齐时间戳
  for (let i = 0; i < 40 && !game.state.value.over; i++) tick(130)
}

/** 小棋盘：蛇头在 (2,1) 朝右，配合 0.42 的随机数食物恰好落在正前方 (3,1) */
const SCORE_COLS = 5
const SCORE_ROWS = 3

/** 小棋盘上确定地吃一口（+1 分）再撞墙，用来验证结算与存档写入 */
function playSmallBoard(): void {
  game.start()
  tick(1000)
  for (let i = 0; i < 20 && !game.state.value.over; i++) tick(130)
}

beforeEach(() => {
  window.localStorage.clear()
  installFakeRaf()
  // 食物投放走 Math.random，固定成 0.42 后：
  //   20×20 棋盘（蛇在 (10,10) 朝右）食物落在 (6,8)，不在前进路线上，分数稳定为 0；
  //   5×3 小棋盘食物恰好落在蛇头正前方 (3,1)，可以确定地吃到一口。
  vi.spyOn(Math, 'random').mockReturnValue(0.42)
  mount()
})

afterEach(() => {
  if (appMounted) app.unmount()
  appMounted = false
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('开局 · 暂停 · 转向', () => {
  it('刚挂载时处于「未开局、未暂停」的初始局面', () => {
    expect(game.running.value).toBe(false)
    expect(game.paused.value).toBe(false)
    expect(game.state.value.over).toBe(false)
    expect(game.state.value.ticks).toBe(0)
    expect(game.state.value.snake).toHaveLength(3)
  })

  it('start 进入进行中，并把旧进度与暂停状态一并清掉', () => {
    game.start()
    expect(game.running.value).toBe(true)
    expect(game.paused.value).toBe(false)

    // 先弄脏局面：走一步再暂停
    tick(1000)
    tick(130)
    game.togglePause()
    expect(game.state.value.ticks).toBe(1)
    expect(game.paused.value).toBe(true)

    game.start()
    expect(game.state.value.ticks).toBe(0)
    expect(game.state.value.score).toBe(0)
    expect(game.state.value.over).toBe(false)
    expect(game.paused.value).toBe(false)
  })

  it('未开局时 togglePause 完全无效', () => {
    // 待机画面点「暂停」不该把 paused 置真，否则开局后会被误判为暂停
    game.togglePause()
    expect(game.paused.value).toBe(false)
    game.togglePause()
    expect(game.paused.value).toBe(false)
  })

  it('进行中可以暂停、再按一次继续', () => {
    game.start()
    game.togglePause()
    expect(game.paused.value).toBe(true)
    game.togglePause()
    expect(game.paused.value).toBe(false)
  })

  it('已结束时 togglePause 无效', () => {
    playUntilOver()
    expect(game.state.value.over).toBe(true)
    game.togglePause()
    expect(game.paused.value).toBe(false)
  })

  it('未开局时 turn 无效', () => {
    game.turn('up')
    expect(game.state.value.nextDir).toBeNull()
  })

  it('暂停时 turn 无效', () => {
    game.start()
    game.togglePause()
    game.turn('up')
    expect(game.state.value.nextDir).toBeNull()
  })

  it('进行中 turn 记入缓冲，下一 tick 才生效', () => {
    game.start()
    game.turn('up')
    expect(game.state.value.nextDir).toBe('up')
    expect(game.state.value.snake[0]).toEqual({ x: 10, y: 10 })

    tick(1000) // 首帧只对齐
    tick(130)
    expect(game.state.value.snake[0]).toEqual({ x: 10, y: 9 })
  })
})

describe('难度与推进间隔', () => {
  it('intervalMs 随难度变化：慢 200 / 中 130 / 快 80', async () => {
    const expected: Array<[SpeedLevel, number]> = [
      ['slow', 200],
      ['medium', 130],
      ['fast', 80]
    ]
    for (const [level, ms] of expected) {
      game.speed.value = level
      await nextTick() // watch 是 pre 刷新，要等一次微任务
      expect(game.intervalMs.value).toBe(ms)
    }

    // 顺带钉住 UI 用的档位表，改错数值要立刻发现
    expect(SPEED_OPTIONS.map((o) => o.value)).toEqual(['slow', 'medium', 'fast'])
    expect(SPEED_OPTIONS.map((o) => o.interval)).toEqual([200, 130, 80])
    expect(SPEED_OPTIONS.map((o) => o.label)).toEqual(['慢', '中', '快'])
  })

  it('speed 被塞进非法值时 intervalMs 回落到 130', async () => {
    // computed 里的 `?? 130` 是给这条路径留的兜底，不该变成 NaN 或 undefined
    game.speed.value = 'nightmare' as SpeedLevel
    await nextTick()
    expect(game.intervalMs.value).toBe(130)
  })

  it('切换难度会重置局面并清掉暂停 —— 防止先把记录带到另一档', async () => {
    game.start()
    tick(1000)
    tick(130)
    game.togglePause()
    expect(game.state.value.ticks).toBe(1)
    expect(game.paused.value).toBe(true)

    game.speed.value = 'fast'
    await nextTick()
    expect(game.state.value.ticks).toBe(0)
    expect(game.state.value.score).toBe(0)
    expect(game.state.value.over).toBe(false)
    expect(game.paused.value).toBe(false)
    // 换档不改变「是否在进行中」：原本开着的局仍然是开着的
    expect(game.running.value).toBe(true)
  })

  it('未开局时切换难度只重置棋盘，不会自动开局', async () => {
    game.speed.value = 'slow'
    await nextTick()
    expect(game.running.value).toBe(false)
    expect(game.state.value.ticks).toBe(0)
    expect(game.paused.value).toBe(false)
  })
})

describe('最高分存档', () => {
  it('最高分按难度分别记录，互不干扰', async () => {
    window.localStorage.setItem('jj-snake-best:slow', '7')
    window.localStorage.setItem('jj-snake-best:fast', '3')
    remount()

    expect(game.best.value).toBe(0) // 默认「中」档没有存档
    game.speed.value = 'slow'
    await nextTick()
    expect(game.best.value).toBe(7)
    game.speed.value = 'fast'
    await nextTick()
    expect(game.best.value).toBe(3)
  })

  it('存档是脏数据（非数字 / 负数 / null / 空串）时一律回落到 0', async () => {
    const dirty: Array<[SpeedLevel, string]> = [
      ['slow', 'abc'],
      ['medium', '-5'],
      ['fast', 'null']
    ]
    for (const [level, raw] of dirty) {
      window.localStorage.setItem('jj-snake-best:' + level, raw)
    }
    remount()

    for (const [level] of dirty) {
      game.speed.value = level
      await nextTick()
      expect(game.best.value).toBe(0)
    }

    window.localStorage.setItem('jj-snake-best:medium', '')
    remount()
    expect(game.best.value).toBe(0)
  })

  it('存档是小数时向下取整', async () => {
    window.localStorage.setItem('jj-snake-best:medium', '12.9')
    remount()
    expect(game.best.value).toBe(12)
  })

  it('结束时分数超过当前难度最高分才写入 localStorage', () => {
    remount(SCORE_COLS, SCORE_ROWS)
    playSmallBoard()

    expect(game.state.value.over).toBe(true)
    expect(game.state.value.reason).toBe('wall')
    expect(game.state.value.score).toBe(1)
    expect(game.best.value).toBe(1)
    expect(window.localStorage.getItem('jj-snake-best:medium')).toBe('1')
    // 其他难度不该被顺手写脏
    expect(window.localStorage.getItem('jj-snake-best:slow')).toBeNull()
    expect(window.localStorage.getItem('jj-snake-best:fast')).toBeNull()
  })

  it('分数没超过旧记录时不覆盖存档', () => {
    window.localStorage.setItem('jj-snake-best:medium', '9')
    remount(SCORE_COLS, SCORE_ROWS)
    playSmallBoard()

    expect(game.state.value.score).toBe(1)
    expect(game.best.value).toBe(9)
    expect(window.localStorage.getItem('jj-snake-best:medium')).toBe('9')
  })

  it('localStorage 读取抛错时回落到 0，不崩溃', () => {
    // Electron 里 localStorage 可能因磁盘/隐私设置直接抛错，readBest 的 try/catch 就是为这条路径写的
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('boom')
    })
    expect(() => remount()).not.toThrow()
    expect(game.best.value).toBe(0)
  })

  it('localStorage 写入抛错时不影响结算，内存里的最高分照样刷新', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    remount(SCORE_COLS, SCORE_ROWS)

    expect(() => playSmallBoard()).not.toThrow()
    expect(game.state.value.over).toBe(true)
    expect(game.state.value.score).toBe(1)
    expect(game.best.value).toBe(1)
  })
})

describe('帧循环', () => {
  it('挂载后立刻排一帧，并且每帧都会重新排下一帧', () => {
    // 少了 frame() 里那句重新排帧，游戏跑一格就停了
    expect(rafCalls).toBe(1)
    tick(1000)
    expect(rafCalls).toBe(2)
    tick(130)
    expect(rafCalls).toBe(3)
  })

  it('首帧只对齐时间戳，不推进', () => {
    // 若不特殊处理，lastTs 从 0 起步会把「页面存在以来的毫秒数」当成累积时间，一开局就连走好几步
    game.start()
    tick(5000)
    expect(game.state.value.ticks).toBe(0)

    tick(130)
    expect(game.state.value.ticks).toBe(1)
  })

  it('累积时间不足一个间隔时不推进，刚好够了才走一步', () => {
    game.start()
    tick(1000)
    tick(129)
    expect(game.state.value.ticks).toBe(0)
    tick(1)
    expect(game.state.value.ticks).toBe(1)
  })

  it('250ms 在 130ms 档只走 1 步：按累积量消费，不往上凑整', () => {
    game.start()
    tick(1000)
    tick(250)
    expect(game.state.value.ticks).toBe(1)
  })

  it('未开局时喂再多时间也不推进', () => {
    tick(1000)
    tick(10000)
    expect(game.state.value.ticks).toBe(0)
    expect(game.state.value.over).toBe(false)
  })

  it('暂停时喂时间不推进，恢复后接着走且不会补跳', () => {
    game.start()
    tick(1000)
    tick(130)
    expect(game.state.value.ticks).toBe(1)

    game.togglePause()
    tick(10000)
    expect(game.state.value.ticks).toBe(1)

    game.togglePause()
    tick(130)
    expect(game.state.value.ticks).toBe(2)
  })

  it('MAX_FRAME_DELTA 钳制：慢档一次喂 10000ms 只推进 1 步', () => {
    // 模拟切到后台再回来。没有 250ms 钳制的话，这一帧会一口气补算到 5 步（撞墙都不够用）
    game.speed.value = 'slow'
    game.start()
    tick(1000)
    tick(10000)
    expect(game.state.value.ticks).toBe(1)
  })

  it('快档一次喂 10000ms 也只推进 3 步（钳制 + 单帧上限 5 步）', () => {
    game.speed.value = 'fast'
    game.start()
    tick(1000)
    tick(10000)
    // 250ms / 80ms = 3 步；若钳制失效，这里会顶着 5 步上限走满
    expect(game.state.value.ticks).toBe(3)
  })

  it('撞墙后：running 停掉、ticks 固定，再喂时间也不推进', () => {
    playUntilOver()
    expect(game.state.value.over).toBe(true)
    expect(game.state.value.reason).toBe('wall')
    expect(game.state.value.ticks).toBe(10)
    expect(game.running.value).toBe(false)

    tick(10000)
    expect(game.state.value.ticks).toBe(10)
    expect(game.state.value.over).toBe(true)
  })

  it('结束后按空格直接开新局（running 已停，走「未开局」分支）', () => {
    playUntilOver()
    expect(game.running.value).toBe(false)

    pressSpace()
    expect(game.running.value).toBe(true)
    expect(game.state.value.over).toBe(false)
    expect(game.state.value.ticks).toBe(0)
  })
})

describe('键盘', () => {
  it('方向键与 wasd（含大写）都能转向', () => {
    const cases: Array<[string, { x: number; y: number }]> = [
      ['ArrowUp', { x: 10, y: 9 }],
      ['ArrowDown', { x: 10, y: 11 }],
      ['w', { x: 10, y: 9 }],
      ['W', { x: 10, y: 9 }], // 大写锁定下也要能玩
      ['s', { x: 10, y: 11 }]
    ]
    for (const [key, head] of cases) {
      game.start()
      tick(1000)
      press(key)
      tick(130)
      expect(game.state.value.snake[0]).toEqual(head)
    }
  })

  it('未开局时空格开新局', () => {
    expect(game.running.value).toBe(false)
    pressSpace()
    expect(game.running.value).toBe(true)
    expect(game.paused.value).toBe(false)
    expect(game.state.value.ticks).toBe(0)
  })

  it('已开局时空格暂停 / 继续', () => {
    game.start()
    pressSpace()
    expect(game.paused.value).toBe(true)
    pressSpace()
    expect(game.paused.value).toBe(false)
  })

  it('r 键重开一局，清掉进度与暂停', () => {
    game.start()
    tick(1000)
    tick(130)
    pressSpace() // 暂停
    expect(game.paused.value).toBe(true)

    press('r')
    expect(game.running.value).toBe(true)
    expect(game.paused.value).toBe(false)
    expect(game.state.value.ticks).toBe(0)
  })

  it('方向键 / 空格 / r 都会 preventDefault，避免页面滚动或被浏览器截走', () => {
    expect(press('ArrowUp').defaultPrevented).toBe(true)
    expect(press('ArrowDown').defaultPrevented).toBe(true)
    expect(pressSpace().defaultPrevented).toBe(true)
    expect(press('r').defaultPrevented).toBe(true)
    // 无关按键不能乱拦
    expect(press('q').defaultPrevented).toBe(false)
  })

  it('无关按键不改变局面', () => {
    game.start()
    tick(1000)
    press('q')
    press('Enter')
    expect(game.state.value.nextDir).toBeNull()
    expect(game.state.value.ticks).toBe(0)
  })
})

describe('卸载清理', () => {
  it('卸载后按方向键不再改变局面（keydown 监听已移除）', () => {
    game.start()
    tick(1000)
    app.unmount()
    appMounted = false

    press('ArrowUp')
    expect(game.state.value.nextDir).toBeNull()
  })

  it('卸载时取消 rAF，帧循环不再空转', () => {
    game.start()
    tick(1000)
    tick(130)
    expect(game.state.value.ticks).toBe(1)

    const lastFrameId = rafSeq
    app.unmount()
    appMounted = false

    expect(cancelCalls).toEqual([lastFrameId])
    expect(pending.size).toBe(0)
    // 没有挂起的帧了，再喂时间也不可能推进
    tick(10000)
    expect(game.state.value.ticks).toBe(1)
  })
})
