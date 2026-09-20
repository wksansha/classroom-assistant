/**
 * 课堂实时演示脚本：先报错，2分钟后解决
 * 用法：node tools/demo-error-resolution.js
 */
const URL = 'http://localhost:3000';
const STUDENT = {
  student_id: 'demo-stu001',
  student_name: '演示学生',
  class_id: '3A',
  timestamp: new Date().toISOString(),
};

async function post(body) {
  const res = await fetch(`${URL}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`上报失败 ${res.status}`);
  return res.json();
}

async function main() {
  console.log('\n[Demo] 开始：学生上报编程错误');
  const error = await post({
    ...STUDENT,
    event_type: 'run',
    raw_message: 'expected ":"',
    error_type: 'SyntaxError',
    error_message: 'expected ":"',
    exit_code: 1,
    file_path: 'simple_functions.py',
    line_no: 12,
    command: 'python simple_functions.py',
    source: 'terminal',
  });
  console.log('[Demo] 错误已上报:', JSON.stringify(error));

  console.log(`\n[Demo] 等待 120 秒，模拟学生思考/修复过程...`);
  await new Promise((resolve) => setTimeout(resolve, 120_000));

  console.log('\n[Demo] 学生解决错误，上报成功结果');
  const success = await post({
    ...STUDENT,
    timestamp: new Date().toISOString(),
    event_type: 'run',
    raw_message: 'run success',
    error_type: 'RunSuccess',
    error_message: '',
    exit_code: 0,
    command: 'python simple_functions.py',
    source: 'terminal',
  });
  console.log('[Demo] 成功结果已上报:', JSON.stringify(success));

  console.log('\n[Demo] 演示结束。打开 http://localhost:5173 查看仪表盘变化：');
  console.log('  1. 学生矩阵：该学生状态从黄色（需要关注）变为绿色（正常）');
  console.log('  2. 错误聚合：该错误类型计数增加，学生列表出现该学生');
  console.log('  3. 教学建议：根据错误比例可能显示讲解/讨论/个别辅导建议');
  console.log('  4. 学生抽屉：能看到完整事件历史（错误 → 成功解决）');
  console.log('  5. 所有变化通过 SSE 实时推送，无需刷新页面');
}

main().catch((err) => {
  console.error('[Demo] 演示失败:', err.message);
  process.exit(1);
});
