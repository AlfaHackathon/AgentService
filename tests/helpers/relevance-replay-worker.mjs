import { DatabaseSync } from 'node:sqlite';
import { init } from '@flue/runtime';
import { sqlite, start } from '@flue/runtime/node';
import { EvidenceRelevanceAgent } from '../../src/agents/news-analysis.ts';
import { createModelProvider } from '../../src/config/model.ts';

// Test-only second attempt lets an intentionally killed process recover the
// same response checkpoint. Production phase durability remains unchanged.
EvidenceRelevanceAgent.durability = { maxAttempts: 2, timeoutMs: 180000 };
process.once('message', async ({ dbPath, receipt: existing, task }) => {
  let priorCorrections;
  let checkpointAtomic = false;
  if (existing) {
    // The parent has confirmed the old process exited. Simulate expiry of
    // ONLY its lease instead of waiting the framework lease scan window.
    // Preserve the original timeout and every response/state checkpoint.
    const db = new DatabaseSync(dbPath);
    const before = db
      .prepare('SELECT timeout_at FROM flue_agent_submissions WHERE submission_id = ?')
      .get(existing.submissionId);
    const batches = db
      .prepare('SELECT data FROM flue_conversation_stream_batches ORDER BY seq')
      .all()
      .map(({ data }) => JSON.parse(data));
    const checkpoint = batches.find((records) =>
      records.some(
        (record) =>
          record.type === 'state_write' &&
          record.name === 'missing-result-corrections:assess_evidence_relevance',
      ),
    );
    const budget = checkpoint?.find(
      (record) =>
        record.type === 'state_write' &&
        record.name === 'missing-result-corrections:assess_evidence_relevance',
    );
    priorCorrections = budget?.value;
    checkpointAtomic =
      checkpoint?.some(
        (record) => record.type === 'signal' && record.signalType === 'missing_result_tool',
      ) && checkpoint.some((record) => record.type === 'agent_finish_cycle');
    const expired = db
      .prepare(
        "UPDATE flue_agent_submissions SET lease_expires_at = ? WHERE submission_id = ? AND status = 'running'",
      )
      .run(Date.now() - 1, existing.submissionId);
    const after = db
      .prepare('SELECT timeout_at FROM flue_agent_submissions WHERE submission_id = ?')
      .get(existing.submissionId);
    db.close();
    if (expired.changes !== 1 || before?.timeout_at !== after?.timeout_at)
      throw new Error('Replay lease fixture changed the original deadline');
  }
  const runtime = await start({
    agents: [EvidenceRelevanceAgent],
    db: sqlite(dbPath),
    providers: [createModelProvider()],
  });
  try {
    const handle = init(EvidenceRelevanceAgent, { id: 'relevance-replay-fixture', uid: null });
    const receipt = await handle.dispatch({
      message: 'Synthetic relevance replay fixture',
      initialData: task,
      idempotencyKey: 'relevance-checkpoint-replay',
    });
    if (existing && receipt.submissionId !== existing.submissionId)
      throw new Error('Replay admitted a different response');
    if (!existing) process.send?.({ type: 'admitted', receipt });
    const reply = await handle.read(receipt);
    // Same final guard as the production agent-runner, including after recovery.
    if (reply.data.result?.length !== 1)
      throw new Error('The Flue phase did not produce exactly one structured result');
    process.send?.({ type: 'completed' });
  } catch (error) {
    process.send?.(
      existing
        ? {
            type: 'failed',
            reason:
              error.message === 'The Flue phase did not produce exactly one structured result'
                ? 'missing_result'
                : 'runtime_failure',
            priorCorrections,
            checkpointAtomic,
          }
        : { type: 'failed' },
    );
  } finally {
    await runtime.stop();
    process.disconnect();
  }
});
process.send?.({ type: 'ready' });
