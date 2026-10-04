<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useTrialStore } from '~/stores/trial';
import type { TrialRole } from '~/types/trial';

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
const actorName = computed(() => actor.value ?? '研究者张宁');

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

const unblind = async (id: string, participantNumber: string) => {
  try {
    const { value } = await ElMessageBox.prompt(`为 ${participantNumber} 填写紧急揭盲原因`, '紧急揭盲', { inputType: 'textarea', inputValidator: (value) => Boolean(value?.trim()) || '揭盲原因不能为空', confirmButtonText: '确认并审计' });
    trial.emergencyUnblind(id, value, actorName.value);
    ElMessage.warning('已揭盲，审计记录已追加');
  } catch {}
};

const commitOne = (id: string) => {
  const result = trial.commitPending(id, actorName.value);
  if (result.ok) ElMessage.success(result.message);
  else ElMessage.error(result.message);
};

const mergeAll = () => {
  const result = trial.commitAllPending(actorName.value);
  if (result.total === 0) {
    ElMessage.info('没有待提交记录');
    return;
  }
  ElMessage.success(`联网合并完成：${result.committed} 条入库，${result.conflicts} 条冲突已留存`);
};

const reissue = async (id: string, participantNumber: string) => {
  try {
    await ElMessageBox.confirm(
      `重新发号将作废 ${participantNumber} 的原随机号与治疗组，并按“中心+年龄层”区组平衡重新发号；若已揭盲，原揭盲结论立即失效并需重新确认。是否继续？`,
      '重新发号',
      { type: 'warning', confirmButtonText: '确认重新发号', cancelButtonText: '取消' }
    );
    const result = trial.reissueParticipant(id, actorName.value);
    if (result.ok) ElMessage.success(result.message);
    else ElMessage.error(result.message);
  } catch {}
};

const auditType = (action: string) => {
  if (action === 'unblinded' || action === 'unblinding-invalidated') return 'danger';
  if (action === 'duplicate-blocked' || action === 'pending-conflict') return 'warning';
  return 'primary';
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
        </el-form>
      </el-card>

      <el-card shadow="never">
        <template #header><div style="display:flex;justify-content:space-between"><b>{{ t('participants') }}</b><el-tag>{{ role }}</el-tag></div></template>
        <el-table :data="participants" max-height="480">
          <el-table-column prop="participantNo" label="受试者" min-width="110" />
          <el-table-column prop="site" label="中心" min-width="110" />
          <el-table-column prop="sequence" label="随机号" width="90" />
          <el-table-column label="治疗组" width="100"><template #default="{ row }"><el-tag :type="row.status === 'unblinded' ? 'danger' : 'info'">{{ visibleArm(row.arm, row.status) }}</el-tag></template></el-table-column>
          <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag :type="row.status === 'unblinded' ? 'danger' : 'success'">{{ row.status === 'unblinded' ? '已揭盲' : '随机中' }}</el-tag></template></el-table-column>
          <el-table-column label="操作" width="170"><template #default="{ row }">
            <el-button v-if="role === 'investigator'" size="small" type="danger" plain @click="unblind(row.id, row.participantNo)">揭盲</el-button>
            <el-button v-if="role === 'investigator'" size="small" type="warning" plain @click="reissue(row.id, row.participantNo)">重新发号</el-button>
          </template></el-table-column>
        </el-table>
      </el-card>
    </div>

    <div class="grid" style="margin-top:20px">
      <el-card shadow="never">
        <template #header><div style="display:flex;justify-content:space-between;align-items:center"><b>{{ t('pending') }}</b><el-button size="small" type="success" plain :disabled="trial.pendingCount === 0" @click="mergeAll">全部联网合并</el-button></div></template>
        <el-empty v-if="pending.length === 0" description="暂无待提交记录" />
        <el-table v-else :data="pending" max-height="320">
          <el-table-column prop="payload.participantNo" label="受试者" min-width="110" />
          <el-table-column prop="payload.identityKey" label="身份标识" min-width="110" />
          <el-table-column prop="payload.site" label="中心" min-width="100" />
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag :type="row.status === 'committed' ? 'success' : row.status === 'conflict' ? 'danger' : 'info'">
                {{ row.status === 'committed' ? '已入库' : row.status === 'conflict' ? '冲突' : '待提交' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="conflictReason" label="冲突原因" min-width="220" show-overflow-tooltip />
          <el-table-column label="操作" width="110">
            <template #default="{ row }">
              <el-button v-if="row.status === 'pending'" size="small" type="primary" @click="commitOne(row.id)">确认入库</el-button>
              <el-tag v-else-if="row.status === 'conflict'" type="danger" effect="plain">已留存</el-tag>
              <span v-else>—</span>
            </template>
          </el-table-column>
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
  </main>
</template>

<style scoped>
@media (max-width: 900px) { section { grid-template-columns: 1fr 1fr !important; } }
</style>
