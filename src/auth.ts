import { isUserAllowed } from './access';
import { hmacHex, signValue, timingSafeEqual, verifySignedValue } from './crypto';
import { brokerOrigin, cookie, corsJson, getCookie } from './http';
import { createBrokerToken, getSigningSecret } from './token';
import type { BrokerUser, Env } from './types';

const AUTH_CODE_TTL_SECONDS = 5 * 60;

// Kicks off Discourse SSO: redirect the user to the forum's sso_provider with a
// signed nonce, which comes back to /auth/callback.
export async function authStart(request: Request, env: Env): Promise<Response> {
	const nonce = crypto.randomUUID();

	const rawPayload = new URLSearchParams({
		nonce,
		return_sso_url: `${brokerOrigin(request, env)}/auth/callback`,
	}).toString();

	const base64Payload = btoa(rawPayload);
	const sig = await hmacHex(base64Payload, env.DISCOURSE_CONNECT_SECRET);

	const discourseUrl = `${env.DISCOURSE_ORIGIN}/session/sso_provider` + `?sso=${encodeURIComponent(base64Payload)}` + `&sig=${sig}`;

	const nonceCookie = await signValue(nonce, await getSigningSecret(env));

	return new Response(null, {
		status: 302,
		headers: {
			Location: discourseUrl,
			'Set-Cookie': cookie('dvb_nonce', nonceCookie, {
				path: '/auth',
				maxAge: 600,
				httpOnly: true,
				sameSite: 'Lax',
			}),
		},
	});
}

// Discourse redirects back here with the signed user payload. Verify it, mint a
// short-lived auth code, and bounce to the forum with the code in the fragment.
export async function authCallback(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const sso = url.searchParams.get('sso');
	const sig = url.searchParams.get('sig');

	if (!sso || !sig) {
		return new Response('Missing sso or sig', { status: 400 });
	}

	const expectedSig = await hmacHex(sso, env.DISCOURSE_CONNECT_SECRET);

	if (!timingSafeEqual(sig, expectedSig)) {
		return new Response('Invalid Discourse signature', { status: 403 });
	}

	const decoded = atob(sso);
	const params = new URLSearchParams(decoded);

	const returnedNonce = params.get('nonce');
	const nonceCookie = getCookie(request, 'dvb_nonce');

	if (!returnedNonce || !nonceCookie) {
		return new Response('Missing nonce', { status: 403 });
	}

	const originalNonce = await verifySignedValue(nonceCookie, await getSigningSecret(env));

	if (!originalNonce || originalNonce !== returnedNonce) {
		return new Response('Invalid nonce', { status: 403 });
	}

	const user: BrokerUser = {
		id: params.get('external_id'),
		username: params.get('username'),
		name: params.get('name'),
		email: params.get('email'),
		admin: params.get('admin') === 'true',
		moderator: params.get('moderator') === 'true',
		groups: (params.get('groups') || '')
			.split(',')
			.map((group) => group.trim())
			.filter(Boolean),
	};

	// Group gate: when ALLOWED_GROUPS is set, only matching members get a code.
	// Bounce the rest back with an error the theme can surface.
	if (!isUserAllowed(user, env)) {
		return new Response(null, {
			status: 302,
			headers: {
				Location: `${env.DISCOURSE_ORIGIN}/#video-broker-error=forbidden`,
				'Set-Cookie': cookie('dvb_nonce', '', {
					path: '/auth',
					maxAge: 0,
					httpOnly: true,
					sameSite: 'Lax',
				}),
			},
		});
	}

	const code = crypto.randomUUID();

	await env.KV.put(
		`authcode:${code}`,
		JSON.stringify({
			user,
			exp: Math.floor(Date.now() / 1000) + AUTH_CODE_TTL_SECONDS,
		}),
		{ expirationTtl: AUTH_CODE_TTL_SECONDS },
	);

	const redirectUrl = `${env.DISCOURSE_ORIGIN}/#video-broker-code=${encodeURIComponent(code)}`;

	return new Response(null, {
		status: 302,
		headers: {
			Location: redirectUrl,
			'Set-Cookie': cookie('dvb_nonce', '', {
				path: '/auth',
				maxAge: 0,
				httpOnly: true,
				sameSite: 'Lax',
			}),
		},
	});
}

// The browser exchanges its one-time code for a broker token it can send as a
// Bearer credential on the upload endpoints.
export async function authExchange(request: Request, env: Env): Promise<Response> {
	const origin = request.headers.get('Origin');

	if (origin !== env.DISCOURSE_ORIGIN) {
		return corsJson({ error: 'Bad origin' }, env, 403);
	}

	const body = (await request.json()) as { code?: string };

	if (!body.code) {
		return corsJson({ error: 'Missing code' }, env, 400);
	}

	const raw = await env.KV.get(`authcode:${body.code}`);

	if (!raw) {
		return corsJson({ error: 'Invalid or expired code' }, env, 403);
	}

	await env.KV.delete(`authcode:${body.code}`);

	const payload = JSON.parse(raw);

	if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
		return corsJson({ error: 'Expired code' }, env, 403);
	}

	const token = await createBrokerToken(payload.user, env);

	return corsJson(
		{
			token,
			expires_in: 60 * 60,
			user: payload.user,
		},
		env,
	);
}
