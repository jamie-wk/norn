import { implement } from '@norn/workflow';
import * as W from './workflow-classes.ts';

export const OrderWorkflow = implement(W.OrderWorkflow);
export const EchoWorkflow = implement(W.EchoWorkflow);
export const CartWorkflow = implement(W.CartWorkflow);
export const TickWorkflow = implement(W.TickWorkflow);
