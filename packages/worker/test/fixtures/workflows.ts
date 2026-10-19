import { implement } from '@norn/workflow';
import * as W from './workflow-classes.ts';

export const GreetWorkflow = implement(W.GreetWorkflow);
export const ReportWorkflow = implement(W.ReportWorkflow);
export const SlowWorkflow = implement(W.SlowWorkflow);
