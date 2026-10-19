import { implement } from '@norn/workflow';
import * as W from './workflow-classes.ts';

export const ReminderWorkflow = implement(W.ReminderWorkflow);
export const WaitWorkflow = implement(W.WaitWorkflow);
