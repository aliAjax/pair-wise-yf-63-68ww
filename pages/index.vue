<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useTrialStore } from '~/stores/trial';
import type { Arm, Participant, TrialRole } from '~/types/trial';

const { t } = useI18n();
const trial = useTrialStore();
const { participants, audits, pending } = storeToRefs(trial);
const role = ref<TrialRole>('investigator');
const offline = ref(false);
const schema = toTypedSchema(z.object({
  participantNo: z.string().min(4, '请输入至少4位受试者编号'),
  identityKey: z.string().min(4, '请输入身份核验标识'),
  site: z.string().min(2, '请选择研究中心'),
  ageBand: z.enum(['18-44', '45-64', '65+']),
  actor: z.string().min(2, '请输入操作人')
}));
const { defineField, handleSubmit, errors, resetForm } = useForm({ validationSchema: schema, initialValues: { participantNo: '', identityKey: '', site: '上海中心', ageBand: '45-64', actor: '研究者张宁' } });
const [participantNo] = defineField('participantNo');
const [identityKey] = defineField('identityKey');
const [site] = defineField('site');
const [ageBand] = defineField('ageBand');
const [actor] = defineField('actor');

const visibleArm = (arm?: 'A' | 'B', status?: string) => {
  if (role.value === 'pharmacist') return arm ?? '待分配';
  if (role.value === 'monitor' && status === 'unblinded') return arm ?? '未知';
  return '已隐藏';
};

const submit = handleSubmit((values) => {
  const result = trial.randomize(values, offline.value);
  if (!result.ok) {
    ElMessage.error(result.message);
    return;
  }
  ElMessage.success(result.message);
  resetForm({ values: { participantNo: '', identityKey: '', site: values.site, ageBand: values.ageBand, actor: values.actor } });
});

// 联网后把待提交队列合并进中央随机台账；冲突记录留在队列中并写明原因
const mergeAll = () => {
  const { merged, conflicts } = trial.mergePending(actor.value || '系统');
  if (merged + conflicts === 0) return;
  if (conflicts > 0) ElMessage.warning(`合并完成：入库 ${merged} 条，冲突 ${conflicts} 条（已保留为冲突记录，未覆盖中央台账）`);
  else ElMessage.success(`合并完成：入库 ${merged} 条`);
};

watch(offline, (value, previous) => {
  if (previous && !value && trial.pendingCount > 0) mergeAll();
});

const unblind = async (id: string, participantNumber: string, reconfirm: boolean) => {
  try {
    const { value } = await ElMessageBox.prompt(
      reconfirm ? `随机号/组别已变更，为 ${participantNumber} 重新确认揭盲并填写原因` : `为 ${participantNumber} 填写紧急揭盲原因`,
      reconfirm ? '重新确认揭盲' : '紧急揭盲',
      { inputType: 'textarea', inputValidator: (value) => Boolean(value?.trim()) || '揭盲原因不能为空', confirmButtonText: '确认并审计' }
    );
    trial.emergencyUnblind(id, value, actor.value || '系统');
    ElMessage.warning(reconfirm ? '已重新确认揭盲，审计记录已追加' : '已揭盲，审计记录已追加');
  } catch {}
};

const adjustVisible = ref(false);
const adjustTarget = ref<Participant | null>(null);
const adjustSequence = ref<number>();
const adjustArm = ref<Arm | ''>('');
const adjustReason = ref('');

const openAdjust = (row: Participant) => {
  adjustTarget.value = row;
  adjustSequence.value = undefined;
  adjustArm.value = '';
  adjustReason.value = '';
  adjustVisible.value = true;
};

const confirmAdjust = () => {
  if (!adjustTarget.value) return;
  if (!adjustReason.value.trim()) {
    ElMessage.error('必须填写调整原因');
    return;
  }
  const result = trial.updateAssignment(
    adjustTarget.value.id,
    { sequence: adjustSequence.value, arm: adjustArm.value || undefined },
    adjustReason.value,
    actor.value || '药品管理员'
  );
  if (!result.ok) {
    ElMessage.error(result.message);
    return;
  }
  ElMessage.success(result.message);
  adjustVisible.value = false;
};

type TagType = 'primary' | 'success' | 'warning' | 'danger' | 'info';

const pendingTag = (status: string): { type: TagType; label: string } => {
  if (status === 'pending') return { type: 'warning', label: '待提交' };
  if (status === 'conflict') return { type: 'danger', label: '冲突未入库' };
  return { type: 'success', label: '已入库' };
};

const statusTag = (status: string): { type: TagType; label: string } => {
  if (status === 'unblinded') return { type: 'danger', label: '已揭盲' };
  if (status === 'unblind-invalidated') return { type: 'warning', label: '揭盲失效·待重新确认' };
  return { type: 'info', label: '已随机' };
};

const auditType = (action: string): TagType => {
  const map: Record<string, TagType> = {
    unblinded: 'danger',
    'unblind-reconfirmed': 'danger',
    'unblind-invalidated': 'warning',
    'merge-conflict': 'danger',
    'duplicate-blocked': 'warning',
    'assignment-updated': 'warning',
    'queue-merged': 'success'
  };
  return map[action] ?? 'primary';
};

const counts = computed(() => ({
  total: participants.value.length,
  unblinded: participants.value.filter((item) => item.status === 'unblinded').length,
  sites: Object.keys(trial.bySite).length,
  pending: trial.pendingCount
}));
</script>

<template>
  <main class="page">
    <header class="hero">
      <div><el-tag type="success">GCP 本地原型</el-tag><h1>{{ t('title') }}</h1><p>{{ t('subtitle') }}</p></div>
      <el-segmented v-model="role" :options="[{ label: '研究者', value: 'investigator' }, { label: '药品管理员', value: 'pharmacist' }, { label: '监察员', value: 'monitor' }]" />
    </header>

    <section style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-bottom:20px">
      <div class="stat"><span>已随机入组</span><b>{{ counts.total }}</b></div>
      <div class="stat"><span>紧急揭盲</span><b>{{ counts.unblinded }}</b></div>
      <div class="stat"><span>参与中心</span><b>{{ counts.sites }}</b></div>
      <div class="stat"><span>待提交</span><b>{{ counts.pending }}</b></div>
    </section>

    <div class="grid">
      <el-card shadow="never">
        <template #header><b>{{ t('randomize') }}</b><el-switch v-model="offline" active-text="模拟离线" style="float:right" /></template>
        <el-form label-position="top" @submit.prevent="submit">
          <el-form-item label="研究中心" :error="errors.site"><el-select v-model="site" style="width:100%"><el-option label="上海中心" value="上海中心" /><el-option label="广州中心" value="广州中心" /><el-option label="新加坡中心" value="新加坡中心" /></el-select></el-form-item>
          <el-form-item label="受试者编号" :error="errors.participantNo"><el-input v-model="participantNo" placeholder="S01-003" /></el-form-item>
          <el-form-item label="身份核验标识" :error="errors.identityKey"><el-input v-model="identityKey" placeholder="脱敏身份键或筛选号" /></el-form-item>
          <el-form-item label="年龄分层" :error="errors.ageBand"><el-radio-group v-model="ageBand"><el-radio-button value="18-44">18-44</el-radio-button><el-radio-button value="45-64">45-64</el-radio-button><el-radio-button value="65+">65+</el-radio-button></el-radio-group></el-form-item>
          <el-form-item label="操作人" :error="errors.actor"><el-input v-model="actor" /></el-form-item>
          <el-button type="primary" native-type="submit" style="width:100%">执行分层区组随机</el-button>
          <div style="margin-top:8px;color:#909399;font-size:12px">关闭“模拟离线”后，待提交队列将自动合并进中央随机台账</div>
        </el-form>
      </el-card>

      <el-card shadow="never">
        <template #header><div style="display:flex;justify-content:space-between"><b>{{ t('participants') }}</b><el-tag>{{ role }}</el-tag></div></template>
        <el-table :data="participants" max-height="480">
          <el-table-column prop="participantNo" label="受试者" min-width="110" />
          <el-table-column prop="site" label="中心" min-width="110" />
          <el-table-column prop="sequence" label="随机号" width="90" />
          <el-table-column label="治疗组" width="100"><template #default="{ row }"><el-tag :type="row.status === 'unblinded' ? 'danger' : 'info'">{{ visibleArm(row.arm, row.status) }}</el-tag></template></el-table-column>
          <el-table-column label="状态" width="150"><template #default="{ row }"><el-tag :type="statusTag(row.status).type">{{ statusTag(row.status).label }}</el-tag></template></el-table-column>
          <el-table-column label="操作" width="180">
            <template #default="{ row }">
              <el-button v-if="role === 'investigator' && row.status !== 'unblinded'" size="small" type="danger" plain @click="unblind(row.id, row.participantNo, row.status === 'unblind-invalidated')">{{ row.status === 'unblind-invalidated' ? '重新确认揭盲' : '揭盲' }}</el-button>
              <el-button v-if="role === 'pharmacist'" size="small" type="warning" plain @click="openAdjust(row as Participant)">调整</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </div>

    <div class="grid" style="margin-top:20px">
      <el-card shadow="never">
        <template #header>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <b>{{ t('pending') }}</b>
            <span>
              <el-tag v-if="trial.conflictCount > 0" type="danger" style="margin-right:8px">冲突 {{ trial.conflictCount }}</el-tag>
              <el-button size="small" type="success" :disabled="offline || trial.pendingCount === 0" @click="mergeAll">联网合并队列</el-button>
            </span>
          </div>
        </template>
        <el-empty v-if="pending.length === 0" description="暂无待提交记录" />
        <el-table v-else :data="pending">
          <el-table-column prop="payload.participantNo" label="受试者" min-width="100" />
          <el-table-column prop="payload.site" label="中心" min-width="100" />
          <el-table-column label="状态" width="110"><template #default="{ row }"><el-tag :type="pendingTag(row.status).type">{{ pendingTag(row.status).label }}</el-tag></template></el-table-column>
          <el-table-column label="冲突原因" min-width="180"><template #default="{ row }"><span v-if="row.conflictReason" style="color:#c45656">{{ row.conflictReason }}</span><span v-else>—</span></template></el-table-column>
          <el-table-column label="操作" width="110"><template #default="{ row }"><el-button v-if="row.status === 'pending'" size="small" type="primary" @click="trial.commitPending(row.id, actor || '系统')">确认入库</el-button><el-tag v-else-if="row.status === 'conflict'" size="small" type="danger">已保留</el-tag></template></el-table-column>
        </el-table>
      </el-card>
      <el-card shadow="never">
        <template #header><b>{{ t('audit') }}</b><el-tag type="warning" style="float:right">仅追加</el-tag></template>
        <el-timeline>
          <el-timeline-item v-for="entry in audits" :key="entry.id" :timestamp="new Date(entry.at).toLocaleString()" :type="auditType(entry.action)">
            <b>{{ entry.actor }} · {{ entry.action }}</b><div>{{ entry.detail }}</div>
          </el-timeline-item>
        </el-timeline>
      </el-card>
    </div>

    <el-dialog v-model="adjustVisible" title="调整随机号 / 组别" width="440px">
      <el-alert type="warning" :closable="false" show-icon title="若该受试者已揭盲，保存后原揭盲结论立即失效，需研究者重新确认；旧结论仅保留在审计记录中。" style="margin-bottom:14px" />
      <el-form label-position="top">
        <el-form-item label="受试者"><el-input :model-value="adjustTarget ? `${adjustTarget.participantNo}（当前随机号 ${adjustTarget.sequence}，组别 ${adjustTarget.arm}）` : ''" disabled /></el-form-item>
        <el-form-item label="新随机号（留空则不变）"><el-input-number v-model="adjustSequence" :min="1" :max="999999" :controls="false" placeholder="保持不变" style="width:100%" /></el-form-item>
        <el-form-item label="新组别（不选择则不变）"><el-select v-model="adjustArm" clearable placeholder="保持不变" style="width:100%"><el-option label="A 组" value="A" /><el-option label="B 组" value="B" /></el-select></el-form-item>
        <el-form-item label="调整原因（必填）"><el-input v-model="adjustReason" type="textarea" :rows="3" placeholder="例如：中央台账数据勘误" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="adjustVisible = false">取消</el-button>
        <el-button type="primary" @click="confirmAdjust">确认调整并审计</el-button>
      </template>
    </el-dialog>
  </main>
</template>

<style scoped>
@media (max-width: 900px) { section { grid-template-columns: 1fr 1fr !important; } }
</style>
