import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
				miniflare: {
					bindings: {
						DISCOURSE_ORIGIN: 'http://lcoalhost:3000',
						DISCOURSE_WEBHOOK_SECRET: 'test-webhook-secret',
						MAX_UPLOADS_PER_DAY: '2',
					},
				},
			},
		},
	},
});
