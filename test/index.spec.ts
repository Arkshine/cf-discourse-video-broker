import { env, SELF, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { enforceUploadQuota, userMatchesGroups } from '../src/access';
import type { BrokerUser } from '../src/types';
import worker from '../src/index';

function makeUser(overrides: Partial<BrokerUser> = {}): BrokerUser {
	return {
		id: 'u1',
		username: 'alice',
		name: 'Alice',
		email: 'a@test',
		admin: false,
		moderator: false,
		groups: [],
		...overrides,
	};
}

describe('video broker routing & auth', () => {
	it('returns 404 for an unknown route', async () => {
		const response = await SELF.fetch('https://broker.test/nope');
		expect(response.status).toBe(404);
		expect(await response.text()).toBe('Not found');
	});

	it('reports health with a version', async () => {
		const response = await SELF.fetch('https://broker.test/health');
		expect(response.status).toBe(200);
		const body = await response.json<{ ok: boolean; version: string }>();
		expect(body.ok).toBe(true);
		expect(typeof body.version).toBe('string');
	});

	it('answers CORS preflight with the Discourse origin', async () => {
		const response = await SELF.fetch('https://broker.test/uploads/direct', {
			method: 'OPTIONS',
		});
		expect(response.status).toBe(204);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe(env.DISCOURSE_ORIGIN);
	});

	it('rejects a Cloudflare upload without a broker token', async () => {
		const response = await SELF.fetch('https://broker.test/uploads/direct', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ size: 10, mime_type: 'video/mp4' }),
		});
		expect(response.status).toBe(401);
	});

	it('rejects a Cloudflare status check without a broker token', async () => {
		const response = await SELF.fetch('https://broker.test/videos/uid123');
		expect(response.status).toBe(401);
	});

	it('rejects a Mux upload without a broker token', async () => {
		const response = await SELF.fetch('https://broker.test/mux/uploads', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ size: 10, mime_type: 'video/mp4' }),
		});
		expect(response.status).toBe(401);
	});
});

async function signDiscourse(body: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
	const hex = [...new Uint8Array(sig)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
	return `sha256=${hex}`;
}

describe('discourse cleanup webhook', () => {
	const secret = 'test-webhook-secret';

	it('rejects a request with no signature', async () => {
		const response = await SELF.fetch('https://broker.test/discourse/webhook', {
			method: 'POST',
			body: '{}',
		});
		expect(response.status).toBe(400);
	});

	it('rejects a request with a bad signature', async () => {
		const response = await SELF.fetch('https://broker.test/discourse/webhook', {
			method: 'POST',
			headers: { 'X-Discourse-Event-Signature': 'sha256=deadbeef', 'X-Discourse-Event': 'ping' },
			body: '{}',
		});
		expect(response.status).toBe(403);
	});

	it('answers a signed ping with pong', async () => {
		const body = JSON.stringify({ ping: 'OK' });
		const response = await SELF.fetch('https://broker.test/discourse/webhook', {
			method: 'POST',
			headers: {
				'X-Discourse-Event-Signature': await signDiscourse(body, secret),
				'X-Discourse-Event': 'ping',
			},
			body,
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('pong');
	});

	it('schedules (does not immediately delete) a video on post_destroyed', async () => {
		const playbackId = 'pbSchedule123';
		const body = JSON.stringify({
			post: { raw: `watch https://player.mux.com/${playbackId}`, cooked: '' },
		});

		const response = await SELF.fetch('https://broker.test/discourse/webhook', {
			method: 'POST',
			headers: {
				'X-Discourse-Event-Signature': await signDiscourse(body, secret),
				'X-Discourse-Event': 'post_destroyed',
			},
			body,
		});

		expect(response.status).toBe(200);

		const marker = await env.KV.get(`pending_delete:mux:${playbackId}`);
		expect(marker, 'a pending-delete marker is written').not.toBeNull();
		expect(JSON.parse(marker!).deleteAt).toBeGreaterThan(Date.now());
	});

	it('cancels a pending delete on post_recovered', async () => {
		const playbackId = 'pbRecover123';
		await env.KV.put(
			`pending_delete:mux:${playbackId}`,
			JSON.stringify({ provider: 'mux', id: playbackId, deleteAt: Date.now() + 1000 }),
		);

		const body = JSON.stringify({
			post: { raw: `watch https://player.mux.com/${playbackId}`, cooked: '' },
		});

		const response = await SELF.fetch('https://broker.test/discourse/webhook', {
			method: 'POST',
			headers: {
				'X-Discourse-Event-Signature': await signDiscourse(body, secret),
				'X-Discourse-Event': 'post_recovered',
			},
			body,
		});

		expect(response.status).toBe(200);
		expect(await env.KV.get(`pending_delete:mux:${playbackId}`)).toBeNull();
	});

	it('cron only acts on markers past their grace window', async () => {
		const due = 'pbDue';
		const notDue = 'pbNotDue';

		await env.KV.put(`pending_delete:mux:${due}`, JSON.stringify({ provider: 'mux', id: due, deleteAt: Date.now() - 1000 }));
		await env.KV.put(
			`pending_delete:mux:${notDue}`,
			JSON.stringify({ provider: 'mux', id: notDue, deleteAt: Date.now() + 60_000 }),
		);

		const ctx = createExecutionContext();
		await worker.scheduled!({ scheduledTime: Date.now(), cron: '0 3 * * *', noRetry() {} }, env, ctx);
		await waitOnExecutionContext(ctx);

		// No playback->asset mapping exists, so the Mux delete is a no-op, but the
		// due marker is consumed and the not-due one is left alone.
		expect(await env.KV.get(`pending_delete:mux:${due}`)).toBeNull();
		expect(await env.KV.get(`pending_delete:mux:${notDue}`)).not.toBeNull();
	});
});

describe('group gate (userMatchesGroups)', () => {
	it('allows everyone when the list is empty', () => {
		expect(userMatchesGroups(makeUser({ groups: [] }), [])).toBe(true);
	});

	it('rejects a member outside the allowed groups', () => {
		expect(userMatchesGroups(makeUser({ groups: ['trust_level_0'] }), ['trust_level_2'])).toBe(false);
	});

	it('allows a member inside an allowed group', () => {
		expect(userMatchesGroups(makeUser({ groups: ['trust_level_0', 'trust_level_2'] }), ['trust_level_2'])).toBe(true);
	});

	it('always allows admins and moderators', () => {
		expect(userMatchesGroups(makeUser({ admin: true, groups: [] }), ['video_creators'])).toBe(true);
		expect(userMatchesGroups(makeUser({ moderator: true, groups: [] }), ['video_creators'])).toBe(true);
	});
});

describe('per-user daily quota (enforceUploadQuota)', () => {
	it('allows up to the cap, then returns 429', async () => {
		// vitest binds MAX_UPLOADS_PER_DAY = 2.
		const user = makeUser({ id: 'quota-user' });

		expect(await enforceUploadQuota(env, user)).toBeNull();
		expect(await enforceUploadQuota(env, user)).toBeNull();

		const blocked = await enforceUploadQuota(env, user);
		expect(blocked).not.toBeNull();
		expect(blocked!.status).toBe(429);
	});

	it('counts each member separately', async () => {
		const other = makeUser({ id: 'quota-user-2' });
		expect(await enforceUploadQuota(env, other)).toBeNull();
	});
});
