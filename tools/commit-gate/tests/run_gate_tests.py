"""gate.py 的系统测试。

**自己建临时仓库来跑，不碰任何已有仓库。** 所以放在仓库里、谁都能跑：
装好依赖后 `python tools/commit-gate/tests/run_gate_tests.py` 即可。

（早先它跑在一个手工维护的 scratch 仓库 `F:/ai/gate-e2e` 里。那套测试做的是破坏性操作——
真提交、改 `.git/MERGE_HEAD`、在索引里翻来覆去——放在仓库外是怕误伤真仓库。
现在改成自己 `mkdtemp` 建仓库，这个顾虑就没了，而且测试终于能进版本控制。）

**判官脚本与钩子都从真仓库拷当前版本**（见 `GATE_SRC` / `HOOK_SRC`），
所以验的永远是仓库里那一份，而不是某个副本。副本会漂移，而用副本去测门禁等于没测。

用法: python run_gate_tests.py
退出码 0 = 全部通过。
"""

import atexit
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve()
# 本文件在 <仓库>/tools/commit-gate/tests/ 下
GATE_SRC = HERE.parents[1] / "gate.py"                    # 判官脚本
HOOK_SRC = HERE.parents[3] / ".githooks" / "pre-commit"    # git 钩子

# 跑被测脚本用**跑本套件的那个解释器**，而不是 PATH 里的 `python`。
# 本机上两者恰好是同一个，但在只有 `py -3`、或用了 venv 的机器上，写死 "python"
# 会让 subprocess 抛 FileNotFoundError —— 整套用例以 traceback 中断，
# 连一条结论都打不出来（看起来像「什么都没跑」）。
PYEXE = sys.executable or "python"

# 跑钩子用 `sh`（pre-commit 是纯 sh 脚本）。直接写死 "sh" 会在没有它的机器上让
# subprocess 抛 FileNotFoundError，整套钩子层用例以 traceback 中断、
# 看起来像「什么都没跑」；而实际上 T-H2 之后的用例一条都没执行。
#
# 也不能只写 shutil.which("sh")：实测本机子进程拿到的 PATH 会被上层环境**重写过**
# （父进程 PATH 里的 F:/Git/bin 会被剥掉，只剩 F:/Git/cmd），which 返回 None
# 而 sh 其实就在 git 的隔壁 —— 于是整组钩子层用例被静默跳过，套件却像是「跑完了」。
#
# 所以兜底从 `git` 的位置反推：Git for Windows 跑钩子用的就是 <git 根>/bin/sh.exe。
def _find_sh() -> str | None:
    """定位一个能执行 pre-commit 的 POSIX sh；找不到返回 None。

    只找 sh，**刻意不退到 bash**：本机 shutil.which("bash") 命中的是
    C:\\Windows\\System32\\bash.EXE，那是 WSL 的 bash，与 Git 自带的 sh 环境不同，
    拿它跑钩子只会得到一堆与本题无关的报错。
    """
    found = shutil.which("sh") or shutil.which("sh.exe")
    if found:
        return found
    git = shutil.which("git") or shutil.which("git.exe")
    if not git:
        return None
    root = Path(git).resolve().parent.parent   # F:/Git/cmd/git.exe -> F:/Git
    for rel in ("bin/sh.exe", "usr/bin/sh.exe", "bin/sh", "usr/bin/sh"):
        cand = root / rel
        if cand.is_file():
            return str(cand)
    return None


SHEXE = _find_sh()

REPO: Path   # 本轮的临时仓库，由 setup_repo() 建
GATE: Path
RUN: Path

# 建过的临时目录，跑完统一清掉
_CLEANUP: list[Path] = []

results: list[tuple[str, bool, str]] = []


class CaseAborted(Exception):
    """某条用例的前提没满足，剩下的用例已经没有意义。

    抬到 `main()` 统一收尾，为的是让**汇总仍然打得出来**。早先这种情况是
    直接读一个不存在的 `context.json` 而抛 FileNotFoundError，整套用例以
    traceback 中断，前面已经 FAIL 的用例一条都看不到 —— 看起来像「什么都没跑」。
    """


def _git(cwd: Path, *args: str) -> None:
    """在 cwd 里跑一条 git 命令，**故意丢弃输出与退出码**。

    只用于「建仓库、add、commit」这类不在乎结果的装配动作；要看结果的地方用 sh() / gate()。
    """
    subprocess.run(["git", *args], cwd=str(cwd), capture_output=True)


def make_repo(prefix: str, *, managed: bool = True, seed_commit: bool = True) -> Path:
    """建一个临时仓库并返回它的路径。

    - `managed=False`：不拷 gate.py，用来验「不受管的仓库直接放行」
    - `seed_commit=False`：只暂存不提交，用来造 unborn HEAD 的边界情形
    """
    root = Path(tempfile.mkdtemp(prefix=prefix))
    _CLEANUP.append(root)

    _git(root, "init", "-q", "-b", "main")
    _git(root, "config", "core.hooksPath", ".githooks")
    # 明写身份：测试不该依赖跑它那台机器的 git 全局配置
    _git(root, "config", "user.email", "commit-gate-test@example.invalid")
    _git(root, "config", "user.name", "commit-gate-test")

    (root / ".gitignore").write_text(".workbuddy/\n", encoding="utf-8")
    (root / ".githooks").mkdir()
    shutil.copy(HOOK_SRC, root / ".githooks" / "pre-commit")
    if managed:
        (root / "tools" / "commit-gate").mkdir(parents=True)
        shutil.copy(GATE_SRC, root / "tools" / "commit-gate" / "gate.py")
    (root / "src").mkdir()
    (root / "src" / "demo.ts").write_text("export const x = 1\n", encoding="utf-8")

    _git(root, "add", "-A")
    if seed_commit:
        # 必须 --no-verify：受管仓库里钩子是活的，而这时还没有通行证，
        # 不跳过的话连这个用来打底的提交都建不起来
        _git(root, "commit", "-q", "-m", "seed", "--no-verify")
    return root


def setup_repo() -> None:
    """建本轮的临时仓库，并填好三个全局 REPO / GATE / RUN。

    之所以设成全局：下面每个用例都要读它们，写成局部变量就得层层传参。
    """
    global REPO, GATE, RUN
    REPO = make_repo("commit-gate-test-")
    GATE = REPO / "tools" / "commit-gate" / "gate.py"
    RUN = REPO / ".workbuddy" / "commit-gate" / "run"


def _force_rmtree(path: Path) -> None:
    """删掉整棵目录树，先去掉只读位再删。

    **不能只写 `shutil.rmtree(path, ignore_errors=True)`**：git 在 Windows 上把
    `.git/objects` 里的文件设成只读，直接删会失败，而 `ignore_errors=True` 会把失败
    静静吞掉 —— 于是临时仓库每次跑都堆在 temp 里，没人发现。
    （这个坑就是这么撞出来的：跑完一看 temp 里躺了三个。）

    `chmod` 到 `S_IWRITE` 就够了，不用管原来是什么权限。
    """
    for root, dirs, files in os.walk(path):
        for name in dirs + files:
            try:
                os.chmod(os.path.join(root, name), stat.S_IWRITE)
            except OSError:
                pass
    shutil.rmtree(path, ignore_errors=True)


def _cleanup_temp_repos() -> None:
    """删掉本进程建过的所有临时仓库（由 atexit 注册，正常结束与异常退出都会跑到）。"""
    for root in _CLEANUP:
        _force_rmtree(root)


# 用 atexit 而不是在 main() 末尾手写清理：中途抛异常时也要收干净，
# 否则临时仓库会在 temp 目录里越堆越多
atexit.register(_cleanup_temp_repos)


def sh(*args: str) -> subprocess.CompletedProcess:
    """在临时仓库（REPO）里跑一条外部命令，输出按 UTF-8 解码后返回。"""
    return subprocess.run(args, cwd=str(REPO), capture_output=True, text=True,
                          encoding="utf-8", errors="replace")


def gate(cmd: str) -> subprocess.CompletedProcess:
    """跑 `gate.py <cmd> --project <临时仓库>` 并返回执行结果。

    用 `PYEXE`（跑本套件的解释器）而不是 PATH 里的 `python`，见那里的说明。
    """
    return sh(PYEXE, str(GATE), cmd, "--project", str(REPO))


def hook() -> subprocess.CompletedProcess:
    """直接执行 pre-commit 钩子，看它的判决。

    这是整个验证体系里最省事的一环：钩子只用相对路径 + `git write-tree`，
    所以不必真的提交就能预览判决。cwd 必须是仓库根 —— git 调钩子时保证如此，
    这里手动执行也要照做（只读 `git rev-parse` / `write-tree` 的话无所谓，
    但保持一致更省心）。

    `sh` 不在 PATH 时（本机默认就这样）不要让它抛 FileNotFoundError 把整套
    钩子层用例崩掉：先记一条明确的 FAIL，再抛 CaseAborted 交回 main() 收尾，
    这样汇总仍然打得出来、其余用例照常执行。
    """
    if SHEXE is None:
        results.append((
            "钩子层用例无法执行（找不到 sh）",
            False,
            "PATH 与 git 安装位置都没找到 sh，钩子层用例无法执行；其余用例照常执行。"
            "装 Git for Windows 并把它的 bin 目录加进 PATH 后重跑即可。",
        ))
        raise CaseAborted
    return sh(SHEXE, ".githooks/pre-commit")


def raw_ticket(name: str, value: str) -> None:
    """手写一张通行证（含故意的错误值），用来做定向反例。"""
    RUN.mkdir(parents=True, exist_ok=True)
    (RUN / name).write_bytes((value + "\n").encode("ascii"))


def write(name: str, obj, where: Path | None = None) -> None:
    """把标记文件写进运行时目录。where 用于 unborn 那个独立仓库的用例。"""
    target = where or RUN
    target.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, ensure_ascii=False, indent=2) if not isinstance(obj, str) else obj
    (target / name).write_bytes(text.encode("utf-8"))


def check(label: str, expect_code: int, proc: subprocess.CompletedProcess, must_contain: str = "") -> None:
    """断言退出码，并（可选）断言某段文字出现在输出里。

    搜 stdout **和** stderr：gate.py 把结论写在 stdout，而钩子把拒绝理由写在 stderr
    （git 会把钩子的 stderr 转给用户看）。只搜 stdout 的话，钩子的反例用例会
    因为「找不到文案」全部误报失败，而退出码其实全是对的 —— 排查时很容易
    反过来去怀疑钩子。这个坑真踩过。
    """
    ok = proc.returncode == expect_code
    detail = ""
    both = (proc.stdout or "") + (proc.stderr or "")
    if ok and must_contain and must_contain not in both:
        ok = False
        detail = f"输出里没找到 {must_contain!r}\n      stdout: {(proc.stdout or '')[:200]}\n      stderr: {(proc.stderr or '')[:200]}"
    if not ok:
        detail = detail or f"退出码 {proc.returncode}（期望 {expect_code}）\n      {both[:300]}"
    results.append((label, ok, detail))


def begin() -> str:
    """跑一次 begin 并返回本轮的 runId。

    **begin 失败时不去读 context.json**：那时文件根本不存在，`read_text` 会抛
    FileNotFoundError，整套用例以 traceback 中断 —— 连已经 FAIL 的用例都汇总不出来。
    改为记一条 FAIL、再抛 CaseAborted，由 `main()` 接住后照常走到汇总。
    """
    p = gate("begin")
    if p.returncode != 0:
        results.append(("begin 失败（后续用例无法进行）", False,
                        f"退出码 {p.returncode}\n      {(p.stdout or '')[:300]}"))
        raise CaseAborted
    ctx = json.loads((RUN / "context.json").read_text(encoding="utf-8"))
    return ctx["runId"]


def good_tests(run_id: str, changed: list[str], where: Path | None = None) -> None:
    """一次性写齐五个标记文件，造出「三项检查都通过」的正常态：
    tests.json / tests.log / typecheck.json / typecheck.log / quality.json。

    名字只提 tests 是历史遗留。where 传另一个仓库的运行时目录时，
    用于 unborn HEAD 那个独立用例。
    """
    write("tests.json", {
        "schema": 1, "gate": "tests", "runId": run_id, "command": "npm test", "exitCode": 0,
        "total": 146, "passed": 146, "failed": 0, "durationMs": 3870,
        "logPath": ".workbuddy/commit-gate/run/tests.log",
    }, where)
    write("tests.log", "Tests  146 passed (146)\n", where)
    write("typecheck.json", {"schema": 1, "gate": "typecheck", "runId": run_id,
                             "command": "npm run typecheck", "exitCode": 0}, where)
    write("typecheck.log", "> vue-tsc --noEmit\n\n(无输出)\n", where)
    write("quality.json", {
        "schema": 1, "gate": "quality", "runId": run_id, "applicable": True, "tool": "quality-engineer",
        "scope": {"kind": "changed-files", "scanned": changed, "skipped": []},
        "findings": [
            {"id": "Q1", "file": changed[0] if changed else "x.ts", "line": 10, "level": "medium",
             "confidence": "confirmed", "dimension": "other", "title": "示例中等问题"},
        ],
        "counts": {"critical": 0, "high": 0, "medium": 1, "low": 0},
        "confirmed": {"critical": 0, "high": 0},
        "reportPath": ".workbuddy/quality-report.md",
    }, where)


def unborn_head_case() -> None:
    """unborn HEAD（仓库还没有任何提交）时，钩子必须放行。

    这是 HEAD 绑定的边界情形：`git rev-parse HEAD` 在没有任何提交的仓库上会失败，
    now_head 取到空串；而 gate.py 的 head_sha 同样返回空串、PASS.head 里就是
    单独一个空行。两边都是空串 → 判为相等 → 放行。首次提交本来就该放行。

    推理看着没问题，但「空 vs 空」这种相等很容易被某一侧的特殊处理打破
    （比如 read 一个只含空行的文件到底算不算读到了内容），所以实测一遍。
    用全新的临时仓库，不扰动上面那个已经跑了一堆用例的仓库。
    """
    # seed_commit=False：只暂存、不提交，正是 unborn HEAD 的样子
    tmp = make_repo("commit-gate-unborn-", seed_commit=False)

    def r(*args: str) -> subprocess.CompletedProcess:
        """在这个独立临时仓库（tmp）里跑命令 —— 本用例专用的薄封装。"""
        return subprocess.run(args, cwd=str(tmp), capture_output=True, text=True,
                              encoding="utf-8", errors="replace")

    gp = tmp / "tools" / "commit-gate" / "gate.py"
    run = tmp / ".workbuddy" / "commit-gate" / "run"

    p = r(PYEXE, str(gp), "begin", "--project", str(tmp))
    if p.returncode != 0:
        results.append(("T-N2 unborn: begin 应通过", False,
                        f"退出码 {p.returncode}\n      {p.stdout[:300]}"))
        return
    ctx = json.loads((run / "context.json").read_text(encoding="utf-8"))
    if ctx["head"] != "":
        results.append(("T-N2 unborn: context 里 head 应为空串", False, f"实际 {ctx['head']!r}"))
        return

    good_tests(ctx["runId"], ctx["changedFiles"], run)

    p = r(PYEXE, str(gp), "check", "--project", str(tmp))
    if p.returncode != 0:
        results.append(("T-N2 unborn: check 应通过", False,
                        f"退出码 {p.returncode}\n      {p.stdout[:300]}"))
        return
    results.append(("T-N2 unborn: check 通过", True, ""))

    raw = (run / "PASS.head").read_bytes()
    if raw == b"\n":
        results.append(("T-N2 unborn: PASS.head 是单独一个空行", True, ""))
    else:
        results.append(("T-N2 unborn: PASS.head 是单独一个空行", False, f"实际 {raw!r}"))
        return  # 格式都不对，后面的判决没有意义

    if SHEXE is None:
        results.append((
            "T-N2 unborn: 钩子放行",
            False,
            "PATH 与 git 安装位置都没找到 sh，钩子层用例无法执行",
        ))
    else:
        check("T-N2 unborn: 钩子放行", 0, r(SHEXE, ".githooks/pre-commit"))


def non_ascii_path_case() -> None:
    """非 ASCII 文件名必须出现在变更清单里。

    防的是 git 的 `core.quotePath=true`（默认）：它会把 `src/账单解析.py`
    输出成 `"src/\\350\\264\\246..."` 这种**带引号的八进制转义**，于是
    `(project / n).exists()` 永远为假、这个文件被静默踢出变更清单。
    后果不是报错而是**质量检查被整体跳过**：changedFiles 变空 → qualityRequired
    变假 → begin 打印「不需要质量检查」并照发通行证，全程没有任何提示。
    修法是给 `git diff` 加 `-z`（NUL 分隔、不做转义）。

    是本项目特别该防的一类：仓库目录本身就叫「将军记账」。
    """
    tmp = make_repo("commit-gate-quote-")
    name = "src/账单解析.py"
    (tmp / name).write_text("x = 1\n", encoding="utf-8")

    def g(*args: str) -> None:
        """在这个临时仓库里跑 git，丢弃结果。"""
        subprocess.run(["git", *args], cwd=str(tmp), capture_output=True)

    g("add", "-A")

    gp = tmp / "tools" / "commit-gate" / "gate.py"
    proc = subprocess.run([PYEXE, str(gp), "begin", "--project", str(tmp)],
                          capture_output=True, text=True, encoding="utf-8", errors="replace")
    ctx_path = tmp / ".workbuddy" / "commit-gate" / "run" / "context.json"
    if proc.returncode != 0 or not ctx_path.exists():
        results.append(("T-Q2 非 ASCII 文件名: begin 应通过", False, proc.stdout[:200]))
        return

    ctx = json.loads(ctx_path.read_text(encoding="utf-8"))
    listed = name in ctx.get("changedFiles", [])
    results.append((
        "T-Q2 非 ASCII 文件名必须进变更清单（漏了等于静默跳过质量检查）",
        listed,
        "" if listed else f"changedFiles={ctx.get('changedFiles')!r}",
    ))
    results.append((
        "T-Q2 非 ASCII 文件名 -> qualityRequired 应为真",
        ctx.get("qualityRequired") is True,
        "" if ctx.get("qualityRequired") else "被误判成「不需要质量检查」",
    ))


def quality_not_required_case() -> None:
    """纯文档变更时 qualityRequired 必须为假。

    没有这个负例，`quality_applicable()` 被写成**恒真**也照样过 T-E 那条断言
    （它只钉「必须有质量检查」那一侧）。这一条钉另一侧：真的不需要时不能硬要求 ——
    否则改一行文档也要被迫跑一遍质量检查，门禁会因为无谓的摩擦而被绕过。

    做法：在独立临时仓库里只新增一个 `README.md`（`.md` 不在 `QUALITY_EXTENSIONS` 里）。
    `make_repo` 已经把其余文件都提交进 seed commit 了，所以变更清单里只有它。
    """
    tmp = make_repo("commit-gate-doconly-")
    (tmp / "README.md").write_text("x\n", encoding="utf-8")

    def gg(*args: str) -> None:
        """在这个临时仓库里跑 git，丢弃结果。"""
        subprocess.run(["git", *args], cwd=str(tmp), capture_output=True)

    gg("add", "-A")

    gp = tmp / "tools" / "commit-gate" / "gate.py"
    proc = subprocess.run([PYEXE, str(gp), "begin", "--project", str(tmp)],
                          capture_output=True, text=True, encoding="utf-8", errors="replace")
    ctx_path = tmp / ".workbuddy" / "commit-gate" / "run" / "context.json"
    if proc.returncode != 0 or not ctx_path.exists():
        results.append(("T-Q8 纯文档变更: begin 应通过", False, proc.stdout[:300]))
        return

    ctx = json.loads(ctx_path.read_text(encoding="utf-8"))
    results.append((
        "T-Q8 纯文档变更 -> qualityRequired 应为假",
        ctx.get("qualityRequired") is False,
        "" if ctx.get("qualityRequired") is False
        else f"实际 {ctx.get('qualityRequired')!r} —— 改一行文档也要跑质量检查",
    ))


def _case_pass_path() -> None:
    """T-E: 完整通过路径 + 通行证文件（tree/head）内容校验。

    这条守的是「quality_applicable 退化成恒假」：那种情况下质量检查被整体跳过、
    quality.json 不再被要求，而门禁对此毫无提示。实测植 bug 确认过它会 FAIL。

    **但它守不到「.py 被从 QUALITY_EXTENSIONS 里删掉」**：本用例的变更里含
    `src/demo.ts`，光靠 ".ts" 就足以让 qualityRequired 为真 —— 这也实测过。
    那个场景由 T-Q2 负责（它用的是 `src/账单解析.py`，唯一的源码扩展名就是 .py）。

    PASS.tree / PASS.head 必须逐字节等于 `<值>\n`（不带 CR）——文本模式写 CRLF
    会让 shell 的 read 拿到尾部 \r，表现为每次提交都被拒。
    """
    rid = begin()
    ctx = json.loads((RUN / "context.json").read_text(encoding="utf-8"))
    # 直接断言 context.json 的值。**不要**写成 check(..., must_contain="需要") ——
    # 子串「不需要」里就含着「需要」，两种结果都会判成通过，那条断言永远不可能失败；
    # 而且它的断言对象是手工构造的 CompletedProcess，根本没碰 begin 的真实输出。
    results.append((
        "T-E begin 的 qualityRequired 为真（本次变更含源码）",
        ctx["qualityRequired"] is True,
        "" if ctx["qualityRequired"] is True
        else f"实际 {ctx['qualityRequired']!r} —— 质量检查会被整体跳过、且没有任何提示",
    ))
    good_tests(rid, ctx["changedFiles"])
    p = gate("check")
    check("T-E 全部就绪 -> 签发通行证", 0, p, "可以提交了")
    ok_tree = False
    ticket = RUN / "PASS.tree"
    if ticket.exists():
        # 必须是 <tree>\n 且**不带 CR**（Python 文本模式会写 CRLF，那会让
        # shell 的 read 拿到尾部 \r，表现为每次提交都被拒）
        raw = ticket.read_bytes()
        ok_tree = raw == (ctx["tree"] + "\n").encode("ascii")
        if not ok_tree:
            results.append(("T-E PASS.tree 内容异常", False, f"实际字节: {raw!r}"))
    else:
        results.append(("T-E PASS.tree 未生成", False, "check 通过却没写通行证"))
    if ok_tree:
        results.append(("T-E PASS.tree 内容正确（无 CR）", True, ""))

    # PASS.head 必须与 context.json 记的 head 一致 —— 它是钩子侧「这张通行证
    # 还没被用掉」的判据，写错了会让所有提交都被拒，所以要和 PASS.tree 一样较真。
    headticket = RUN / "PASS.head"
    if not headticket.exists():
        results.append(("T-E PASS.head 未生成", False, "check 通过却没写 HEAD 绑定文件"))
    else:
        want = ((ctx["head"] or "") + "\n").encode("ascii")
        got = headticket.read_bytes()
        if got == want:
            results.append(("T-E PASS.head 内容正确", True, ""))
        else:
            results.append(("T-E PASS.head 内容异常", False, f"期望 {want!r}，实际 {got!r}"))


def _case_tests_typecheck() -> None:
    """T-F / T-G: 测试日志与类型检查的两个反例。"""
    # T-F: tests.log 与 tests.json 数字不符
    rid = begin()
    ctx = json.loads((RUN / "context.json").read_text(encoding="utf-8"))
    good_tests(rid, ctx["changedFiles"])
    write("tests.log", "Tests  999 passed (999)\n")
    check("T-F tests.json 与 tests.log 不符 -> 拒绝", 1, gate("check"), "对不上")

    # T-G: typecheck 日志里出现错误
    rid = begin()
    ctx = json.loads((RUN / "context.json").read_text(encoding="utf-8"))
    good_tests(rid, ctx["changedFiles"])
    write("typecheck.log", "src/demo.ts(3,7): error TS2304: Cannot find name 'foo'.\n")
    check("T-G 类型错误 -> 拒绝", 1, gate("check"), "类型检查没通过")


def _case_quality_fields() -> None:
    """T-H / T-I / T-J / T-K: quality.json 字段与阻断阈值的几个反例。"""
    # T-H: quality 的 counts 与 findings 明细不符
    rid = begin()
    ctx = json.loads((RUN / "context.json").read_text(encoding="utf-8"))
    good_tests(rid, ctx["changedFiles"])
    q = json.loads((RUN / "quality.json").read_text(encoding="utf-8"))
    q["counts"] = {"critical": 0, "high": 0, "medium": 7, "low": 0}  # 谎报
    write("quality.json", q)
    check("T-H counts 与明细不符 -> 拒绝", 1, gate("check"), "对不上")

    # T-I: quality 漏扫了变更文件
    rid = begin()
    ctx = json.loads((RUN / "context.json").read_text(encoding="utf-8"))
    good_tests(rid, ["某个没扫的文件.ts"])
    check("T-I 漏扫变更文件 -> 拒绝", 1, gate("check"), "漏扫")

    # T-J: 有 confirmed high -> 按阈值阻断
    rid = begin()
    ctx = json.loads((RUN / "context.json").read_text(encoding="utf-8"))
    good_tests(rid, ctx["changedFiles"])
    q = json.loads((RUN / "quality.json").read_text(encoding="utf-8"))
    q["findings"] = [{"id": "Q2", "file": "src/demo.ts", "line": 5, "level": "high",
                      "confidence": "confirmed", "dimension": "other", "title": "空捕获吞掉写入失败"}]
    q["counts"] = {"critical": 0, "high": 1, "medium": 0, "low": 0}
    q["confirmed"] = {"critical": 0, "high": 1}
    write("quality.json", q)
    check("T-J confirmed high -> 拒绝并列出条目", 1, gate("check"), "空捕获吞掉写入失败")

    # T-K: 同样一条 high，但标成「疑似」-> 不该阻断
    rid = begin()
    ctx = json.loads((RUN / "context.json").read_text(encoding="utf-8"))
    good_tests(rid, ctx["changedFiles"])
    q = json.loads((RUN / "quality.json").read_text(encoding="utf-8"))
    q["findings"] = [{"id": "Q3", "file": "src/demo.ts", "line": 5, "level": "high",
                      "confidence": "suspected", "dimension": "other", "title": "疑似问题"}]
    q["counts"] = {"critical": 0, "high": 1, "medium": 0, "low": 0}
    q["confirmed"] = {"critical": 0, "high": 0}
    write("quality.json", q)
    check("T-K 疑似不计入阻断 -> 通过", 0, gate("check"), "可以提交了")


def _case_revoke_fingerprint() -> None:
    """T-L: revoke 幂等；T-M: 检查期间索引被改 -> 拒绝。"""
    # T-L: revoke 幂等
    check("T-L revoke 第一次", 0, gate("revoke"), "已撤销")
    check("T-L revoke 第二次（幂等）", 0, gate("revoke"), "已撤销")
    check("T-L revoke 后 PASS.tree 确实没了", 0,
          subprocess.CompletedProcess([], 0 if not (RUN / "PASS.tree").exists() else 1))

    # T-M: 指纹变化 -> 拒绝
    rid = begin()
    ctx = json.loads((RUN / "context.json").read_text(encoding="utf-8"))
    good_tests(rid, ctx["changedFiles"])
    (REPO / "src" / "demo.ts").write_text("export const x = 2\n", encoding="utf-8")
    sh("git", "add", "-A")
    check("T-M 检查期间索引被改 -> 拒绝", 1, gate("check"), "被改动")
    sh("git", "checkout", "--", "src/demo.ts")
    sh("git", "reset", "-q")
    # T-M 的收尾用 `git reset -q` 清空索引来还原自己造成的改动，而 begin 要求
    # 「工作区 == 暂存区」。**下面两段都要有暂存状态**，所以在这里统一补一次，
    # 只此一处 —— 不补的话 begin 会以「工作区还有没暂存的改动」拒绝，
    # 而那个报错指向的是门禁，实际是测试自己的收尾动作留下的，很容易查错方向。
    sh("git", "add", "-A")


def _case_quality_json_shape_a() -> None:
    """T-Q1 / T-Q3 / T-Q4: quality.json 形状异常的几个反例（退出码必须归到 1）。"""
    # T-Q1: findings 里混入非对象。
    # 这条是回归保护：早先这里会抛 AttributeError，被 main() 归成**退出码 2**
    # 「脚本自己出错」——而按 gate.py 自己的设计，2 的含义是「该我修脚本」，
    # 会把排查方向从那份 json 引到 gate.py 上。所以断言的是**退出码 1 + 明确的文案**。
    # 顺带说明为什么不能用「跳过非对象」来修：跳过会把一条可能是真问题的条目
    # 悄悄丢掉、还给出「通过」。这里必须拒绝。
    rid = begin()
    ctx = json.loads((RUN / "context.json").read_text(encoding="utf-8"))
    good_tests(rid, ctx["changedFiles"])
    q = json.loads((RUN / "quality.json").read_text(encoding="utf-8"))
    q["findings"] = ["[high] 空捕获吞掉写盘失败"]        # 一行文字，不是对象
    q["counts"] = {"critical": 0, "high": 0, "medium": 0, "low": 0}
    q["confirmed"] = {"critical": 0, "high": 0}
    write("quality.json", q)
    check("T-Q1 findings 混入非对象 -> 拒绝（退出码 1，不是脚本出错 2）", 1,
          gate("check"), "不是对象")

    # T-Q3 / T-Q4: 另外两处「报错指错方向」的同类漏洞。
    # 它们原先都会抛 AttributeError → 被归成退出码 2「脚本自己出错」，
    # 而 2 的含义是「该我修脚本」。断言退出码 1 才说明归对了类。
    rid = begin()
    ctx = json.loads((RUN / "context.json").read_text(encoding="utf-8"))
    good_tests(rid, ctx["changedFiles"])
    write("quality.json", "[1, 2, 3]")     # 顶层是数组，不是对象
    check("T-Q3 quality.json 顶层是数组 -> 拒绝（退出码 1）", 1,
          gate("check"), "读不出对象")

    rid = begin()
    ctx = json.loads((RUN / "context.json").read_text(encoding="utf-8"))
    good_tests(rid, ctx["changedFiles"])
    q = json.loads((RUN / "quality.json").read_text(encoding="utf-8"))
    q["scope"] = "changed-files"           # 应为对象，写成了字符串
    write("quality.json", q)
    check("T-Q4 scope 写成字符串 -> 拒绝（退出码 1）", 1,
          gate("check"), "scope 不是对象")


def _case_quality_json_shape_b() -> None:
    """T-Q5 / T-Q6 / T-Q7: 取值越界与类型错误（必须显式拒绝，不许静默放行）。"""
    # T-Q5 / T-Q6: findings 的 level / confidence 取值不在已知集合。
    # 这两条守的是**fail-open**：取值拼错（手滑写成 "hight"，或照抄了 security-audit
    # 输出的 `severity`）时，histogram 的 `if value in counts` 会静默跳过它 ——
    # 既不计数、也不进阻断阈值；counts 又恰巧全 0 的话核对还正好对得上，
    # 于是一条真的 critical 无声通过。实测复现过。
    # 所以断言的不是「报错」，而是**退出码 1**：必须显式拒绝，不许跳过。
    rid = begin()
    ctx = json.loads((RUN / "context.json").read_text(encoding="utf-8"))
    good_tests(rid, ctx["changedFiles"])
    q = json.loads((RUN / "quality.json").read_text(encoding="utf-8"))
    q["findings"] = [{"id": "Q1", "file": ctx["changedFiles"][0], "line": 1,
                      "level": "hight", "confidence": "confirmed",
                      "dimension": "logic-guard", "title": "真问题被拼错成 hight"}]
    q["counts"] = {"critical": 0, "high": 0, "medium": 0, "low": 0}   # 全 0 时旧逻辑会放行
    q["confirmed"] = {"critical": 0, "high": 0}
    write("quality.json", q)
    check("T-Q5 level 拼错成 hight 且 counts 全 0 -> 拒绝（不能静默放行）", 1,
          gate("check"), "level 不在")

    rid = begin()
    ctx = json.loads((RUN / "context.json").read_text(encoding="utf-8"))
    good_tests(rid, ctx["changedFiles"])
    q = json.loads((RUN / "quality.json").read_text(encoding="utf-8"))
    q["findings"][0]["confidence"] = "high"      # 把严重度误填进了 confidence
    write("quality.json", q)
    check("T-Q6 confidence 取值不规范 -> 拒绝（退出码 1）", 1,
          gate("check"), "confidence 不在")

    # T-Q7: scope.scanned 的元素不是字符串。
    # 与 T-Q3/T-Q4 同源：元素不可哈希时 `set(scanned)` 会抛 TypeError，
    # 冒到 main() 兜底被归成退出码 2「脚本自己出错」，把排查方向从这份 json
    # 引到 gate.py 上。断言退出码 1 才说明归对了类。
    rid = begin()
    ctx = json.loads((RUN / "context.json").read_text(encoding="utf-8"))
    good_tests(rid, ctx["changedFiles"])
    q = json.loads((RUN / "quality.json").read_text(encoding="utf-8"))
    q["scope"]["scanned"] = [{"path": ctx["changedFiles"][0]}]
    write("quality.json", q)
    check("T-Q7 scope.scanned 含非字符串元素 -> 拒绝（退出码 1，不是脚本出错 2）", 1,
          gate("check"), "不是字符串")


def _case_hook_head_binding() -> None:
    """T-H0..T-H7: 钩子层 / HEAD 绑定那一组（依赖 sh）。

    没有 sh 时，这里的第一个 hook() 会记 1 条 FAIL 并抛 CaseAborted，
    由 main() 接住收尾；本组其余用例不再执行（也不该执行）。

    这一组专门验 HEAD 绑定：它是「一张通行证只对应一次提交」的机器强制手段。
    而撤销通行证的动作用户已拍板只放在 gitcommit-agent 里，所以这道兜底不能失效。
    （暂存区已经在上面统一重整过了，这里直接用。）
    """
    rid = begin()
    ctx = json.loads((RUN / "context.json").read_text(encoding="utf-8"))
    good_tests(rid, ctx["changedFiles"])
    check("T-H0 先签出一张有效通行证", 0, gate("check"), "可以提交了")
    check("T-H1 tree + HEAD 都匹配 -> 放行", 0, hook())

    # 没有通行证 -> 直接拒（门禁最基本的行为）
    (RUN / "PASS.tree").unlink(missing_ok=True)
    check("T-H2 没有通行证 -> 拒绝", 1, hook(), "没有通行证")

    # 只有 tree 没有 head -> 拒。旧版 gate.py 签发的通行证无法确认有没有被用掉，
    # 宁可让人重跑一轮，也不能放行一张来历不明的通行证。
    raw_ticket("PASS.tree", ctx["tree"])
    (RUN / "PASS.head").unlink(missing_ok=True)
    check("T-H3 缺少 PASS.head -> 拒绝", 1, hook(), "缺少 HEAD 绑定")

    # tree 对但 HEAD 被伪造成别的值 -> 拒（等价于「这张通行证已经被用掉了」）
    raw_ticket("PASS.head", "0" * 40)
    check("T-H4 PASS.head 对不上当前 HEAD -> 拒绝", 1, hook(), "不是针对当前 HEAD")

    # tree 对不上 -> 拒
    raw_ticket("PASS.head", ctx["head"])
    raw_ticket("PASS.tree", "1" * 40)
    check("T-H5 PASS.tree 对不上索引 -> 拒绝", 1, hook(), "tree 不匹配")

    # T-H6 / T-H7：真实提交。这是唯一能证明「提交一发生，旧通行证立刻失效」的用例 ——
    # T-H4 伪造 PASS.head 只证明了比对逻辑是对的，证明不了 HEAD 真的会动。
    #
    # 判据的关键：**提交不改变索引**，所以提交完 tree 仍然匹配，
    # 能挡下它的只可能是新加的 HEAD 那一关。下面专门断言了这一点，
    # 否则万一 tree 也变了，这个用例就变成了在验别的分支而不自知。
    rid = begin()
    ctx = json.loads((RUN / "context.json").read_text(encoding="utf-8"))
    good_tests(rid, ctx["changedFiles"])
    check("T-H6 提交前先签通行证", 0, gate("check"), "可以提交了")
    p = sh("git", "commit", "-m", "gate-e2e: verify one-shot ticket")
    committed = p.returncode == 0
    results.append((
        "T-H6 带有效通行证的真实提交成功（钩子真的在跑）",
        committed,
        "" if committed else f"退出码 {p.returncode}\n      {(p.stderr or p.stdout)[:400]}",
    ))
    if committed:
        same_tree = sh("git", "write-tree").stdout.strip() == ctx["tree"]
        results.append((
            "T-H6 提交后索引 tree 未变（确保 T-H7 验的是 HEAD 那一关）",
            same_tree,
            "" if same_tree else "tree 也变了 —— T-H7 会在 tree 那一关被拒，就验不到 HEAD 绑定了",
        ))
        check("T-H7 提交后同一张通行证（未撤销）-> 拒绝", 1, hook(), "不是针对当前 HEAD")
        sh("git", "reset", "--soft", "HEAD~1")


def _case_in_progress_markers() -> None:
    """T-X0..T-X: 中途操作豁免（回归保护）+ 不受管仓库放行。

    阶段 1 只手工验过这一组（T8），一直没进自动化套件。但按当时的结论它是
    「**必须**而不是保险」——没有它连冲突合并都收不了尾。而那种退化只会在
    你正收尾冲突的时候才暴露，所以这里补上。
    """
    if SHEXE is None:
        # 本组全部依赖钩子。**不要**靠「上面的钩子组已经抛过 CaseAborted」来保证
        # 这里不为空 —— 那只在两组顺序不变时成立，而顺序是会被改的（刚被改过一次）。
        # 守卫写在这里，就不依赖任何调用次序。
        results.append((
            "T-X 中途操作豁免组无法执行（找不到 sh）",
            False,
            "PATH 与 git 安装位置都没找到 sh；本组全部用例依赖钩子。",
        ))
        return

    (RUN / "PASS.tree").unlink(missing_ok=True)
    (RUN / "PASS.head").unlink(missing_ok=True)

    check("T-X0 无通行证、无中途标记 -> 拒绝", 1, hook(), "没有通行证")

    for marker in ("MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer"):
        target = REPO / ".git" / marker
        target.write_text("x\n", encoding="utf-8")
        check(f"T-X 中途 {marker} -> 放行", 0, hook())
        target.unlink()

    for marker in ("rebase-merge", "rebase-apply"):
        target = REPO / ".git" / marker
        target.mkdir(exist_ok=True)
        check(f"T-X 中途 {marker}/ -> 放行", 0, hook())
        target.rmdir()

    check("T-X 标记全部清掉后 -> 恢复拒绝", 1, hook(), "没有通行证")

    # 不受管的仓库必须直接放行 —— 防止将来有人设了全局 core.hooksPath 误伤别的仓库
    # 这里要换 cwd，所以没用 sh() 那个助手；但解释器一样得用 SHEXE，不能写死 "sh"
    # （写死会在没有它的机器上抛 FileNotFoundError，把这一组用例整段打断）
    other = make_repo("commit-gate-unmanaged-", managed=False)
    proc = subprocess.run([SHEXE, ".githooks/pre-commit"], cwd=str(other), capture_output=True)
    results.append((
        "T-X 不受管的仓库（没有 gate.py）-> 直接放行",
        proc.returncode == 0,
        "" if proc.returncode == 0 else f"退出码={proc.returncode}",
    ))


def _run_cases() -> None:
    """跑完所有用例，只把结果记进 `results`；不做汇总、不返回退出码。

    与 `main()` 拆开，是为了**不必给这几百行用例体加一层缩进**就能兜住异常：
    搬进独立函数之后，`main()` 里一个 try/except 就覆盖了全部用例。
    手动重缩进那么大一块的风险，比这个拆分本身大得多。

    具体的用例体按组切到上面的 _case_*()，本函数只做装配（建仓库 + 暂存）
    和调度。三个不依赖 sh 的用例挪到钩子组之前：没有 sh 时它们仍会被执行到。
    """
    # 建临时仓库。core.hooksPath 已经在 make_repo 里设好 ——
    # T-H6 靠一次真实提交来证明 HEAD 会前移，钩子没接上的话那个用例就变成了一句空话。
    setup_repo()

    # 准备：让变更里包含 .ts 文件，这样 qualityRequired 为真。
    # 注意**只暂存、不提交** —— 门禁流程的前提就是「改动已 git add 但还没 commit」，
    # begin 拿 git diff --cached HEAD 算变更清单。先提交掉的话清单就是空的。
    #
    # 内容每次都不同：文件可能已经被之前几轮提交进 HEAD 了，
    # 写死内容的话 diff 为空，qualityRequired 会静默变成 false，测试就假通过了。
    ts = REPO / "src" / "demo.ts"
    ts.parent.mkdir(parents=True, exist_ok=True)
    ts.write_text(f"export const x = {int(time.time() * 1000)}\n", encoding="utf-8")
    sh("git", "add", "-A")

    (RUN / "PASS.json").unlink(missing_ok=True)
    (RUN / "PASS.tree").unlink(missing_ok=True)

    # 质量标记字段校验那一组（不依赖 sh）
    _case_pass_path()
    _case_tests_typecheck()
    _case_quality_fields()
    _case_revoke_fingerprint()
    _case_quality_json_shape_a()
    _case_quality_json_shape_b()

    # 三个不依赖 sh 的用例，挪到钩子组之前执行：
    # 这样即使 PATH 里没有 sh，它们仍会被执行到，而不是被钩子组的崩溃吞掉。
    unborn_head_case()
    non_ascii_path_case()
    quality_not_required_case()

    # 钩子层 / HEAD 绑定（依赖 sh）。没有 sh 时 hook() 记 1 条 FAIL 并抛 CaseAborted，
    # 由 main() 接住收尾；其余（T-X 那一组）随之不再执行——它们同样依赖 sh。
    _case_hook_head_binding()
    _case_in_progress_markers()

    # 汇总不在这里打 —— 挪到 main()，因为异常路径下也必须打得出来（见那里的说明）


def _print_results() -> int:
    """逐条打印结果与合计，返回失败条数。

    单独抽出来是为了**异常路径也能打到**：它不碰任何用例状态，只读 `results`。
    """
    print()
    failed = 0
    for label, ok, detail in results:
        mark = "PASS" if ok else "FAIL"
        print(f"  [{mark}] {label}")
        if not ok:
            failed += 1
            print(f"         {detail}")
    print()
    print(f"  共 {len(results)} 项，失败 {failed} 项")
    return failed


def main() -> int:
    """跑完整套用例并汇总。返回 0 = 全部通过 / 1 = 有失败。

    **用例体包在 try 里，是为了保证汇总一定打得出来。** 前提一旦失败
    （`begin` 被拒、解释器找不到…），早先会以 traceback 中断，前面已经 FAIL
    的用例连汇总都印不出来 —— 看起来像「什么都没跑」。现在那类失败会被记成
    一条 FAIL 并抛 `CaseAborted`，由这里接住后照常走到汇总。
    """
    # 中文输出必须显式 UTF-8：Windows 上 Python 默认按 GBK 写 stdout，
    # 打印中文会直接抛 UnicodeEncodeError（阶段 0 踩过同一个坑）
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    try:
        _run_cases()
    except CaseAborted:
        pass  # begin() 已经记过 FAIL，继续往下走到汇总
    except Exception:
        # 意料之外的异常同样不能让汇总丢掉 —— 「跑过但看不出结论」是最坏的结果。
        # 记一条 FAIL 把栈带出来，然后照常汇总。
        results.append(("套件因未预期的异常中断", False, traceback.format_exc()[:2000]))
    return 1 if _print_results() else 0


if __name__ == "__main__":
    sys.exit(main())
