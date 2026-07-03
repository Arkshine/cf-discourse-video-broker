import type { Env } from './types';

export function brokerOrigin(request: Request, env: Env): string {
	return env.BROKER_ORIGIN || new URL(request.url).origin;
}

export function corsJson(data: unknown, env: Env, status = 200): Response {
	return corsResponse(
		new Response(JSON.stringify(data), {
			status,
			headers: {
				'Content-Type': 'application/json',
			},
		}),
		env,
	);
}

export function corsResponse(response: Response | null, env: Env): Response {
	const res = response || new Response(null, { status: 204 });
	const headers = new Headers(res.headers);

	headers.set('Access-Control-Allow-Origin', env.DISCOURSE_ORIGIN);
	headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
	headers.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
	headers.set('Access-Control-Max-Age', '86400');

	return new Response(res.body, {
		status: res.status,
		statusText: res.statusText,
		headers,
	});
}

export function getCookie(request: Request, name: string): string | null {
	const cookieHeader = request.headers.get('Cookie') || '';
	const cookies = cookieHeader.split(';').map((cookiePart) => cookiePart.trim());

	for (const cookiePart of cookies) {
		const [key, ...value] = cookiePart.split('=');

		if (key === name) {
			return decodeURIComponent(value.join('='));
		}
	}

	return null;
}

export function cookie(
	name: string,
	value: string,
	opts: {
		path: string;
		maxAge: number;
		httpOnly?: boolean;
		sameSite?: 'Lax' | 'Strict' | 'None';
	},
): string {
	const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path}`, `Max-Age=${opts.maxAge}`, 'Secure'];

	if (opts.httpOnly) {
		parts.push('HttpOnly');
	}

	if (opts.sameSite) {
		parts.push(`SameSite=${opts.sameSite}`);
	}

	return parts.join('; ');
}
