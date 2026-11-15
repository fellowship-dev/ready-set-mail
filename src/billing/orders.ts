// Order statuses and the one place that says which moves are legal.
//
//   pending ─▶ paid ─▶ started ─▶ done
//      │         │         │         │
//      │         └─────────┴─────────┴──▶ refunded
//      ├──▶ failed
//      └──▶ canceled
//
// Moves are only forward: an event that arrives late (`invoice.paid` after `charge.refunded`) finds no legal predecessor and changes nothing.
// `failed`, `canceled` and `refunded` are final. Each move is one conditional UPDATE (billing.orders.move), so of two racing callers exactly
// one makes it and alone performs its side effects.
import type { OrderRow, OrderStatus } from '@ready-set-mail/db';

export const ORDER_FLOW: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = Object.freeze({
  pending: ['paid', 'failed', 'canceled'],
  paid: ['started', 'refunded'],
  started: ['done', 'refunded'],
  done: ['refunded'],
  refunded: [],
  failed: [],
  canceled: [],
});

export const canMove = (from: OrderStatus, to: OrderStatus): boolean => ORDER_FLOW[from].includes(to);

/** The statuses from which `to` may be reached: the WHERE of the conditional update. */
export const predecessorsOf = (to: OrderStatus): OrderStatus[] =>
  (Object.keys(ORDER_FLOW) as OrderStatus[]).filter((s) => ORDER_FLOW[s].includes(to));

/** The timestamp column a move sets. */
export const STAMP: Readonly<Partial<Record<OrderStatus, 'paid_at' | 'started_at' | 'done_at' | 'refunded_at' | 'failed_at'>>> = {
  paid: 'paid_at', started: 'started_at', done: 'done_at', refunded: 'refunded_at', failed: 'failed_at', canceled: 'failed_at',
};

/** Holds its domain's single slot (pending, paid, started). */
export const isOpen = (s: OrderStatus): boolean => s === 'pending' || s === 'paid' || s === 'started';

/** What a customer's browser may see of an order: no Stripe ids, no buyer id, no internal notes. */
export interface OrderView {
  id: string;
  domain: string;
  domain_id: number | null;
  offer: string;
  amount: number;
  /** What Stripe collected (less than `amount` after a credit balance or coupon); null until paid. */
  amount_paid: number | null;
  currency: string;
  status: OrderStatus;
  amount_refunded: number;
  buyer_email: string | null;
  /** Plain words for a failed order. */
  failure_message: string | null;
  /** True while the buyer has to finish confirming with their bank (the invoice page is `action_url`). */
  action_required: boolean;
  action_url: string | null;
  /** True while Stripe reports the invoice paid but we are checking it against what was sold: the buyer is told it arrived. */
  payment_review: boolean;
  created_at: number;
  paid_at: number | null;
  started_at: number | null;
  done_at: number | null;
  refunded_at: number | null;
  failed_at: number | null;
}

export function orderView(o: OrderRow): OrderView {
  const action = o.status === 'pending' && o.note === 'action_required';
  return {
    id: o.id, domain: o.domain_name, domain_id: o.domain_id, offer: o.offer, amount: o.amount, amount_paid: o.amount_paid, currency: o.currency, status: o.status,
    amount_refunded: o.amount_refunded, buyer_email: o.buyer_email, failure_message: o.failure_message,
    action_required: action, action_url: action ? o.hosted_invoice_url : null, payment_review: o.status === 'pending' && o.note === 'payment_review',
    created_at: o.created_at, paid_at: o.paid_at, started_at: o.started_at, done_at: o.done_at, refunded_at: o.refunded_at, failed_at: o.failed_at,
  };
}

/** What the instance owner sees: the same plus who, where and the Stripe ids to find it in the dashboard. */
export interface OperatorOrderView extends OrderView {
  workspace_id: string;
  workspace_name: string;
  stripe_invoice_id: string | null;
  next: 'started' | 'done' | null;
}

export function operatorView(o: OrderRow): OperatorOrderView {
  return { ...orderView(o), workspace_id: o.workspace_id, workspace_name: o.workspace_name, stripe_invoice_id: o.stripe_invoice_id, next: o.status === 'paid' ? 'started' : o.status === 'started' ? 'done' : null };
}
