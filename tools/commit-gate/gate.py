"""提交门禁（commit gate）判定核心。

两个子命令，对应一轮检查的首尾两端：

  begin   检查**开始前**调用：断言索引干净、记下这一轮的内容指纹，
          并清掉上一轮的标记文件（防止旧标记被当成新结果）。
  check   检查**结束前**调用：复算指纹确认期间没人动过代码，校验三个维度的
          结果，全过才签发通行证。
  revoke  作废通行证（推送成功后调用）。

为什么这么写（这几条是设计决定，不是实现细节）：

- **指纹用 `git write-tree` 的 tree SHA。** `git commit` 提交的就是这个 tree，
  所以指纹与「即将提交的内容」精确等价。用时间戳或文件 mtime 都做不到这一点 ——
  它们只能证明"多久以前检查过"，不能证明"检查的是不是这一份"。
  实测确认过：它对 `-a` / `--amend` / 「检查后改了工作区但没 add」全部安全，
  因为这些形态要么改不动索引，要么改了索引就必然导致指纹不匹配。
- **check 里同时断言工作区等于暂存区、且未跟踪文件没变多。**
  只看 tree 会漏掉一种情况：有人改了工作区文件但没 `git add`，此时 tree 不变、
  而测试跑的却是新代码，结果与提交内容不对应。
- **退出码 1 和 2 严格分开。** 1 是「检查不通过，你去改代码」，2 是「脚本自己出错，
  该我修脚本」。混在一起会让人误判成检查失败，跑去改本来没问题的业务代码。
- **通行证有两个作废机制，不能只留一个。** 主动作废是 `revoke`（推送成功后由
  gitcommit-agent 调用）；兜底是另写一个 `PASS.head`，让 pre-commit 钩子比对当前
  HEAD —— 提交一发生 HEAD 就前移，旧通行证自动失效。只留前者的话，手动提交时
  没人清通行证，同一张通行证就能被用第二次。
- **不依赖 cwd。** 阶段 0 探针已证实子进程环境里的 cwd 不可靠。所有路径都从
  --project 推导成绝对路径，而 --project 是必填的。
- **判官脚本与运行时产物物理分离。** 脚本在 `tools/commit-gate/`（进版本库），
  产物在 `.workbuddy/commit-gate/run/`（gitignore）。这样 clear 操作不可能删到脚本自己，
  而且脚本本身有版本控制、丢了能找回。

除 `git write-tree` 会往 ODB 写 tree 对象外，本脚本不修改仓库内容。
纯标准库；不发网络请求；不修改任何业务代码。
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path

# 写进各个 json 的版本号。将来改了字段含义就加一，便于识别旧文件。
SCHEMA_VERSION = 1

# 判官脚本的位置（相对仓库根）。它的存在与否用来判断「这是不是受管仓库」——
# pre-commit 钩子也读同一个路径做自我禁用。
GATE_SCRIPT_REL = Path("tools") / "commit-gate" / "gate.py"

# 一轮检查的运行时产物目录（相对仓库根）。整个 `.workbuddy/` 已被 .gitignore 忽略。
RUN_DIR_REL = Path(".workbuddy") / "commit-gate" / "run"

# begin 会把这几个删掉重来。刻意用显式列名而不是通配符 ——
# 通配符会把将来放进来的说明文档一起删掉。
RUNTIME_FILES = (
    "context.json",
    "tests.json",
    "tests.log",
    "typecheck.json",
    "typecheck.log",
    "quality.json",
    "quality-sec.json",
    "quality-cmt.json",
    "PASS.json",
    "PASS.tree",
    "PASS.head",
)

# 通行证由这三个文件共同构成，revoke 必须把它们一起清掉、并逐个回读确认。
# 单独列一个常量是为了不再重复第三遍：这三份清单（RUNTIME_FILES / revoke 的删除
# 与校验）之前是各写各的，将来加一个通行证文件就很容易漏改其中一处。
TICKET_FILES = ("PASS.json", "PASS.tree", "PASS.head")

# 命中任一即视为「仓库处于未完成的 git 操作中途」，此时提交会把仓库搞乱。
# 注意：这几种状态在 pre-commit 钩子里是**放行**的（否则冲突合并无法收尾），
# 但 begin 时应当拦下 —— 检查跑在半个合并态上没有意义。
IN_PROGRESS_MARKERS = (
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "rebase-apply",
)

# 质量维度的阻断阈值：只看「已确认」的这两个级别。
# 标为「疑似待确认」的条目不参与判定 —— 否则误报会直接把门禁变成噪音源。
BLOCKING_LEVELS = ("critical", "high")

# 质量检查需要覆盖的文件类型。纯文档/配置变更不必跑质量检查 ——
# 注意这个判断**由脚本做，不由 agent 声明**，否则又是一个
# 「agent 自己宣布不用查」的后门。
QUALITY_EXTENSIONS = frozenset({".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue"})

# git 的空 tree 常量。仓库还没有任何提交（unborn HEAD）时，用它作为 diff 基准。
EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

# 单条 git 命令的等待上限。gate.py 不跑测试，正常都是毫秒级；
# 给个上限是为了万一 git 卡住（比如网络远端不可达）不会把整条流程拖死。
GIT_TIMEOUT_SECONDS = 30

# vitest 汇总行的两种形态：
#   Tests  146 passed (146)
#   Tests  2 failed | 144 passed (146)
# 也可能带 skipped 段。这是 check 用来和 tests.json 交叉核对的依据。
TESTS_LINE_RE = re.compile(
    r"Tests\s+"
    r"(?:(?P<failed>\d+)\s+failed\s*\|\s*)?"
    r"(?:(?P<skipped>\d+)\s+skipped\s*\|\s*)?"
    r"(?P<passed>\d+)\s+passed\s+\((?P<total>\d+)\)"
)

# tsc / vue-tsc 的错误行。typecheck 的核对是**否定式**的：只要日志里出现
# 一条 error TSxxxx 就拒绝。伪造「日志里没有错误」需要主动删行，
# 比伪造一个通过数字要难得多。
TYPECHECK_ERROR_RE = re.compile(r"\berror TS\d+")

# 去掉终端颜色码，否则带颜色的输出会让上面的正则匹配不上
ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")

EXIT_PASS = 0
EXIT_REJECT = 1
EXIT_ERROR = 2

# load_json 的三态。区分「不存在」和「存在但解析失败」很重要 ——
# 两种情况的排查方向完全不同，报同一句话会把人带偏。
STATUS_OK = "ok"
STATUS_MISSING = "missing"
STATUS_BROKEN = "broken"


def emit(message: str) -> None:
    """把人类可读的结论打到 stdout。

    **这段文字会被 gitcommit-agent 读到**，所以每句话都要写清
    「为什么」和「下一步做什么」，不能只说一句失败。

    注意：这里用 buffer 写 UTF-8 字节流。Python 在 Windows 上的 stdout
    默认按 GBK 编码，而调用方按 UTF-8 读 —— 直接用 print() 会让所有中文
    变成乱码，等于没给理由。（阶段 0 实测踩过，与 stdin 必须显式解码同源）
    """
    try:
        sys.stdout.buffer.write((message + "\n").encode("utf-8"))
        sys.stdout.buffer.flush()
    except Exception:
        pass


def reject(message: str) -> int:
    """判定不通过：打印原因并返回退出码 1。"""
    emit("拒绝：" + message)
    return EXIT_REJECT


def script_error(message: str) -> int:
    """脚本自身出错：打印原因并返回退出码 2（与「拒绝」区分开）。"""
    emit("脚本出错：" + message)
    return EXIT_ERROR


def run_git(project: Path, *args: str) -> tuple[int, str, str]:
    """在指定仓库里跑一条 git 命令，返回 (退出码, stdout, stderr)。

    显式用 `-C <仓库>` 而不是切 cwd：本机子进程的 cwd 不可靠，
    切过去反而会引入不确定性。输出显式按 UTF-8 解码 —— Windows 默认编码不是 UTF-8，
    不写死的话中文路径和中文文件名会变成乱码。
    """
    try:
        proc = subprocess.run(
            ["git", "-C", str(project), *args],
            capture_output=True,
            timeout=GIT_TIMEOUT_SECONDS,
        )
    except FileNotFoundError:
        return 127, "", "git 不在 PATH 里"
    except subprocess.TimeoutExpired:
        return 124, "", f"git 命令超时（>{GIT_TIMEOUT_SECONDS}s）"
    stdout = proc.stdout.decode("utf-8", errors="replace").strip()
    stderr = proc.stderr.decode("utf-8", errors="replace").strip()
    return proc.returncode, stdout, stderr


def ensure_repo(project: Path) -> str | None:
    """确认这是个能操作的 git 仓库。是则返回 None，否则返回拒绝原因。"""
    code, out, err = run_git(project, "rev-parse", "--is-inside-work-tree")
    if code != 0:
        return f"{project} 不是 git 仓库（{err or 'rev-parse 失败'}）"
    if out.strip() != "true":
        return f"{project} 不在工作区内（rev-parse 返回 {out!r}）"
    return None


def in_progress_operation(project: Path) -> str | None:
    """检查仓库是否处于 merge / rebase / cherry-pick 中途。

    这几种状态下跑门禁没有意义（代码处于中间态），所以先拦下来让人收尾。
    返回命中的标记名，没有则返回 None。
    """
    code, git_dir, _ = run_git(project, "rev-parse", "--git-dir")
    if code != 0:
        return None  # 拿不到 .git 目录就别在这里拦，后面自会失败
    base = Path(git_dir)
    if not base.is_absolute():
        base = project / base
    for marker in IN_PROGRESS_MARKERS:
        if (base / marker).exists():
            return marker
    return None


def changes_unstaged(project: Path) -> bool | None:
    """工作区与暂存区是否不一致（只看已跟踪文件）。

    返回 True=有未暂存改动，False=一致，None=git 报错（调用方应视为脚本错误）。
    `git diff --quiet` 的约定是：退出码 0 表示无差异，1 表示有差异。
    """
    code, _, _ = run_git(project, "diff", "--quiet")
    if code == 0:
        return False
    if code == 1:
        return True
    return None


def untracked_files(project: Path) -> list[str] | None:
    """列出未跟踪且未被忽略的文件。

    为什么要单独查这个：`git diff --quiet` **看不见未跟踪文件**。
    于是出现这种漏洞 —— 子代理新建了一个文件、跑测试时它在磁盘上所以测试通过，
    但没 `git add`；提交出来的 tree 里根本没有这个文件，本地绿、换台机器就红。

    `--exclude-standard` 尊重 .gitignore，所以门禁自己的产物（在 .workbuddy/ 下）
    不会把自己卡住。返回 None 表示 git 报错。
    """
    code, out, _ = run_git(project, "ls-files", "--others", "--exclude-standard")
    if code != 0:
        return None
    return [line for line in out.splitlines() if line.strip()]


def changed_files(project: Path, head: str) -> list[str] | None:
    """本次提交会包含哪些文件（相对仓库根的路径）。

    用 `git diff --cached <base>` —— 比较的是**索引**（即将提交的内容）与基准提交，
    正是质量检查该覆盖的范围。head 为空（unborn HEAD）时用空 tree 作基准。
    过滤掉磁盘上已不存在的路径，避免把已删除文件也算进检查范围。
    """
    base = head or EMPTY_TREE
    code, out, _ = run_git(
        project, "diff", "--cached", "--name-only", "--diff-filter=ACMR", base
    )
    if code != 0:
        return None
    return [n for n in out.splitlines() if n.strip() and (project / n).exists()]


def quality_applicable(files: list[str]) -> bool:
    """变更文件里是否有需要做质量检查的源码。

    纯文档 / 配置变更（比如只改了 CLAUDE.md）不必跑质量检查，否则
    两个分析脚本会以「没有可扫描文件」的退出码 2 结束，被误判成检查失败。
    """
    return any(Path(f).suffix.lower() in QUALITY_EXTENSIONS for f in files)


def is_ignored(project: Path, target: Path) -> bool:
    """target 是否被 .gitignore 覆盖。

    用来做一道**不能省**的前置断言：门禁的运行时目录必须是被忽略的。
    否则 `git add -A` 会把 PASS.tree 自己扫进提交 —— 而 PASS.tree 记录的是
    包含它自己的那棵树的哈希，形成自引用，每次提交都会改变指纹。
    （阶段 1 在 scratch repo 上真实踩到过这个 bug）
    """
    try:
        rel = target.relative_to(project)
    except ValueError:
        return False
    code, _, _ = run_git(project, "check-ignore", "-q", "--", rel.as_posix())
    return code == 0


def write_tree(project: Path) -> str | None:
    """取当前索引的 tree SHA —— 这一轮唯一的内容指纹。

    失败通常意味着索引里有未解决的冲突，返回 None 由调用方拒绝。
    """
    code, out, _ = run_git(project, "write-tree")
    if code != 0 or not out:
        return None
    return out.strip()


def head_sha(project: Path) -> str:
    """取当前 HEAD 的 SHA。仓库还没有任何提交时返回空串（不是错误）。"""
    code, out, _ = run_git(project, "rev-parse", "HEAD")
    return out.strip() if code == 0 else ""


def load_json(path: Path) -> tuple[str, dict | None]:
    """读一个 json 文件，返回 (状态, 内容)。

    状态是 ok / missing / broken 三态之一。**这个区分很重要**：
    两种失败原因的排查方向完全不同（「没跑」vs「跑了但写坏了或被中断」），
    报同一句话会把人带偏。

    解码用 utf-8-sig 而不是 utf-8：PowerShell 5.1 的 `Out-File -Encoding utf8`
    写出来的是**带 BOM** 的 UTF-8，BOM 会让 json.loads 直接抛异常。
    utf-8-sig 对无 BOM 的普通 UTF-8 同样正确，所以是无损切换。
    （阶段 0 实测确认过这个坑）
    """
    if not path.exists():
        return STATUS_MISSING, None
    try:
        return STATUS_OK, json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return STATUS_BROKEN, None


def dump_json(path: Path, payload: dict) -> None:
    """把结果写成 json，显式 UTF-8（无 BOM）+ 缩进（要给人看）。

    写完**回读校验**：设计稿记录过「报告成功但文件仍在/没写对」的现象，
    只看 write 有没有抛异常是不够的。不一致就抛 OSError，由调用方归入脚本错误。

    回读用 read_bytes 而不是 read_text：文本模式会把 CRLF 归一成 LF，
    于是「文件其实被写成了 CRLF」这种偏差**在校验里看不见** ——
    校验就成了摆设。比字节才能真的验出问题。
    """
    expected = (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    path.write_bytes(expected)
    if path.read_bytes() != expected:
        raise OSError(f"回读校验失败，写入的内容与磁盘上的不一致：{path}")


def write_ticket(path: Path, value: str) -> None:
    """写一张单行纯文本通行证（`<值>\\n`），并回读校验。

    **必须走 write_bytes，不能用 write_text**：Python 文本模式会把 `\\n` 翻译成
    `os.linesep`，Windows 下写出 `<值>\\r\\n`，而 shell 的 `read` 只去掉 `\\n`
    不去掉 `\\r`，于是永远比不相等 —— 表现为「每次提交都被拒」。
    （钩子侧另有 `printf '%.40s'` 作为第二道防御，两层都要有）

    回读同样比字节：文本模式读回时 CRLF 会被归一成 LF，
    那正好会把上面这个 CRLF 问题**掩盖掉**，校验等于没做。
    """
    expected = (value + "\n").encode("ascii")
    path.write_bytes(expected)
    if path.read_bytes() != expected:
        raise OSError(f"通行证回读校验失败，写入的内容与磁盘上的不一致：{path}")


def clear_previous_run(run_dir: Path) -> None:
    """清掉上一轮的运行时文件，并回读确认真的删掉了。

    这一步是「标记文件会过期」这个洞的主要堵法：只要 begin 把旧标记删干净，
    check 就只能读到本轮产出的文件 —— 不存在「读到上一轮结果」的可能。

    删完再 exists() 复核，因为设计稿记录过「删除报成功但文件仍在」的现象。
    删不掉（被别的进程占着）时抛 OSError，由 main 归入脚本错误。
    """
    for name in RUNTIME_FILES:
        target = run_dir / name
        if not target.exists():
            continue
        target.unlink()
        if target.exists():
            raise OSError(f"删除后文件仍然存在：{target}")
    # 顺带清掉上一轮的 reject.log：它是排查线索，但不该跨轮累积
    reject_log = run_dir.parent / "reject.log"
    if reject_log.exists():
        reject_log.unlink()


def parse_tests_log(log_path: Path) -> dict | None:
    """从 npm test 的原始输出里解析出 vitest 汇总行。

    这是防止「标记文件被编造」的关键一环：tester 写 tests.json 的同时必须存下
    命令的原始 stdout，这里独立解析出数字用于交叉核对。
    伪造一份 json 很容易，伪造一份格式正确、数字自洽的 vitest 输出要难得多。

    返回 {total, passed, failed} 或 None（没找到汇总行）。
    """
    try:
        text = log_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    clean = ANSI_RE.sub("", text)
    matches = list(TESTS_LINE_RE.finditer(clean))
    if not matches:
        return None
    last = matches[-1]  # 一次运行可能有多个汇总行，取最后一个
    return {
        "total": int(last.group("total")),
        "passed": int(last.group("passed")),
        "failed": int(last.group("failed") or 0),
    }


def typecheck_errors(log_path: Path) -> list[str] | None:
    """从 typecheck 的原始输出里抽出错误行。

    返回错误行列表（空列表=干净），None=日志读不到。
    这是**否定式**核对：伪造「日志里没有错误」需要主动删行，比伪造一个通过数字难。
    """
    try:
        text = log_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    clean = ANSI_RE.sub("", text)
    return [line.strip() for line in clean.splitlines() if TYPECHECK_ERROR_RE.search(line)]


def histogram(findings: list, field: str) -> dict[str, int]:
    """按某个字段统计 findings 的条数。gate 用它自己重算，不信 agent 填的汇总。"""
    counts = {level: 0 for level in ("critical", "high", "medium", "low")}
    for item in findings:
        if not isinstance(item, dict):
            continue
        value = str(item.get(field, "")).lower()
        if value in counts:
            counts[value] += 1
    return counts


def cmd_begin(args: argparse.Namespace) -> int:
    """`begin`：一轮检查开始前的准备。返回退出码。"""
    project = Path(args.project).resolve()
    run_dir = project / RUN_DIR_REL

    # 一进来就先删掉上一轮的 context.json。
    #
    # 为什么：如果本轮 begin 在前面几道检查上被拒（工作区脏、有未跟踪文件…），
    # 旧的 context.json 会留在原地，接着 check 就会拿**上一轮的指纹**去比对，
    # 报出「检查期间代码被改动」—— 而真实原因是「begin 根本没跑成功」。
    # 这两句话指向完全不同的排查方向，会白白浪费一轮。实测踩到过。
    #
    # 只删 context.json，**不动 PASS.json / PASS.tree** ——
    # 那可能是上一轮留下的、仍然有效的通行证，不该因为一次失败的 begin 被销毁。
    try:
        (run_dir / "context.json").unlink(missing_ok=True)
    except OSError:
        pass

    problem = ensure_repo(project)
    if problem:
        return reject(problem)

    marker = in_progress_operation(project)
    if marker:
        return reject(
            f"仓库正处于未完成的 git 操作中途（检测到 .git/{marker}）。"
            "请先把这个操作收尾或中止（merge / rebase / cherry-pick），再重新开始检查。"
        )

    unstaged = changes_unstaged(project)
    if unstaged is None:
        return script_error("git diff --quiet 返回了预期之外的状态，无法判断工作区是否干净")
    if unstaged:
        return reject(
            "工作区还有没暂存的改动。请先执行 `git add -A` 再重新开始检查 —— "
            "否则测试跑的是工作区里的新代码，而提交的是暂存区里的旧内容，两者对不上。"
        )

    untracked = untracked_files(project)
    if untracked is None:
        return script_error("git ls-files --others 失败，无法判断有没有未跟踪文件")
    if untracked:
        listing = "\n".join(f"    {name}" for name in untracked[:20])
        more = f"\n    …（另有 {len(untracked) - 20} 个）" if len(untracked) > 20 else ""
        return reject(
            "工作区有未跟踪的文件，先决定它们的去留再开始检查：\n"
            f"{listing}{more}\n"
            "  要提交就 `git add` 进去；不该进版本库就写进 .gitignore。\n"
            "  为什么必须处理：git diff 看不见未跟踪文件，若不管它们，"
            "提交出来的树会缺少你以为已经包含的文件。"
        )

    # 门禁的运行时目录必须被忽略，否则 PASS.tree 会被自己扫进提交（自引用）
    if not is_ignored(project, run_dir / "PASS.tree"):
        return reject(
            f"{RUN_DIR_REL.as_posix()}/ 没有被 .gitignore 忽略。\n"
            "  必须先把 `.workbuddy/` 加进 .gitignore —— 否则门禁产物会被"
            "`git add -A` 扫进提交，而 PASS.tree 记录的是包含它自己的那棵树的哈希，"
            "形成自引用，每次提交指纹都会变。"
        )

    tree = write_tree(project)
    if tree is None:
        return reject(
            "无法计算内容指纹（git write-tree 失败）。"
            "常见原因是索引里有未解决的冲突，请先用 `git status` 查看。"
        )

    head = head_sha(project)
    files = changed_files(project, head)
    if files is None:
        return script_error("git diff --cached 失败，无法算出本次变更的文件清单")

    try:
        run_dir.mkdir(parents=True, exist_ok=True)
        clear_previous_run(run_dir)
    except OSError as exc:
        return script_error(f"准备运行时目录失败：{exc}")

    context = {
        "schema": SCHEMA_VERSION,
        "runId": uuid.uuid4().hex,
        "tree": tree,
        "head": head,
        "changedFiles": files,
        "untracked": [],
        "qualityRequired": quality_applicable(files),
        "startedAt": int(time.time() * 1000),
    }
    try:
        dump_json(run_dir / "context.json", context)
    except OSError as exc:
        return script_error(f"写入 context.json 失败：{exc}")

    emit(f"本轮开始。内容指纹 = {tree}")
    emit(f"runId = {context['runId']}")
    emit(
        "本次提交变更的文件（质量检查范围）："
        + ("\n" + "\n".join(f"  {name}" for name in files) if files else "（空）")
    )
    emit(f"是否需要质量检查：{'需要' if context['qualityRequired'] else '不需要（纯文档/配置变更）'}")
    emit(
        "请把上面的 runId 原样传给子代理，并要求它们先读 "
        f"{(RUN_DIR_REL / 'context.json').as_posix()} 核对。"
    )
    return EXIT_PASS


def _check_tests(run_dir: Path, context: dict) -> int | None:
    """校验单元测试维度。通过返回 None，否则返回退出码。

    返回值刻意与另外两个 checker 保持一致（单个 int | None）。
    早先写成返回二元组、却在调用处和另两个混在一个循环里，导致 sys.exit(元组)
    把 "(1, None)" 打到 stderr 上 —— 虽然退出码碰巧也是 1，但输出会误导排查。
    """
    status, tests = load_json(run_dir / "tests.json")
    if status == STATUS_MISSING:
        return reject(
            "找不到 tests.json —— 单元测试这一轮没有产出结果。"
            "请确认 tester 已经跑过 `npm test` 并写出该文件。"
        )
    if status == STATUS_BROKEN:
        return reject(
            "tests.json 存在但解析失败（可能被中断、写了一半，或编码不对）。"
            "请让 tester 重新产出 —— 注意必须写无 BOM 的 UTF-8。"
        )
    assert tests is not None

    if tests.get("runId") != context.get("runId"):
        return reject(
            "tests.json 的 runId 与本轮不符 —— 这份结果是别的轮次留下的，不能算数。\n"
            f"  本轮 runId：{context.get('runId')}\n"
            f"  文件里的：  {tests.get('runId')}\n"
            "请让 tester 读 context.json 拿到本轮 runId 后重新产出。"
        )

    total, failed = tests.get("total"), tests.get("failed")
    if not isinstance(total, int) or not isinstance(failed, int):
        return reject("tests.json 里 total / failed 不是整数，文件格式不对")
    if total <= 0:
        return reject("tests.json 报告 total = 0，等于一个用例都没跑，不能算通过")
    if failed != 0:
        return reject(
            f"单元测试未全绿：{failed} 个失败 / 共 {total} 个。"
            "请修到全部通过后重跑一轮（不要放宽断言或删用例来凑绿）。"
        )

    logged = parse_tests_log(run_dir / "tests.log")
    if logged is None:
        return reject(
            "无法从 tests.log 里解析出 vitest 的汇总行。"
            "tests.log 必须是 `npm test` 的原始输出，不能是摘要或空文件。"
        )
    if (
        logged["total"] != total
        or logged["passed"] != tests.get("passed")
        or logged["failed"] != failed
    ):
        return reject(
            "tests.json 与 tests.log 的数字对不上，标记不可信。\n"
            f"  tests.json：total={total} passed={tests.get('passed')} failed={failed}\n"
            f"  tests.log： total={logged['total']} passed={logged['passed']} failed={logged['failed']}\n"
            "请重新跑一遍测试并如实记录，不要手工改写这两个文件。"
        )
    return None


def _check_typecheck(run_dir: Path, context: dict) -> int | None:
    """校验类型检查维度。通过返回 None，否则返回退出码。

    为什么单独有这一维：vitest 用 esbuild 转译，**完全不做类型检查**。
    只跑单测会放行「测试全绿 + 类型炸掉」的提交，而这对 TS 项目是最典型的回归。
    """
    status, tc = load_json(run_dir / "typecheck.json")
    if status == STATUS_MISSING:
        return reject(
            "找不到 typecheck.json —— 类型检查这一轮没有产出结果。"
            "请确认 tester 已经跑过 `npm run typecheck` 并写出该文件。"
        )
    if status == STATUS_BROKEN:
        return reject("typecheck.json 存在但解析失败，请让 tester 重新产出（无 BOM UTF-8）。")
    assert tc is not None

    if tc.get("runId") != context.get("runId"):
        return reject("typecheck.json 的 runId 与本轮不符，这份结果不能算数。")

    errors = typecheck_errors(run_dir / "typecheck.log")
    if errors is None:
        return reject("读不到 typecheck.log —— 它必须是 `npm run typecheck` 的原始输出。")
    if errors:
        preview = "\n".join(f"    {line}" for line in errors[:8])
        more = f"\n    …（另有 {len(errors) - 8} 条）" if len(errors) > 8 else ""
        return reject(
            f"类型检查没通过，共 {len(errors)} 条错误：\n{preview}{more}\n"
            "请修到 `npm run typecheck` 退出码为 0 再重跑一轮。"
        )

    if tc.get("exitCode") not in (0, "0"):
        return reject(
            f"typecheck.json 记录的退出码是 {tc.get('exitCode')!r}，不是 0，"
            "但日志里又没找到错误行 —— 两者矛盾，请让 tester 重新跑一遍并如实记录。"
        )
    return None


def _check_quality(run_dir: Path, context: dict) -> int | None:
    """校验质量维度。通过返回 None，否则返回退出码。"""
    if not context.get("qualityRequired"):
        return None  # 纯文档/配置变更，本维度不适用

    status, quality = load_json(run_dir / "quality.json")
    if status == STATUS_MISSING:
        return reject(
            "找不到 quality.json —— 质量检查这一轮没有产出结果。"
            "请确认 quality-engineer 已经跑完并写出该文件。"
        )
    if status == STATUS_BROKEN:
        return reject("quality.json 存在但解析失败，请让 quality-engineer 重新产出。")
    assert quality is not None

    if quality.get("runId") != context.get("runId"):
        return reject("quality.json 的 runId 与本轮不符，这份结果不能算数。")

    # 覆盖范围必须是本次变更文件的超集。这条把「只查改动」从散文
    # 变成了机器可校验的不变式 —— 否则 agent 可以声称查了其实没查。
    scanned = quality.get("scope", {}).get("scanned")
    if not isinstance(scanned, list):
        return reject("quality.json 缺少 scope.scanned，无法确认检查覆盖了哪些文件。")
    required = set(context.get("changedFiles") or [])
    missed = sorted(required - set(scanned))
    if missed:
        listing = "\n".join(f"    {name}" for name in missed)
        return reject(
            "质量检查漏扫了本次变更的文件：\n"
            f"{listing}\n"
            "请让 quality-engineer 补齐这些文件后重新产出 quality.json。"
        )

    findings = quality.get("findings")
    if not isinstance(findings, list):
        return reject(
            "quality.json 缺少 findings 明细数组。"
            "只给汇总数字不够 —— 门禁需要按明细自己重算，"
            "否则「通过与否」就完全由 agent 自报了。"
        )

    # findings 里混入非对象（比如 agent 把一行文字直接塞进数组）必须**显式拒绝**。
    # 后面几处都要按字段取值，遇到字符串会抛 AttributeError，被 main() 归成
    # 退出码 2「脚本自己出错」——而按本脚本的设计，2 的含义是「该我修脚本」，
    # 那会把排查方向从这份 json 引到 gate.py 上。实测踩过。
    #
    # **不能改成「跳过非对象」**：跳过等于把一条可能是真问题的条目悄悄丢掉，
    # 然后给出「通过」—— 那比报错严重得多。宁可拒绝。
    malformed = [i for i, f in enumerate(findings) if not isinstance(f, dict)]
    if malformed:
        shown = ", ".join(str(i) for i in malformed[:5])
        more = f"，另有 {len(malformed) - 5} 项" if len(malformed) > 5 else ""
        return reject(
            f"quality.json 的 findings 里有 {len(malformed)} 项不是对象（下标 {shown}{more}）。\n"
            "  每一条发现都必须是带 file / line / level / confidence / title 的对象，"
            "不能直接写成字符串或数字。\n"
            "  请让 quality-engineer 重新产出。"
        )

    # 门禁自己重算，不信 agent 填的 counts / confirmed
    by_level = histogram(findings, "level")
    confirmed_findings = [f for f in findings if str(f.get("confidence", "")).lower() == "confirmed"]
    # confirmed 只统计**阻断级别**（critical/high）—— 它与 counts 的语义不同：
    # counts 是全量直方图，confirmed 是「够格阻断的有几条」。
    # 早先把四个级别都算进来，导致 agent 按契约只写 critical/high 时，
    # medium 那一项会被判成「缺字段」而误拒。实测抓到的 bug。
    confirmed_all = histogram(confirmed_findings, "level")
    by_confirmed = {level: confirmed_all[level] for level in BLOCKING_LEVELS}

    for field, recomputed in (("counts", by_level), ("confirmed", by_confirmed)):
        claimed = quality.get(field)
        if not isinstance(claimed, dict):
            return reject(f"quality.json 缺少 {field} 字段，无法与明细核对。")
        mismatch = {
            level: (claimed.get(level), recomputed[level])
            for level in recomputed
            if claimed.get(level, 0) != recomputed[level]
        }
        if mismatch:
            detail = "\n".join(
                f"    {level}: 文件里写 {got}，按 findings 明细重算是 {want}"
                for level, (got, want) in mismatch.items()
            )
            return reject(
                f"quality.json 的 {field} 与 findings 明细对不上，标记不可信：\n{detail}\n"
                "请让 quality-engineer 如实汇总，不要手工改写。"
            )

    blocking = [f for f in confirmed_findings if str(f.get("level", "")).lower() in BLOCKING_LEVELS]
    if blocking:
        listing = "\n".join(
            f"    [{f.get('level')}] {f.get('file', '?')}:{f.get('line', '?')}  {f.get('title', '(无标题)')}"
            for f in blocking[:20]
        )
        more = f"\n    …（另有 {len(blocking) - 20} 条）" if len(blocking) > 20 else ""
        return reject(
            f"质量检查有已确认的高危问题（阈值：{'/'.join(BLOCKING_LEVELS)}），共 {len(blocking)} 条：\n"
            f"{listing}{more}\n"
            "请先处理掉（报告里每条都附了可直接套用的修复示例），然后重跑一轮。"
            f"\n  报告位置：{quality.get('reportPath', '(未记录)')}"
        )
    return None


def cmd_check(args: argparse.Namespace) -> int:
    """`check`：一轮检查结束后做判定。返回退出码。"""
    project = Path(args.project).resolve()
    run_dir = project / RUN_DIR_REL

    status, context = load_json(run_dir / "context.json")
    if status == STATUS_MISSING:
        return reject(
            "找不到本轮的 context.json —— 说明没有正确执行 begin，流程不完整。"
            "请重新从 `gate.py begin` 开始。"
        )
    if status == STATUS_BROKEN:
        return script_error("context.json 存在但解析失败，文件可能被写坏了")
    assert context is not None

    expected_tree = context.get("tree")
    if not expected_tree:
        return script_error("context.json 里没有 tree 字段，文件可能被改坏了")

    # 第一道：指纹是否还是同一个。这一条同时兜住了「tester 越权改了代码」的风险 ——
    # tester 的工具集里有 Edit，结构上它是能改的，只能靠这里确定性发现。
    # （注意它的边界：只发现「留下来的」改动。改了又还原这种瞬时改动，
    #   端点比对在原理上看不见 —— 那部分只能靠 agent 自律，见 tester.md 的门禁模式）
    current_tree = write_tree(project)
    if current_tree is None:
        return script_error("复算指纹时 git write-tree 失败，无法判定")
    if current_tree != expected_tree:
        return reject(
            "检查期间代码被改动，本轮结果作废。\n"
            f"  开始时的指纹：{expected_tree}\n"
            f"  现在的指纹：  {current_tree}\n"
            "如果刚才是子代理跑了测试并顺手改了代码，请撤销那些改动后重跑一轮。"
        )

    # 第二道：工作区是否仍等于暂存区。只看 tree 会漏掉这种情形 ——
    # 有人改了文件但没 git add，此时 tree 不变、而测试跑的是新代码。
    unstaged = changes_unstaged(project)
    if unstaged is None:
        return script_error("git diff --quiet 返回了预期之外的状态，无法判断工作区是否干净")
    if unstaged:
        return reject(
            "工作区出现了未暂存的改动 —— 检查跑的是改动后的代码，"
            "而提交的会是暂存区里的旧内容，两者不对应。\n"
            "请确认改动是否有意为之：有意就 `git add -A` 后重跑一轮，无意就撤销掉。"
        )

    # 第三道：未跟踪文件有没有变多。检查期间新冒出来的文件同样会让
    # 「测过的内容」与「提交的内容」对不上。
    untracked_now = untracked_files(project)
    if untracked_now is None:
        return script_error("git ls-files --others 失败，无法判断未跟踪文件")
    before = set(context.get("untracked") or [])
    new_ones = sorted(set(untracked_now) - before)
    if new_ones:
        listing = "\n".join(f"    {name}" for name in new_ones[:20])
        return reject(
            f"检查期间产生了新的未跟踪文件：\n{listing}\n"
            "它们不在本次提交里（提交的是暂存区的内容），但可能被测试依赖。"
            "请决定：要提交就 `git add` 后重跑一轮，不该有就删掉。"
        )

    # 第四~六道：三个维度
    for checker in (_check_tests, _check_typecheck, _check_quality):
        code = checker(run_dir, context)
        if code is not None:
            return code

    _, tests = load_json(run_dir / "tests.json")
    _, quality = load_json(run_dir / "quality.json")

    # 全过 —— 签发通行证
    passed_at = int(time.time() * 1000)
    pass_payload = {
        "schema": SCHEMA_VERSION,
        "action": "commit",
        "runId": context.get("runId"),
        "tree": expected_tree,
        # head 同时用作「这张通行证还没被用过」的绑定依据：
        # 提交之后 HEAD 会前移，通行证就对不上新的 HEAD 了，自动失效。
        # 这样即使后续的删除动作漏了，过期通行证也用不了。
        "head": context.get("head", ""),
        "changedFiles": context.get("changedFiles", []),
        "passedAt": passed_at,
        "checks": {
            "tests": {
                "total": (tests or {}).get("total"),
                "passed": (tests or {}).get("passed"),
                "failed": (tests or {}).get("failed"),
                "durationMs": (tests or {}).get("durationMs"),
                "command": (tests or {}).get("command"),
            },
            "typecheck": {"exitCode": 0, "command": "npm run typecheck"},
            "quality": {
                "applicable": bool(context.get("qualityRequired")),
                # 必须显式记录范围：PASS.tree 绑定的是**整棵树**，
                # 而质量维度只看了一部分文件。不写清楚，将来回看通行证
                # 会以为「整棵树都通过了质量检查」，那是严重高估。
                "scope": "changed-files",
                "policy": list(BLOCKING_LEVELS),
                "blocking": 0,
                "findings": (quality or {}).get("counts", {}),
                "reportPath": (quality or {}).get("reportPath"),
            },
        },
    }
    try:
        dump_json(run_dir / "PASS.json", pass_payload)
        # PASS.tree / PASS.head 是单行纯文本：给 git pre-commit 那个 shell 脚本读的。
        # 让 shell 去解析 json 很别扭，多两个纯文本文件就省掉了这件事。
        #
        # PASS.tree：本次提交的内容指纹，必须与 `git write-tree` 相等。
        # PASS.head：签发这张通行证时的 HEAD。
        #
        # PASS.head 为什么必须有：撤销通行证的动作只在 gitcommit-agent 里，
        # 手动提交（比如直接 /git-save）时没人清它。没有 HEAD 绑定，同一张通行证
        # 就能被用第二次 —— 提交完再 amend 改提交信息，tree 没变、通行证照样匹配。
        # 有它之后，「一次通行证只对应一次提交」不再依赖任何 agent 记得调 revoke：
        # 提交一发生 HEAD 就前移，旧通行证自动失效。
        write_ticket(run_dir / "PASS.tree", expected_tree)
        write_ticket(run_dir / "PASS.head", context.get("head", ""))
    except OSError as exc:
        return script_error(f"写入通行证失败：{exc}")

    emit(f"通过。指纹 {expected_tree}")
    emit(f"  runId：{context.get('runId')}")
    emit(
        f"  单元测试：{(tests or {}).get('passed')}/{(tests or {}).get('total')} 通过，"
        f"耗时 {(tests or {}).get('durationMs')}ms"
    )
    emit("  类型检查：通过（无 error TS）")
    if context.get("qualityRequired"):
        emit(f"  质量检查：已确认的 {'/'.join(BLOCKING_LEVELS)} 均为 0（范围：本次变更文件）")
    else:
        emit("  质量检查：本轮不适用（纯文档/配置变更）")
    emit("可以提交了。")
    return EXIT_PASS


def cmd_revoke(args: argparse.Namespace) -> int:
    """`revoke`：作废通行证。推送成功后调用，使一张通行证只对应一次提交+推送。

    幂等：通行证本来就不存在时也算成功 —— 调用方是 gitcommit-agent，
    而它的流程里可能有分支会重复走到这里（比如推送失败后重试），
    重复调用不该报错。

    注意这只是**主要**的作废手段，不是唯一防线：撤销动作只在 agent 里，
    手动提交（直接 /git-save 或敲 git commit）时没人清通行证。
    所以 git pre-commit 钩子另有一道 HEAD 绑定 —— 提交一发生 HEAD 就前移，
    旧通行证自动失效。两道都在，缺一不可。
    """
    project = Path(args.project).resolve()
    run_dir = project / RUN_DIR_REL

    removed = []
    try:
        # context.json 一并删掉：它描述的是本轮检查，通行证都没了它就没有意义了
        for name in (*TICKET_FILES, "context.json"):
            target = run_dir / name
            if target.exists():
                target.unlink()
                removed.append(name)
    except OSError as exc:
        return script_error(f"撤销通行证失败：{exc}")

    for name in TICKET_FILES:
        if (run_dir / name).exists():
            return script_error(f"撤销后 {name} 仍然存在，删除没有生效")

    emit(f"通行证已撤销（清理了 {len(removed)} 个文件）。下次提交需要重新跑一轮检查。")
    return EXIT_PASS


def build_parser() -> argparse.ArgumentParser:
    """构造命令行解析器。

    --project 刻意做成**必填、无默认值**：文档明说「不依赖 cwd」，
    而给个 "." 默认值恰好就是依赖 cwd，自相矛盾（且本机子进程 cwd 不可靠）。
    所有调用点都显式传仓库根目录。
    """
    parser = argparse.ArgumentParser(
        prog="gate.py",
        description="提交门禁判定核心：begin 记指纹，check 校验并签发通行证，revoke 作废通行证",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    for name, help_text in (
        ("begin", "检查开始前调用：断言索引干净、记录内容指纹、清掉上一轮的标记"),
        ("check", "检查结束后调用：复算指纹、校验三个维度、全过则签发通行证"),
        ("revoke", "作废通行证（推送成功后调用，幂等）"),
    ):
        child = sub.add_parser(name, help=help_text)
        child.add_argument(
            "--project",
            required=True,
            help="仓库根目录的绝对路径（必填；脚本内部转绝对路径，不依赖 cwd）",
        )
    return parser


def main() -> int:
    """入口。把子命令分派出去，并统一兜住意料之外的异常。"""
    parser = build_parser()
    args = parser.parse_args()
    try:
        if args.command == "begin":
            return cmd_begin(args)
        if args.command == "revoke":
            return cmd_revoke(args)
        return cmd_check(args)
    except Exception as exc:  # 兜底：任何没预料到的异常都算脚本错误，不是「拒绝」
        return script_error(f"未预期的异常：{exc!r}")


if __name__ == "__main__":
    sys.exit(main())
