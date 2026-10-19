// The generated-barrel shape: export names equal workflow type names.
import { implement } from '../../src/index.ts';
import * as W from './workflow-classes.ts';

export const OrderWorkflow = implement(W.OrderWorkflow);
export const CartWorkflow = implement(W.CartWorkflow);
export const StrictWorkflow = implement(W.StrictWorkflow);
export const FailureWorkflow = implement(W.FailureWorkflow);
export const RetryWorkflow = implement(W.RetryWorkflow);
export const ShipmentWorkflow = implement(W.ShipmentWorkflow);
export const ParentWorkflow = implement(W.ParentWorkflow);
export const PausableJobWorkflow = implement(W.PausableJobWorkflow, { descriptions: { pause: 'Pause the job' } });
export const CounterWorkflow = implement(W.CounterWorkflow);
export const CarryWorkflow = implement(W.CarryWorkflow);
