import { randomUUID } from 'node:crypto';
import { Store } from './db.js';
import { applySnapshot, coordinate } from './coordinator.js';
import { ProviderError, type Provider } from './github.js';
import { isGovernanceJob, type GovernanceService } from './governance.js';

export class Worker {
  private busy = false;
  private timer?: NodeJS.Timeout;

  constructor(private store: Store, private provider: Provider, private governance?: GovernanceService) {}

  start() { this.timer = setInterval(() => { void this.tick(); }, 1_000); this.timer.unref(); void this.tick(); }
  stop() { if (this.timer) clearInterval(this.timer); }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    let heartbeat: NodeJS.Timeout | undefined;
    try {
      const project = this.store.get('project', '1');
      if (!project?.confirmed) return;
      const now = Date.now();
      const jobs = this.store.all('event_job');
      const isSync = (type: string) => type !== 'github_comment' && !isGovernanceJob(type);
      const syncJobs = jobs.filter(job => isSync(job.type));
      if (!syncJobs.some(job => job.state === 'queued' || job.state === 'running') && now - project.last_sync > 300_000 && !syncJobs.some(job => job.state === 'failed')) this.store.enqueue('reconcile', {}, `poll:${Math.floor(now / 300_000)}`);
      this.store.tx(() => {
        this.store.db.prepare('DELETE FROM idempotency WHERE expires<?').run(now);
        this.store.db.prepare('DELETE FROM session WHERE expires<?').run(now);
        this.store.db.prepare('DELETE FROM oauth_state WHERE expires<?').run(now);
        // Governance/comment jobs contain only durable row identifiers needed for at-least-once delivery; never erase those payloads while scrubbing old raw webhook jobs.
        for (const job of this.store.all('event_job')) if (job.created_at < now - 7 * 86_400_000 && job.payload !== '{}' && !isGovernanceJob(job.type) && job.type !== 'github_comment') { job.payload = '{}'; this.store.put('event_job', job.id, job); }
        coordinate(this.store);
      });
      const job = this.store.tx(() => {
        const lane = (type: string) => isGovernanceJob(type) ? 'governance' : type === 'github_comment' ? 'notification' : 'sync';
        const activeLanes = new Set(this.store.all('event_job').filter(value => value.state === 'running' && value.lease_until > now).map(value => lane(value.type)));
        const next = this.store.all('event_job').filter(value => (value.state === 'queued' && value.next_at <= now || value.state === 'running' && value.lease_until <= now) && !activeLanes.has(lane(value.type))).sort((a, b) => a.created_at - b.created_at)[0];
        if (!next) return undefined;
        next.state = 'running'; next.lease_token = randomUUID(); next.lease_until = now + 90_000; this.store.put('event_job', next.id, next); return next;
      });
      if (!job) return;
      const owns = () => this.store.get('event_job', job.id)?.lease_token === job.lease_token && this.store.get('event_job', job.id)?.state === 'running';
      heartbeat = setInterval(() => { if (owns()) { job.lease_until = Date.now() + 90_000; this.store.put('event_job', job.id, job); } }, 20_000); heartbeat.unref();
      try {
        if (isGovernanceJob(job.type)) {
          const payload = JSON.parse(job.payload) as { request_id?: string };
          if (!this.governance || !payload.request_id) throw new ProviderError('Durable governance request is unavailable', 409);
          await this.governance.process(payload.request_id);
          this.store.tx(() => { if (owns()) { job.state = 'done'; job.lease_until = 0; job.error = null; this.store.put('event_job', job.id, job); } });
        } else if (job.type === 'github_comment') {
          const payload = JSON.parse(job.payload) as { comment_id?: string; change_id?: string };
          const comment = payload.comment_id ? this.store.get('github_comment', payload.comment_id) : undefined;
          const change = payload.change_id ? this.store.get('git_change', payload.change_id) : undefined;
          if (!comment || !change) throw new ProviderError('Durable GitHub comment target is unavailable', 409);
          if (comment.state === 'delivered') {
            this.store.tx(() => { if (owns()) { job.state = 'done'; job.lease_until = 0; job.error = null; this.store.put('event_job', job.id, job); } });
          } else if (!this.provider.maintainComment) {
            // The isolated fake provider mirrors the queue shape but never calls
            // GitHub. Keep the notice visible instead of claiming delivery.
            this.store.tx(() => { if (owns()) { comment.state = 'blocked'; comment.error = 'GitHub comment delivery is unavailable in the isolated demo'; comment.updated_at = Date.now(); this.store.put('github_comment', comment.id, comment); job.state = 'done'; job.lease_until = 0; job.error = comment.error; this.store.put('event_job', job.id, job); } });
          } else {
            const delivered = await this.provider.maintainComment(change, comment.body);
            this.store.tx(() => {
              if (!owns()) return;
              const current = this.store.get('github_comment', comment.id);
              if (!current) return;
              current.comment_id = delivered.id; current.state = 'delivered'; current.error = null; current.updated_at = Date.now(); this.store.put('github_comment', current.id, current);
              job.state = 'done'; job.lease_until = 0; job.error = null; this.store.put('event_job', job.id, job);
            });
          }
        } else {
          const snapshot = job.type === 'projection' ? null : await this.provider.snapshot(project, this.store.all('git_change'), JSON.parse(job.payload));
          this.store.tx(() => {
            if (!owns() || this.store.get('project', '1')?.integration_branch !== project.integration_branch) return;
            if (snapshot) applySnapshot(this.store, snapshot); else coordinate(this.store);
            job.state = 'done'; job.lease_until = 0; job.error = null; this.store.put('event_job', job.id, job);
          });
        }
      } catch (error) {
        this.store.tx(() => {
          if (!owns()) return;
          const retry = error instanceof ProviderError ? error.retryAt : 0;
          if (!retry) job.attempts++;
          // A spoofed marker must never be retried into a duplicate comment.
          const blocked = job.type === 'github_comment' && error instanceof ProviderError && error.status === 409;
          if (blocked) {
            const payload = JSON.parse(job.payload) as { comment_id?: string };
            const comment = payload.comment_id ? this.store.get('github_comment', payload.comment_id) : undefined;
            if (comment) { comment.state = 'blocked'; comment.error = error.message; comment.updated_at = Date.now(); this.store.put('github_comment', comment.id, comment); }
          }
          job.state = blocked || job.attempts >= 8 ? 'failed' : 'queued'; job.next_at = retry || Date.now() + Math.min(300_000, 1_000 * 2 ** job.attempts) + Math.floor(Math.random() * 1_000); job.lease_until = 0;
          job.error = error instanceof ProviderError ? error.message : 'Synchronization failed; inspect deployment connectivity and provider configuration';
          this.store.put('event_job', job.id, job);
          const current = this.store.get('project', '1')!;
          if (isGovernanceJob(job.type)) {
            const payload = JSON.parse(job.payload) as { request_id?: string };
            if (payload.request_id) this.governance?.retryableFailure(payload.request_id, error);
          } else if (job.type !== 'github_comment') { current.error = job.error; this.store.put('project', '1', current); this.store.notice('sync_error', 'project', String(current.last_sync), job.error); coordinate(this.store); }
        });
      }
    } finally { if (heartbeat) clearInterval(heartbeat); this.busy = false; }
  }
}
