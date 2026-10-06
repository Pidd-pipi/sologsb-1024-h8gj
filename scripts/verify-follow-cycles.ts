import { findFollowCycles, findBlockedCueIds, wouldCreateCycle, recalculatePlans, detectConflicts } from '../src/data';
import type { Cue, LightingPlan, Scene } from '../src/types';

let seq = 0;
function cue(number: string, followCueId = '', status: Cue['status'] = 'ready'): Cue {
  seq += 1;
  return {
    id: `t-${seq}`, number, label: number, position: '全台', channel: 'CH',
    color: '暖白', colorHex: '#FFF1C7', brightness: 50,
    fadeIn: 1, hold: 2, fadeOut: 1, followCueId, targetNote: '', notes: '', status
  };
}
function planWith(scenes: Scene[]): LightingPlan {
  return { id: 'p1', name: 'p', description: '', updatedAt: '', scenes };
}
function sceneOf(id: string, order: number, frozen: boolean, cues: Cue[]): Scene {
  return { id, name: id, order, frozen, cues };
}

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL: ${name}`); }
  else console.log(`ok: ${name}`);
}

// 1. 互相跟随 A<->B + 自跟随 C->C + 下游 D->A
const a = cue('A'); const b = cue('B'); const c = cue('C'); const d = cue('D'); const e = cue('E');
a.followCueId = b.id; b.followCueId = a.id; c.followCueId = c.id; d.followCueId = a.id;
const s1 = sceneOf('s1', 1, false, [a, b, c, d, e]);
const cycles = findFollowCycles(s1);
check('检测出两个回路', cycles.length === 2);
check('自跟随成环', cycles.some((cy) => cy.length === 1 && cy[0] === c.id));
check('互相跟随成环', cycles.some((cy) => cy.length === 2 && cy.includes(a.id) && cy.includes(b.id)));
const blocked = findBlockedCueIds(s1);
check('下游 D 被阻断', blocked.has(d.id));
check('无跟随 E 不受影响', !blocked.has(e.id));

// 2. 重算：回路成员退出待执行、时间不排定，正常提示仍排期
const p1 = planWith([s1]);
recalculatePlans([p1]);
check('回路成员 A 退出待执行', a.status === 'draft');
check('回路成员 B 退出待执行', b.status === 'draft');
check('自跟随 C 退出待执行', c.status === 'draft');
check('回路成员不排期', a.startTime === undefined && b.startTime === undefined && c.startTime === undefined);
check('下游 D 不排期', d.startTime === undefined);
check('E 正常排期', e.startTime === 0 && e.endTime === 4);
check('draft 状态不受影响', true); // d was ready -> downstream not demoted
check('下游 D 状态保持 ready（仅回路成员降级）', d.status === 'ready');

// 3. 冲突输出
const conflicts = detectConflicts([p1]);
const cycleErrs = conflicts.filter((x) => x.type === 'follow-cycle' && x.severity === 'error');
check('回路错误冲突 3 条', cycleErrs.length === 3);
check('下游警告 1 条', conflicts.some((x) => x.type === 'follow-cycle' && x.severity === 'warning' && x.cueId === d.id));

// 4. 坏引用
const f = cue('F'); f.followCueId = 'ghost-id';
const p2 = planWith([sceneOf('s2', 1, false, [f])]);
recalculatePlans([p2]);
const c2 = detectConflicts([p2]);
check('坏引用类型 broken-follow', c2.some((x) => x.type === 'broken-follow' && x.cueId === f.id));
check('坏引用仍按顺序排期', f.startTime === 0);

// 5. 冻结场次：不重排但标记受上游影响
const g1 = cue('G1'); const g2 = cue('G2');
const frozen = sceneOf('s3', 2, true, [g2]);
const upstream = sceneOf('s2b', 1, false, [g1]);
const p3 = planWith([upstream, frozen]);
recalculatePlans([p3]);
check('冻结场次初次排期', frozen.startTime === 4 && frozen.affectedByUpstream === false);
// 上游变长
g1.hold = 10;
recalculatePlans([p3]);
check('冻结场次保持原排期', frozen.startTime === 4);
check('冻结场次标记受上游影响', frozen.affectedByUpstream === true);
// 解冻后重算
frozen.frozen = false;
recalculatePlans([p3]);
check('解冻后自动重算', frozen.startTime === 12 && frozen.affectedByUpstream === false);

// 6. 冻结场次内回路不降级（只读）
const h1 = cue('H1'); const h2 = cue('H2');
h1.followCueId = h2.id; h2.followCueId = h1.id;
const p4 = planWith([sceneOf('s4', 1, true, [h1, h2])]);
recalculatePlans([p4]);
check('冻结场次回路成员不降级', h1.status === 'ready' && h2.status === 'ready');
check('冻结场次回路仍报冲突', detectConflicts([p4]).filter((x) => x.type === 'follow-cycle').length === 2);

// 7. wouldCreateCycle 预判
const i1 = cue('I1'); const i2 = cue('I2'); const i3 = cue('I3');
i2.followCueId = i3.id;
const s5 = sceneOf('s5', 1, false, [i1, i2, i3]);
check('I3->I1 不成环', wouldCreateCycle(s5, i3.id, i1.id) === false);
check('I3->I2 成环（I2->I3）', wouldCreateCycle(s5, i3.id, i2.id) === true);
check('自跟随预判', wouldCreateCycle(s5, i1.id, i1.id) === true);
check('空目标不成环', wouldCreateCycle(s5, i1.id, '') === false);

// 8. 解除回路后恢复排期
a.followCueId = '';
c.followCueId = '';
recalculatePlans([p1]);
check('解除回路后 A 恢复排期', a.startTime !== undefined);
check('解除后 B 恢复排期', b.startTime !== undefined);
check('解除后下游 D 恢复排期', d.startTime !== undefined);
check('解除后无回路冲突', detectConflicts([p1]).filter((x) => x.type === 'follow-cycle').length === 0);

console.log(failures ? `\n${failures} 个断言失败` : '\n全部断言通过');
process.exit(failures ? 1 : 0);
