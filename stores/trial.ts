import { defineStore } from 'pinia';
import type { Arm, AuditEntry, Participant, PendingRandomization, RandomizeInput } from '~/types/trial';
import { readLocal, writeLocal } from '~/composables/useLocalPersist';

const STORAGE_KEY = 'trial-randomization-v1';
const seed: { participants: Participant[]; audits: AuditEntry[]; pending: PendingRandomization[] } = {
  participants: [
    { id: 'p-1', participantNo: 'S01-001', identityKey: 'demo-a', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1001, arm: 'A' },
    { id: 'p-2', participantNo: 'S01-002', identityKey: 'demo-b', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1002, arm: 'B' }
  ],
  audits: [
    { id: 'a-1', at: new Date(Date.now() - 3600_000).toISOString(), actor: '系统', action: 'randomized', detail: 'S01-002 完成分层随机，中央随机号 1002', participantNo: 'S01-002' }
  ],
  pending: []
};

export const useTrialStore = defineStore('trial', {
  state: () => readLocal(STORAGE_KEY, seed),
  getters: {
    bySite: (state) => state.participants.reduce<Record<string, number>>((result, participant) => {
      result[participant.site] = (result[participant.site] ?? 0) + 1;
      return result;
    }, {}),
    pendingCount: (state) => state.pending.filter((item) => item.status === 'pending').length
  },
  actions: {
    persist() { writeLocal(STORAGE_KEY, { participants: this.participants, audits: this.audits, pending: this.pending }); },
    addAudit(action: AuditEntry['action'], detail: string, actor: string, participantNo?: string) {
      this.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), actor, action, detail, participantNo });
      this.persist();
    },
    randomize(input: RandomizeInput, offline = false): { ok: boolean; message: string; arm?: Arm } {
      // 在线提交：中央台账已有的身份标识或编号直接拒绝，防止重复入组。
      // 离线登记：无法核验中央台账，先 provisional 入队，联网合并时再做冲突判定。
      if (!offline && this.participants.some((item) => item.identityKey === input.identityKey || item.participantNo === input.participantNo)) {
        this.addAudit('duplicate-blocked', `拒绝重复入组：${input.participantNo}`, input.actor, input.participantNo);
        return { ok: false, message: '身份标识或受试者编号已存在，已阻止重复入组' };
      }
      if (offline) {
        const queued: PendingRandomization = { id: crypto.randomUUID(), payload: input, createdAt: new Date().toISOString(), status: 'pending' };
        this.pending.unshift(queued);
        this.addAudit('pending-queued', `离线登记进入待处理队列（联网后核验身份标识并合并入中央台账）：${input.participantNo}`, input.actor, input.participantNo);
        return { ok: true, message: '已离线登记，联网后合并入中央台账并核验' };
      }
      return this.commitRandomization(input);
    },
    // 中央台账当前最大随机号，保证并入/补发只往后发号，绝不重排已发出的随机号。
    nextSequence(): number {
      return 1000 + this.participants.reduce((max, item) => Math.max(max, item.sequence), 0) + 1;
    },
    // 按“中心 + 年龄层”区组平衡：取该分层内较少的一组，并入新记录时不改动既有记录。
    balancedArm(site: string, ageBand: Participant['ageBand'], excludeId?: string): Arm {
      const stratum = this.participants.filter((item) => item.site === site && item.ageBand === ageBand && item.id !== excludeId);
      const armA = stratum.filter((item) => item.arm === 'A').length;
      const armB = stratum.filter((item) => item.arm === 'B').length;
      return armA <= armB ? 'A' : 'B';
    },
    commitRandomization(input: RandomizeInput): { ok: boolean; message: string; arm: Arm } {
      const sequence = this.nextSequence();
      const arm = this.balancedArm(input.site, input.ageBand);
      const participant: Participant = { id: crypto.randomUUID(), ...input, status: 'randomized', sequence, arm };
      this.participants.unshift(participant);
      this.addAudit('randomized', `${input.participantNo} 完成分层随机，中央随机号 ${sequence}`, input.actor, input.participantNo);
      return { ok: true, message: `随机成功，中央序列号 ${sequence}`, arm };
    },
    commitPending(id: string, actor: string): { ok: boolean; message: string } {
      const item = this.pending.find((pending) => pending.id === id);
      if (!item || item.status !== 'pending') return { ok: false, message: '待提交记录不存在或已处理' };
      // 合并冲突判定：同一身份标识（或编号）中央台账已入组的，离线记录留存为冲突记录并写明原因，
      // 绝不覆盖中央记录。
      const existing = this.participants.find((p) => p.identityKey === item.payload.identityKey || p.participantNo === item.payload.participantNo);
      if (existing) {
        item.status = 'conflict';
        item.conflictAt = new Date().toISOString();
        item.conflictReason = `身份标识已由中央台账入组（中央记录 ${existing.participantNo}，${existing.site}），离线记录不予入库，原中央记录保持不变`;
        this.addAudit(
          'pending-conflict',
          `离线记录冲突：${item.payload.participantNo}（${item.payload.identityKey}）中央已入组为 ${existing.participantNo}；已留存冲突记录，未覆盖中央记录`,
          actor,
          item.payload.participantNo
        );
        this.persist();
        return { ok: false, message: `冲突：${item.payload.participantNo} 中央已入组，已留存冲突记录` };
      }
      item.status = 'committed';
      this.commitRandomization(item.payload);
      this.addAudit('pending-committed', `待提交记录已确认入库：${item.payload.participantNo}`, actor, item.payload.participantNo);
      this.persist();
      return { ok: true, message: `已入库：${item.payload.participantNo}` };
    },
    // 联网后把待提交队列合并进中央台账：逐条核验，冲突的留存为冲突记录，其余入库。
    commitAllPending(actor: string): { total: number; committed: number; conflicts: number } {
      const items = this.pending.filter((item) => item.status === 'pending');
      let committed = 0;
      let conflicts = 0;
      for (const item of items) {
        const result = this.commitPending(item.id, actor);
        if (result.ok) committed += 1; else conflicts += 1;
      }
      return { total: items.length, committed, conflicts };
    },
    // 随机号或组别一旦更新，原有揭盲结论立即失效并需重新确认；旧揭盲记录只留审计，不删除。
    reissueParticipant(id: string, actor: string): { ok: boolean; message: string; arm?: Arm } {
      const participant = this.participants.find((item) => item.id === id);
      if (!participant) return { ok: false, message: '未找到受试者' };
      const oldSequence = participant.sequence;
      const oldArm = participant.arm;
      const sequence = this.nextSequence();
      const arm = this.balancedArm(participant.site, participant.ageBand, participant.id);
      participant.sequence = sequence;
      participant.arm = arm;
      const wasUnblinded = participant.status === 'unblinded';
      if (wasUnblinded) {
        participant.status = 'randomized';
        participant.unblindedAt = undefined;
      }
      this.addAudit(
        'randomization-updated',
        `重新发号：${participant.participantNo} 随机号 ${oldSequence}→${sequence}，治疗组 ${oldArm ?? '未分配'}→${arm}`,
        actor,
        participant.participantNo
      );
      if (wasUnblinded) {
        this.addAudit(
          'unblinding-invalidated',
          `随机信息变更，原揭盲结论（治疗组 ${oldArm ?? '未知'}）立即失效，需重新揭盲确认；旧揭盲记录仅留存审计，不删除`,
          actor,
          participant.participantNo
        );
      }
      this.persist();
      return {
        ok: true,
        message: `已重新发号：中央随机号 ${sequence}，治疗组 ${arm}${wasUnblinded ? '；原揭盲已失效，请重新确认' : ''}`,
        arm
      };
    },
    emergencyUnblind(id: string, reason: string, actor: string) {
      const participant = this.participants.find((item) => item.id === id);
      if (!participant || !reason.trim()) return;
      participant.status = 'unblinded';
      participant.unblindedAt = new Date().toISOString();
      this.addAudit('unblinded', `紧急揭盲：${reason}；分配组别 ${participant.arm}`, actor, participant.participantNo);
    }
  }
});
