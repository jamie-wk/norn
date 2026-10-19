import { defineActivities } from '@norn/workflow';
import type { NotifyActivities as NotifyActivities$ } from './activities.ts';

export const NotifyActivities = defineActivities<NotifyActivities$>()({ prefix: 'notify.', methods: { email: {}, audit: {} } });
