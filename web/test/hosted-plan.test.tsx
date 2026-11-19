import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanLimitNotice, planLimitOf } from '../src/components/PlanLimitNotice';
import { ApiError } from '../src/lib/api';
import { SettingsPage } from '../src/pages/settings/SettingsPage';
import { renderApp } from './render';

afterEach(() => vi.unstubAllGlobals());

const CARD = { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2028 };
const billing = (over: Record<string, unknown> = {}) => ({ enabled: true, role: 'owner', can_manage: true, billing_email: 'owner@example.com', has_customer: true, card_on_file: true, card: CARD, offer: null, offer_problem: 'unavailable', orders: [], terms_url: null, refund_policy_url: null, ...over });
const PLAN = { free_domains: 1, interval: 'year', prices: { month: { amount: 500, currency: 'usd' }, year: { amount: 5000, currency: 'usd' } }, billed_domains: 2, card_on_file: true, started: false };
const settings = (opts: Parameters<typeof renderApp>[1]) => renderApp(<SettingsPage />, { status: { mode: 'saas' }, ...opts });

describe('Settings → Billing: the plan block', () => {
  it('renders only when the server sends `plan`: the sentence, the billed count, the owner\'s choice', async () => {
    const r = settings({ routes: { 'GET /api/billing': billing({ plan: PLAN }), 'POST /api/billing/plan': { ok: true } } });
    const section = within(await screen.findByRole('region', { name: 'Billing' }));
    expect(await section.findByText('Free for one domain. Each extra domain is $50 a year (or $5 a month), charged only once it is proven.')).toBeInTheDocument();
    expect(section.getByText('Billed now: 2 extra domains.')).toBeInTheDocument();
    const yearly = section.getByRole('button', { name: 'Yearly' });
    expect(yearly).toHaveAttribute('aria-pressed', 'true');
    expect(yearly.className).not.toContain('bg-brand');
    await userEvent.click(section.getByRole('button', { name: 'Monthly' }));
    await waitFor(() => expect(r.calls.find((c) => c.path === '/api/billing/plan')!.body).toEqual({ interval: 'month' }));
  });

  it('a member sees the facts and no choice; after the first billing the interval is fixed', async () => {
    const m = settings({ role: 'member', routes: { 'GET /api/billing': billing({ role: 'member', can_manage: false, card: undefined, billing_email: undefined, plan: PLAN }) } });
    const section = within(await screen.findByRole('region', { name: 'Billing' }));
    expect(await section.findByText('Billed now: 2 extra domains.')).toBeInTheDocument();
    expect(section.queryByRole('button', { name: 'Yearly' })).not.toBeInTheDocument();
    m.unmount();
    settings({ routes: { 'GET /api/billing': billing({ plan: { ...PLAN, started: true, billed_domains: 1 } }) } });
    const owner = within(await screen.findByRole('region', { name: 'Billing' }));
    expect(await owner.findByText('Billed now: 1 extra domain.')).toBeInTheDocument();
    expect(owner.queryByRole('button', { name: 'Monthly' })).not.toBeInTheDocument();
  });

  it('with the plan off (`plan: null` or absent) nothing about paying for domains renders', async () => {
    for (const over of [{ plan: null }, {}]) {
      const r = settings({ routes: { 'GET /api/billing': billing(over) } });
      const section = within(await screen.findByRole('region', { name: 'Billing' }));
      await section.findByText(/Visa ending 4242/);
      expect(screen.getByRole('region', { name: 'Billing' }).textContent).not.toMatch(/Free for one domain|extra domain|Billed now|Yearly|Monthly/);
      r.unmount();
    }
  });
});

describe('the add-domain refusal card_required', () => {
  const refusal = (can_manage: boolean) => new ApiError(402, 'Your free plan covers one domain, and a domain waiting for proof counts.', { code: 'card_required', can_manage, prices: { month: 'USD 5', year: 'USD 50' } });
  it('shows the server\'s sentence, and for the owner an Add a card link to Settings', async () => {
    const limit = planLimitOf(refusal(true))!;
    expect(limit.code).toBe('card_required');
    renderApp(<PlanLimitNotice limit={limit} />, { status: { mode: 'saas' }, routes: {} });
    expect(await screen.findByText('Your free plan covers one domain, and a domain waiting for proof counts.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add a card' })).toHaveAttribute('href', '/settings');
  });
  it('a non-owner gets the sentence and no button', async () => {
    renderApp(<PlanLimitNotice limit={planLimitOf(refusal(false))!} />, { status: { mode: 'saas' }, routes: {} });
    expect(await screen.findByText(/free plan covers one domain/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Add a card' })).not.toBeInTheDocument();
  });
  it('a plain plan_limit is unchanged (no card button)', async () => {
    const l = planLimitOf(new ApiError(403, 'This workspace has reached its limit of 10 domains.', { code: 'plan_limit', limit: { kind: 'domains_per_workspace', max: 10 }, help_url: null }))!;
    expect(l.code).toBeUndefined();
    renderApp(<PlanLimitNotice limit={l} />, { status: { mode: 'saas' }, routes: {} });
    await screen.findByText(/reached its limit/);
    expect(screen.queryByRole('link', { name: 'Add a card' })).not.toBeInTheDocument();
  });
});
