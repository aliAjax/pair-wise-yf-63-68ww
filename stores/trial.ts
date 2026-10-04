import { defineStore } from 'pinia';
import type { Arm, AuditEntry, Participant, PendingRandomization, RandomizeInput } from '~/types/trial';
import { readLocal, writeLocal } from '~/composables/useLocalPersist';

const STORAGE_KEY = 'trial-randomization-v1';
const BLOCK_SIZE_ARMS: Arm[] = ['A', 'A', 'B', 'B'];

interface TrialState {
  participants: Participant[];
  audits: AuditEntry[];
  pending: PendingRandomization[];
  nextSequence: number;
  blockPools: Record<string, Arm[]>;
}

const seed: Pick<TrialState, 'participants' | 'audits' | 'pending'> = {
  participants: [
    { id: 'p-1', participantNo: 'S01-001', identityKey: 'demo-a', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1001, arm: 'A' },
    { id: 'p-2', participantNo: 'S01-002', identityKey: 'demo-b', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1002, arm: 'B' }
  ],
  audits: [
    { id: 'a-1', at: new Date(Date.now() - 3600_000).toISOString(), actor: '系统', action: 'randomized', detail: 'S01-002 完成分层随机，中央随机号 1002', participantNo: 'S01-002' }
  ],
  pending: []
};

// 兼容旧版本持久化数据：缺失的字段用默认值补齐，已发出的随机号继续递增、不复用
const loadState = (): TrialState => {
  const persisted = readLocal<Partial<TrialState> | null>(STORAGE_KEY, null);
  const participants = persisted?.participants ?? seed.participants;
  const maxSequence = participants.reduce((max, item) => Math.max(max, item.sequence), 1000);
  return {
    participants,
    audits: persisted?.audits ?? seed.audits,
    pending: persisted?.pending ?? seed.pending,
    nextSequence: persisted?.nextSequence ?? maxSequence + 1,
    blockPools: persisted?.blockPools ?? {}
  };
};

// 区组内随机洗牌（Fisher-Yates），保证每个区组 A/B 各半
const shuffledBlock = (): Arm[] => {
  const block = [...BLOCK_SIZE_ARMS];
  const random = new Uint32Array(1);
  for (let i = block.length - 1; i > 0; i--) {
    crypto.getRandomValues(random);
    const j = random[0] % (i + 1);
    [block[i], block[j]] = [block[j], block[i]];
  }
  return block;
};

const stratumKey = (site: string, ageBand: string) => `${site}|${ageBand}`;

export const useTrialStore = defineStore('trial', {
  state: (): TrialState => loadState(),
  getters: {
    bySite: (state) => state.participants.reduce<Record<string, number>>((result, participant) => {
      result[participant.site] = (result[participant.site] ?? 0) + 1;
      return result;
    }, {}),
    pendingCount: (state) => state.pending.filter((item) => item.status === 'pending').length,
    conflictCount: (state) => state.pending.filter((item) => item.status === 'conflict').length
  },
  actions: {
    persist() { writeLocal(STORAGE_KEY, { participants: this.participants, audits: this.audits, pending: this.pending, nextSequence: this.nextSequence, blockPools: this.blockPools }); },
    addAudit(action: AuditEntry['action'], detail: string, actor: string, participantNo?: string) {
      this.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), actor, action, detail, participantNo });
      this.persist();
    },
    findClash(input: RandomizeInput) {
      return this.participants.find((item) => item.identityKey === input.identityKey || item.participantNo === input.participantNo);
    },
    randomize(input: RandomizeInput, offline = false): { ok: boolean; message: string; arm?: Arm } {
      if (this.findClash(input)) {
        this.addAudit('duplicate-blocked', `拒绝重复入组：${input.participantNo}`, input.actor, input.participantNo);
        return { ok: false, message: '身份标识或受试者编号已存在，已阻止重复入组' };
      }
      if (offline) {
        const queued: PendingRandomization = { id: crypto.randomUUID(), payload: input, createdAt: new Date().toISOString(), status: 'pending' };
        this.pending.unshift(queued);
        this.addAudit('pending-queued', `离线提交进入待处理队列：${input.participantNo}`, input.actor, input.participantNo);
        return { ok: true, message: '已加入待提交队列，联网后确认入库' };
      }
      return this.commitRandomization(input);
    },
    // 从本中心×年龄层的当前区组中取出一个组别；区组用尽再开新区组，保证区组平衡
    drawArm(site: string, ageBand: string): Arm {
      const key = stratumKey(site, ageBand);
      let pool = this.blockPools[key] ?? [];
      if (pool.length === 0) pool = shuffledBlock();
      const arm = pool.pop() as Arm;
      this.blockPools[key] = pool;
      return arm;
    },
    commitRandomization(input: RandomizeInput): { ok: boolean; message: string; arm: Arm } {
      const sequence = this.nextSequence;
      this.nextSequence += 1;
      const arm = this.drawArm(input.site, input.ageBand);
      const participant: Participant = { id: crypto.randomUUID(), ...input, status: 'randomized', sequence, arm };
      this.participants.unshift(participant);
      this.addAudit('randomized', `${input.participantNo} 完成分层区组随机，随机号 ${sequence}（${input.site} · ${input.ageBand}）`, input.actor, input.participantNo);
      return { ok: true, message: `随机成功，中央随机号 ${sequence}`, arm };
    },
    // 合并单条待提交记录：与中央台账冲突的保留为冲突记录，绝不覆盖中央记录
    settlePending(item: PendingRandomization, actor: string): 'merged' | 'conflict' {
      const clash = this.findClash(item.payload);
      if (clash) {
        const field = clash.identityKey === item.payload.identityKey ? '身份核验标识' : '受试者编号';
        item.status = 'conflict';
        item.resolvedAt = new Date().toISOString();
        item.conflictReason = `${field}与中央台账 ${clash.participantNo}（${clash.site}，随机号 ${clash.sequence}）重复，保留中央记录，本条不予入库`;
        this.addAudit('merge-conflict', `合并冲突：${item.payload.participantNo}（${item.payload.site}）${item.conflictReason}`, actor, item.payload.participantNo);
        return 'conflict';
      }
      item.status = 'committed';
      item.resolvedAt = new Date().toISOString();
      this.commitRandomization(item.payload);
      return 'merged';
    },
    commitPending(id: string, actor: string) {
      const pending = this.pending.find((item) => item.id === id && item.status === 'pending');
      if (!pending) return;
      if (this.settlePending(pending, actor) === 'merged') {
        this.addAudit('pending-committed', `待提交记录已确认入库：${pending.payload.participantNo}`, actor, pending.payload.participantNo);
      }
      this.persist();
    },
    // 联网后把待提交队列按提交时间先后合并进中央随机台账
    mergePending(actor: string): { merged: number; conflicts: number } {
      const queue = this.pending
        .filter((item) => item.status === 'pending')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      let merged = 0;
      let conflicts = 0;
      for (const item of queue) {
        if (this.settlePending(item, actor) === 'merged') merged++;
        else conflicts++;
      }
      if (queue.length > 0) {
        this.addAudit('queue-merged', `待提交队列合并完成：入库 ${merged} 条，冲突 ${conflicts} 条`, actor);
      }
      this.persist();
      return { merged, conflicts };
    },
    // 修正随机号/组别：已发出的随机号只允许改到未占用的新号；已揭盲的受试者原结论立即失效
    updateAssignment(id: string, patch: { sequence?: number; arm?: Arm }, reason: string, actor: string): { ok: boolean; message: string } {
      const participant = this.participants.find((item) => item.id === id);
      if (!participant) return { ok: false, message: '未找到受试者记录' };
      if (!reason.trim()) return { ok: false, message: '必须填写调整原因' };
      const changes: string[] = [];
      if (patch.sequence !== undefined && patch.sequence !== participant.sequence) {
        if (this.participants.some((item) => item.id !== participant.id && item.sequence === patch.sequence)) {
          return { ok: false, message: `随机号 ${patch.sequence} 已被占用，已发出的随机号不能复用` };
        }
        changes.push(`随机号 ${participant.sequence} → ${patch.sequence}`);
        participant.sequence = patch.sequence;
      }
      if (patch.arm !== undefined && patch.arm !== participant.arm) {
        changes.push(`组别 ${participant.arm} → ${patch.arm}`);
        participant.arm = patch.arm;
      }
      if (changes.length === 0) return { ok: false, message: '未发生任何变更' };
      if (participant.status === 'unblinded') {
        const concludedAt = participant.unblindedAt;
        participant.status = 'unblind-invalidated';
        participant.unblindedAt = undefined;
        this.addAudit('unblind-invalidated', `${participant.participantNo} 原揭盲结论（${concludedAt}，组别见历史审计）因${changes.join('、')}立即失效，需重新确认`, actor, participant.participantNo);
      }
      this.addAudit('assignment-updated', `${participant.participantNo} ${changes.join('、')}；原因：${reason}`, actor, participant.participantNo);
      this.persist();
      return { ok: true, message: participant.status === 'unblind-invalidated' ? '已更新，原揭盲结论失效，需重新确认' : '已更新并写入审计' };
    },
    emergencyUnblind(id: string, reason: string, actor: string) {
      const participant = this.participants.find((item) => item.id === id);
      if (!participant || !reason.trim() || participant.status === 'unblinded') return;
      const reconfirm = participant.status === 'unblind-invalidated';
      participant.status = 'unblinded';
      participant.unblindedAt = new Date().toISOString();
      if (reconfirm) {
        this.addAudit('unblind-reconfirmed', `重新确认揭盲：${reason}；分配组别 ${participant.arm}（替代已失效的原结论）`, actor, participant.participantNo);
      } else {
        this.addAudit('unblinded', `紧急揭盲：${reason}；分配组别 ${participant.arm}`, actor, participant.participantNo);
      }
    }
  }
});
