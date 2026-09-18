/**
 * 学生端模拟器（升级版）
 * 发送与 learner reporter 完全一致的 flat 格式。
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

async function post(body) {
  const res = await fetch(`${URL}/api/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error(`[Sim] 上报失败 ${res.status}`);
}

function nextEvent() {
  const i = Math.floor(Math.random() * N);
  const student = {
    student_id: `stu${String(i + 1).padStart(3, "0")}`,
    student_name: NAMES[i % NAMES.length],
    class_id: "3A",
    timestamp: new Date().toISOString(),
  };
  if (Math.random() < SUCCESS_RATIO) {
    return { ...student, event_type: "run", raw_message: "run success", error_type: "RunSuccess", error_message: "", exit_code: 0, command: "python simple_functions.py", source: "terminal" };
  }
  if (Math.random() < 0.5) {
    const sample = pick(DIAG_SAMPLES);
    return { ...student, event_type: "diag", raw_message: sample, samples: [sample], file_path: "simple_functions.py" };
  }
  const e = pick(RUN_ERRORS);
  return { ...student, event_type: "run", raw_message: e.error_message, error_type: e.error_type, error_message: e.error_message, exit_code: 1, file_path: e.file, line_no: e.line, command: "python simple_functions.py", source: "terminal" };
}

let sent = 0;
console.log(`[Sim] ${N} 名学生 → ${URL}，间隔 ${INTERVAL}ms，成功率 ${SUCCESS_RATIO}`);
(async function loop() {
  while (true) {
    await post(nextEvent());
    sent++;
    if (sent % 20 === 0) console.log(`[Sim] 已发送 ${sent} 条`);
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
})();