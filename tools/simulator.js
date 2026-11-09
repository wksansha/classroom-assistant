/**
 * 学生端模拟器（L1 统一入库版）
 * 发送 /api/events 新格式：TraceEvent 原样平铺 + { id, ts, surface, kind, payload, student_id, student_name, class_id }。
 * id 随机生成（<surface>: 前缀 + base36 时间戳 + 随机段），重跑不会撞幂等。
 * 用法：node tools/simulator.js [--url=http://localhost:3000] [--students=20] [--interval=2000] [--success-ratio=0.3]
 */
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  }),
);
const URL = args.url || "http://localhost:3000";
const N = parseInt(args.students || "3", 10);
const INTERVAL = parseInt(args.interval || "2000", 10);
const SUCCESS_RATIO = parseFloat(args["success-ratio"] || "0.3");

const NAMES = ["张三","李四","王五","赵六","钱七","孙八","周九","吴十","郑一","王二","冯三","陈四","褚五","卫六","蒋七","沈八","韩九","杨十","朱一","秦二"];

// 错误代码片段（围绕错误行前后 3 行）
const CODE_SNIPPETS = {
  "expected \":\"": [
    "def greet():",
    "    print(\"Hello\")",
    "if __name__ = \"__main__\":",
    "    greet()",
  ].join("\n"),
  "division by zero": [
    "def divide(a, b):",
    "    return a / b",
    "",
    "print(divide(10, 0))",
  ].join("\n"),
  "expected an indented block": [
    "def hello():",
    "print(\"Hello\")",
    "",
    "hello()",
  ].join("\n"),
  "name 'totl' is not defined": [
    "def calculate():",
    "    result = totl + 1",
    "    return result",
    "",
    "calculate()",
  ].join("\n"),
  "can only concatenate str (not \"int\") to str": [
    "def greet(name):",
    "    print(\"Hello \" + name + 1)",
    "",
    "greet(\"Alice\")",
  ].join("\n"),
};

// 真实样本（沿用 demo，来自 pylearner 实际记录）
const DIAG_SAMPLES = [
  '应为 ":"',
  "Expected an indented block",
  "name 'x' is not defined",
  "unsupported operand type(s) for +: 'str' and 'int'",
  "list index out of range",
];
const RUN_ERRORS = [
  { error_type: "SyntaxError", error_message: 'expected ":"' },
  { error_type: "ZeroDivisionError", error_message: "division by zero", file: "simple_functions.py", line: 30 },
  { error_type: "IndentationError", error_message: "expected an indented block" },
  { error_type: "NameError", error_message: "name 'totl' is not defined", file: "simple_functions.py", line: 12 },
  { error_type: "TypeError", error_message: 'can only concatenate str (not "int") to str' },
];

const pick = (a) => a[Math.floor(Math.random() * a.length)];

function codeSnippetFor(rawMessage) {
  return CODE_SNIPPETS[rawMessage] ?? "（未捕获到代码片段）";
}

// 服务端 EVENT_ID_PATTERN: ^<surface>:[0-9A-Za-z-]{6,64}$
function eventId(surface) {
  return `${surface}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function post(body) {
  const res = await fetch(`${URL}/api/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error(`[Sim] 上报失败 ${res.status}`);
}

// ── 登录态在线模型三信号：identity_confirmed（启动一次）+ heartbeat（60s 一拍）──
// 不发这两类信号的学生在服务端登录态模型下永不在线，大屏矩阵显示灰色、
// 急需帮助告警会排除离线学生。machine_id 稳定复用，幂等重跑安全。
const machineId = (sid) => `sim-machine-${sid}`;

function students() {
  return Array.from({ length: N }, (_, i) => ({
    student_id: `stu${String(i + 1).padStart(3, "0")}`,
    student_name: NAMES[i % NAMES.length],
    class_id: "3A",
  }));
}

async function loginStudent(s) {
  await post({
    id: eventId("behavior"), ts: new Date().toISOString(),
    surface: "behavior", kind: "identity_confirmed",
    payload: { machine_id: machineId(s.student_id) },
    ...s,
  });
}

async function heartbeat(s) {
  const res = await fetch(`${URL}/api/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      student_id: s.student_id, student_name: s.student_name,
      machine_id: machineId(s.student_id),
    }),
  });
  if (!res.ok) console.error(`[Sim] 心跳失败 ${res.status} ${s.student_id}`);
}

function nextEvent() {
  const i = Math.floor(Math.random() * N);
  const student = {
    student_id: `stu${String(i + 1).padStart(3, "0")}`,
    student_name: NAMES[i % NAMES.length],
    class_id: "3A",
  };
  if (Math.random() < SUCCESS_RATIO) {
    return {
      id: eventId("run"), ts: new Date().toISOString(), surface: "run", kind: "execution_success",
      payload: { command: "python simple_functions.py", exit_code: 0 },
      ...student,
    };
  }
  if (Math.random() < 0.5) {
    const sample = pick(DIAG_SAMPLES);
    return {
      id: eventId("diag"), ts: new Date().toISOString(), surface: "diag", kind: "diagnostics_change",
      payload: { file: "simple_functions.py", samples: [sample], errors: 1, code_snippet: codeSnippetFor(sample) },
      ...student,
    };
  }
  const e = pick(RUN_ERRORS);
  return {
    id: eventId("run"), ts: new Date().toISOString(), surface: "run", kind: "execution_error",
    payload: {
      command: "python simple_functions.py", exit_code: 1,
      error_type: e.error_type, error_message: e.error_message,
      file: e.file, line: e.line,
      code_snippet: codeSnippetFor(e.error_message),
    },
    ...student,
  };
}

let sent = 0;
console.log(`[Sim] ${N} 名学生 → ${URL}，间隔 ${INTERVAL}ms，成功率 ${SUCCESS_RATIO}`);
(async function loop() {
  const roster = students();
  for (const s of roster) await loginStudent(s);           // 启动先确认身份点亮在线
  setInterval(() => { for (const s of roster) void heartbeat(s); }, 60_000);
  while (true) {
    await post(nextEvent());
    sent++;
    if (sent % 20 === 0) console.log(`[Sim] 已发送 ${sent} 条`);
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
})();
