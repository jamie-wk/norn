import { defineActivities } from '@norn-ts/workflow';
import type { NotifyActivities as NotifyActivities$ } from './activities.ts';

export const NotifyActivities = defineActivities<NotifyActivities$>()({ prefix: 'notify.', methods: { email: {}, audit: {} } });
