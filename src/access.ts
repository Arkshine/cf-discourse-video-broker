import { corsJson } from './http';
import type { BrokerUser, Env } from './types';

function parseList(raw: string | undefined): string[] {
	return (raw || '')
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);
}


export function userMatchesGroups(user: BrokerUser, allowedGroups: string[]): boolean {
	if (allowedGroups.length === 0) {
		return true;
	}

	if (user.admin || user.moderator) {
		return true;
	}

	return user.groups.some((group) => allowedGroups.includes(group));
}

export function isUserAllowed(user: BrokerUser, env: Env): boolean {
	return userMatchesGroups(user, parseList(env.ALLOWED_GROUPS));
}

export async function enforceUploadQuota(env: Env, user: BrokerUser): Promise<Response | null> {
	const max = Number(env.MAX_UPLOADS_PER_DAY || '0');
	if (max <= 0) {
		return null; // unlimited
	}

	const day = new Date().toISOString().slice(0, 10);
	const key = `quota:${user.id}:${day}`;
	const current = Number((await env.KV.get(key)) || '0');

	if (current >= max) {
		return corsJson({ error: 'Daily upload limit reached' }, env, 429);
	}

	// Expire after 48h so the counter self-cleans without a cron.
	await env.KV.put(key, String(current + 1), { expirationTtl: 60 * 60 * 48 });
	return null;
}
