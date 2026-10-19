import { implement } from '@norn-ts/workflow';
import * as W from './workflow-classes.ts';

export const ReminderWorkflow = implement(W.ReminderWorkflow);
export const WaitWorkflow = implement(W.WaitWorkflow);
